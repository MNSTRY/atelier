import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveGitExecutable, runGit } from '../src/runtime/git-adapter.mjs'
import {
  acquireRepositoryLock,
  appendOperationTrace,
  atomicWriteJson,
  readOperationTrace,
  runtimePaths,
  writeRuntimeState,
} from '../src/runtime/local-state.mjs'
import {
  enrollRepository,
  executeUserConfirmedCommit,
  operationTrace,
  planUserConfirmedCommit,
  reconcileRepository,
  runtimeStatus,
  setRepositoryPaused,
} from '../src/runtime/supervisor.mjs'

const git = resolveGitExecutable()

function configure(root) {
  runGit(git, root, ['config', 'user.name', 'Atelier Test'])
  runGit(git, root, ['config', 'user.email', 'atelier@example.invalid'])
  runGit(git, root, ['config', 'commit.gpgsign', 'false'])
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-supervisor-'))
  const remote = path.join(base, 'remote.git')
  const root = path.join(base, 'workspace')
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  runGit(git, null, ['init', '--bare', '--initial-branch=main', remote])
  fs.mkdirSync(root)
  runGit(git, root, ['init', '--initial-branch=main'])
  configure(root)
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# Atelier Supervisor\n')
  runGit(git, root, ['add', '.'])
  runGit(git, root, ['commit', '-m', 'initial'])
  runGit(git, root, ['remote', 'add', 'origin', remote])
  runGit(git, root, ['push', '-u', 'origin', 'main'])
  return { base, remote, root }
}

function writePrivateBoundaryProject(root, { actorEmail, mode = 'strict' }) {
  fs.writeFileSync(path.join(root, 'atelier.project.json'), `${JSON.stringify({
    schema: 'mnstry.atelier-project-config@v1',
    name: 'workspace',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    boundaries: { policyPath: 'boundary-policy.v1.json', governanceLedgerPath: 'governance/repo-boundary-ledger.md', strictNewRepos: true },
    repos: [{ name: 'workspace', path: '.', readBoundary: 'private' }],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'repo-access.v1.json'), `${JSON.stringify({
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'private',
    repos: { workspace: { readBoundary: 'private' } },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'boundary-policy.v1.json'), `${JSON.stringify({
    schema: 'mnstry.atelier-boundary-policy@v1',
    mode,
    actors: { owner: { githubLogin: 'owner-login', gitEmails: [actorEmail], privateDomainRepo: 'workspace' } },
    repos: {
      workspace: {
        kind: 'private_domain',
        ownerActor: 'owner',
        readBoundary: 'private',
        allowedAudiences: ['private', 'sensitive', 'team', 'operator', 'staff', 'public'],
        forbiddenAudiences: [],
        autoCommit: 'guarded',
      },
    },
    promotion: { requiresGitPromote: true, recordsPath: 'governance/git-promote-events.jsonl' },
    governanceLedgerPath: 'governance/repo-boundary-ledger.md',
  }, null, 2)}\n`)
}

function pinWrapperEnvironment(t, { base, root }) {
  const log = path.join(base, 'pinned-git.log')
  const ambientGitMarker = path.join(base, 'ambient-git-ran')
  const ghMarker = path.join(base, 'gh-ran')
  const wrapper = path.join(base, 'pinned-git')
  const fakeBin = path.join(base, 'fake-bin')
  const redirected = path.join(base, 'redirected')
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(redirected)
  runGit(git, redirected, ['init', '--initial-branch=main'])
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(git)} "$@"\n`)
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > ${JSON.stringify(ambientGitMarker)}\nexit 97\n`)
  fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh\nprintf invoked > ${JSON.stringify(ghMarker)}\nprintf '%s\\n' owner-login\n`)
  fs.chmodSync(wrapper, 0o755)
  fs.chmodSync(path.join(fakeBin, 'git'), 0o755)
  fs.chmodSync(path.join(fakeBin, 'gh'), 0o755)
  const previous = {
    path: process.env.PATH,
    gitPath: process.env.ATELIER_GIT_PATH,
    gitDir: process.env.GIT_DIR,
    actor: process.env.MNSTRY_ATELIER_ACTOR,
    githubActor: process.env.GITHUB_ACTOR,
  }
  process.env.PATH = `${fakeBin}${path.delimiter}${previous.path || ''}`
  process.env.ATELIER_GIT_PATH = wrapper
  process.env.GIT_DIR = path.join(redirected, '.git')
  delete process.env.MNSTRY_ATELIER_ACTOR
  delete process.env.GITHUB_ACTOR
  t.after(() => {
    if (previous.path == null) delete process.env.PATH
    else process.env.PATH = previous.path
    if (previous.gitPath == null) delete process.env.ATELIER_GIT_PATH
    else process.env.ATELIER_GIT_PATH = previous.gitPath
    if (previous.gitDir == null) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previous.gitDir
    if (previous.actor == null) delete process.env.MNSTRY_ATELIER_ACTOR
    else process.env.MNSTRY_ATELIER_ACTOR = previous.actor
    if (previous.githubActor == null) delete process.env.GITHUB_ACTOR
    else process.env.GITHUB_ACTOR = previous.githubActor
  })
  return { wrapper, log, ambientGitMarker, ghMarker }
}

function head(root) {
  return runGit(git, root, ['rev-parse', 'HEAD']).stdout.trim()
}

function planFile(root, operationId) {
  return path.join(runtimePaths(root).plans, `${operationId}.json`)
}

test('explicit enrollment writes ignored local state and reports healthy status', (t) => {
  const { root } = fixture(t)
  const enrolled = enrollRepository({ repoPath: root, gitExecutable: git })
  assert.equal(enrolled.enrollment.mode, 'explicit-single-repository')
  assert.equal(enrolled.state.status, 'healthy')
  const status = runtimeStatus({ repoPath: root })
  assert.equal(status.state.status, 'healthy')
  assert.equal(status.state.observation.status.clean, true)
  assert.equal(runGit(git, root, ['status', '--porcelain']).stdout, '')
})

test('credential-bearing config labels stay out of persisted state and status stdout', (t) => {
  const { root } = fixture(t)
  const material = ['sentinel', '-persisted-config'].join('')
  runGit(git, root, ['config', `url.https://user:${material}@example.test/.insteadOf`, 'https://example.test/'])
  enrollRepository({ repoPath: root, gitExecutable: git })
  const paths = runtimePaths(root)
  assert.equal(fs.readFileSync(paths.state, 'utf8').includes(material), false)
  const syncCommand = path.resolve('src/commands/sync.mjs')
  const status = spawnSync(process.execPath, [syncCommand, 'status', '--repo', root], { encoding: 'utf8' })
  assert.equal(status.status, 1)
  assert.equal(status.stdout.includes(material), false)
})

test('commit plan requires an exact confirmation and re-observes before staging', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'notes.md'), 'reviewed\n')
  const before = head(root)
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['notes.md'], message: 'docs: add reviewed notes' })
  assert.equal(plan.mode, 'user-confirmed')
  assert.equal(plan.confirmation.operationId, plan.operationId)
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: 'wrong' }),
    /exact operation confirmation token is required/,
  )
  assert.equal(head(root), before)

  fs.appendFileSync(path.join(root, 'notes.md'), 'changed after review\n')
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /repository changed after review/,
  )
  assert.equal(runGit(git, root, ['diff', '--cached', '--name-only']).stdout, '')
  assert.equal(head(root), before)
})

test('core.fileMode false can commit reviewed content without mode drift', (t) => {
  const { root } = fixture(t)
  const script = path.join(root, 'script.sh')
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(script, 0o755)
  runGit(git, root, ['add', 'script.sh'])
  runGit(git, root, ['update-index', '--chmod=+x', 'script.sh'])
  runGit(git, root, ['commit', '-m', 'add executable'])
  runGit(git, root, ['push', 'origin', 'main'])
  runGit(git, root, ['config', 'core.fileMode', 'false'])
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.chmodSync(script, 0o644)
  fs.appendFileSync(script, '# reviewed change\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['script.sh'], message: 'fix: preserve tracked mode' })
  const result = executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId })
  assert.equal(result.ok, true)
  assert.equal(runGit(git, root, ['ls-tree', 'HEAD', 'script.sh']).stdout.startsWith('100755 '), true)
})

test('user-confirmed commit stages only reviewed files and can publish through the declared upstream', (t) => {
  const { root, remote } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  runGit(git, root, ['tag', '-a', 'local-only', '-m', 'must not follow'])
  runGit(git, root, ['config', 'push.followTags', 'true'])
  runGit(git, root, ['config', 'push.recurseSubmodules', 'on-demand'])
  fs.writeFileSync(path.join(root, 'publish.md'), 'publish me\n')
  fs.writeFileSync(path.join(root, 'leave-local.md'), 'do not include\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['publish.md'], message: 'docs: publish bounded change', publish: true })
  assert.deepEqual(plan.paths, ['publish.md'])
  assert.equal(plan.publish.remote, 'origin')
  assert.equal(plan.publish.branch, 'main')
  const result = executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId })
  assert.equal(result.ok, true)
  assert.equal(result.publish.ok, true)
  assert.equal(fs.existsSync(planFile(root, plan.operationId)), false)
  assert.equal(runGit(git, root, ['status', '--porcelain']).stdout.trim(), '?? leave-local.md')
  assert.equal(runGit(git, null, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(), result.commit)
  assert.equal(runGit(git, root, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim(), result.commit)
  const afterPublish = runtimeStatus({ repoPath: root })
  assert.equal(afterPublish.ok, true)
  assert.notEqual(afterPublish.state.code, 'local-commits-unpublished')
  fs.writeFileSync(path.join(root, 'second-publish.md'), 'publish again\n')
  const { plan: nextPlan } = planUserConfirmedCommit({ repoPath: root, paths: ['second-publish.md'], message: 'docs: allow subsequent publish', publish: true })
  assert.equal(nextPlan.publish.remote, 'origin')
  assert.equal(runGit(git, null, ['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/tags']).stdout, '')
  const trace = readOperationTrace(runtimePaths(root).trace)
  assert.deepEqual(trace.map((item) => item.operation), ['enroll', 'commit-plan-created', 'commit-created', 'commit-publish', 'commit-plan-created'])
})

test('publish uses the reviewed push URL rather than the fetch remote', (t) => {
  const { base, remote, root } = fixture(t)
  const redirected = path.join(base, 'redirected.git')
  runGit(git, null, ['init', '--bare', redirected])
  runGit(git, root, ['remote', 'set-url', '--push', 'origin', redirected])
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'publish.md'), 'reviewed push destination\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['publish.md'], message: 'docs: bind push destination', publish: true })
  assert.equal(plan.publish.url, redirected)
  const result = executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId })
  assert.equal(result.ok, false)
  assert.equal(result.committed, true)
  assert.equal(result.publish.ok, true)
  assert.equal(result.state.code, 'published-to-distinct-push-target')
  assert.equal(runGit(git, null, ['--git-dir', redirected, 'rev-parse', 'refs/heads/main']).stdout.trim(), result.commit)
  assert.notEqual(runGit(git, null, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(), result.commit)
})

test('reconciliation ignores watcher history and performs only a clean fast-forward', (t) => {
  const { base, remote, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const writer = path.join(base, 'writer')
  runGit(git, null, ['clone', '--branch', 'main', remote, writer])
  configure(writer)
  fs.writeFileSync(path.join(writer, 'upstream.md'), 'upstream\n')
  runGit(git, writer, ['add', 'upstream.md'])
  runGit(git, writer, ['commit', '-m', 'upstream'])
  runGit(git, writer, ['push', 'origin', 'main'])

  const result = reconcileRepository({ repoPath: root, fetchAttempts: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.state.code, 'fast-forwarded')
  assert.equal(fs.readFileSync(path.join(root, 'upstream.md'), 'utf8').replaceAll('\r\n', '\n'), 'upstream\n')
  assert.equal(runGit(git, root, ['status', '--porcelain']).stdout, '')
})

test('local work blocks upstream reconciliation and produces one stable attention incident', (t) => {
  const { base, remote, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const writer = path.join(base, 'writer')
  runGit(git, null, ['clone', '--branch', 'main', remote, writer])
  configure(writer)
  fs.writeFileSync(path.join(writer, 'upstream.md'), 'upstream\n')
  runGit(git, writer, ['add', 'upstream.md'])
  runGit(git, writer, ['commit', '-m', 'upstream'])
  runGit(git, writer, ['push', 'origin', 'main'])
  fs.writeFileSync(path.join(root, 'local.md'), 'local work\n')

  const first = reconcileRepository({ repoPath: root, fetchAttempts: 1 })
  const second = reconcileRepository({ repoPath: root, fetchAttempts: 1 })
  assert.equal(first.state.code, 'update-blocked-by-local-changes')
  assert.equal(first.state.incidentId, second.state.incidentId)
  assert.equal(fs.existsSync(path.join(root, 'upstream.md')), false)
})

test('bounded fetch failures become attention and prevent publish-plan creation', (t) => {
  const { base, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  runGit(git, root, ['remote', 'set-url', 'origin', path.join(base, 'missing-remote.git')])
  const reconciled = reconcileRepository({ repoPath: root, fetchAttempts: 1 })
  assert.equal(reconciled.ok, false)
  assert.equal(reconciled.state.code, 'fetch-unavailable')
  assert.equal(reconciled.state.details.attempts, 1)

  fs.writeFileSync(path.join(root, 'publish.md'), 'reviewed\n')
  assert.throws(
    () => planUserConfirmedCommit({ repoPath: root, paths: ['publish.md'], message: 'docs: no fetch no publish', publish: true, fetchAttempts: 1 }),
    /cannot prepare a publish plan because fetch failed/,
  )
  assert.deepEqual(fs.readdirSync(runtimePaths(root).plans), [])
})

test('publish planning refuses incomplete evidence before fetch and prior unpublished commits before disclosure', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'publish.md'), 'reviewed\n')
  runGit(git, root, ['config', 'core.sparseCheckout', 'true'])
  assert.throws(
    () => planUserConfirmedCommit({ repoPath: root, paths: ['publish.md'], message: 'docs: incomplete must not fetch', publish: true, fetchAttempts: 1 }),
    /completeness blockers|incomplete|sparse/i,
  )
  runGit(git, root, ['config', 'core.sparseCheckout', 'false'])
  runGit(git, root, ['add', 'publish.md'])
  runGit(git, root, ['commit', '-m', 'local unpublished commit'])
  fs.writeFileSync(path.join(root, 'next.md'), 'next\n')
  assert.throws(
    () => planUserConfirmedCommit({ repoPath: root, paths: ['next.md'], message: 'docs: bounded payload', publish: true }),
    /prior local commits are unpublished/,
  )
})

test('pause, resume, busy locks, and stale-lock recovery remain machine-local', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  assert.equal(setRepositoryPaused({ repoPath: root, paused: true, reason: 'maintenance' }).state.status, 'paused')
  assert.equal(reconcileRepository({ repoPath: root, fetchAttempts: 1 }).state.status, 'paused')
  assert.equal(setRepositoryPaused({ repoPath: root, paused: false }).state.code, 'resumed')

  const paths = runtimePaths(root)
  const held = acquireRepositoryLock(paths, { operation: 'test-held' })
  assert.equal(held.ok, true)
  assert.equal(acquireRepositoryLock(paths, { operation: 'test-contender' }).code, 'repository-busy')
  held.release()

  fs.mkdirSync(paths.lock)
  assert.equal(acquireRepositoryLock(paths, { operation: 'owner-pending' }).code, 'repository-busy')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(paths.lock, old, old)
  const missingOwnerRecovered = acquireRepositoryLock(paths, { operation: 'recover-missing-owner' })
  assert.equal(missingOwnerRecovered.ok, true)
  missingOwnerRecovered.release()

  fs.mkdirSync(paths.lock)
  fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ lockNonce: 'stale', pid: 99999999, operation: 'dead' }))
  fs.utimesSync(paths.lock, old, old)
  const recovered = acquireRepositoryLock(paths, { operation: 'recover' })
  assert.equal(recovered.ok, true)
  recovered.release()

  fs.mkdirSync(paths.lock)
  const agedAt = new Date(Date.now() - (25 * 60 * 60 * 1000))
  fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ lockNonce: 'reused-pid', pid: process.pid, operation: 'wedged', acquiredAt: agedAt.toISOString() }))
  fs.utimesSync(paths.lock, agedAt, agedAt)
  const reusedPidRecovered = acquireRepositoryLock(paths, { operation: 'recover-reused-pid' })
  assert.equal(reusedPidRecovered.ok, true)
  reusedPidRecovered.release()
})

test('status and reconcile use non-zero process exits for attention and failure', (t) => {
  const { base, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'ahead.md'), 'ahead\n')
  runGit(git, root, ['add', 'ahead.md'])
  runGit(git, root, ['commit', '-m', 'local ahead'])
  const syncCommand = path.resolve('src/commands/sync.mjs')
  const status = spawnSync(process.execPath, [syncCommand, 'status', '--repo', root], { encoding: 'utf8' })
  assert.equal(status.status, 1)
  assert.equal(JSON.parse(status.stdout).state.code, 'local-commits-unpublished')
  runGit(git, root, ['reset', '--hard', 'origin/main'])
  runGit(git, root, ['remote', 'set-url', 'origin', path.join(base, 'missing.git')])
  const reconcile = spawnSync(process.execPath, [syncCommand, 'reconcile', '--repo', root, '--retries', '1'], { encoding: 'utf8' })
  assert.equal(reconcile.status, 1)
  assert.equal(JSON.parse(reconcile.stdout).state.code, 'fetch-unavailable')
})

test('paused status and failed publish commits use non-zero process exits', (t) => {
  const { remote, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const syncCommand = path.resolve('src/commands/sync.mjs')
  setRepositoryPaused({ repoPath: root, paused: true, reason: 'maintenance' })
  const paused = spawnSync(process.execPath, [syncCommand, 'status', '--repo', root], { encoding: 'utf8' })
  assert.equal(paused.status, 1)
  assert.equal(JSON.parse(paused.stdout).state.status, 'paused')
  const pausedReconcile = spawnSync(process.execPath, [syncCommand, 'reconcile', '--repo', root], { encoding: 'utf8' })
  assert.equal(pausedReconcile.status, 1)
  assert.equal(JSON.parse(pausedReconcile.stdout).state.status, 'paused')
  const pausedRun = spawnSync(process.execPath, [syncCommand, 'run', '--once', '--repo', root], { encoding: 'utf8' })
  assert.equal(pausedRun.status, 1)
  assert.equal(JSON.parse(pausedRun.stdout).state.status, 'paused')
  setRepositoryPaused({ repoPath: root, paused: false })

  fs.writeFileSync(path.join(root, 'publish.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['publish.md'], message: 'docs: publish failure exit', publish: true })
  fs.rmSync(remote, { recursive: true, force: true })
  const committed = spawnSync(process.execPath, [syncCommand, 'commit', '--repo', root, '--operation', plan.operationId, '--confirm', plan.operationId], { encoding: 'utf8' })
  assert.equal(committed.status, 1)
  assert.equal(JSON.parse(committed.stdout).committed, true)
  assert.equal(JSON.parse(committed.stdout).publish.ok, false)
})

test('read-only commands do not create runtime state in an unenrolled repository', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-unenrolled-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  runGit(git, base, ['init', '--initial-branch=main'])
  const local = path.join(base, '.atelier-local')
  assert.throws(() => runtimeStatus({ repoPath: base }), /not enrolled/)
  assert.throws(() => operationTrace({ repoPath: base }), /not enrolled/)
  assert.throws(() => setRepositoryPaused({ repoPath: base, paused: true }), /not enrolled/)
  assert.equal(fs.existsSync(local), false)
})

test('runtime state refuses redirected ancestors and leaves outside targets untouched', (t) => {
  const { base, root } = fixture(t)
  const outside = path.join(base, 'outside')
  fs.mkdirSync(outside)
  const local = path.join(root, '.atelier-local')
  try {
    fs.symlinkSync(outside, local, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('symlink privilege unavailable')
    throw error
  }
  assert.throws(
    () => atomicWriteJson(path.join(local, 'runtime', 'state.json'), { unsafe: true }),
    /redirected|non-directory/,
  )
  assert.throws(() => enrollRepository({ repoPath: root, gitExecutable: git }), /Git-ignored|redirected|non-directory/)
  assert.equal(fs.existsSync(path.join(outside, 'runtime', 'enrollment.json')), false)
})

test('runtime state refuses redirected leaves without modifying their targets', (t) => {
  const { base, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const target = path.join(base, 'outside-control.json')
  fs.writeFileSync(target, 'outside\n')
  const control = runtimePaths(root).control
  try {
    fs.symlinkSync(target, control, 'file')
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('symlink privilege unavailable')
    throw error
  }
  assert.throws(() => setRepositoryPaused({ repoPath: root, paused: true }), /regular file/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside\n')
})

test('enrollment remains closed, ignored, untracked, and bound to the inspected system Git', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const enrollmentFile = runtimePaths(root).enrollment
  const original = JSON.parse(fs.readFileSync(enrollmentFile, 'utf8'))

  fs.writeFileSync(enrollmentFile, `${JSON.stringify({ ...original, unsupported: true }, null, 2)}\n`)
  assert.throws(() => runtimeStatus({ repoPath: root }), /unsupported fields/)

  fs.writeFileSync(enrollmentFile, `${JSON.stringify(original, null, 2)}\n`)
  runGit(git, root, ['add', '-f', '.atelier-local/runtime/enrollment.json'])
  assert.throws(() => runtimeStatus({ repoPath: root }), /Git-ignored and untracked/)
  runGit(git, root, ['reset', '--quiet', 'HEAD', '--', '.atelier-local/runtime/enrollment.json'])

  fs.writeFileSync(enrollmentFile, `${JSON.stringify({ ...original, git: { ...original.git, executableSha256: '0'.repeat(64) } }, null, 2)}\n`)
  assert.throws(() => runtimeStatus({ repoPath: root }), /Git identity no longer matches/)

  const substituted = structuredClone(original)
  substituted.git.executable = path.join(root, 'repo-owned-git')
  fs.writeFileSync(enrollmentFile, `${JSON.stringify(substituted, null, 2)}\n`)
  assert.throws(() => runtimeStatus({ repoPath: root }), /trusted Git selection|outside the enrolled repository/)
})

test('enrollment refuses a repository-owned Git executable before executing it', (t) => {
  const { root } = fixture(t)
  const marker = path.join(root, 'repo-git-executed')
  const repoGit = path.join(root, 'repo-owned-git')
  fs.writeFileSync(repoGit, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexit 1\n`)
  fs.chmodSync(repoGit, 0o755)
  assert.throws(() => enrollRepository({ repoPath: root, gitExecutable: repoGit }), /must live outside the repository before it can be inspected/)
  assert.equal(fs.existsSync(marker), false)
})

test('re-enrollment respects the repository lock and preserves a readable trace', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const paths = runtimePaths(root)
  const held = acquireRepositoryLock(paths, { operation: 'held-during-reenroll' })
  assert.equal(held.ok, true)
  assert.throws(() => enrollRepository({ repoPath: root, gitExecutable: git }), /repository is busy/)
  held.release()
  assert.doesNotThrow(() => readOperationTrace(paths.trace))
})

test('a redirected operation lock is refused without writing through its target', (t) => {
  const { base, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const paths = runtimePaths(root)
  const outside = path.join(base, 'outside-lock')
  fs.mkdirSync(outside)
  try {
    fs.symlinkSync(outside, paths.lock, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('symlink privilege unavailable')
    throw error
  }
  assert.throws(() => acquireRepositoryLock(paths, { operation: 'must-refuse' }), /redirected or not a directory/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('a retained confirmation cannot authorize a mutated plan or unsafe operation path', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'notes.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['notes.md'], message: 'docs: reviewed' })
  const original = JSON.parse(fs.readFileSync(planFile(root, plan.operationId), 'utf8'))
  const mutations = [
    (stored) => { stored.message = 'docs: substituted after confirmation' },
    (stored) => { stored.paths = ['substituted.md'] },
    (stored) => { stored.observedHead = '0'.repeat(40) },
    (stored) => { stored.observedStatusDigest = '0'.repeat(64) },
    (stored) => { stored.repoRoot = path.dirname(root) },
    (stored) => { stored.gitExecutable = path.join(root, 'other-git') },
    (stored) => { stored.reviewedManifest[0].worktree.blob = '0'.repeat(40) },
    (stored) => { stored.publish = { remote: 'other', branch: 'main', url: '/tmp/other.git', authentication: 'local' } },
  ]
  for (const mutate of mutations) {
    const stored = structuredClone(original)
    mutate(stored)
    fs.writeFileSync(planFile(root, plan.operationId), `${JSON.stringify(stored, null, 2)}\n`)
    assert.throws(
      () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
      /content does not match/,
    )
  }
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: '../state', confirmation: '../state' }),
    /exact operation confirmation/,
  )
})

test('publish target drift after review is refused before commit or push', (t) => {
  const { base, root } = fixture(t)
  const redirected = path.join(base, 'redirected.git')
  runGit(git, null, ['init', '--bare', redirected])
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'publish.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['publish.md'], message: 'docs: reviewed target', publish: true })
  runGit(git, root, ['remote', 'set-url', 'origin', redirected])
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /publish target changed/,
  )
  assert.equal(runGit(git, root, ['log', '-1', '--format=%s']).stdout.trim(), 'initial')
})

test('push URL drift after review is refused before commit', (t) => {
  const { base, root } = fixture(t)
  const redirected = path.join(base, 'redirected.git')
  runGit(git, null, ['init', '--bare', redirected])
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'publish.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['publish.md'], message: 'docs: reviewed push target', publish: true })
  runGit(git, root, ['remote', 'set-url', '--push', 'origin', redirected])
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /publish target changed/,
  )
  assert.equal(runGit(git, root, ['log', '-1', '--format=%s']).stdout.trim(), 'initial')
})

test('a hook that enlarges the index cannot create or publish an unreviewed commit', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  fs.writeFileSync(path.join(root, 'hook-added.md'), 'must stay out\n')
  const before = head(root)
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: bounded hook test' })
  const hook = path.join(root, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\ngit add hook-added.md\n')
  fs.chmodSync(hook, 0o755)
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /commit tree.*rolled back/,
  )
  assert.equal(head(root), before)
  assert.equal(runGit(git, root, ['diff', '--cached', '--name-only']).stdout, '')
})

test('a partially successful Git add is always compensated back to a clean index', (t) => {
  if (process.platform === 'win32') return t.skip('native Windows exact-process substitution belongs to signed beta evidence')
  const { base, root } = fixture(t)
  const wrapper = path.join(base, 'partial-add-git')
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$4" = "add" ]; then\n  ${JSON.stringify(git)} "$1" "$2" "$3" "$4" "$5" "$6"\n  exit 1\nfi\nexec ${JSON.stringify(git)} "$@"\n`)
  fs.chmodSync(wrapper, 0o755)
  const previous = process.env.ATELIER_GIT_PATH
  process.env.ATELIER_GIT_PATH = wrapper
  t.after(() => {
    if (previous == null) delete process.env.ATELIER_GIT_PATH
    else process.env.ATELIER_GIT_PATH = previous
  })
  enrollRepository({ repoPath: root, gitExecutable: wrapper })
  fs.writeFileSync(path.join(root, 'first.md'), 'first\n')
  fs.writeFileSync(path.join(root, 'second.md'), 'second\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['first.md', 'second.md'], message: 'docs: partial add rollback' })
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /Git --literal-pathspecs failed/,
  )
  assert.equal(runGit(git, root, ['diff', '--cached', '--name-only']).stdout, '')
})

test('configured boundary policy must actually include the enrolled repository', (t) => {
  const { base, root } = fixture(t)
  const other = path.join(base, 'other')
  fs.mkdirSync(other)
  runGit(git, other, ['init', '--initial-branch=main'])
  configure(other)
  fs.writeFileSync(path.join(other, 'README.md'), '# Other\n')
  runGit(git, other, ['add', 'README.md'])
  runGit(git, other, ['commit', '-m', 'other initial'])
  fs.writeFileSync(path.join(root, 'atelier.project.json'), `${JSON.stringify({
    schema: 'mnstry.atelier-project-config@v1',
    name: 'scope-mismatch',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    boundaries: { policyPath: 'boundary-policy.v1.json', governanceLedgerPath: 'governance/repo-boundary-ledger.md', strictNewRepos: true },
    repos: [{ name: 'other', path: '../other', readBoundary: 'team' }],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'repo-access.v1.json'), `${JSON.stringify({ schema: 'mnstry.repo-access@v1', defaultReadBoundary: 'team', repos: { other: { readBoundary: 'team' } } }, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'boundary-policy.v1.json'), `${JSON.stringify({
    schema: 'mnstry.atelier-boundary-policy@v1',
    mode: 'strict',
    actors: {},
    repos: { other: { kind: 'shared', readBoundary: 'team', allowedAudiences: ['team', 'operator', 'staff', 'public'], forbiddenAudiences: ['private', 'sensitive'], autoCommit: 'guarded' } },
    promotion: { requiresGitPromote: true, recordsPath: 'governance/git-promote-events.jsonl' },
    governanceLedgerPath: 'governance/repo-boundary-ledger.md',
  }, null, 2)}\n`)
  enrollRepository({ repoPath: root, projectConfig: 'atelier.project.json', gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: boundary scope' })
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /boundary validation refused.*does not include the enrolled repository/,
  )
  assert.equal(runGit(git, root, ['diff', '--cached', '--name-only']).stdout, '')
})

test('confirmed commit boundary evidence uses only the enrolled Git and strips repository redirection', (t) => {
  if (process.platform === 'win32') return t.skip('native Windows exact-process substitution belongs to signed beta evidence')
  const { base, root } = fixture(t)
  writePrivateBoundaryProject(root, { actorEmail: 'atelier@example.invalid' })
  const pinned = pinWrapperEnvironment(t, { base, root })
  enrollRepository({ repoPath: root, projectConfig: 'atelier.project.json', gitExecutable: pinned.wrapper })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: pinned boundary evidence' })
  fs.writeFileSync(pinned.log, '')
  const result = executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId })
  assert.equal(result.ok, true)
  assert.match(fs.readFileSync(pinned.log, 'utf8'), /config user[.]email/)
  assert.equal(fs.existsSync(pinned.ambientGitMarker), false)
  assert.equal(fs.existsSync(pinned.ghMarker), false)
})

test('confirmed commit suppresses the boundary network actor fallback', (t) => {
  if (process.platform === 'win32') return t.skip('native Windows exact-process substitution belongs to signed beta evidence')
  const { base, root } = fixture(t)
  writePrivateBoundaryProject(root, { actorEmail: 'different@example.invalid' })
  const pinned = pinWrapperEnvironment(t, { base, root })
  enrollRepository({ repoPath: root, projectConfig: 'atelier.project.json', gitExecutable: pinned.wrapper })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: no network actor fallback' })
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /boundary validation refused.*could not verify local actor/,
  )
  assert.equal(fs.existsSync(pinned.ambientGitMarker), false)
  assert.equal(fs.existsSync(pinned.ghMarker), false)
  assert.equal(runGit(git, root, ['diff', '--cached', '--name-only']).stdout, '')
})

test('Sync treats declared private-domain actor uncertainty as blocking in legacy-warning mode', (t) => {
  const { root } = fixture(t)
  writePrivateBoundaryProject(root, { actorEmail: 'different@example.invalid', mode: 'legacy-warning' })
  enrollRepository({ repoPath: root, projectConfig: 'atelier.project.json', gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: actor must be known' })
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /boundary validation refused.*could not verify local actor/,
  )
})

test('Sync never treats repository history as current private-domain actor identity', (t) => {
  const { root } = fixture(t)
  writePrivateBoundaryProject(root, { actorEmail: 'atelier@example.invalid' })
  runGit(git, root, ['config', 'user.email', 'current-operator@example.invalid'])
  enrollRepository({ repoPath: root, projectConfig: 'atelier.project.json', gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: history is not identity' })
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /boundary validation refused.*could not verify local actor/,
  )
})

test('a hook-created parent cannot authorize a commit and the reviewed plan is consumed', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const before = head(root)
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: reviewed parent' })
  const hook = path.join(root, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\ngit commit --no-verify -m "hook commit"\n')
  fs.chmodSync(hook, 0o755)
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /HEAD.*rolled back|parent.*rolled back/,
  )
  assert.equal(head(root), before)
  assert.equal(fs.existsSync(planFile(root, plan.operationId)), false)
})

test('a commit-msg hook cannot substitute the reviewed message', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const before = head(root)
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: exact reviewed message' })
  const hook = path.join(root, '.git', 'hooks', 'commit-msg')
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "%s\\n" "substituted by hook" > "$1"\n')
  fs.chmodSync(hook, 0o755)
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId }),
    /commit message.*rolled back/,
  )
  assert.equal(head(root), before)
  assert.equal(fs.existsSync(planFile(root, plan.operationId)), false)
})

test('a late post-commit HEAD change can never replace the exact reviewed object on the remote', async (t) => {
  if (process.platform === 'win32') return t.skip('native Windows asynchronous hook proof belongs to signed beta evidence')
  const { root, remote } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const remoteBefore = runGit(git, null, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim()
  const { plan } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: exact publish object', publish: true })
  const hook = path.join(root, '.git', 'hooks', 'post-commit')
  const completed = path.join(root, '.git', 'late-head-complete')
  fs.writeFileSync(hook, `#!/bin/sh\nnohup sh -c 'sleep 0.1; rm -f ${JSON.stringify(hook)}; cd ${JSON.stringify(root)}; ${JSON.stringify(git)} commit --allow-empty --no-verify -m late-head; touch ${JSON.stringify(completed)}' >/dev/null 2>&1 &\n`)
  fs.chmodSync(hook, 0o755)
  let result = null
  let failure = null
  try {
    result = executeUserConfirmedCommit({ repoPath: root, operationId: plan.operationId, confirmation: plan.operationId })
  } catch (error) {
    failure = error
  }
  const deadline = Date.now() + 5_000
  while (!fs.existsSync(completed) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(fs.existsSync(completed), true)
  const remoteAfter = runGit(git, null, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim()
  if (result) assert.equal(remoteAfter, result.commit)
  else {
    assert.match(failure.message, /reviewed commit|HEAD changed|rolled back/)
    assert.equal(remoteAfter, remoteBefore)
  }
})

test('commit plans expire, are consumed, and refuse an unbounded resident plan set', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const oldAt = '2026-01-01T00:00:00.000Z'
  const { plan: expired } = planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: expiring plan', clock: () => oldAt })
  assert.throws(
    () => executeUserConfirmedCommit({ repoPath: root, operationId: expired.operationId, confirmation: expired.operationId, clock: () => '2026-01-03T00:00:00.000Z' }),
    /commit plan expired/,
  )
  assert.equal(fs.existsSync(planFile(root, expired.operationId)), false)
  const plans = runtimePaths(root).plans
  for (let index = 0; index < 256; index += 1) fs.writeFileSync(path.join(plans, `resident-${index}.json`), '{}\n')
  assert.throws(
    () => planUserConfirmedCommit({ repoPath: root, paths: ['reviewed.md'], message: 'docs: bounded plans' }),
    /resident ceiling/,
  )
})

test('expired and malformed retained plans are pruned before resident ceilings are enforced', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'reviewed.md'), 'reviewed\n')
  const plans = runtimePaths(root).plans
  for (let index = 0; index < 256; index += 1) {
    fs.writeFileSync(path.join(plans, `expired-${index}.json`), `${JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' })}\n`)
  }
  fs.writeFileSync(path.join(plans, 'oversized.json'), 'x'.repeat((4 * 1024 * 1024) + 1))
  const { plan } = planUserConfirmedCommit({
    repoPath: root,
    paths: ['reviewed.md'],
    message: 'docs: recover bounded plans',
    clock: () => '2026-01-03T00:00:00.000Z',
  })
  assert.equal(fs.existsSync(planFile(root, plan.operationId)), true)
  assert.deepEqual(fs.readdirSync(plans), [`${plan.operationId}.json`])
})

test('post-fast-forward completeness blockers produce attention, not healthy state', (t) => {
  const { base, remote, root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const writer = path.join(base, 'submodule-writer')
  runGit(git, null, ['clone', '--branch', 'main', remote, writer])
  configure(writer)
  const gitlink = head(writer)
  fs.writeFileSync(path.join(writer, '.gitmodules'), '[submodule "missing"]\n\tpath = vendor/missing\n\turl = ../missing.git\n')
  runGit(git, writer, ['add', '.gitmodules'])
  runGit(git, writer, ['update-index', '--add', '--cacheinfo', `160000,${gitlink},vendor/missing`])
  runGit(git, writer, ['commit', '-m', 'add unresolved submodule'])
  runGit(git, writer, ['push', 'origin', 'main'])
  const result = reconcileRepository({ repoPath: root, fetchAttempts: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.state.code, 'repository-incomplete')
  assert.equal(result.state.observation.blockers.some((item) => item.code === 'submodules-incomplete'), true)
})

test('persisted runtime state omits unbounded path evidence and hard-compacts oversized details', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  fs.writeFileSync(path.join(root, 'dirty.md'), 'dirty\n')
  runtimeStatus({ repoPath: root })
  const paths = runtimePaths(root)
  const persisted = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
  assert.equal(Object.hasOwn(persisted.observation, 'schema'), false)
  assert.equal(persisted.observation.sourceSchema, 'atelier-repository-observation@v1')
  assert.equal(Object.hasOwn(persisted.observation.status, 'entries'), false)
  assert.equal(Object.hasOwn(persisted.observation.status, 'fingerprints'), false)
  writeRuntimeState(paths, { status: 'healthy', code: 'oversized', message: 'x'.repeat(600_000), details: {} })
  const compacted = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
  assert.equal(compacted.code, 'runtime-state-resident-ceiling')
  assert.equal(fs.statSync(paths.state).size < 512 * 1024, true)
})

test('reconciliation converts transient observation failures into attention state', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const index = path.join(root, '.git', 'index')
  const indexBytes = fs.readFileSync(index)
  let clockCalls = 0
  const clock = () => {
    clockCalls += 1
    if (clockCalls === 2) {
      fs.unlinkSync(index)
      fs.mkdirSync(index)
    }
    return new Date().toISOString()
  }
  try {
    const result = reconcileRepository({ repoPath: root, fetchAttempts: 1, clock })
    assert.equal(result.ok, false)
    assert.equal(result.state.code, 'observation-failed')
  } finally {
    fs.rmdirSync(index)
    fs.writeFileSync(index, indexBytes)
  }
})

test('resident operation trace checkpoints before crossing its byte ceiling', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const trace = runtimePaths(root).trace
  const large = 'x'.repeat(700_000)
  const truncated = appendOperationTrace(trace, { at: new Date().toISOString(), operation: 'large-1', outcome: 'ok', details: { large } })
  assert.equal(truncated.details.truncated, true)
  const bounded = 'x'.repeat(250_000)
  for (let index = 0; index < 10; index += 1) {
    appendOperationTrace(trace, { at: new Date().toISOString(), operation: `bounded-${index}`, outcome: 'ok', details: { bounded } })
  }
  const records = readOperationTrace(trace)
  assert.equal(records[0].operation, 'trace-checkpoint')
  assert.equal(records.at(-1).operation, 'bounded-9')
})

test('an externally oversized trace recovers to a bounded checkpoint on the next append', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const trace = runtimePaths(root).trace
  fs.writeFileSync(trace, 'x'.repeat((2 * 1024 * 1024) + 1))
  appendOperationTrace(trace, { at: new Date().toISOString(), operation: 'after-oversize', outcome: 'ok', details: {} })
  const records = readOperationTrace(trace)
  assert.equal(records[0].operation, 'trace-checkpoint')
  assert.equal(records[0].outcome, 'recovered')
  assert.equal(records.at(-1).operation, 'after-oversize')
  assert.equal(fs.statSync(trace).size < 2 * 1024 * 1024, true)
})

test('read-only status reports a corrupt trace without rewriting it; the next locked mutation recovers it', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const trace = runtimePaths(root).trace
  fs.appendFileSync(trace, '{"torn":')
  const corrupt = fs.readFileSync(trace)
  const status = runtimeStatus({ repoPath: root })
  assert.equal(status.state.status, 'healthy')
  assert.equal(status.traceLength, null)
  assert.match(status.traceError, /invalid runtime trace/)
  assert.deepEqual(fs.readFileSync(trace), corrupt)
  assert.throws(() => operationTrace({ repoPath: root }), /invalid runtime trace/)
  assert.deepEqual(fs.readFileSync(trace), corrupt)

  setRepositoryPaused({ repoPath: root, paused: true, reason: 'recover under lock' })
  const records = readOperationTrace(trace)
  assert.equal(records[0].operation, 'trace-checkpoint')
  assert.equal(records[0].outcome, 'recovered')
  assert.equal(records.at(-1).operation, 'pause')
})

test('an existing stale-recovery claim blocks deletion of the observed lock', (t) => {
  const { root } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
  const paths = runtimePaths(root)
  fs.mkdirSync(paths.lock)
  atomicWriteJson(path.join(paths.lock, 'owner.json'), { lockNonce: 'stale', pid: 99999999, operation: 'dead' })
  fs.writeFileSync(path.join(paths.lock, 'recovery.claim'), 'other-contender')
  const contender = acquireRepositoryLock(paths, { operation: 'contender' })
  assert.equal(contender.ok, false)
  assert.equal(contender.code, 'repository-busy')
  assert.equal(fs.existsSync(paths.lock), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.lock, 'owner.json'), 'utf8')).lockNonce, 'stale')

  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(path.join(paths.lock, 'recovery.claim'), old, old)
  fs.utimesSync(paths.lock, old, old)
  const recovered = acquireRepositoryLock(paths, { operation: 'recover-abandoned-claim' })
  assert.equal(recovered.ok, true)
  recovered.release()
})
