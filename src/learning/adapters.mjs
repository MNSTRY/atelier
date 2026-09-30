import { learningDigest, validateLearningInput } from './store.mjs'
import { boundedLearningValue } from './contracts.mjs'
import { assertDocument } from '../capabilities/package.mjs'

// Preserve exact version, binding and reported cause. Metadata never becomes a
// fabricated user quote, a verified causal claim or an automatic lesson.
export function capabilityEventToLearningInput({ event, scope, feedback = null }) {
  boundedLearningValue({ event, scope, feedback })
  assertDocument(event, 'event')
  if (event.ext && Object.keys(event.ext).length) throw new Error('capability event extensions are not admitted')
  let cause = event.cause
  if (feedback !== null) {
    const fields = ['event', 'subject', 'historyDigest', 'reportedCause', 'causeMapping', 'recorded', 'authority']
    if (!feedback || Object.keys(feedback).sort().join() !== fields.sort().join() ||
      learningDigest(feedback.event) !== learningDigest(event) || feedback.authority !== 'none' || feedback.recorded !== false ||
      !['skill', 'host', 'tool', 'configuration', 'context', 'provider', 'unknown'].includes(feedback.reportedCause) ||
      !/^sha256:[a-f0-9]{64}$/.test(feedback.historyDigest) ||
      !feedback.subject || Object.keys(feedback.subject).sort().join() !== 'digest,id' ||
      typeof feedback.subject.id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(feedback.subject.digest)) throw new Error('invalid harness feedback provenance')
    cause = feedback.reportedCause
    const mapped = ['context', 'provider'].includes(cause) ? 'unknown' : cause
    if (mapped !== event.cause || feedback.causeMapping !== (mapped === cause ? 'exact' : 'unsupported-steward-cause-preserved-in-wrapper')) throw new Error('feedback cause mapping mismatch')
  }
  const input = {
    id: `capability:${event.id}`,
    signal: event.kind === 'exercise' && event.outcome === 'passed' ? 'successful-run' : event.outcome === 'failed' && cause === 'tool' ? 'tool-failure' : 'exception',
    text: `Caller-reported capability metadata: ${event.kind}; outcome: ${event.outcome}; reported cause: ${cause}; package: ${event.package}; release: ${event.releaseDigest}; binding: ${event.binding}; binding digest: ${event.bindingDigest}; session: ${event.session}. Original feedback text and causal verification are unavailable.`,
    interpretation: 'tool', scope,
    source: { ref: `capability-event:${event.id}`, digest: learningDigest(feedback ?? event), locator: event.evidenceDigest },
  }
  if (validateLearningInput('capture', input).length) throw new Error('capability event cannot fit learning contract')
  return input
}

// Existing skill observations contain metadata, not the owner's actual words.
// Preserve that limitation rather than manufacturing a transcript or lesson.
export function skillObservationToLearningInput({ receipt, scope }) {
  const observation = receipt?.observation
  if (receipt?.schema !== 'mnstry.atelier-skill-observation-receipt@v1' || receipt.ok !== true
    || typeof observation?.id !== 'string' || typeof observation.workflowKey !== 'string'
    || typeof observation.signal !== 'string' || typeof observation.outcome !== 'string') {
    throw new Error('valid skill observation receipt required')
  }
  const supported = { 'user-correction': 'user-correction', 'successful-run': 'successful-run', 'tool-failure': 'tool-failure' }
  const input = {
    id: `skill:${observation.id}`, signal: supported[observation.signal] ?? 'exception',
    text: `Skill metadata: ${observation.signal}; outcome: ${observation.outcome}; workflow: ${observation.workflowKey}. Original feedback text is unavailable.`,
    interpretation: 'tool', scope,
    source: { ref: `skill-receipt:${observation.id}`, digest: learningDigest(receipt) },
  }
  if (validateLearningInput('capture', input).length) throw new Error('skill observation cannot fit learning contract')
  return input
}

// A legacy proposal is evidence for a new proposal. Its old status/receipt can
// never activate anything in this workspace. The caller selects exact local
// evidence and scope; review remains a separate operation.
export function legacyLessonToLearningInput({ legacy, id, scope, evidenceIds, artifact }) {
  if (!legacy || typeof legacy.id !== 'string' || typeof legacy.claim !== 'string'
    || !legacy.claim.trim()) throw new Error('legacy lesson claim required')
  const input = { id, title: artifact?.name, principle: legacy.claim,
    rationale: 'Imported proposal; its prior acceptance and activation are not authority in this workspace.',
    exceptions: [], evidenceIds, scope, artifact,
  }
  if (validateLearningInput('propose', input).length) throw new Error('legacy proposal cannot fit learning contract')
  return { input, provenance: { sourceId: legacy.id, sourceDigest: learningDigest(legacy),
    authorityTransferred: false } }
}
