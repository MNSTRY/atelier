import fs from 'node:fs'
import path from 'node:path'
import { openObjectStore } from '../../../src/projection/obsidian/edits/index.mjs'
import { RACE_MODES, raceIdentity, raceOperation } from './operations.mjs'

// One of two real processes that meet on the same objects. Each round has its
// own object and starts at an agreed wall-clock instant: this process offers
// its edit, then tries for the object lease once. While it holds a lease it
// holds an exclusive file beside the store, which is a second, independent
// witness that nobody else held the lease at the same time. It prints what it
// saw as one JSON document and exits.

const { stateRoot, holdRoot, role, rounds, firstRound, startAt, periodMs, holdMs } = JSON.parse(process.argv[2])
const store = openObjectStore({ stateRoot, workspaceId: 'ws-race', repositoryRoots: [], clock: () => new Date() })

const spinUntil = (instant) => { while (Date.now() < instant) { /* a few milliseconds at most */ } }
const waitUntil = async (instant) => {
  const early = instant - Date.now() - 3
  if (early > 0) await new Promise((resolve) => { setTimeout(resolve, early) })
  spinUntil(instant)
}

const report = []
for (let index = 0; index < rounds; index += 1) {
  const round = firstRound + index
  const mode = RACE_MODES[round % RACE_MODES.length]
  const identity = raceIdentity(round)
  const operation = raceOperation({ round, role, mode })
  await waitUntil(startAt + index * periodMs + Math.floor(Math.random() * 6))
  const seen = { round, mode, doubleHolder: false, applied: false }
  const observed = store.observe(operation)
  Object.assign(seen, { acknowledgement: observed.acknowledgement, appended: observed.appended, first: observed.acknowledgement.sequence === 1 })
  spinUntil(Date.now() + Math.floor(Math.random() * 4))
  const attempt = await store.acquireLease(identity, { runtimeId: `rt-${role}` })
  seen.lease = attempt.acquired ? 'acquired' : attempt.reason
  if (attempt.acquired) {
    const witness = path.join(holdRoot, `round-${round}`)
    try { fs.closeSync(fs.openSync(witness, 'wx')) } catch (error) { if (error.code !== 'EEXIST') throw error; seen.doubleHolder = true }
    spinUntil(Date.now() + holdMs)
    const now = store.stateOf(identity)
    const mine = now.operations.find((entry) => entry.idempotencyKey === operation.idempotencyKey)
    if (mode === 'same-edit' && now.state === 'pending' && mine?.state === 'pending') {
      const ext = Object.values(operation.ext)[0]
      const record = { idempotencyKey: operation.idempotencyKey, actor: `actor-${role}`, policy: { mode: 'manual' } }
      store.recordIntent(attempt.lease, { ...record, expectedSourceDigest: operation.baseSourceDigest, newSourceDigest: ext.result.newSourceDigest })
      store.recordApplied(attempt.lease, { ...record, oldSourceDigest: operation.baseSourceDigest, newSourceDigest: ext.result.newSourceDigest })
      seen.applied = true
    }
    if (!seen.doubleHolder) fs.unlinkSync(witness)
    seen.released = store.releaseLease(attempt.lease)
  }
  report.push(seen)
}
process.stdout.write(`${JSON.stringify({ role, pid: process.pid, report })}\n`)
