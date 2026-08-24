import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ATELIER_COLLABORATION_EVENT_SCHEMA,
  COLLABORATION_LEDGER_LIMITS,
  createCollaborationEventLedger,
} from '../src/collaboration/event-ledger.mjs'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ledger-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function eventInput(expectedVersion, overrides = {}) {
  return {
    aggregateId: 'proposal-synthetic-one',
    expectedVersion,
    type: expectedVersion === 0 ? 'proposal-created' : 'proposal-reviewed',
    actor: 'actor:synthetic:contributor',
    at: `2025-01-01T00:${String(expectedVersion % 60).padStart(2, '0')}:00Z`,
    payload: { value: 'Synthetic proposal' },
    ...overrides,
  }
}

test('collaboration event ledger returns typed optimistic results', (t) => {
  const root = makeRoot(t)
  const ledger = createCollaborationEventLedger({ workspaceRoot: root })
  const created = ledger.append(eventInput(0))
  assert.equal(created.ok, true)
  const stale = ledger.append(eventInput(0))
  assert.equal(stale.ok, false)
  assert.equal(stale.status, 409)
  const reviewed = ledger.append(eventInput(1))
  assert.equal(reviewed.event.version, 2)
  const events = ledger.eventsFor('proposal-synthetic-one')
  assert.equal(events.ok, true)
  assert.equal(events.events.length, 2)
  assert.equal(events.currentVersion, 2)
  assert.equal(fs.statSync(ledger.ledgerPath).mode & 0o777, 0o600)
})

test('partial corruption is diagnosed and blocks subsequent writes', (t) => {
  const root = makeRoot(t)
  const ledger = createCollaborationEventLedger({ workspaceRoot: root })
  assert.equal(ledger.append(eventInput(0)).ok, true)
  fs.appendFileSync(ledger.ledgerPath, '{truncated\n')
  const before = fs.readFileSync(ledger.ledgerPath)

  const read = ledger.readAll()
  assert.equal(read.ok, false)
  assert.equal(read.status, 422)
  assert.equal(read.events.length, 1)
  assert.equal(read.diagnostics[0].code, 'ledger-json-invalid')
  const append = ledger.append(eventInput(1))
  assert.equal(append.ok, false)
  assert.equal(append.status, 422)
  assert.deepEqual(fs.readFileSync(ledger.ledgerPath), before)
})

test('line ceilings and an active writer lock fail closed', (t) => {
  const root = makeRoot(t)
  const ledger = createCollaborationEventLedger({ workspaceRoot: root, maxLineBytes: 512 })
  const oversized = ledger.append(eventInput(0, { payload: { value: 'x'.repeat(800) } }))
  assert.equal(oversized.status, 413)
  assert.equal(fs.existsSync(ledger.ledgerPath), false)

  fs.writeFileSync(ledger.lockPath, 'other-writer\n', { mode: 0o600 })
  const locked = ledger.append(eventInput(0))
  assert.equal(locked.status, 423)
  assert.match(locked.error, /locked/)

  fs.unlinkSync(ledger.lockPath)
  const byteBound = createCollaborationEventLedger({ workspaceRoot: root, maxLineBytes: 512, maxBytes: 128 })
  const bytesRefused = byteBound.append(eventInput(0))
  assert.equal(bytesRefused.status, 413)
  assert.match(bytesRefused.error, /byte hard ceiling/)

  const countRoot = fs.mkdtempSync(path.join(root, 'count-'))
  const countBound = createCollaborationEventLedger({ workspaceRoot: countRoot, maxEvents: 1 })
  assert.equal(countBound.append(eventInput(0)).ok, true)
  const countRefused = countBound.append(eventInput(0, { aggregateId: 'proposal-synthetic-two' }))
  assert.equal(countRefused.status, 413)
  assert.match(countRefused.error, /event hard ceiling/)
})

test('explicit compaction retains bounded aggregate history and its latest version', (t) => {
  const root = makeRoot(t)
  const ledger = createCollaborationEventLedger({ workspaceRoot: root })
  for (let version = 0; version < 60; version += 1) {
    const result = ledger.append(eventInput(version))
    assert.equal(result.ok, true, result.error)
  }
  const compacted = ledger.compact({ now: '2026-08-25T00:00:00Z' })
  assert.equal(compacted.ok, true)
  assert.ok(compacted.after <= COLLABORATION_LEDGER_LIMITS.retainPerAggregate)
  assert.ok(compacted.removed > 0)
  const retained = ledger.eventsFor('proposal-synthetic-one')
  assert.equal(retained.ok, true)
  assert.equal(retained.events[0].version, 1)
  assert.equal(retained.currentVersion, 60)
  const next = ledger.append(eventInput(60, { at: '2026-08-25T01:00:00Z' }))
  assert.equal(next.ok, true, next.error)
  assert.equal(next.event.version, 61)
})

test('ten-thousand-event synthetic ledger reads within the target budget', (t) => {
  const root = makeRoot(t)
  const ledger = createCollaborationEventLedger({ workspaceRoot: root })
  const lines = []
  for (let index = 0; index < COLLABORATION_LEDGER_LIMITS.maxEvents; index += 1) {
    lines.push(JSON.stringify({
      schema: ATELIER_COLLABORATION_EVENT_SCHEMA,
      id: `event-${index.toString(16).padStart(32, '0')}`,
      aggregateId: `aggregate-${index}`,
      version: 1,
      type: 'proposal-created',
      actor: 'synthetic-reader',
      at: '2026-08-25T00:00:00Z',
      payload: {},
    }))
  }
  fs.writeFileSync(ledger.ledgerPath, `${lines.join('\n')}\n`, { mode: 0o600 })
  const result = ledger.readAll()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.events.length, COLLABORATION_LEDGER_LIMITS.maxEvents)
  assert.ok(result.stats.durationMs < 500, `read took ${result.stats.durationMs.toFixed(1)}ms`)
})
