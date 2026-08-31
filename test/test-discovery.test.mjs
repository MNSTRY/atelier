import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { discoverTests } from '../scripts/run-tests.mjs'
import { resolveNpmCli } from '../scripts/npm-cli.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const testCommand = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-test-discovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (relative, source) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, source)
    return file
  }
  write('scripts/run-tests.mjs', fs.readFileSync(path.join(ROOT, 'scripts/run-tests.mjs')))
  write('package.json', JSON.stringify({ private: true, scripts: { test: testCommand } }))
  fs.mkdirSync(path.join(root, 'test'), { recursive: true })
  return { root, write }
}

function run(root) {
  // Exercise the package command, including Windows npm resolution, not a second selector.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [resolveNpmCli(), 'test', '--', '--test-reporter=tap'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

test('npm test discovers nested tests and excludes non-test executable helpers', (t) => {
  const { root, write } = fixture(t)
  const subtrees = ['', 'alpha', 'beta', 'beta/deep', 'gamma/delta',
    'path with spaces/deep # café']
  for (const [index, subtree] of subtrees.entries()) {
    write(`test/${subtree}/probe.test.mjs`,
      `import test from 'node:test'; test('discovery-probe-${index}', () => {});\n`)
    write(`test/${subtree}/helper.mjs`, "throw new Error('NON_TEST_EXECUTED');\n")
    write(`test/${subtree}/helper.target.mjs`, "throw new Error('NON_TEST_EXECUTED');\n")
    write(`test/${subtree}/not-a-test.js`, "throw new Error('NON_TEST_EXECUTED');\n")
  }
  const found = discoverTests(path.join(root, 'test'))
  assert.equal(found.length, subtrees.length)
  assert.deepEqual(found, [...found].sort())
  const result = run(root)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  for (const index of subtrees.keys()) assert.match(result.stdout, new RegExp(`ok \\d+ - discovery-probe-${index}\\b`))
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /NON_TEST_EXECUTED/)
})

test('a nested failing test makes the actual npm command fail', (t) => {
  const { root, write } = fixture(t)
  write('test/pass.test.mjs', "import test from 'node:test'; test('root-pass', () => {});\n")
  write('test/deep/nested/fail.test.mjs',
    "import test from 'node:test'; test('nested-failure', () => { throw new Error('expected failure'); });\n")
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /not ok \d+ - nested-failure/)
})

test('an empty test tree refuses instead of falling back to unrelated programs', (t) => {
  const { root, write } = fixture(t)
  write('test/helper.mjs', "throw new Error('NON_TEST_EXECUTED');\n")
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No \.test\.mjs files found/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /NON_TEST_EXECUTED/)
})

test('a missing test tree fails clearly', (t) => {
  const { root } = fixture(t)
  fs.rmdirSync(path.join(root, 'test'))
  assert.equal(run(root).status, 1)
})

test('discovery never follows a linked directory outside the test tree', (t) => {
  const { root, write } = fixture(t)
  const local = write('test/pass.test.mjs', 'export {}\n')
  write('outside/hidden.test.mjs', "throw new Error('OUTSIDE_TREE');\n")
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'test', 'linked'), 'junction')
  assert.deepEqual(discoverTests(path.join(root, 'test')), [local])
})
