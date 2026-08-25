import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  atomicReplacePrivateText,
  ensureContainedPrivateDirectory,
  openRegularFileNoFollow,
} from '../project/private-state.mjs'

export const ATELIER_COLLABORATION_EVENT_SCHEMA = 'atelier-collaboration-event@v1'
export const COLLABORATION_LEDGER_LIMITS = Object.freeze({
  maxLineBytes: 256 * 1024,
  maxBytes: 16 * 1024 * 1024,
  maxEvents: 10_000,
  retainPerAggregate: 50,
  retainDays: 180,
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function secureAppendLine(file, line) {
  const descriptor = openRegularFileNoFollow(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, line)
    fs.fsyncSync(descriptor)
    fs.fchmodSync(descriptor, 0o600)
  } finally {
    fs.closeSync(descriptor)
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

function boundedLimit(value, hardLimit) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), hardLimit) : hardLimit
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
  if (
    typeof event.id === 'string' && /^event-[a-f0-9]{32}$/.test(event.id) &&
    typeof event.aggregateId === 'string' && event.aggregateId &&
    Number.isInteger(event.version) && event.version > 0 &&
    validTimestamp(event.at) &&
    event.id !== eventId(event.aggregateId, event.version, event.at)
  ) {
    issues.push('event id does not match aggregate, version, and timestamp')
  }
  return issues.length === 0 ? { ok: true, value: event } : { ok: false, issues }
}

export function createCollaborationEventLedger({
  workspaceRoot = process.cwd(),
  ledgerPath = path.join(workspaceRoot, '.atelier-proposals', 'events.ndjson'),
  clock = () => new Date().toISOString(),
  maxLineBytes = COLLABORATION_LEDGER_LIMITS.maxLineBytes,
  maxBytes = COLLABORATION_LEDGER_LIMITS.maxBytes,
  maxEvents = COLLABORATION_LEDGER_LIMITS.maxEvents,
} = {}) {
  const root = fs.realpathSync(workspaceRoot)
  const resolvedLedger = path.resolve(ledgerPath)
  const ledgerDirReal = ensureContainedPrivateDirectory({
    workspaceRoot,
    directory: path.dirname(resolvedLedger),
    label: 'collaboration ledger directory',
  })
  const ledgerReal = path.join(ledgerDirReal, path.basename(resolvedLedger))
  const relative = path.relative(root, ledgerReal)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('collaboration ledger escapes workspace')
  }

  const limits = Object.freeze({
    maxLineBytes: boundedLimit(maxLineBytes, COLLABORATION_LEDGER_LIMITS.maxLineBytes),
    maxBytes: boundedLimit(maxBytes, COLLABORATION_LEDGER_LIMITS.maxBytes),
    maxEvents: boundedLimit(maxEvents, COLLABORATION_LEDGER_LIMITS.maxEvents),
  })
  const lockPath = `${ledgerReal}.lock`

  function failure(status, error, diagnostics = [], stats = {}) {
    return { ok: false, status, error, events: [], diagnostics, stats }
  }

  function readAll() {
    const startedAt = performance.now()
    if (!fs.existsSync(ledgerReal)) {
      return { ok: true, status: 200, events: [], diagnostics: [], stats: { bytes: 0, eventCount: 0, durationMs: performance.now() - startedAt } }
    }

    let descriptor
    let bytes
    try {
      descriptor = openRegularFileNoFollow(ledgerReal, fs.constants.O_RDONLY)
      bytes = fs.fstatSync(descriptor).size
    } catch (error) {
      return failure(500, `collaboration ledger cannot be inspected: ${error.message}`)
    }
    if (bytes > limits.maxBytes) {
      fs.closeSync(descriptor)
      return failure(413, `collaboration ledger exceeds ${limits.maxBytes} byte hard ceiling`, [{ code: 'ledger-byte-limit', bytes }], { bytes, eventCount: 0 })
    }

    let raw
    try {
      raw = fs.readFileSync(descriptor, 'utf8')
    } catch (error) {
      return failure(500, `collaboration ledger cannot be read: ${error.message}`, [], { bytes, eventCount: 0 })
    } finally {
      fs.closeSync(descriptor)
    }

    const diagnostics = []
    const events = []
    const versions = new Map()
    const eventIds = new Set()
    const lines = raw.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      const lineNumber = index + 1
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > limits.maxLineBytes) {
        diagnostics.push({ line: lineNumber, code: 'ledger-line-limit', message: `line exceeds ${limits.maxLineBytes} bytes` })
        continue
      }
      if (events.length >= limits.maxEvents) {
        diagnostics.push({ line: lineNumber, code: 'ledger-event-limit', message: `ledger exceeds ${limits.maxEvents} events` })
        break
      }
      let event
      try {
        event = JSON.parse(line)
      } catch (error) {
        diagnostics.push({ line: lineNumber, code: 'ledger-json-invalid', message: error.message })
        continue
      }
      const validation = validateCollaborationEvent(event)
      if (!validation.ok) {
        diagnostics.push({ line: lineNumber, code: 'ledger-event-invalid', message: validation.issues.join('; ') })
        continue
      }
      if (eventIds.has(event.id)) {
        diagnostics.push({ line: lineNumber, code: 'ledger-event-duplicate', message: `duplicate event id ${event.id}` })
        continue
      }
      const previousVersion = versions.get(event.aggregateId) ?? 0
      if (event.version <= previousVersion) {
        diagnostics.push({ line: lineNumber, code: 'ledger-version-order', message: `version ${event.version} does not advance aggregate ${event.aggregateId}` })
        continue
      }
      eventIds.add(event.id)
      versions.set(event.aggregateId, event.version)
      events.push(event)
    }

    const stats = { bytes, eventCount: events.length, durationMs: performance.now() - startedAt }
    if (diagnostics.length) {
      return { ok: false, status: 422, error: `collaboration ledger validation failed at ${diagnostics.length} line(s)`, events, diagnostics, stats }
    }
    return { ok: true, status: 200, events, diagnostics: [], stats }
  }

  function eventsFor(aggregateId) {
    const id = String(aggregateId || '').trim()
    if (!id) return failure(400, 'aggregateId is required')
    const result = readAll()
    if (!result.ok) return result
    const events = result.events.filter((event) => event.aggregateId === id)
    return {
      ...result,
      events,
      currentVersion: events.at(-1)?.version ?? 0,
    }
  }

  function withWriteLock(operation) {
    let descriptor
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${process.pid}\n`)
      fs.fsyncSync(descriptor)
    } catch (error) {
      if (descriptor != null) fs.closeSync(descriptor)
      if (error?.code === 'EEXIST') return { ok: false, status: 423, error: 'collaboration ledger is locked; retry after the active writer finishes' }
      return { ok: false, status: 500, error: `collaboration ledger lock failed: ${error.message}` }
    }
    try {
      return operation()
    } finally {
      fs.closeSync(descriptor)
      try {
        fs.unlinkSync(lockPath)
      } catch {
        // The completed write remains authoritative; cleanup can be diagnosed
        // by the next writer's explicit locked result.
      }
    }
  }

  function append({ aggregateId, expectedVersion = 0, type, actor, at = clock(), payload = {} }) {
    return withWriteLock(() => {
      const current = eventsFor(aggregateId)
      if (!current.ok) return current
      if (current.currentVersion !== expectedVersion) {
        return {
          ok: false,
          status: 409,
          error: `stale collaboration event refused: expected ${expectedVersion}, current ${current.currentVersion}`,
        }
      }
      if (current.stats.eventCount >= limits.maxEvents) {
        return { ok: false, status: 413, error: `collaboration ledger reached ${limits.maxEvents} event hard ceiling; compact it explicitly before appending` }
      }
      const version = current.currentVersion + 1
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
      const line = `${JSON.stringify(event)}\n`
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > limits.maxLineBytes) {
        return { ok: false, status: 413, error: `collaboration event exceeds ${limits.maxLineBytes} byte line ceiling` }
      }
      if (current.stats.bytes + lineBytes > limits.maxBytes) {
        return { ok: false, status: 413, error: `collaboration ledger would exceed ${limits.maxBytes} byte hard ceiling; compact it explicitly before appending` }
      }
      try {
        secureAppendLine(ledgerReal, line)
      } catch (error) {
        return { ok: false, status: 500, error: `collaboration ledger cannot be appended: ${error.message}` }
      }
      return { ok: true, status: 200, event }
    })
  }

  function materialize(aggregateId, reducer, initial = null) {
    if (typeof reducer !== 'function') return { ok: false, status: 400, error: 'reducer is required', value: initial }
    const result = eventsFor(aggregateId)
    if (!result.ok) return { ...result, value: initial }
    return {
      ...result,
      value: result.events.reduce((state, event) => reducer(state, event), initial),
    }
  }

  function compact({
    now = clock(),
    retainPerAggregate = COLLABORATION_LEDGER_LIMITS.retainPerAggregate,
    retainDays = COLLABORATION_LEDGER_LIMITS.retainDays,
  } = {}) {
    return withWriteLock(() => {
      const current = readAll()
      if (!current.ok) return current
      const perAggregate = Math.max(2, boundedLimit(retainPerAggregate, COLLABORATION_LEDGER_LIMITS.retainPerAggregate))
      const days = boundedLimit(retainDays, COLLABORATION_LEDGER_LIMITS.retainDays)
      const cutoff = Date.parse(now) - days * 24 * 60 * 60 * 1000
      if (!Number.isFinite(cutoff)) return { ok: false, status: 400, error: 'compaction timestamp is invalid' }

      const grouped = new Map()
      for (const event of current.events) {
        const group = grouped.get(event.aggregateId) ?? []
        group.push(event)
        grouped.set(event.aggregateId, group)
      }
      const kept = []
      for (const events of grouped.values()) {
        const first = events[0]
        const latest = events.at(-1)
        const recent = events.filter((event) => Date.parse(event.at) >= cutoff)
        const candidates = [first, ...recent, latest]
        const unique = [...new Map(candidates.map((event) => [event.id, event])).values()]
          .sort((left, right) => left.version - right.version)
        const selected = unique.length <= perAggregate
          ? unique
          : [unique[0], ...unique.slice(-(perAggregate - 1))]
        kept.push(...selected)
      }
      // `at` is contributor-controlled metadata and may regress. The physical
      // ledger must retain each aggregate's causal version order after rewrite.
      kept.sort((left, right) => (
        left.aggregateId.localeCompare(right.aggregateId) ||
        left.version - right.version ||
        left.id.localeCompare(right.id)
      ))
      const text = kept.length ? `${kept.map((event) => JSON.stringify(event)).join('\n')}\n` : ''
      if (Buffer.byteLength(text) > limits.maxBytes) {
        return { ok: false, status: 413, error: 'compacted collaboration ledger still exceeds the byte hard ceiling' }
      }
      atomicReplacePrivateText(ledgerReal, text)
      return {
        ok: true,
        status: 200,
        before: current.events.length,
        after: kept.length,
        removed: current.events.length - kept.length,
        retainPerAggregate: perAggregate,
        retainDays: days,
      }
    })
  }

  return Object.freeze({
    ledgerPath: ledgerReal,
    lockPath,
    limits,
    readAll,
    eventsFor,
    append,
    materialize,
    compact,
  })
}
