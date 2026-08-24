import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ATELIER_COLLABORATION_EVENT_SCHEMA = 'atelier-collaboration-event@v1'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Best effort for filesystems without POSIX modes.
  }
}

function secureAppendLine(file, value) {
  ensurePrivateDir(path.dirname(file))
  const descriptor = fs.openSync(file, 'a', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort for filesystems without POSIX modes.
  }
}

function eventId(aggregateId, version, at) {
  const digest = crypto
    .createHash('sha256')
    .update([aggregateId, version, at].join('\0'))
    .digest('hex')
    .slice(0, 32)
  return `event-${digest}`
}

export function validateCollaborationEvent(event) {
  const issues = []
  if (!isRecord(event)) return { ok: false, issues: ['event must be an object'] }
  if (event.schema !== ATELIER_COLLABORATION_EVENT_SCHEMA) issues.push('event schema is unsupported')
  if (typeof event.id !== 'string' || !/^event-[a-f0-9]{32}$/.test(event.id)) issues.push('event id is invalid')
  if (typeof event.aggregateId !== 'string' || !event.aggregateId) issues.push('aggregateId is required')
  if (!Number.isInteger(event.version) || event.version < 1) issues.push('version must be a positive integer')
  if (typeof event.type !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(event.type)) issues.push('event type is invalid')
  if (typeof event.actor !== 'string' || !event.actor.trim()) issues.push('actor is required')
  if (!validTimestamp(event.at)) issues.push('event timestamp is invalid')
  if (!isRecord(event.payload)) issues.push('event payload must be an object')
  return issues.length === 0 ? { ok: true, value: event } : { ok: false, issues }
}

export function createCollaborationEventLedger({
  workspaceRoot = process.cwd(),
  ledgerPath = path.join(workspaceRoot, '.atelier-proposals', 'events.ndjson'),
  clock = () => new Date().toISOString(),
} = {}) {
  const root = fs.realpathSync(workspaceRoot)
  const resolvedLedger = path.resolve(ledgerPath)
  ensurePrivateDir(path.dirname(resolvedLedger))
  const ledgerDirReal = fs.realpathSync(path.dirname(resolvedLedger))
  const ledgerReal = path.join(ledgerDirReal, path.basename(resolvedLedger))
  const relative = path.relative(root, ledgerReal)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('collaboration ledger escapes workspace')
  }

  function readAll() {
    if (!fs.existsSync(ledgerReal)) return []
    return fs
      .readFileSync(ledgerReal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        try {
          const event = JSON.parse(line)
          const validation = validateCollaborationEvent(event)
          if (!validation.ok) throw new Error(validation.issues.join('; '))
          return event
        } catch (error) {
          throw new Error(`invalid collaboration ledger line ${index + 1}: ${error.message}`)
        }
      })
  }

  function eventsFor(aggregateId) {
    return readAll().filter((event) => event.aggregateId === aggregateId)
  }

  function append({ aggregateId, expectedVersion = 0, type, actor, at = clock(), payload = {} }) {
    const current = eventsFor(aggregateId)
    if (current.length !== expectedVersion) {
      return {
        ok: false,
        status: 409,
        error: `stale collaboration event refused: expected ${expectedVersion}, current ${current.length}`,
      }
    }
    const version = current.length + 1
    const event = {
      schema: ATELIER_COLLABORATION_EVENT_SCHEMA,
      id: eventId(aggregateId, version, at),
      aggregateId,
      version,
      type,
      actor: String(actor || '').trim(),
      at,
      payload,
    }
    const validation = validateCollaborationEvent(event)
    if (!validation.ok) return { ok: false, status: 400, error: validation.issues.join('; ') }
    secureAppendLine(ledgerReal, event)
    return { ok: true, status: 200, event }
  }

  function materialize(aggregateId, reducer, initial = null) {
    return eventsFor(aggregateId).reduce((state, event) => reducer(state, event), initial)
  }

  return Object.freeze({
    ledgerPath: ledgerReal,
    readAll,
    eventsFor,
    append,
    materialize,
  })
}
