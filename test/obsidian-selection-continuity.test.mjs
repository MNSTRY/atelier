import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inspectPrivateLock, withPrivateLock } from '../src/project/durable-state.mjs'
import { createSelectionContinuity, MAX_SELECTION_CONTINUITY_BYTES, MAX_SELECTION_IDENTITIES } from '../src/runtime/obsidian/selection-continuity.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const refused = (code) => (error) => error.code === code
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-selection-state-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const options = { workspaceRoot: root, workspaceId: 'workspace-synthetic', personalHome: path.join(root, 'personal-home') }
  const file = path.join(root, 'state', 'maintenance', 'selection-continuity.json')
  const lock = path.join(root, 'state', 'maintenance', 'selection-continuity.lock')
  const store = () => createSelectionContinuity(options)
  return { root, file, lock, store, options }
}
function head(labels, { legacy = false } = {}) {
  const recordDigests = labels.map(hash)
  const confirmationIds = legacy ? [] : labels.map(() => randomUUID())
  return { selected: labels.length ? hash('synthetic-generation') : null, sequence: labels.length,
    head: recordDigests.at(-1) ?? 'genesis', confirmationId: confirmationIds.at(-1) ?? null, recordDigests, confirmationIds }
}

test('the highest sequence survives a fresh store and shortening requires a fresh identity, including after an accepted reset', (t) => {
  const f = fixture(t)
  const initial = head(['a', 'b', 'c', 'd'])
  f.store().note(initial)
  assert.throws(() => f.store().note(head(['a'])), refused('selection-history-shortened'))
  // The identity is new to the store but the old second record was already observed as part of the full history.
  assert.throws(() => f.store().note(head(['a', 'b'])), refused('selection-history-shortened'))
  const confirmed = head(['a', 'fresh'])
  f.store().note(confirmed)
  f.store().note(confirmed)
  let state = JSON.parse(fs.readFileSync(f.file))
  assert.equal(state.highestSequence, 4)
  assert.equal(state.accepted.sequence, 2)
  assert.throws(() => f.store().note(head(['a', 'b', 'c'])), refused('selection-history-shortened'))
  f.store().note(head(['a', 'fresh', 'next']))
  state = JSON.parse(fs.readFileSync(f.file))
  assert.equal(state.highestSequence, 4, 'normal appends never discard the historical maximum')
  assert.equal(state.accepted.sequence, 3)
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
})

test('after an accepted shortening, a divergent head at or above the historical maximum needs a fresh confirmation', (t) => {
  const f = fixture(t)
  const original = head(['a', 'b', 'c', 'd'])
  f.store().note(original)
  f.store().note(head(['a', 'fresh']))
  // The complete earlier history is restored, but it no longer contains the accepted head.
  assert.throws(() => f.store().note(original), refused('selection-history-shortened'))
  assert.throws(() => f.store().note(head(['a', 'b', 'c', 'other'], { legacy: true })), refused('selection-history-shortened'))
  const reusedAbove = { ...head(['a', 'b', 'c', 'd', 'e']), confirmationId: original.confirmationId, confirmationIds: original.confirmationIds }
  assert.throws(() => f.store().note(reusedAbove), refused('selection-history-shortened'))
  assert.throws(() => f.store().note(head(['a', 'b', 'c', 'd', 'e'], { legacy: true })), refused('selection-history-shortened'))
  let state = JSON.parse(fs.readFileSync(f.file))
  assert.deepEqual(state.accepted, { sequence: 2, head: hash('fresh') })
  // Continuing the accepted chain past the maximum remains an ordinary append, legacy records included.
  f.store().note(head(['a', 'fresh', 'x', 'y', 'z'], { legacy: true }))
  state = JSON.parse(fs.readFileSync(f.file))
  assert.equal(state.accepted.sequence, 5)
  assert.equal(state.highestSequence, 5)
  // A genuinely fresh confirmation still authorizes a divergent replacement.
  f.store().note(head(['a', 'b', 'c', 'd', 'e', 'confirmed']))
})

test('exact restoration of a temporarily shortened history is accepted without a new confirmation', (t) => {
  const f = fixture(t)
  const original = head(['a', 'b', 'c'])
  f.store().note(original)
  assert.throws(() => f.store().note(head(['a'], { legacy: true })), refused('selection-history-shortened'))
  f.store().note(original)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).accepted.sequence, 3)
})

test('equal sequence alone cannot authorize a replacement, while a genuine new confirmation can', (t) => {
  const f = fixture(t)
  const first = head(['a', 'b'])
  f.store().note(first)
  const reused = { ...head(['a', 'changed-bytes']), confirmationId: first.confirmationId, confirmationIds: first.confirmationIds }
  assert.throws(() => f.store().note(reused), refused('selection-history-shortened'))
  assert.throws(() => f.store().note(head(['a', 'replaced'], { legacy: true })), refused('selection-history-shortened'))
  f.store().note(head(['a', 'confirmed']))
  assert.throws(() => f.store().note(head(['a', 'b'])), refused('selection-history-shortened'))
})

test('legacy histories initialize and append, but a changed legacy head below the maximum cannot accept shortening', (t) => {
  const f = fixture(t)
  f.store().note(head(['a', 'b'], { legacy: true }))
  f.store().note(head(['a', 'b', 'c'], { legacy: true }))
  assert.throws(() => f.store().note(head(['a', 'different'], { legacy: true })), refused('selection-history-shortened'))
  f.store().note(head(['a', 'new-confirmation']))
})

test('empty history refuses after any confirmation, and an unchanged checkpoint is never rewritten', (t) => {
  const f = fixture(t)
  const store = f.store()
  store.note(head([]))
  const empty = fs.readFileSync(f.file)
  store.note(head([]))
  assert.deepEqual(fs.readFileSync(f.file), empty)
  store.note(head(['a']))
  assert.throws(() => store.note(head([])), refused('selection-history-shortened'))
})

for (const damage of ['json', 'schema', 'workspace', 'home', 'extra', 'maximum', 'seen', 'oversized', 'symlink', 'directory']) {
  test(`damaged private checkpoint refuses before adoption: ${damage}`, (t) => {
    const f = fixture(t)
    const selected = head(['a', 'b'])
    f.store().note(selected)
    const value = JSON.parse(fs.readFileSync(f.file))
    if (damage === 'json') fs.writeFileSync(f.file, '{')
    else if (damage === 'oversized') fs.writeFileSync(f.file, ' '.repeat(MAX_SELECTION_CONTINUITY_BYTES + 1))
    else if (damage === 'symlink') { fs.renameSync(f.file, `${f.file}.kept`); fs.symlinkSync(`${f.file}.kept`, f.file) }
    else if (damage === 'directory') { fs.unlinkSync(f.file); fs.mkdirSync(f.file) }
    else {
      if (damage === 'schema') value.schema = 'unrecognized'
      if (damage === 'workspace') value.workspaceId = 'other-workspace'
      if (damage === 'home') value.homeDigest = hash('another-home')
      if (damage === 'extra') value.extra = true
      if (damage === 'maximum') value.highestSequence = -1
      if (damage === 'seen') value.seen = []
      fs.writeFileSync(f.file, JSON.stringify(value))
    }
    assert.throws(() => f.store().note(selected), refused('invalid-selection-continuity'))
  })
}

test('a checkpoint removed after this reader observed it is refused', (t) => {
  const f = fixture(t)
  const store = f.store()
  const selected = head(['a'])
  store.note(selected)
  fs.unlinkSync(f.file)
  assert.throws(() => store.note(selected), refused('invalid-selection-continuity'))
})

test('genuine first use initializes under its first ownership ticket and unchanged reads take no new ticket', (t) => {
  const f = fixture(t)
  assert.equal(inspectPrivateLock(f.lock).reason, 'unused')
  const selected = head(['a', 'b'])
  f.store().note(selected)
  assert.deepEqual([inspectPrivateLock(f.lock).reason, inspectPrivateLock(f.lock).generation], ['released', 1])
  f.store().note(selected)
  assert.equal(inspectPrivateLock(f.lock).generation, 1)
})

const assertMissingCheckpointRefuses = (initialize) => assert.throws(initialize, refused('invalid-selection-continuity'))

test('a new store refuses a removed checkpoint while prior released ownership remains', (t) => {
  const f = fixture(t)
  f.store().note(head(['a', 'b', 'c']))
  fs.unlinkSync(f.file)
  assert.equal(inspectPrivateLock(f.lock).reason, 'released')
  assertMissingCheckpointRefuses(() => f.store().note(head(['a'])))
  assert.equal(fs.existsSync(f.file), false)
  assert.equal(inspectPrivateLock(f.lock).generation, 1, 'refusal does not acquire a new ticket')
})

test('mutation control: removing all ownership evidence defeats the missing-checkpoint oracle', (t) => {
  const f = fixture(t)
  f.store().note(head(['a', 'b', 'c']))
  fs.unlinkSync(f.file)
  const initialize = () => f.store().note(head(['a']))
  assertMissingCheckpointRefuses(initialize)
  // All continuity evidence gone is indistinguishable from first installation; the oracle must detect its acceptance.
  fs.rmSync(`${f.lock}.owners`, { recursive: true })
  assert.throws(() => assertMissingCheckpointRefuses(initialize), assert.AssertionError)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).highestSequence, 1)
})

test('a prior ownership generation without a checkpoint cannot be adopted as first use', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.dirname(f.lock), { recursive: true, mode: 0o700 })
  withPrivateLock(f.lock, () => {})
  assertMissingCheckpointRefuses(() => f.store().note(head(['a'])))
  assert.equal(fs.existsSync(f.file), false)
})

test('a failed first replacement leaves ownership evidence that a fresh store cannot ignore', (t) => {
  const f = fixture(t)
  const original = fs.renameSync
  fs.renameSync = function (from, to) {
    if (to === f.file) throw Object.assign(new Error('synthetic initial write refusal'), { code: 'EIO' })
    return original.call(this, from, to)
  }
  try { assert.throws(() => f.store().note(head(['a', 'b', 'c'])), refused('selection-continuity-unavailable')) }
  finally { fs.renameSync = original }
  assert.deepEqual([fs.existsSync(f.file), inspectPrivateLock(f.lock).reason], [false, 'released'])
  assertMissingCheckpointRefuses(() => f.store().note(head(['a'])))
})

test('a failed durable write returns no authority and the same process keeps the observed maximum', (t) => {
  const f = fixture(t)
  const store = f.store()
  store.note(head(['a', 'b']))
  const previous = fs.readFileSync(f.file)
  const original = fs.renameSync
  fs.renameSync = function (from, to) {
    if (to === f.file) throw Object.assign(new Error('synthetic write refusal'), { code: 'EIO' })
    return original.call(this, from, to)
  }
  try { assert.throws(() => store.note(head(['a', 'b', 'c'])), refused('selection-continuity-unavailable')) }
  finally { fs.renameSync = original }
  assert.deepEqual(fs.readFileSync(f.file), previous)
  assert.throws(() => store.note(head(['a', 'b'])), refused('selection-history-shortened'))
  store.note(head(['a', 'b', 'c']))
  assert.equal(JSON.parse(fs.readFileSync(f.file)).highestSequence, 3)
})

test('the observed identity budget fails closed without replacing the last checkpoint', (t) => {
  const f = fixture(t)
  const store = f.store()
  store.note(head(['a']))
  const previous = fs.readFileSync(f.file)
  assert.throws(() => store.note(head(Array.from({ length: MAX_SELECTION_IDENTITIES + 1 }, (_, index) => `record-${index}`))), refused('selection-continuity-capacity'))
  assert.deepEqual(fs.readFileSync(f.file), previous)
})
