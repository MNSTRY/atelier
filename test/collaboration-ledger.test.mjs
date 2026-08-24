import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCollaborationEventLedger } from '../src/collaboration/event-ledger.mjs'

test('collaboration event ledger is append-only, private, and optimistic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ledger-'))
  try {
    const ledger = createCollaborationEventLedger({ workspaceRoot: root })
    const created = ledger.append({
      aggregateId: 'proposal-synthetic-one',
      expectedVersion: 0,
      type: 'proposal-created',
      actor: 'actor:synthetic:contributor',
      at: '2026-08-24T00:00:00Z',
      payload: { value: 'Synthetic proposal' },
    })
    assert.equal(created.ok, true)
    const stale = ledger.append({
      aggregateId: 'proposal-synthetic-one',
      expectedVersion: 0,
      type: 'proposal-reviewed',
      actor: 'actor:synthetic:reviewer',
      at: '2026-08-24T01:00:00Z',
      payload: { status: 'reviewed' },
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.status, 409)
    const reviewed = ledger.append({
      aggregateId: 'proposal-synthetic-one',
      expectedVersion: 1,
      type: 'proposal-reviewed',
      actor: 'actor:synthetic:reviewer',
      at: '2026-08-24T01:00:00Z',
      payload: { status: 'reviewed' },
    })
    assert.equal(reviewed.event.version, 2)
    assert.equal(ledger.eventsFor('proposal-synthetic-one').length, 2)
    assert.equal(fs.statSync(ledger.ledgerPath).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
