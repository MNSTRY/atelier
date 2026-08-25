import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveGitExecutable, runGit } from '../src/runtime/git-adapter.mjs'
import { acquireRepositoryLock, readOperationTrace, runtimePaths } from '../src/runtime/local-state.mjs'
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
