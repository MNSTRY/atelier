// Authored source only. Uses the existing store and disposable local Git fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCoauthorStore } from '../src/coauthor/store.mjs'
import { contentDigest } from '../src/coauthor/session.mjs'
function setup(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'owning-readback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0)
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'packet.md'), 'Invented source')
  const store = createCoauthorStore({ workspaceRoot: root })
  store.start({ id: 'saved-case', fields: [{ id: 'words', source: { ref: 'packet.md', digest: contentDigest('Invented source') } }] })
  store.dispatch('saved-case', { id: 'original-answer', type: 'answer', expectedRevision: 0, text: 'Exact retained words' })
  const state = store.dispatch('saved-case', { id: 'original-save', type: 'save', expectedRevision: 1 })
  const file = path.join(root, '.atelier-local/coauthor/values', contentDigest('saved-case'), contentDigest('original-save') + '.json')
  return { root, store, state, file }
}
test('existing values and event chain agree after store restart; no append', t => {
  const s = setup(t), ledger = path.join(s.root, '.atelier-local/coauthor/events.ndjson')
  const before = fs.readFileSync(ledger), value = fs.readFileSync(s.file)
  const actual = createCoauthorStore({ workspaceRoot: s.root }).readSavedFields('saved-case')
  assert.deepEqual(actual.state, s.state)
  assert.equal(actual.values[0].text, 'Exact retained words')
  assert.deepEqual(actual.values[0].receipt, s.state.saved[0].receipt)
  assert.deepEqual(fs.readFileSync(ledger), before)
  assert.deepEqual(fs.readFileSync(s.file), value)
})
for (const kind of ['tampered', 'missing', 'redirected-file', 'redirected-directory']) test('owning saved readback refuses ' + kind + ' and does not repair it', t => {
  const s = setup(t), retained = s.file + '.retained'
  const ledger = path.join(s.root, '.atelier-local/coauthor/events.ndjson'), before = fs.readFileSync(ledger)
  if (kind === 'tampered') {
    const value = JSON.parse(fs.readFileSync(s.file, 'utf8')); value.text = 'Changed words'
    fs.writeFileSync(s.file, JSON.stringify(value))
  } else if (kind === 'missing') fs.renameSync(s.file, retained)
  else if (kind === 'redirected-file') {
    fs.renameSync(s.file, retained); fs.symlinkSync(retained, s.file)
  } else {
    const dir = path.dirname(s.file); fs.renameSync(dir, dir + '.retained'); fs.symlinkSync(dir + '.retained', dir, 'dir')
  }
  assert.throws(() => s.store.readSavedFields('saved-case'))
  assert.deepEqual(fs.readFileSync(ledger), before)
  if (kind === 'missing') assert.equal(fs.existsSync(s.file), false)
  if (kind === 'tampered') assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).text, 'Changed words')
  if (kind === 'redirected-file') assert.equal(fs.lstatSync(s.file).isSymbolicLink(), true)
  if (kind === 'redirected-directory') assert.equal(fs.lstatSync(path.dirname(s.file)).isSymbolicLink(), true)
})

test('same parsed value with changed serialized bytes refuses immutable readback', t => {
  const s = setup(t), before = fs.readFileSync(s.file, 'utf8')
  fs.writeFileSync(s.file, before + '\n')
  assert.throws(() => s.store.readSavedFields('saved-case'), /differs/)
  assert.equal(fs.readFileSync(s.file, 'utf8'), before + '\n')
})
