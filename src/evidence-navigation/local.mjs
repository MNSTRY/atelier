import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createIngestionStore } from '../ingestion/store.mjs'
import { evidenceJson } from './contracts.mjs'

const schema = 'atelier-local-evidence-result@v1'
const flags = { executionAuthorized: false, authorityTransferred: false, semanticTruthVerified: false }
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex')
const bytes = text => Buffer.byteLength(text, 'utf8')
const refusal = reason => ({ schema, status: 'refused', reason, ...flags })
function fail(reason = 'not-available') { throw { reason } }
function record(input, keys) {
  const value = evidenceJson(input)
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-request')
  return value
}
function positive(value, ceiling) { return Number.isSafeInteger(value) && value > 0 && value <= ceiling }
function clip(text, ceiling) {
  if (bytes(text) <= ceiling) return { text, truncated: false }
  let result = '', used = 0
  for (const character of text) {
    const size = bytes(character)
    if (used + size > ceiling) break
    result += character; used += size
  }
  return { text: result, truncated: true }
}

/**
 * One host-owned session over one exact, whole-plan admission. Construction
 * options and callbacks are trusted code, never model arguments. No writes,
 * providers, or persisted handles. A separate host must qualify actual authority.
 */
export function createLocalEvidenceReader({ workspaceRoot, workspaceId, plan,
  admit, openStore = createIngestionStore, now = () => performance.now(), limits = {} } = {}) {
  let binding, bounds, started
  try {
    binding = record(plan, ['planId', 'planDigest'])
    bounds = { maxReads: 32, maxHandles: 32, maxTextBytes: 16384, maxTotalTextBytes: 65536, lifetimeMs: 60000,
      ...record(limits, ['maxReads', 'maxHandles', 'maxTextBytes', 'maxTotalTextBytes', 'lifetimeMs']) }
    if (!/^plan-[a-f0-9]{40}$/.test(binding.planId) || !/^sha256:[a-f0-9]{64}$/.test(binding.planDigest) ||
      typeof workspaceRoot !== 'string' || typeof workspaceId !== 'string' ||
      typeof admit !== 'function' || typeof openStore !== 'function' || typeof now !== 'function' ||
      !positive(bounds.maxReads, 128) || !positive(bounds.maxHandles, 128) ||
      !positive(bounds.maxTextBytes, 65536) || !positive(bounds.maxTotalTextBytes, 262144) ||
      !positive(bounds.lifetimeMs, 600000)) throw new Error()
    started = now()
    if (!Number.isFinite(started)) throw new Error()
  } catch { throw new Error('Invalid local evidence reader configuration') }
  Object.freeze(binding)
  const handles = new Map()
  let reads = 0, releasedBytes = 0, closed = false, busy = false, lastTime = started
  function live() {
    const time = now()
    if (closed || !Number.isFinite(time) || time < lastTime || time - started >= bounds.lifetimeMs) {
      closed = true; handles.clear(); fail()
    }
    lastTime = time
  }
  function permission(operation, expected) {
    live()
    let decision
    try {
      const response = admit(Object.freeze({ operation, ...binding, readScope: 'all-plan' }))
      let asynchronous = false
      // Contain native Promise rejection without invoking an untrusted then getter.
      try { Promise.prototype.then.call(response, undefined, () => {}); asynchronous = true } catch {}
      if (asynchronous) fail()
      decision = record(response, ['disposition', 'revision', 'readScope'])
    }
    catch { fail() }
    if (decision.disposition !== 'permit' || decision.readScope !== 'all-plan' ||
      typeof decision.revision !== 'string' || !decision.revision || decision.revision.length > 256 ||
      (expected !== undefined && decision.revision !== expected)) fail()
    live()
    return decision.revision
  }
  function reserve(count) {
    if (reads + count > bounds.maxReads || releasedBytes >= bounds.maxTotalTextBytes) fail('budget-exhausted')
    reads += count // Failed reads retain their reservation; no free retries.
  }
  function exact(store, reference) {
    live()
    const value = store.getEvidence({ ...binding, ...reference })
    if (!value || value.schema !== 'mnstry.atelier-ingestion-evidence@v1' || value.readScope !== 'all-plan' ||
      value.planId !== binding.planId || value.planDigest !== binding.planDigest ||
      value.sourceId !== reference.sourceId || value.sourceDigest !== reference.sourceDigest ||
      value.attemptId !== reference.attemptId || value.locator?.kind !== reference.locator.kind ||
      value.locator?.value !== reference.locator.value || value.freshness !== 'current' ||
      value.integrity !== 'verified' || value.semanticAcceptance !== 'pending' || value.synthesized !== false ||
      typeof value.text !== 'string' || bytes(value.text) > 262144) fail()
    live()
    return value.text
  }
  function execute(input, operation, body) {
    if (busy) return refusal('not-available')
    busy = true
    try {
      live()
      let request
      try { request = record(input, operation === 'search' ? ['query', 'limit', 'readScope'] : ['handle', 'readScope']) }
      catch { fail('invalid-request') }
      if (request.readScope !== undefined && request.readScope !== 'all-plan') fail('unsupported-scope')
      return body(request)
    } catch (error) {
      // Never forward backend errors, path-bearing messages, or denied counts.
      return refusal(['invalid-request', 'unsupported-scope', 'budget-exhausted'].includes(error?.reason) ? error.reason : 'not-available')
    } finally { busy = false }
  }
  return Object.freeze({
    search(input) {
      return execute(input, 'search', request => {
        const limit = request.limit ?? 5
        if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 512 ||
          bytes(request.query) > 2048 || request.query.toLowerCase().trim().split(/\s+/u).length > 32 || !positive(limit, 5)) fail('invalid-request')
        const revision = permission('search')
        if (handles.size + limit > bounds.maxHandles) fail('budget-exhausted')
        reserve(1 + limit)
        const store = openStore({ workspaceRoot, workspaceId })
        permission('search', revision)
        const found = store.query({ ...binding, query: request.query, limit })
        if (!found || found.schema !== 'mnstry.atelier-ingestion-query@v1' || found.readScope !== 'all-plan' ||
          found.planId !== binding.planId || found.planDigest !== binding.planDigest ||
          !Array.isArray(found.hits) || found.hits.length > limit) fail()
        const pending = [], items = []
        let outputBytes = 0
        for (const hit of found.hits) {
          permission('search', revision)
          const reference = evidenceJson({ sourceId: hit.sourceId, sourceDigest: hit.sourceDigest,
            attemptId: hit.attemptId, locator: hit.locator })
          // Query text is only a pointer. Exact fetch supplies every released byte.
          const text = exact(store, reference)
          const remaining = bounds.maxTotalTextBytes - releasedBytes - outputBytes
          if (remaining <= 0) fail('budget-exhausted')
          const projected = clip(text, Math.min(bounds.maxTextBytes, remaining))
          outputBytes += bytes(projected.text)
          const handle = randomUUID()
          pending.push([handle, { reference, textDigest: digest(text), revision }])
          items.push({ handle, ...projected, kind: 'source-evidence', semanticAcceptance: 'pending' })
        }
        permission('search', revision)
        for (const [key, value] of pending) handles.set(key, value)
        releasedBytes += outputBytes
        return { schema, status: 'ok', items, coverage: 'partial', readScope: 'all-plan', ...flags }
      })
    },
    get(input) {
      return execute(input, 'get', request => {
        if (typeof request.handle !== 'string' || request.handle.length > 64) fail('invalid-request')
        const revision = permission('get')
        const held = handles.get(request.handle)
        if (!held || held.revision !== revision) fail()
        reserve(1)
        const store = openStore({ workspaceRoot, workspaceId })
        permission('get', revision)
        const text = exact(store, held.reference)
        if (digest(text) !== held.textDigest) fail()
        const projected = clip(text, Math.min(bounds.maxTextBytes, bounds.maxTotalTextBytes - releasedBytes))
        permission('get', revision)
        releasedBytes += bytes(projected.text)
        return { schema, status: 'ok', item: { handle: request.handle, ...projected, kind: 'source-evidence', semanticAcceptance: 'pending' },
          coverage: 'partial', readScope: 'all-plan', ...flags }
      })
    },
    close() { closed = true; handles.clear() },
  })
}
