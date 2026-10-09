import { createHash } from 'node:crypto'
import { PRESENCE_PROFILES } from '../evaluation/index.mjs'

// Private host execution declarations reuse existing capability owners. This is
// not a capability-adoption, identity, evidence or knowledge canonical.
const json = value => JSON.stringify(value)
const digest = value => createHash('sha256').update(json(value)).digest('hex')
const ownValue = (object, key) => Object.getOwnPropertyDescriptor(object ?? {}, key)?.value
const callableFor = (bindings, step) => ownValue(ownValue(bindings, step.provider), step.operation)
const compiledCallables = new WeakMap()

export function compileRoute({ profile, selected, bindings, operationRoles }) {
  if (!PRESENCE_PROFILES.includes(profile) || !selected || !ownValue(bindings, 'vanilla') || !operationRoles) throw new TypeError('Known presence profile, selected route, vanilla binding and own operation-role declarations required')
  const present = new Set(['vanilla', ...(profile === 'vanilla' ? [] : profile.split('+'))])
  const used = new Set(), callables = new Map()
  const resolve = (step, role) => {
    const callable = callableFor(bindings, step ?? {})
    if (typeof step?.provider !== 'string' || typeof step?.operation !== 'string' || !present.has(step.provider) ||
      typeof callable !== 'function') throw new Error(`Selected ${role} capability is unavailable in this profile`)
    if (step.provider === 'jev' && role !== 'assess') throw new Error('Jev supplies bounded judgments rather than extraction or generation')
    const id = `${step.provider}/${step.operation}`
    if (used.has(id)) throw new Error('Duplicate selected operation across route roles')
    if (ownValue(ownValue(operationRoles, step.provider), step.operation) !== role) throw new Error(`Selected operation is not declared for ${role}`)
    used.add(id)
    callables.set(id, callable)
    return Object.freeze({ provider: step.provider, operation: step.operation, role, options: structuredClone(step.options ?? {}) })
  }
  const list = (values, role) => {
    if (!Array.isArray(values)) throw new TypeError(`Explicit selected ${role} operations required`)
    return values.map(x => resolve(x, role))
  }
  const route = { profile, extractor: selected.extractor ? resolve(selected.extractor, 'extract') : null,
    assessors: list(selected.assessors ?? [], 'assess'), projectors: list(selected.projectors ?? [], 'project'),
    retrievers: list(selected.retrievers ?? [], 'retrieve'), answerer: selected.answerer ? resolve(selected.answerer, 'answer') : null,
    nativeAnswer: selected.nativeAnswer ? resolve(selected.nativeAnswer, 'native-answer') : null,
    view: selected.view ?? 'native-exploration' }
  if (!['native-exploration', 'accepted-knowledge'].includes(route.view)) throw new Error('Explicit native exploration or existing accepted knowledge view required')
  if (route.answerer && !route.retrievers.length) throw new Error('Grounded answer route needs selected evidence retrieval')
  if (route.nativeAnswer && (route.answerer || route.retrievers.length)) throw new Error('Coupled native retrieval/answer is a separate route; do not duplicate retrieval or generation')
  const compiled = Object.freeze({ ...route, routeDigest: digest(route) })
  compiledCallables.set(compiled, callables)
  return compiled
}

function answerReference(ref) {
  if (!ref || ['sourceId', 'revision', 'representationId'].some(k => typeof ownValue(ref, k) !== 'string' || !ownValue(ref, k) || ownValue(ref, k).length > 256)) return null
  const locator = ownValue(ref, 'locator')
  if (typeof locator === 'string' ? !locator || locator.length > 16384 :
    !locator || Object.keys(locator).sort().join(',') !== 'kind,value' || ['kind','value'].some(k => typeof ownValue(locator, k) !== 'string' || !ownValue(locator, k) || ownValue(locator, k).length > 16384)) return null
  return { sourceId: ownValue(ref, 'sourceId'), revision: ownValue(ref, 'revision'),
    representationId: ownValue(ref, 'representationId'), locator: typeof locator === 'string' ? locator :
      { kind: ownValue(locator, 'kind'), value: ownValue(locator, 'value') } }
}

export async function composeEvidence(bundles, { eligible }) {
  if (!Array.isArray(bundles) || typeof eligible !== 'function') throw new TypeError('Located bundles and actual current evidence owner required')
  const combined = new Map(), unresolved = [], excluded = []
  for (const bundle of bundles) {
    if (!bundle?.provider || !Array.isArray(bundle.hits)) throw new TypeError('Each native bundle needs provider and hits')
    // Explicit declined native citations survive receiving and prevent a coupled
    // answer from appearing fully grounded merely because some hits mapped.
    for (const field of ['unresolved', 'unresolvedReferences']) {
      if (bundle[field] !== undefined && !Array.isArray(bundle[field])) throw new TypeError('Native receiving gaps must be explicit arrays')
      for (const gap of bundle[field] ?? []) unresolved.push({ provider: bundle.provider, receivingGap: structuredClone(gap) })
    }
    for (const hit of bundle.hits) {
      // Detach the exact inspected quote/reference before asynchronous receiving.
      const nativeHit = structuredClone(hit), reference = answerReference(nativeHit?.evidenceRef), quote = nativeHit?.quote
      if (!reference || typeof quote !== 'string' || !quote) { unresolved.push({ provider: bundle.provider, hit: nativeHit }); continue }
      const identity = json([reference.sourceId, reference.revision, reference.representationId, reference.locator, quote])
      const verdict = await eligible(structuredClone(reference), { quote, provider: bundle.provider, generation: bundle.generation })
      if (verdict?.current !== true || verdict?.permitted !== true || verdict?.supported !== true) { excluded.push({ provider: bundle.provider, hit: nativeHit, reason: verdict?.reason ?? 'exact-quote-support-unreceived' }); continue }
      if (!combined.has(identity)) combined.set(identity, { evidenceRef: reference, quote, observations: [] })
      combined.get(identity).observations.push({ provider: bundle.provider, generation: bundle.generation ?? null,
        nativeHit, score: nativeHit.score ?? null, scoreSemantics: nativeHit.scoreSemantics ?? 'unmapped-native-score' })
    }
  }
  return { hits: [...combined.values()], unresolved, excluded,
    providerArtifacts: bundles.map(x => ({ provider: x.provider, generation: x.generation ?? null, artifactRef: x.artifactRef ?? null })),
    distinctSourceCount: new Set([...combined.values()].map(x => x.evidenceRef.sourceId)).size,
    combinedScore: null, acceptance: 'existing-owner-view-only' }
}

// Only eligible located evidence reaches ordinary answer generation. Raw hits,
// artifacts, view content and native rejection strings stay in receipt custody.
function answerEvidence(evidence) {
  return { hits: evidence.hits.map(x => ({ evidenceRef: answerReference(x.evidenceRef), quote: x.quote })),
    distinctSourceCount: evidence.distinctSourceCount,
    rejectionCounts: { unlocated: evidence.unresolved.length, ineligible: evidence.excluded.length } }
}

export class CompositionFailure extends Error {
  constructor(cause, state) {
    super(`Selected route needs owner reconciliation: ${cause.message}`, { cause })
    this.name = 'CompositionFailure'
    Object.assign(this, state)
  }
}

/** Host bridges retain actual effect admission, view and evidence authority.
 * No implicit retry or fallback occurs. Receipt custody survives late failures.
 */
export function createComposition({ bindings, operationRoles, invoke, readKnowledgeView, eligible }) {
  if (!operationRoles || typeof invoke !== 'function' || typeof readKnowledgeView !== 'function' || typeof eligible !== 'function') throw new TypeError('Actual operation roles, effect, knowledge-view and evidence owners required')
  return Object.freeze({ async execute({ route, input, question, signal }) {
    const compiled = compileRoute({ profile: route.profile, selected: route, bindings, operationRoles })
    const receipts = [], retainedResults = [], dispatched = []
    let failedStep = null, effectUncertain = false
    const call = async (step, payload) => {
      failedStep = step
      if (signal?.aborted) throw new Error('Host cancelled selected route')
      // Each owner receives an isolated payload; prior results remain under
      // separate custody even when a later callable mutates its own input.
      const invocationPayload = structuredClone(payload)
      dispatched.push(step); effectUncertain = true
      const returned = await invoke({ step, callable: compiledCallables.get(compiled).get(`${step.provider}/${step.operation}`), payload: invocationPayload, routeDigest: compiled.routeDigest, signal })
      let result
      try { result = structuredClone(returned) }
      catch (snapshotError) {
        // Returned data/costs remain in custody even when a snapshot cannot be
        // made. Do not continue grounding or pretend this live value is frozen.
        retainedResults.push({ step, result: returned, snapshotState: 'failed', snapshotError })
        throw snapshotError
      }
      // Retain a detached snapshot even when its receipt is malformed.
      retainedResults.push({ step, result, snapshotState: 'received' })
      if (!result || !result.receiptRef) throw new Error('Selected operation must return its actual receipt reference')
      receipts.push(structuredClone({ ...step, receiptRef: result.receiptRef, usage: result.usage ?? null }))
      effectUncertain = false; failedStep = null
      return structuredClone(result)
    }
    const counts = () => ({ selectedExtractorCount: dispatched.filter(x => x.role === 'extract').length,
      selectedAnswererCount: dispatched.filter(x => ['answer', 'native-answer'].includes(x.role)).length })
    try {
      const extraction = compiled.extractor ? await call(compiled.extractor, { input }) : null
      const assessments = []
      for (const step of compiled.assessors) assessments.push(await call(step, { input, extraction }))
      const view = structuredClone(await readKnowledgeView(structuredClone({ requestedView: compiled.view, input, extraction, assessments, routeDigest: compiled.routeDigest })))
      if (!view?.ownerRef || view.kind !== compiled.view) throw new Error('Existing knowledge owner must return the selected view')
      const projections = []
      for (const step of compiled.projectors) projections.push(await call(step, { input, view }))
      if (compiled.nativeAnswer) {
        // Existing host must admit authorized current input before a coupled
        // native model call. Final evidence validation is a separate check.
        const native = await call(compiled.nativeAnswer, { input, question, view, projections })
        if (!Array.isArray(native.hits)) throw new Error('Coupled native answer must return located evidence references')
        const evidence = await composeEvidence([{ ...native, provider: compiled.nativeAnswer.provider }], { eligible })
        const current = evidence.excluded.length === 0 && evidence.unresolved.length === 0 && evidence.hits.length > 0
        return { routeDigest: compiled.routeDigest, extraction, assessments, view, projections, evidence,
          answer: current ? native : null, withheldNativeResult: current ? null : native,
          answerStatus: current ? 'current-grounding-received' : 'withheld-grounding-unreceived', receipts,
          ...counts(), nativeAnswerGroundingCurrent: current,
          canonicalMutation: false, semanticAcceptance: 'existing-owner-only', nativeQualification: false }
      }
      const bundles = []
      for (const step of compiled.retrievers) {
        const result = await call(step, { input, question, view, projections })
        if (!Array.isArray(result.hits)) throw new Error('Retriever must return located evidence hits')
        bundles.push({ ...result, provider: step.provider })
      }
      const evidence = await composeEvidence(bundles, { eligible })
      const answer = compiled.answerer ? await call(compiled.answerer, { question, evidence: answerEvidence(evidence),
        view: { kind: view.kind, ownerRef: view.ownerRef } }) : null
      return { routeDigest: compiled.routeDigest, extraction, assessments, view, projections, evidence, answer, receipts,
        ...counts(), canonicalMutation: false, semanticAcceptance: 'existing-owner-only', nativeQualification: false }
    } catch (cause) {
      throw new CompositionFailure(cause, { routeDigest: compiled.routeDigest, receipts, retainedResults, failedStep,
        effectUncertain, ...counts(), retryAuthorized: false })
    }
  } })
}
