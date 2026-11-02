import { deepFreeze } from '../composition/wire.mjs'
import { refKey } from './refs.mjs'
import { refuse } from './errors.mjs'

// Validation emits no action. A host must separately revalidate current grants
// and source before accepting any stale-sensitive operation.
export function assertGraphViewIntent(view, intent) {
  if (!intent || intent.projectionDigest !== view.projectionDigest) refuse('stale_source')
  const specifications = {
    select: ['type', 'projectionDigest', ...(Object.hasOwn(intent, 'ref') ? ['ref'] : ['edgeId'])],
    expand: ['type', 'projectionDigest', 'ref', 'direction'],
    openEvidence: ['type', 'projectionDigest', 'evidenceId'],
    setQuestion: ['type', 'projectionDigest', 'questionId'],
    compareSnapshots: ['type', 'projectionDigest', 'a', 'b'],
    proposeModelChange: ['type', 'projectionDigest', 'draftRef'],
  }
  const allowed = Object.hasOwn(specifications, intent.type) ? specifications[intent.type] : null
  if (!allowed || Object.keys(intent).sort().join(',') !== allowed.sort().join(',')) refuse('contract_mismatch')
  if (intent.ref) {
    if (Object.keys(intent.ref).sort().join(',') !== 'localId,repoId' || !view.nodes.some(node => refKey(node.ref) === refKey(intent.ref))) refuse('unavailable')
  }
  if (intent.edgeId && !view.edges.some(edge => edge.edgeId === intent.edgeId)) refuse('unavailable')
  if (intent.type === 'select' && !intent.ref && !intent.edgeId) refuse('contract_mismatch')
  if (intent.type === 'expand' && (!intent.ref || !['in', 'out', 'both'].includes(intent.direction) || !view.capabilities.queries.includes('neighborhood'))) refuse('contract_mismatch')
  if (intent.type === 'openEvidence' && !view.evidence.some(item => item.evidenceId === intent.evidenceId)) refuse('unavailable')
  if (intent.type === 'setQuestion' && !view.questions.some(item => item.questionId === intent.questionId)) refuse('unavailable')
  if (intent.type === 'compareSnapshots' && ![intent.a, intent.b].every(value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value))) refuse('contract_mismatch')
  if (intent.type === 'proposeModelChange' && (!view.capabilities.proposalIntents.includes('proposeModelChange') || typeof intent.draftRef !== 'string' || !intent.draftRef || intent.draftRef.length > 512)) refuse('policy_refusal')
  return deepFreeze(JSON.parse(JSON.stringify(intent)))
}
