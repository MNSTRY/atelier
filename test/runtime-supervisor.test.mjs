import assert from 'node:assert/strict'
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
} from '../src/runtime/local-state.mjs'
import {
  enrollRepository,
  executeUserConfirmedCommit,
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
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  runGit(git, null, ['init', '--bare', remote])
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

test('user-confirmed commit stages only reviewed files and can publish through the declared upstream', (t) => {
  const { root, remote } = fixture(t)
  enrollRepository({ repoPath: root, gitExecutable: git })
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
  const trace = readOperationTrace(runtimePaths(root).trace)
  assert.deepEqual(trace.map((item) => item.operation), ['enroll', 'commit-plan-created', 'commit-created', 'commit-publish'])
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
  const recovered = acquireRepositoryLock(paths, { operation: 'recover' })
  assert.equal(recovered.ok, true)
  recovered.release()
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
})
