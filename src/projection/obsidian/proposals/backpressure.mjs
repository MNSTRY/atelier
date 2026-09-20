import { COLLABORATION_LEDGER_LIMITS } from '../../../collaboration/event-ledger.mjs'

// The limits of the existing proposal ledger are contracts of that ledger:
// 256 KiB a line, 16 MiB in all, 10,000 events, and a line that cannot be read
// refuses every append. This module asks about them BEFORE the adapter appends
// anything, and decides what becomes of an operation the ledger cannot take.
//
//   proposal-too-large  the event would be longer than a line may be. Refused; a proposal refers to the preserved
//                       bytes by digest instead of holding them, and nothing is ever cut to fit.
//   ledger-full         the ledger has no room (or too little: see the reserve). The operation waits in the adapter
//                       queue as `backpressure`, its preserved edit untouched, and is tried again later.
//   ledger-corrupt      a line of the ledger cannot be read. Refused, for that repository only.
//   store-unavailable   the store could not be read or is locked by another writer right now. Waits, like a full one.
//
// Nothing here, and nothing in the adapter, compacts, rotates or deletes a
// ledger or a proposal. Making room is a decision of a person.

export const PROPOSAL_LEDGER_LIMITS = Object.freeze({
  maxLineBytes: COLLABORATION_LEDGER_LIMITS.maxLineBytes,
  maxBytes: COLLABORATION_LEDGER_LIMITS.maxBytes,
  maxEvents: COLLABORATION_LEDGER_LIMITS.maxEvents,
})

export const PROPOSAL_BACKPRESSURE = Object.freeze({
  // A proposal the adapter creates is reviewed by people, and a review is two more events. The adapter never takes
  // the last of the room they need to settle what is already there.
  reserveEvents: 32,
  reserveBytes: 512 * 1024,
  // What the store adds around a proposal when it writes the event (identifiers, timestamps) is a few hundred bytes
  // of fixed length; the estimate is that and this much more.
  lineMarginBytes: 1024,
  // Per tick and per repository.
  maxBatchPerRepository: 8,
  // Pending edits looked at per tick to find new structural edits.
  maxExaminedPerTick: 64,
  // An operation under backpressure is tried at most this many times, each time later than the last.
  maxAttempts: 8,
  retryIntervalMs: 60 * 1000,
  maxRetryIntervalMs: 60 * 60 * 1000,
})

export const BACKPRESSURE_CODES = Object.freeze(['ledger-full', 'store-unavailable', 'route-visibility-unknown'])
export const STORE_REFUSAL_CODES = Object.freeze(['proposal-too-large', 'ledger-corrupt', 'store-refused', 'identity-not-preserved'])

// What a read of the whole ledger says about it. `read` is the answer of
// `eventLedger.readAll()` (or of `listProposals()`, which carries the same
// status, diagnostics and stats).
export function classifyLedgerRead(read, limits = PROPOSAL_LEDGER_LIMITS) {
  const events = read?.stats?.eventCount ?? 0
  const bytes = read?.stats?.bytes ?? 0
  const headroom = { events: Math.max(0, limits.maxEvents - events), bytes: Math.max(0, limits.maxBytes - bytes) }
  if (read?.ok) return { state: 'readable', code: null, events, bytes, headroom }
  const diagnostics = Array.isArray(read?.diagnostics) ? read.diagnostics : []
  // Larger than a ledger may be, or more events than one may hold: full, and then some. Not a line that is wrong.
  if (read?.status === 413 || (diagnostics.length > 0 && diagnostics.every((item) => item.code === 'ledger-event-limit'))) {
    return { state: 'full', code: 'ledger-full', events, bytes, headroom: { events: 0, bytes: read?.status === 413 ? 0 : headroom.bytes } }
  }
  if (read?.status === 422) return { state: 'corrupt', code: 'ledger-corrupt', events, bytes, headroom: { events: 0, bytes: 0 }, lines: diagnostics.length }
  return { state: 'unavailable', code: 'store-unavailable', events, bytes, headroom: { events: 0, bytes: 0 } }
}

// The length of the line the store would write for `body`, to within the margin, and never less than it. It repeats
// what createProposal makes of a body: the members it copies, and the payload, which it keeps whole. The identifiers
// and timestamps the store adds have a fixed length, so placeholders of that length stand for them.
export function estimateEventLineBytes({ body, workspaceId, marginBytes = PROPOSAL_BACKPRESSURE.lineMarginBytes }) {
  const at = '2000-01-01T00:00:00.000Z'
  const id = `proposal-${'0'.repeat(32)}`
  const record = {
    schema: 'atelier-proposal@v1', workspaceId,
    proposal: {
      id, status: 'proposed', createdAt: at, updatedAt: at, sessionId: String(body.sessionId ?? ''), viewId: String(body.viewId ?? ''), path: String(body.path ?? ''), action: String(body.action ?? ''),
      intent: String(body.intent ?? ''), reason: String(body.reason ?? ''), storage: { kind: 'local', ignored: true },
      authority: { action: String(body.action ?? ''), capability: 'proposal.copy-only', copyOnly: true, directWrite: false, applyEndpoint: null }, eventVersion: 1,
    },
    diff: typeof body.diff === 'string' ? body.diff : '',
    payload: body.proposal ?? {},
  }
  const event = { schema: 'atelier-collaboration-event@v1', aggregateId: id, version: 1, type: 'proposal-created', actor: String(body.actor ?? ''), at, payload: { record }, id: `event-${'0'.repeat(32)}` }
  return Buffer.byteLength(`${JSON.stringify(event)}\n`) + marginBytes
}

// { ok: true } or { ok: false, code, detail }. `ledger` is a classifyLedgerRead answer that is `readable`.
export function preflightAppend({ ledger, lineBytes, limits = PROPOSAL_LEDGER_LIMITS, bounds = PROPOSAL_BACKPRESSURE }) {
  if (lineBytes > limits.maxLineBytes) return { ok: false, code: 'proposal-too-large', detail: { lineBytes, limit: limits.maxLineBytes } }
  if (ledger.headroom.events < 1 + bounds.reserveEvents) return { ok: false, code: 'ledger-full', detail: { member: 'events', headroom: ledger.headroom.events, reserve: bounds.reserveEvents } }
  if (ledger.headroom.bytes < lineBytes + bounds.reserveBytes) return { ok: false, code: 'ledger-full', detail: { member: 'bytes', headroom: ledger.headroom.bytes, reserve: bounds.reserveBytes, lineBytes } }
  return { ok: true }
}

// What a refused createProposal means, from its status.
export function classifyStoreRefusal(status) {
  if (status === 413) return 'ledger-full'
  if (status === 422) return 'ledger-corrupt'
  if (status === 423 || status === 500 || status === 409) return 'store-unavailable'
  return 'store-refused'
}

// When an operation under backpressure is tried next: twice as long after each attempt, up to the maximum.
export function nextAttemptAt({ attempts, nowMs, bounds = PROPOSAL_BACKPRESSURE }) {
  const wait = Math.min(bounds.maxRetryIntervalMs, bounds.retryIntervalMs * 2 ** Math.max(0, Math.min(attempts, 30) - 1))
  return new Date(nowMs + wait).toISOString()
}

export const isExhausted = (record, bounds = PROPOSAL_BACKPRESSURE) => record.state === 'backpressure' && record.attempts >= bounds.maxAttempts

// Whether the adapter looks at this operation on this tick. Never for one that is settled, refused or exhausted, and
// never before its time: an unchanged tick reads the queue and nothing else.
export function isDue(record, { nowMs, bounds = PROPOSAL_BACKPRESSURE }) {
  if (record.state === 'acknowledged' || record.state === 'refused' || isExhausted(record, bounds)) return false
  return record.nextAttemptAt === null || Date.parse(record.nextAttemptAt) <= nowMs
}
