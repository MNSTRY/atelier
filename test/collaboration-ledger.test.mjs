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
import { createProposalStore } from '../src/collaboration/proposals.mjs'

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

test('read-side ceilings, duplicate ids, and non-advancing versions block mutations', (t) => {
  const root = makeRoot(t)

  const oversizedRoot = fs.mkdtempSync(path.join(root, 'oversized-line-'))
  const oversized = createCollaborationEventLedger({ workspaceRoot: oversizedRoot, maxLineBytes: 512 })
  fs.writeFileSync(oversized.ledgerPath, `${'x'.repeat(513)}\n`, { mode: 0o600 })
  const oversizedBefore = fs.readFileSync(oversized.ledgerPath)
  assert.equal(oversized.readAll().diagnostics[0].code, 'ledger-line-limit')
  assert.equal(oversized.append(eventInput(0)).status, 422)
  assert.equal(oversized.compact().status, 422)
  assert.deepEqual(fs.readFileSync(oversized.ledgerPath), oversizedBefore)

  const byteRoot = fs.mkdtempSync(path.join(root, 'byte-limit-'))
  const byteBound = createCollaborationEventLedger({ workspaceRoot: byteRoot, maxBytes: 128 })
  fs.writeFileSync(byteBound.ledgerPath, Buffer.alloc(129, 0x20), { mode: 0o600 })
  assert.equal(byteBound.readAll().status, 413)
  assert.equal(byteBound.append(eventInput(0)).status, 413)
  assert.equal(byteBound.compact().status, 413)

  const countRoot = fs.mkdtempSync(path.join(root, 'read-count-'))
  const writer = createCollaborationEventLedger({ workspaceRoot: countRoot, maxEvents: 2 })
  assert.equal(writer.append(eventInput(0)).ok, true)
  assert.equal(writer.append(eventInput(0, { aggregateId: 'proposal-synthetic-two' })).ok, true)
  const countBound = createCollaborationEventLedger({ workspaceRoot: countRoot, maxEvents: 1 })
  assert.equal(countBound.readAll().diagnostics[0].code, 'ledger-event-limit')
  assert.equal(countBound.append(eventInput(1)).status, 422)
  assert.equal(countBound.compact().status, 422)

  function assertCorruptSequence(code, mutate) {
    const sequenceRoot = fs.mkdtempSync(path.join(root, `${code}-`))
    const ledger = createCollaborationEventLedger({ workspaceRoot: sequenceRoot })
    assert.equal(ledger.append(eventInput(0)).ok, true)
    assert.equal(ledger.append(eventInput(1)).ok, true)
    const events = fs.readFileSync(ledger.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse)
    mutate(events)
    fs.writeFileSync(ledger.ledgerPath, `${events.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 })
    const before = fs.readFileSync(ledger.ledgerPath)
    assert.ok(ledger.readAll().diagnostics.some((item) => item.code === code))
    assert.equal(ledger.append(eventInput(2)).status, 422)
    assert.equal(ledger.compact().status, 422)
    assert.deepEqual(fs.readFileSync(ledger.ledgerPath), before)
  }

  assertCorruptSequence('ledger-event-duplicate', (events) => { events[1].id = events[0].id })
  assertCorruptSequence('ledger-version-order', (events) => { events[1].version = events[0].version })
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

test('compaction preserves aggregate version order when timestamps regress', (t) => {
  const root = makeRoot(t)
  const ledger = createCollaborationEventLedger({ workspaceRoot: root })
  assert.equal(ledger.append(eventInput(0, { at: '2030-01-01T00:00:00Z' })).ok, true)
  assert.equal(ledger.append(eventInput(1, { at: '2020-01-01T00:00:00Z' })).ok, true)
  assert.equal(ledger.append(eventInput(0, {
    aggregateId: 'proposal-synthetic-two',
    at: '2025-01-01T00:00:00Z',
  })).ok, true)

  const compacted = ledger.compact({ now: '2031-01-01T00:00:00Z' })
  assert.equal(compacted.ok, true, compacted.error)
  const reread = ledger.readAll()
  assert.equal(reread.ok, true, reread.error)
  assert.deepEqual(
    reread.events.filter((event) => event.aggregateId === 'proposal-synthetic-one').map((event) => event.version),
    [1, 2],
  )
  assert.equal(ledger.append(eventInput(2, { at: '2010-01-01T00:00:00Z' })).ok, true)
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

test('proposal listing materializes the ten-thousand-event ceiling from one ledger read', (t) => {
  const root = makeRoot(t)
  const proposalsDir = path.join(root, '.atelier-proposals')
  const store = createProposalStore({ workspaceRoot: root, proposalsDir })
  const lines = []
  for (let index = 0; index < COLLABORATION_LEDGER_LIMITS.maxEvents; index += 1) {
    const id = `proposal-${index.toString(16).padStart(32, '0')}`
    lines.push(JSON.stringify({
      schema: ATELIER_COLLABORATION_EVENT_SCHEMA,
      id: `event-${index.toString(16).padStart(32, '0')}`,
      aggregateId: id,
      version: 1,
      type: 'proposal-created',
      actor: 'synthetic-reader',
      at: '2026-08-25T00:00:00Z',
      payload: {
        record: {
          schema: 'atelier-proposal@v1',
          proposal: { id, status: 'proposed', updatedAt: '2026-08-25T00:00:00Z' },
        },
      },
    }))
  }
  fs.writeFileSync(path.join(proposalsDir, 'events.ndjson'), `${lines.join('\n')}\n`, { mode: 0o600 })

  const startedAt = performance.now()
  const listed = store.listProposals()
  const durationMs = performance.now() - startedAt
  assert.equal(listed.ok, true, listed.error)
  assert.equal(listed.proposals.length, COLLABORATION_LEDGER_LIMITS.maxEvents)
  assert.ok(durationMs < 1500, `proposal listing took ${durationMs.toFixed(1)}ms`)
})

test('ledger and proposal snapshot leaf symlinks fail closed without outside reads or writes', (t) => {
  const root = makeRoot(t)
  const proposalsDir = path.join(root, '.atelier-proposals')
  fs.mkdirSync(proposalsDir, { recursive: true })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ledger-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))

  const outsideLedger = path.join(outside, 'events.ndjson')
  fs.writeFileSync(outsideLedger, 'outside ledger sentinel\n')
  fs.symlinkSync(outsideLedger, path.join(proposalsDir, 'events.ndjson'))
  const ledger = createCollaborationEventLedger({ workspaceRoot: root })
  assert.equal(ledger.readAll().ok, false)
  assert.equal(ledger.append(eventInput(0)).ok, false)
  assert.equal(fs.readFileSync(outsideLedger, 'utf8'), 'outside ledger sentinel\n')

  fs.unlinkSync(path.join(proposalsDir, 'events.ndjson'))
  const outsideSnapshot = path.join(outside, 'proposal-external.json')
  fs.writeFileSync(outsideSnapshot, '{"secret":"outside snapshot sentinel"}\n')
  fs.symlinkSync(outsideSnapshot, path.join(proposalsDir, 'proposal-external.json'))
  const store = createProposalStore({ workspaceRoot: root, proposalsDir })
  const read = store.readProposal('proposal-external')
  assert.equal(read.ok, false)
  assert.equal(read.status, 422)
  assert.doesNotMatch(read.error, /outside snapshot sentinel/)
  const listed = store.listProposals()
  assert.equal(listed.ok, false)
  assert.equal(listed.status, 422)
  assert.doesNotMatch(listed.error, /outside snapshot sentinel/)
})

test('redirected collaboration directories are refused before outside creation or chmod', (t) => {
  const root = makeRoot(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-state-dir-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.chmodSync(outside, 0o755)
  fs.symlinkSync(outside, path.join(root, 'redirected'), 'dir')

  assert.throws(
    () => createCollaborationEventLedger({
      workspaceRoot: root,
      ledgerPath: path.join(root, 'redirected', 'nested', 'events.ndjson'),
    }),
    /redirected or non-directory component/,
  )
  assert.equal(fs.existsSync(path.join(outside, 'nested')), false)
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755)

  fs.symlinkSync(outside, path.join(root, '.atelier-proposals'), 'dir')
  assert.throws(
    () => createProposalStore({ workspaceRoot: root }),
    /redirected or non-directory component/,
  )
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755)
})

test('compatibility snapshot failures stay diagnostic after authoritative events commit', (t) => {
  const root = makeRoot(t)
  const store = createProposalStore({
    workspaceRoot: root,
    snapshotWriter() { throw new Error('synthetic projection failure') },
  })
  const created = store.createProposal({ path: 'index.html' })
  assert.equal(created.ok, true)
  assert.equal(created.diagnostics[0].code, 'proposal-snapshot-write-failed')
  assert.equal(store.eventLedger.eventsFor(created.record.proposal.id).events.length, 1)

  const reviewed = store.reviewProposal(created.record.proposal.id, {
    status: 'reviewed',
    reviewer: 'synthetic reviewer',
  })
  assert.equal(reviewed.ok, true)
  assert.equal(reviewed.diagnostics[0].code, 'proposal-snapshot-write-failed')
  assert.equal(store.eventLedger.eventsFor(created.record.proposal.id).events.length, 2)
})

test('proposal lookup refuses identifier aliases and mismatched compatibility snapshots', (t) => {
  const root = makeRoot(t)
  const proposalsDir = path.join(root, '.atelier-proposals')
  const store = createProposalStore({ workspaceRoot: root, proposalsDir })
  const created = store.createProposal({ path: 'index.html' })
  assert.equal(created.ok, true)
  const id = created.record.proposal.id
  const before = store.eventLedger.eventsFor(id).events.length

  assert.equal(store.readProposal(`${id}!`).status, 404)
  assert.equal(store.reviewProposal(`${id}!`, { status: 'reviewed' }).status, 404)
  assert.equal(store.eventLedger.eventsFor(id).events.length, before)

  fs.writeFileSync(path.join(proposalsDir, 'proposal-legacy.json'), JSON.stringify({
    schema: 'atelier-proposal@v1',
    proposal: { id: 'proposal-different', status: 'proposed' },
  }), { mode: 0o600 })
  const mismatched = store.readProposal('proposal-legacy')
  assert.equal(mismatched.ok, false)
  assert.equal(mismatched.status, 422)
  assert.match(mismatched.error, /does not match/)
})

test('proposal materialization rejects invalid authoritative event sequences without snapshot fallback', (t) => {
  const root = makeRoot(t)

  function scenario(name, id, event) {
    const scenarioRoot = path.join(root, name)
    fs.mkdirSync(scenarioRoot)
    const proposalsDir = path.join(scenarioRoot, '.atelier-proposals')
    const store = createProposalStore({ workspaceRoot: scenarioRoot, proposalsDir })
    const appended = store.eventLedger.append({
      aggregateId: id,
      expectedVersion: 0,
      actor: 'synthetic sequence test',
      at: '2026-08-25T00:00:00Z',
      ...event,
    })
    assert.equal(appended.ok, true, appended.error)
    fs.writeFileSync(path.join(proposalsDir, `${id}.json`), JSON.stringify({
      schema: 'atelier-proposal@v1',
      proposal: { id, status: 'proposed', createdAt: '2026-08-25T00:00:00Z' },
    }), { mode: 0o600 })
    const read = store.readProposal(id)
    assert.equal(read.ok, false)
    assert.equal(read.status, 422)
    assert.equal(store.listProposals().status, 422)
  }

  scenario('review-first', 'proposal-review-first', {
    type: 'proposal-reviewed',
    payload: { status: 'reviewed', review: { reviewer: 'synthetic' } },
  })
  scenario('unknown-event', 'proposal-unknown-event', {
    type: 'proposal-unknown',
    payload: {},
  })
  scenario('identity-mismatch', 'proposal-identity-mismatch', {
    type: 'proposal-imported',
    payload: {
      record: {
        schema: 'atelier-proposal@v1',
        proposal: { id: 'proposal-different', status: 'proposed' },
      },
    },
  })
})

test('proposal materialization accepts the compactor canonical origin plus bounded version tail', (t) => {
  const root = makeRoot(t)
  const store = createProposalStore({ workspaceRoot: root })
  const created = store.createProposal({ path: 'index.html' })
  assert.equal(created.ok, true)
  const id = created.record.proposal.id
  assert.equal(store.reviewProposal(id, {
    status: 'reviewed', reviewer: 'synthetic compaction reviewer',
  }).ok, true)
  assert.equal(store.reviewProposal(id, {
    status: 'accepted', reviewer: 'synthetic compaction reviewer',
  }).ok, true)
  for (let index = 0; index < 58; index += 1) {
    const reviewed = store.reviewProposal(id, {
      status: 'accepted', reviewer: 'synthetic compaction reviewer',
    })
    assert.equal(reviewed.ok, true, reviewed.error)
  }
  const compacted = store.eventLedger.compact({ now: '2026-08-25T01:00:00Z' })
  assert.equal(compacted.ok, true, compacted.error)
  assert.ok(compacted.removed > 0)
  const retainedVersions = store.eventLedger.eventsFor(id).events.map((event) => event.version)
  assert.equal(retainedVersions[0], 1)
  assert.ok(retainedVersions[1] > 2)
  const read = store.readProposal(id)
  assert.equal(read.ok, true, read.error)
  assert.equal(read.record.proposal.status, 'accepted')
  assert.equal(store.listProposals().ok, true)
})
