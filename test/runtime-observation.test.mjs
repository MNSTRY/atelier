import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveGitExecutable, runGit } from '../src/runtime/git-adapter.mjs'
import {
  ATELIER_REPOSITORY_OBSERVATION_SCHEMA,
  classifyFilesystemRoot,
  observeRepository,
  parsePorcelainStatus,
  validateRepositoryObservation,
} from '../src/runtime/repository-observation.mjs'

const git = resolveGitExecutable()

function repository(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-observation-'))
  const remote = path.join(base, 'remote.git')
  const root = path.join(base, 'workspace')
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  runGit(git, null, ['init', '--bare', remote])
  fs.mkdirSync(root)
  runGit(git, root, ['init', '--initial-branch=main'])
  runGit(git, root, ['config', 'user.name', 'Atelier Test'])
  runGit(git, root, ['config', 'user.email', 'atelier@example.invalid'])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n')
  runGit(git, root, ['add', '.'])
  runGit(git, root, ['commit', '-m', 'initial'])
  runGit(git, root, ['remote', 'add', 'origin', remote])
  runGit(git, root, ['push', '-u', 'origin', 'main'])
  return { base, remote, root }
}

test('full observation proves a normal local clone complete', (t) => {
  const { root } = repository(t)
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.schema, ATELIER_REPOSITORY_OBSERVATION_SCHEMA)
  assert.equal(report.complete, true)
  assert.equal(report.status.clean, true)
  assert.equal(report.branch.branch, 'main')
  assert.equal(report.branch.upstream, 'origin/main')
  assert.equal(report.remotes[0].authentication, 'local')
  assert.deepEqual(validateRepositoryObservation(report), [])
})

test('observation fails closed on sparse and partial workspace state', (t) => {
  const { root } = repository(t)
  runGit(git, root, ['config', 'core.sparseCheckout', 'true'])
  runGit(git, root, ['config', 'remote.origin.promisor', 'true'])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.deepEqual(report.blockers.map((item) => item.code).sort(), ['partial-clone-unsupported', 'sparse-checkout-unsupported'])
})

test('filesystem classifier refuses provider-managed, UNC, and WSL boundary roots before enrollment', () => {
  assert.equal(classifyFilesystemRoot('C:\\Users\\person\\OneDrive\\project', { platform: 'win32' }).code, 'provider-managed-onedrive')
  assert.equal(classifyFilesystemRoot('\\\\server\\share\\project', { platform: 'win32' }).code, 'network-unc-root')
  assert.equal(classifyFilesystemRoot('/mnt/c/accounts/person/project', { platform: 'linux' }).code, 'wsl-cross-boundary-root')
})

test('porcelain parser preserves spaces, renames, and conflict codes without line splitting', () => {
  const parsed = parsePorcelainStatus(' M file with spaces.md\0R  new name.md\0old name.md\0UU conflict.md\0')
  assert.deepEqual(parsed, [
    { code: 'UU', path: 'conflict.md', originalPath: null },
    { code: ' M', path: 'file with spaces.md', originalPath: null },
    { code: 'R ', path: 'new name.md', originalPath: 'old name.md' },
  ])
})
