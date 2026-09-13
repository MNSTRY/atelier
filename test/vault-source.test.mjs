import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareVaultSource } from '../src/vault/source.mjs'
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-vault-source-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'artifacts'))
  fs.writeFileSync(path.join(root, 'artifacts', 'report.html'), '<h1>Synthetic report</h1>')
  fs.writeFileSync(path.join(root, 'private.txt'), 'Must not be selected implicitly')
  return root
}
test('folder and separate checkout layouts produce the same explicit bundle', async t => {
  const repo = fixture(t)
  const a = await prepareVaultSource({ root: path.join(repo, 'artifacts'), paths: ['report.html'], expectedRevision: 0 })
  const separate = fixture(t)
  const b = await prepareVaultSource({ root: path.join(separate, 'artifacts'), paths: ['report.html'], expectedRevision: 0 })
  assert.equal(a.publication, b.publication)
  assert.deepEqual(a.manifest.map(x => x.path), ['report.html'])
  assert.equal(a.request.files.length, 1)
})
test('source selection refuses escape paths, directories, duplicates and symlinks', async t => {
  const repo = fixture(t); const root = path.join(repo, 'artifacts')
  for (const selected of [['../private.txt'], ['/private.txt'], ['report.html', 'report.html'], ['..'], ['.']]) await assert.rejects(prepareVaultSource({ root, paths: selected, expectedRevision: 0 }))
  fs.mkdirSync(path.join(root, 'folder'))
  await assert.rejects(prepareVaultSource({ root, paths: ['folder'], expectedRevision: 0 }))
  try { fs.symlinkSync(path.join(repo, 'private.txt'), path.join(root, 'linked.txt')) }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Symlink scenario unavailable without Windows symlink permission; remaining source checks ran.'); return } throw error }
  await assert.rejects(prepareVaultSource({ root, paths: ['linked.txt'], expectedRevision: 0 }), /symlink/)
})
test('source refuses hard links, oversized files and symlinked ancestors', async t => {
  const root = fixture(t)
  fs.linkSync(path.join(root, 'artifacts/report.html'), path.join(root, 'hard.html'))
  await assert.rejects(prepareVaultSource({ root, paths: ['hard.html'], expectedRevision: 0 }))
  fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(4 * 1024 * 1024 + 1))
  await assert.rejects(prepareVaultSource({ root, paths: ['large.txt'], expectedRevision: 0 }))
  try { fs.symlinkSync(path.join(root, 'artifacts'), path.join(root, 'linked'), 'junction') }
  catch (e) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) { t.diagnostic('Directory symlink creation unavailable'); return } throw e }
  await assert.rejects(prepareVaultSource({ root, paths: ['linked/report.html'], expectedRevision: 0 }), /symlink/)
  await assert.rejects(prepareVaultSource({ root: path.join(root, 'linked'), paths: ['report.html'], expectedRevision: 0 }), /symlink/)
})
