import { learningDigest, validateLearningInput } from './store.mjs'

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
