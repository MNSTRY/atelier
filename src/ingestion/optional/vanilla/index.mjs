import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

// Private supplier serialization, not an ontology, ledger, or public contract.
export const VANILLA_CAPTURE_FORMAT = 'atelier.vanilla-extraction-capture/v0'
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024 // Existing intake UTF-8 ceiling.
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fields = ['inputTokens', 'outputTokens', 'cost', 'currency', 'elapsedMs', 'retries']

export class VanillaIngestionError extends Error {
  constructor(code, message, { cause, recovery, recorded, captured, attemptedCapture, uncaptured } = {}) {
    super(message, { cause }); this.name = 'VanillaIngestionError'; this.code = code
    if (recovery) this.recovery = recovery
    if (recorded) this.recorded = recorded
    if (captured) this.captured = captured
    if (attemptedCapture) this.attemptedCapture = attemptedCapture
    if (uncaptured) this.uncaptured = uncaptured
  }
}
function check(value, code, message) { if (!value) throw new VanillaIngestionError(code, message) }
function ownData(value, key) {
  if (value === null || !['object', 'function'].includes(typeof value)) return undefined
  try { return Object.getOwnPropertyDescriptor(value, key)?.value } catch { return undefined }
}
function same(left, right) {
  // Object key order is not an intake or runner receipt contract.
  const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return stable(left) === stable(right)
}
function rawBytes(output) {
  check(typeof output === 'string' || output instanceof Uint8Array, 'VANILLA_OUTPUT', 'Extractor output must be text or bytes')
  return Buffer.from(output) // Copy: the host cannot mutate the captured buffer later.
}
function captureFor(status, output, suppliedUsage, elapsedMs) {
  const bytes = rawBytes(output)
  const usage = Object.fromEntries(fields.map(key => [key, suppliedUsage?.[key] ?? (key === 'elapsedMs' ? elapsedMs : null)]))
  for (const value of Object.values(usage)) check(typeof value !== 'number' || Number.isFinite(value),
    'VANILLA_USAGE_ENCODING', 'Nonfinite reported usage cannot be losslessly encoded; retain returned bytes and settle host accounting')
  const capture = {
    format: VANILLA_CAPTURE_FORMAT,
    inputDigest: status.input.digest,
    extractor: status.extractor,
    raw: { encoding: 'base64', bytes: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') },
    usage, usageAssurance: 'host-reported',
    timing: { extractionElapsedMs: elapsedMs, assurance: 'host-measured-monotonic' },
    coverage: status.input.coverage,
  }
  const outputEnvelope = JSON.stringify(capture)
  check(Buffer.byteLength(outputEnvelope) <= MAX_CAPTURE_BYTES, 'VANILLA_CAPTURE_LIMIT', 'Capture exceeds the existing intake byte ceiling')
  return { capture, outputEnvelope, outputDigest: digest(outputEnvelope) }
}

/** Verify the immutable wrapper and exact producer/input pins before reuse. */
export function readVanillaCapture(status) {
  check(['partial', 'complete'].includes(status?.attempt?.status) && typeof status.attempt.output === 'string', 'VANILLA_CAPTURE_MISSING', 'No saved extraction bytes are available')
  const outputEnvelope = status.attempt.output
  check(Buffer.byteLength(outputEnvelope) <= MAX_CAPTURE_BYTES, 'VANILLA_CAPTURE_LIMIT', 'Saved capture exceeds the intake ceiling')
  let capture
  try { capture = JSON.parse(outputEnvelope) } catch (cause) { throw new VanillaIngestionError('VANILLA_CAPTURE_INTEGRITY', 'Saved output is not a vanilla capture', { cause }) }
  check(capture?.format === VANILLA_CAPTURE_FORMAT && capture.inputDigest === status.input.digest &&
    same(capture.extractor, status.extractor) && capture.coverage === status.input.coverage &&
    capture.usageAssurance === 'host-reported' && same(Object.keys(capture.usage ?? {}).sort(), [...fields].sort()),
  'VANILLA_CAPTURE_INTEGRITY', 'Capture producer, input, coverage or usage pins differ')
  const raw = capture.raw
  check(raw?.encoding === 'base64' && typeof raw.data === 'string' && Number.isSafeInteger(raw.bytes) && raw.bytes >= 0,
    'VANILLA_CAPTURE_INTEGRITY', 'Capture must retain exact encoded raw bytes')
  const bytes = Buffer.from(raw.data, 'base64')
  check(bytes.toString('base64') === raw.data && bytes.length === raw.bytes && digest(bytes) === raw.sha256,
    'VANILLA_CAPTURE_INTEGRITY', 'Extractor raw-byte digest differs')
  const outputDigest = digest(outputEnvelope)
  check(status.attempt.status !== 'complete' || status.attempt.completion?.outputDigest === outputDigest,
    'VANILLA_CAPTURE_INTEGRITY', 'Intake envelope digest differs')
  if (status.phase === 'completed') check(same(status.usage, capture.usage), 'VANILLA_CAPTURE_INTEGRITY', 'Recorded usage differs from immutable capture')
  return { capture, bytes, outputEnvelope, outputDigest }
}

export function normalizeCandidateJson({ bytes }) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

/** A provider-free authored/deterministic callback; vocabulary remains host-owned. */
export function createCandidateExtractor(buildCandidates) {
  check(typeof buildCandidates === 'function', 'VANILLA_EXTRACTOR', 'A candidate authoring function is required')
  return async ({ input, extractor, signal }) => {
    check(['authored', 'deterministic'].includes(extractor.route), 'VANILLA_EXTRACTOR', 'This helper only implements provider-free routes')
    const candidates = await buildCandidates({ input, signal })
    return { output: JSON.stringify(candidates), usage: { inputTokens: 0, outputTokens: 0, cost: 0, currency: null, retries: 0 } }
  }
}

/** Host composition supplies the existing createSemanticOperation result. */
export function createVanillaIngestionBridge({ runner, captureAttempt = null, now = () => new Date().toISOString(), monotonic = () => performance.now() }) {
  for (const method of ['begin', 'status', 'complete', 'proposals']) check(typeof runner?.[method] === 'function', 'VANILLA_RUNNER', `Existing semantic runner.${method} is required`)
  check(captureAttempt === null || typeof captureAttempt === 'function', 'VANILLA_CAPTURE', 'The existing intake completion callback is required when supplied')
  function notAborted(signal) { check(!signal?.aborted, 'VANILLA_ABORTED', 'Host cancelled extraction or interpretation; reopen saved state') }
  async function failure(error, operationId, stage, extra = {}) {
    let status = null
    try { status = await runner.status({ operationId }) } catch { /* Never erase original saved receipts. */ }
    let captured = extra.captured
    const attemptedCapture = extra.attemptedCapture ?? ownData(error, 'captured')
    const expectedOutputDigest = extra.expectedOutputDigest ?? ownData(ownData(attemptedCapture, 'completion'), 'outputDigest')
    const expectedAttemptId = extra.expectedAttemptId ?? ownData(attemptedCapture, 'attemptId')
    if (!captured && !extra.captureReadbackFailed && (expectedOutputDigest || stage === 'recovery') &&
      ['partial', 'complete'].includes(status?.attempt?.status)) {
      try {
        const saved = readVanillaCapture(status)
        if (status.operationId === operationId && (!expectedOutputDigest || saved.outputDigest === expectedOutputDigest) &&
          (!expectedAttemptId || status.attempt.attempt.attemptId === expectedAttemptId)) captured = { attemptId: status.attempt.attempt.attemptId,
          completion: status.attempt.completion, head: status.head, nextAction: 'reopen-captured-output' }
      } catch { /* Unverified readback is never presented as a saved receipt. */ }
    }
    const code = ownData(error, 'code'), message = ownData(error, 'message')
    return new VanillaIngestionError(typeof code === 'string' ? code : 'VANILLA_INTERRUPTED', typeof message === 'string' ? message : 'Host operation was interrupted', {
      cause: error, recorded: ownData(error, 'recorded'), captured, attemptedCapture, uncaptured: captured ? undefined : extra.uncaptured,
      recovery: { operationId, stage, phase: status?.phase ?? null, execution: status?.execution ?? 'unknown',
        nextAction: captured ? 'resume-interpretation-from-capture' : 'inspect-and-explicitly-reconcile-execution',
        extractorMayRunAgain: false },
    })
  }
  async function verifyCapture({ operationId, attemptId, expectedOutputDigest, completion }) {
    const reread = await runner.status({ operationId })
    const verified = readVanillaCapture(reread)
    check(reread.operationId === operationId && reread.attempt.attempt.attemptId === attemptId &&
      reread.attempt.status === 'complete' && verified.outputDigest === expectedOutputDigest && same(completion, reread.attempt.completion),
    'VANILLA_CAPTURE_INTEGRITY', 'Existing intake completion readback differs')
    return { attemptId, completion: reread.attempt.completion, head: reread.head, nextAction: 'reopen-captured-output' }
  }
  async function result(status, { query, proposals = null, cacheReuse = false } = {}) {
    check(status.freshness === 'current', 'VANILLA_STALE', 'Saved extraction is stale; use a new structural plan and extraction operation')
    const saved = readVanillaCapture(status)
    return { status, capture: saved.capture, proposals,
      proposalView: query === undefined ? null : await runner.proposals({ operationId: status.operationId, query }),
      cacheReuse, coverage: status.input.coverage, readScope: status.input.readScope,
      sourceReferences: status.input.evidence.map(span => span.reference),
      semanticAcceptance: 'pending', canonicalMutation: false, authority: 'none' }
  }
  async function interpret(status, { normalize, query, signal }) {
    check(status.freshness === 'current', 'VANILLA_STALE', 'Captured output is retained but its source or domain is stale')
    const saved = readVanillaCapture(status)
    if (status.phase === 'completed') return result(status, { query, cacheReuse: true })
    check(status.phase === 'reserved', 'VANILLA_RECOVERY_REQUIRED', 'Only a reserved capture may finish interpretation')
    notAborted(signal)
    const candidates = await normalize({ bytes: Buffer.from(saved.bytes), input: structuredClone(status.input), extractor: structuredClone(status.extractor) })
    notAborted(signal)
    // Reopen after asynchronous normalization. The actual runner rechecks source,
    // input, immutable raw bytes and history before recording candidates.
    const current = await runner.status({ operationId: status.operationId })
    if (current.phase === 'completed') return result(current, { query, cacheReuse: true })
    check(current.freshness === 'current', 'VANILLA_STALE', 'Source or adopted domain changed during interpretation')
    const completed = await runner.complete({ operationId: status.operationId, output: saved.outputEnvelope,
      expectedOutputDigest: saved.outputDigest, candidates, usage: saved.capture.usage, at: now(), confirm: current.head })
    return result(completed, { query, proposals: completed.proposals })
  }
  async function execute({ begin, extract, normalize = normalizeCandidateJson, query, signal }) {
    check(typeof extract === 'function' && typeof normalize === 'function', 'VANILLA_EXTRACTOR', 'Host extraction and pure normalization callbacks are required')
    notAborted(signal)
    let ready, extracted, retainedOutput, saved, captured, attemptedCapture, captureReadbackFailed = false, stage = 'reservation'
    try {
      ready = await runner.begin(begin)
      if (ready.cacheReuse) return await result(ready, { query, cacheReuse: true })
      check(ready.execution === 'ready-for-host', 'VANILLA_EXECUTION_UNKNOWN', 'Only a new ready reservation permits host extraction')
      notAborted(signal); stage = 'extraction'
      const started = monotonic()
      extracted = await extract({ input: structuredClone(ready.input), extractor: structuredClone(ready.extractor), signal,
        limits: { maxCaptureBytes: MAX_CAPTURE_BYTES, rawEncoding: 'base64' } })
      const elapsedMs = Math.max(0, Math.round(monotonic() - started))
      stage = 'capture'
      retainedOutput = { output: rawBytes(extracted?.output), usage: structuredClone(extracted?.usage) }
      saved = captureFor(ready, extracted?.output, extracted?.usage, elapsedMs)
      const current = await runner.status({ operationId: ready.operationId })
      if (captureAttempt) {
        // The manifest is the runner's reservation. Capture uses that same
        // existing intake owner; runner.complete subsequently verifies it again.
        const attemptId = current.attempt.attempt?.attemptId
        check(current.phase === 'reserved' && attemptId === ready.attempt.attempt.attemptId,
          'VANILLA_CAPTURE_INTEGRITY', 'Capture requires the original reserved intake manifest')
        attemptedCapture = { attemptId, expectedOutputDigest: saved.outputDigest, head: current.head, nextAction: 'inspect-capture-custody' }
        attemptedCapture.completion = await captureAttempt({ attemptId, output: saved.outputEnvelope, expectedOutputDigest: saved.outputDigest })
        stage = 'capture-readback'; captureReadbackFailed = true
        captured = await verifyCapture({ operationId: ready.operationId, attemptId, expectedOutputDigest: saved.outputDigest, completion: attemptedCapture.completion })
        captureReadbackFailed = false
      } else {
        // Runner-only compatibility fallback. There is currently no runner
        // capture-only method; absent candidates produce an expected refusal.
        try {
          await runner.complete({ operationId: ready.operationId, output: saved.outputEnvelope, expectedOutputDigest: saved.outputDigest,
            candidates: null, usage: saved.capture.usage, at: now(), confirm: current.head })
          throw new VanillaIngestionError('VANILLA_RUNNER_PROFILE', 'Runner unexpectedly admitted absent candidates')
        } catch (error) {
          const receipt = ownData(error, 'captured')
          if (!receipt) throw error
          attemptedCapture = receipt
          if (ownData(error, 'code') !== 'SEMANTIC_INVALID') throw error
          stage = 'capture-readback'; captureReadbackFailed = true
          captured = await verifyCapture({ operationId: ready.operationId, attemptId: ready.attempt.attempt.attemptId,
            expectedOutputDigest: saved.outputDigest, completion: ownData(receipt, 'completion') })
          captureReadbackFailed = false
        }
      }
      stage = 'interpretation'
      return await interpret(await runner.status({ operationId: ready.operationId }), { normalize, query, signal })
    } catch (error) {
      throw await failure(error, ready?.operationId ?? begin?.operationId, stage,
        { captured, attemptedCapture, captureReadbackFailed, expectedOutputDigest: saved?.outputDigest,
          expectedAttemptId: ready?.attempt?.attempt?.attemptId,
          uncaptured: stage.startsWith('capture') && !captured && extracted ? retainedOutput ?? extracted : undefined })
    }
  }
  // No extractor argument by design: recovery cannot charge extraction again.
  async function resume({ operationId, normalize = normalizeCandidateJson, query, signal }) {
    check(typeof normalize === 'function', 'VANILLA_EXTRACTOR', 'A pure normalization callback is required')
    try { return await interpret(await runner.status({ operationId }), { normalize, query, signal }) }
    catch (error) { throw await failure(error, operationId, 'recovery') }
  }
  return Object.freeze({ execute, resume })
}
