import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  classifyRemoteAuthentication,
  inspectGitEngine,
  parseGitVersion,
  redactGitDiagnostic,
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
  assert.equal(sanitizeRemoteUrl('git@example.test:org/repo.git'), 'example.test:org/repo.git')
  assert.equal(sanitizeRemoteUrl(['ssh://git:', 'credential@example.test/org/repo.git?', 'to', 'ken=credential'].join('')), 'ssh://example.test/org/repo.git')
  assert.equal(sanitizeRemoteUrl(['vendor://user:', 'credential@example.test/org/repo?', 'to', 'ken=credential'].join('')), 'vendor://example.test/org/repo')
})

test('Git diagnostics redact URL userinfo and credential-shaped values', () => {
  const material = ['sentinel', '-credential'].join('')
  const queryKey = ['to', 'ken'].join('')
  const diagnostic = redactGitDiagnostic(`fatal: https://user:${material}@example.test/repo?${queryKey}=${material} authorization=Bearer-${material} Bearer ${material}`)
  assert.equal(diagnostic.includes(material), false)
  assert.match(diagnostic, /\[redacted\]/)
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

test('Git adapter strips inherited repository and config redirection', (t) => {
  const git = resolveGitExecutable()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-git-env-'))
  const root = path.join(base, 'root')
  const other = path.join(base, 'other')
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  fs.mkdirSync(root)
  fs.mkdirSync(other)
  runGit(git, root, ['init', '--initial-branch=main'])
  runGit(git, other, ['init', '--initial-branch=main'])
  const redirected = {
    ...process.env,
    GIT_DIR: path.join(other, '.git'),
    GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(other, '.git', 'index'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
  }
  assert.equal(runGit(git, root, ['rev-parse', '--show-toplevel'], { env: redirected }).stdout.trim(), fs.realpathSync(root))
  assert.equal(runGit(git, root, ['rev-parse', '--is-bare-repository'], { env: redirected }).stdout.trim(), 'false')
})
