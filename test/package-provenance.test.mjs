import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  inspectPackageProvenance,
  legacyPackageSource,
  safeRepository,
} from '../src/upgrade/provenance.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-origin-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function pkg(root) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@sample/kit',
      version: '1.0.0',
      repository: { url: 'https://example.invalid/sample/kit.git' },
    }),
  )
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export const value = 1\n')
}
function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function init(root) {
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Sample Author'])
  git(root, ['config', 'user.email', 'sample@example.invalid'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'synthetic source'])
}
test('own clean checkout binds tracked source; modified or ignored files refuse verification', (t) => {
  const root = fixture(t)
  pkg(root)
  init(root)
  const clean = inspectPackageProvenance(root)
  assert.equal(clean.sourceVerified, true)
  assert.equal(clean.trackedGitSha, git(root, ['rev-parse', 'HEAD']))
  fs.appendFileSync(path.join(root, 'index.mjs'), '// edit\n')
  const modified = inspectPackageProvenance(root)
  assert.equal(modified.sourceVerified, false)
  assert.notEqual(modified.inventory.digest, clean.inventory.digest)
  git(root, ['checkout', '--', 'index.mjs'])
  fs.writeFileSync(path.join(root, '.gitignore'), 'private-output\n')
  git(root, ['add', '.gitignore'])
  git(root, ['commit', '-m', 'ignore output'])
  fs.writeFileSync(path.join(root, 'private-output'), 'generated content')
  assert.equal(inspectPackageProvenance(root).sourceVerified, false)
})
test('consumer HEAD is never the installed package origin; npm Git metadata remains declared', (t) => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, 'README.md'), 'consumer')
  init(root)
  const installed = path.join(root, 'node_modules/@sample/kit')
  pkg(installed)
  const sha = 'a'.repeat(40)
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/@sample/kit': {
          resolved: `git+https://example.invalid/sample/kit.git#${sha}`,
        },
      },
    }),
  )
  const report = inspectPackageProvenance(installed)
  assert.equal(report.trackedGitSha, null)
  assert.equal(report.level, 'declared')
  assert.equal(report.sourceVerified, false)
  assert.equal(legacyPackageSource(report).gitSha, sha)
  fs.appendFileSync(
    path.join(installed, 'index.mjs'),
    '// changed installed bytes\n',
  )
  const changed = inspectPackageProvenance(installed)
  assert.notEqual(changed.inventory.digest, report.inventory.digest)
  assert.equal(changed.sourceVerified, false)
})
test('conflicting lock declarations and unsupported stores remain unresolved', (t) => {
  const root = fixture(t)
  const installed = path.join(root, 'node_modules/@sample/kit')
  pkg(installed)
  for (const [file, sha] of [
    ['package-lock.json', 'a'],
    ['npm-shrinkwrap.json', 'b'],
  ])
    fs.writeFileSync(
      path.join(root, file),
      JSON.stringify({
        packages: {
          'node_modules/@sample/kit': {
            resolved: `git+https://example.invalid/kit#${sha.repeat(40)}`,
          },
        },
      }),
    )
  assert.equal(inspectPackageProvenance(installed).level, 'unresolved')
  const store = path.join(root, 'store/kit')
  pkg(store)
  assert.equal(inspectPackageProvenance(store).level, 'unresolved')
  assert.equal(
    legacyPackageSource(inspectPackageProvenance(store)).type,
    'local_path',
  )
})
test('origin metadata strips userinfo and parameters; symlink inventory fails closed', (t) => {
  const url = new URL(
    'https://sample:example-value@example.invalid/kit.git?credential=omitted',
  )
  assert.equal(safeRepository(url.href), 'https://example.invalid/kit.git')
  const root = fixture(t)
  pkg(root)
  fs.symlinkSync('index.mjs', path.join(root, 'linked.mjs'))
  const report = inspectPackageProvenance(root)
  assert.equal(report.inventory, null)
  assert.equal(report.sourceVerified, false)
  assert.equal(safeRepository('file:local-directory'), null)
})
test('index hints cannot qualify modified installed bytes as exact source', (t) => {
  const root = fixture(t)
  pkg(root)
  init(root)
  git(root, ['update-index', '--assume-unchanged', 'index.mjs'])
  fs.appendFileSync(path.join(root, 'index.mjs'), '// local alteration\n')
  assert.equal(git(root, ['status', '--porcelain']), '')
  assert.equal(inspectPackageProvenance(root).sourceVerified, false)
})
test('nested instance metadata and symlink slots never borrow another installation origin', (t) => {
  const root = fixture(t),
    first = path.join(root, 'node_modules/@sample/kit'),
    nested = path.join(root, 'node_modules/consumer/node_modules/@sample/kit')
  pkg(first)
  pkg(nested)
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      packages: {
        'node_modules/@sample/kit': {
          resolved: 'https://example.invalid/kit-1.tgz',
          integrity: 'sha512-' + Buffer.from('example-one').toString('base64'),
        },
        'node_modules/consumer/node_modules/@sample/kit': {
          resolved: 'git+https://example.invalid/kit#' + 'b'.repeat(40),
        },
      },
    }),
  )
  assert.equal(inspectPackageProvenance(first).declared[0].kind, 'npm')
  assert.equal(
    inspectPackageProvenance(nested).declared[0].gitSha,
    'b'.repeat(40),
  )
  const linked = path.join(root, 'node_modules/linked-kit')
  fs.symlinkSync(first, linked)
  assert.equal(inspectPackageProvenance(linked).sourceVerified, false)
  assert.equal(inspectPackageProvenance(linked).level, 'unresolved')
})
