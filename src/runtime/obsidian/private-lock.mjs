import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { isPendingPrivateWrite, publishPrivateFile } from '../../project/durable-state.mjs'
import { ensureContainedPrivateDirectory, readRegularTextNoFollow } from '../../project/private-state.mjs'
import { closedObject, isoTime } from './documents.mjs'
import { ObsidianMaintenanceRefusal } from './errors.mjs'

// A private lock between processes of one machine, as a directory of owner
// tickets:
//
//   <lock>/000000000007.json      the ticket of generation 7: who holds it
//   <lock>/000000000007.released  the same bytes: generation 7 was given back
//
// Only the highest generation means anything. A ticket is published with a
// non-overwriting hard link, so of two contenders for generation N+1 exactly
// one wins; the winner then confirms that nothing higher exists (a contender
// that decided on an old listing finds the newer ticket and withdraws) and
// removes every lower generation, so a lock taken on every tick does not grow.
//
// Nothing is ever taken from a holder that may still be working. A ticket
// whose holder did not release it is passed over only with proof:
//
//   - its process is gone; or
//   - it is a maintenance service that recorded where it answers health, and
//     that address refuses connections or answers as another runtime or PID.
//     A service listens from before its first tick until after its last, so
//     either answer proves the recorded runtime is not ticking.
//
// No answer in time proves nothing (a busy holder answers late). A ticket
// from another machine, an unreadable ticket, an unknown file, or a live
// process that recorded no health address all need a person: see
// `inspectPrivateGenerationLock` and docs/local-services.md.

export const LOCK_TICKET_SCHEMA = 'atelier-obsidian-lock-ticket/v1'
export const ENGINE_LOCK_DIRECTORY = path.join('state', 'maintenance', 'engine-lock')

const TICKET_NAME = /^(\d{12})\.(json|released)$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LOOPBACK = new Set(['127.0.0.1', '::1'])
const MAX_GENERATION = 999999999999

export const machineDigest = () => createHash('sha256').update(hostname()).digest('hex')

export function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

function validateTicket(document, workspaceId) {
  closedObject(document, { required: ['schema', 'workspaceId', 'purpose', 'pid', 'machine', 'nonce', 'acquiredAt', 'service'] }, 'invalid-lock-ticket', 'a lock ticket')
  const ok = document.schema === LOCK_TICKET_SCHEMA && document.workspaceId === workspaceId && typeof document.purpose === 'string' && IDENTIFIER.test(document.purpose)
    && Number.isSafeInteger(document.pid) && document.pid > 0 && /^[0-9a-f]{64}$/.test(document.machine) && /^[0-9a-f]{32}$/.test(document.nonce) && typeof document.acquiredAt === 'string'
  if (!ok) throw new ObsidianMaintenanceRefusal('invalid-lock-ticket', 'a lock ticket is malformed or belongs to another workspace')
  if (document.service !== null) {
    closedObject(document.service, { required: ['host', 'port', 'runtimeId'] }, 'invalid-lock-ticket', 'the service of a lock ticket')
    if (!LOOPBACK.has(document.service.host) || !Number.isInteger(document.service.port) || document.service.port < 1 || document.service.port > 65535 || typeof document.service.runtimeId !== 'string' || !IDENTIFIER.test(document.service.runtimeId)) {
      throw new ObsidianMaintenanceRefusal('invalid-lock-ticket', 'the service of a lock ticket is malformed')
    }
  }
  return document
}

// Whether the holder of an unreleased ticket is provably not working any more.
// `probe` answers { kind: 'refused' | 'health' | ... , body }.
export function createAbandonmentProof({ probe = null, alive = isProcessAlive, machine = machineDigest(), maxAgeMs = null } = {}) {
  return async function proveAbandoned(ticket, { nowMs } = {}) {
    if (ticket.machine !== machine) return { abandoned: false, reason: 'held-on-another-machine' }
    if (!alive(ticket.pid)) return { abandoned: true, reason: 'holder-process-gone' }
    if (ticket.pid === process.pid) return { abandoned: false, reason: 'held-by-this-process' }
    // A purpose whose holder is bounded in time by construction (a start) may name a maximum age.
    if (maxAgeMs !== null && Number.isFinite(nowMs) && nowMs - Date.parse(ticket.acquiredAt) > maxAgeMs) return { abandoned: true, reason: 'holder-older-than-its-bound' }
    if (ticket.service === null || typeof probe !== 'function') return { abandoned: false, reason: 'live-process-unproven' }
    const answer = await probe({ host: ticket.service.host, port: ticket.service.port })
    if (answer.kind === 'refused') return { abandoned: true, reason: 'service-address-closed' }
    if (answer.kind === 'health' && (answer.body.runtimeId !== ticket.service.runtimeId || answer.body.pid !== ticket.pid)) return { abandoned: true, reason: 'service-address-answers-as-another-runtime' }
    return { abandoned: false, reason: answer.kind === 'health' ? 'holder-answers-health' : 'live-process-unproven' }
  }
}

function listGenerations(directory) {
  let names
  try { names = fs.readdirSync(directory) } catch (error) { if (error.code === 'ENOENT') return { names: [], highest: 0, unknown: null }; throw error }
  names = names.filter((name) => !isPendingPrivateWrite(name))
  const unknown = names.find((name) => !TICKET_NAME.test(name)) ?? null
  const highest = names.reduce((most, name) => Math.max(most, Number(TICKET_NAME.exec(name)?.[1] ?? 0)), 0)
  return { names, highest, unknown }
}

const ticketName = (generation, kind) => `${String(generation).padStart(12, '0')}.${kind}`

// Read-only. { available, reason, generation, ticket }
export async function inspectPrivateGenerationLock({ directory, workspaceId, proveAbandoned = createAbandonmentProof(), nowMs = Date.now() }) {
  const { names, highest, unknown } = listGenerations(directory)
  if (unknown) return { available: false, reason: 'unknown-lock-file', generation: highest, ticket: null }
  if (highest === 0) return { available: true, reason: 'unused', generation: 0, ticket: null }
  let body
  let ticket
  try {
    body = readRegularTextNoFollow(path.join(directory, ticketName(highest, 'json')))
    ticket = validateTicket(JSON.parse(body), workspaceId)
  } catch (error) {
    // Pruned or replaced between the listing and the read: somebody is working here right now.
    return { available: false, reason: error.code === 'ENOENT' ? 'lock-changed-while-reading' : 'unreadable-lock-ticket', generation: highest, ticket: null }
  }
  if (names.includes(ticketName(highest, 'released'))) {
    let released
    try { released = readRegularTextNoFollow(path.join(directory, ticketName(highest, 'released'))) } catch { released = null }
    return released === body ? { available: true, reason: 'released', generation: highest, ticket } : { available: false, reason: 'release-identity-differs', generation: highest, ticket }
  }
  const proof = await proveAbandoned(ticket, { nowMs })
  return { available: proof.abandoned, reason: proof.reason, generation: highest, ticket }
}

// { acquired: true, generation, release() } or { acquired: false, reason, holder }.
// Never waits and never throws for a lock that is merely held.
export async function acquirePrivateGenerationLock({ workspaceRoot, directory, workspaceId, purpose, service = null, clock, proveAbandoned, randomBytes = cryptoRandomBytes }) {
  const contained = ensureContainedPrivateDirectory({ workspaceRoot, directory, label: 'private lock' })
  const acquiredAt = isoTime(clock)
  const status = await inspectPrivateGenerationLock({ directory: contained, workspaceId, proveAbandoned, nowMs: Date.parse(acquiredAt) })
  const holder = status.ticket ? { pid: status.ticket.pid, purpose: status.ticket.purpose, runtimeId: status.ticket.service?.runtimeId ?? null } : null
  if (!status.available) return { acquired: false, reason: status.reason, holder }
  if (status.generation >= MAX_GENERATION) return { acquired: false, reason: 'lock-generations-exhausted', holder }
  const generation = status.generation + 1
  const ticket = validateTicket({ schema: LOCK_TICKET_SCHEMA, workspaceId, purpose, pid: process.pid, machine: machineDigest(), nonce: randomBytes(16).toString('hex'), acquiredAt, service }, workspaceId)
  const body = JSON.stringify(ticket)
  const file = path.join(contained, ticketName(generation, 'json'))
  try { publishPrivateFile(file, body) } catch (error) {
    if (error.code === 'EEXIST') return { acquired: false, reason: 'lost-the-race-for-this-generation', holder: null }
    throw error
  }
  // Confirm: a decision made on an old listing finds the newer ticket here and withdraws.
  const after = listGenerations(contained)
  if (after.highest !== generation) {
    try { fs.unlinkSync(file) } catch { /* a lower generation is ignored and pruned by the next holder */ }
    return { acquired: false, reason: 'a-newer-holder-exists', holder: null }
  }
  for (const name of after.names) {
    if (Number(TICKET_NAME.exec(name)[1]) < generation) try { fs.unlinkSync(path.join(contained, name)) } catch { /* pruned by somebody else */ }
  }
  let released = false
  return {
    acquired: true,
    generation,
    release() {
      if (released) return false
      released = true
      let current
      try { current = readRegularTextNoFollow(file) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
      // Taken over after a proof of abandonment (this process was thought gone): nothing here is ours to release.
      if (current !== body) return false
      publishPrivateFile(path.join(contained, ticketName(generation, 'released')), body)
      return true
    },
  }
}
