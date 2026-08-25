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
  assert.match(report.remotes[0].identityDigest, /^[0-9a-f]{64}$/)
  assert.deepEqual(validateRepositoryObservation(report), [])
})

test('remote identity binds the exact configured target without persisting credentials', (t) => {
  const { root } = repository(t)
  const firstMaterial = ['sentinel', '-remote-one'].join('')
  const secondMaterial = ['sentinel', '-remote-two'].join('')
  const queryKey = ['to', 'ken'].join('')
  runGit(git, root, ['remote', 'set-url', 'origin', `https://user:${firstMaterial}@example.test/org/repo.git?${queryKey}=${firstMaterial}`])
  const first = observeRepository({ repoRoot: root, gitExecutable: git })
  runGit(git, root, ['remote', 'set-url', 'origin', `https://user:${secondMaterial}@example.test/org/repo.git?${queryKey}=${secondMaterial}`])
  const second = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(first.remotes[0].url, second.remotes[0].url)
  assert.notEqual(first.remotes[0].identityDigest, second.remotes[0].identityDigest)
  assert.equal(JSON.stringify(first).includes(firstMaterial), false)
  assert.equal(JSON.stringify(second).includes(secondMaterial), false)
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

test('runtime observation validation is exactly contract-backed', (t) => {
  const { root } = repository(t)
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.notDeepEqual(validateRepositoryObservation({ ...report, unexpected: true }), [])
  assert.deepEqual(validateRepositoryObservation({ ...report, root: 'relative/by-contract' }), [])
})

test('configuration evidence is label-only and secrets never enter the observation', (t) => {
  const { root } = repository(t)
  const material = ['sentinel', '-proxy-credential'].join('')
  const option = ['--to', 'ken'].join('')
  runGit(git, root, ['config', 'http.proxy', `https://user:${material}@proxy.example.test`])
  runGit(git, root, ['config', 'filter.private.process', `helper ${option}=${material}`])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  const encoded = JSON.stringify(report)
  assert.equal(encoded.includes(material), false)
  assert.deepEqual(report.features.proxy, [{ key: 'http.proxy' }])
  assert.deepEqual(report.features.customFilters, [{ key: 'filter.private.process' }])
  assert.equal(report.complete, false)
})

test('an over-budget required Git evidence read makes the observation incomplete', (t) => {
  const { root } = repository(t)
  fs.appendFileSync(path.join(root, '.git', 'config'), `\n[oversized]\n\tvalue = ${'x'.repeat(17 * 1024 * 1024)}\n`)
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(report.blockers.some((item) => item.code === 'observation-evidence-unavailable'), true)
})
