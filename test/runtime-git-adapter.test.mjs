import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  classifyRemoteAuthentication,
  inspectGitEngine,
  parseGitVersion,
  resolveGitExecutable,
  runGit,
  sanitizeRemoteUrl,
} from '../src/runtime/git-adapter.mjs'

test('Git resolver pins one absolute compatible executable', () => {
  const executable = resolveGitExecutable()
  assert.equal(path.isAbsolute(executable), true)
  assert.equal(fs.existsSync(executable), true)
  const engine = inspectGitEngine(executable)
  assert.equal(engine.supported, true)
  assert.match(engine.version, /^\d+\.\d+\.\d+$/)
  assert.equal(resolveGitExecutable({ env: { ...process.env, ATELIER_GIT_PATH: executable } }), executable)
})

test('Git resolver rejects a relative configured executable', () => {
  assert.throws(
    () => resolveGitExecutable({ env: { ...process.env, ATELIER_GIT_PATH: 'git' } }),
    /must be an absolute path/,
  )
})

test('Git version and provider-native authentication shapes stay explicit', () => {
  assert.deepEqual(parseGitVersion('git version 2.50.1.windows.1'), { major: 2, minor: 50, patch: 1, text: 'git version 2.50.1' })
  assert.equal(classifyRemoteAuthentication('https://github.com/example/project.git'), 'https')
  assert.equal(classifyRemoteAuthentication('git@github.com:example/project.git'), 'ssh')
  assert.equal(classifyRemoteAuthentication('ssh://git@github.com/example/project.git'), 'ssh')
  assert.equal(classifyRemoteAuthentication('/tmp/project.git'), 'local')
  assert.equal(classifyRemoteAuthentication('vendor://opaque'), 'unknown')
})

test('recorded HTTPS remotes discard embedded authentication material', () => {
  const sanitized = sanitizeRemoteUrl(['https://collaborator:', 'credential@example.test/org/repo.git#fragment'].join(''))
  assert.equal(sanitized, 'https://example.test/org/repo.git')
  assert.equal(sanitizeRemoteUrl('git@example.test:org/repo.git'), 'git@example.test:org/repo.git')
})

test('Git adapter passes argv directly and handles repository paths with spaces', (t) => {
  const git = resolveGitExecutable()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier git argv '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  runGit(git, root, ['init', '--initial-branch=main'])
  runGit(git, root, ['config', 'user.name', 'Atelier Test'])
  runGit(git, root, ['config', 'user.email', 'atelier@example.invalid'])
  fs.writeFileSync(path.join(root, 'name;$(touch nope).md'), 'literal\n')
  runGit(git, root, ['--literal-pathspecs', 'add', '--', 'name;$(touch nope).md'])
  runGit(git, root, ['commit', '-m', 'literal argv'])
  assert.equal(fs.existsSync(path.join(root, 'nope')), false)
  assert.equal(runGit(git, root, ['status', '--porcelain']).stdout, '')
})
