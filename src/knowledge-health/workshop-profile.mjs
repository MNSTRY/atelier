import { canonicalize } from '../attestation/jcs.mjs'
import { contentDigest } from '../coauthor/session.mjs'
import { assessKnowledgeHealthWorkshop } from './workshop.mjs'

// A consumer profile of the existing knowledge-session descriptor and coauthor
// fields. These are private drafts, not typed native finding-disposition receipts.
export const PUBLIC_WORKSHOP_FLOW = Object.freeze({
  id: 'workshop', title: 'Workshop',
  description: 'Read the finding, retain your words, and choose your response.',
  prompts: [
    ['original-words', 'What do you make of this finding?', 'Your wording is retained exactly. A missing relationship does not decide readiness.'],
    ['interpretation', 'Optional interpretation', 'Leave it empty, or record a separate interpretation. Proposed wording requires confirmation.'],
    ['choice', 'Which response do you choose?', 'Choose note, perspective-only, disagreement or pause. Review is a separate optional action.'],
  ],
})
export const PUBLIC_WORKSHOP_CHOICES = Object.freeze(['note', 'perspective-only', 'disagreement', 'pause'])
const LEGACY_WORKSHOP_CHOICES = [...PUBLIC_WORKSHOP_CHOICES, 'revision']
export const PUBLIC_PARTICIPANT_PROFILE = 'four-choice-separate-review-r1'
export const PUBLIC_WORKSHOP_REVIEW_FLOW = Object.freeze({ id: 'workshop-review', title: 'Review selected declaration',
  prompts: [['authored-revision', 'Selected draft declaration', 'Save the selected declaration as a private draft. Source-owner editing remains separate.']] })

export function inspectPublicWorkshop({ workspaceRoot }) {
  return assessKnowledgeHealthWorkshop({ workspaceRoot })
}

export function publicWorkshopProfile(workspaceRoot) {
  const observation = inspectPublicWorkshop({ workspaceRoot })
  const a = observation.assessment, f = a.findings?.[0], e = a.evidence
  if (a.status !== 'needs-attention' || a.coverage !== 'complete' || a.currency !== 'current'
    || a.refusal !== null || a.findings.length !== 1 || !f.actionable
    || f.source.id !== 'devday:checklist' || f.declaration.id !== 'kg.relations.supports'
    || e.relationId !== 'checklist-workshop' || e.questionId !== 'workshop-readiness'
    || f.declaration.quote !== '[]') throw new Error('public workshop finding unavailable')
  const findingReference = { id: f.referenceKey, checkId: f.check.id, checkVersion: f.check.version,
    planSha256: e.planSha256, readSetSha256: e.readSetSha256, comparisonSha256: e.comparisonSha256 }
  if (Object.values(findingReference).some(v => typeof v !== 'string' || !v)
    || [e.planSha256, e.readSetSha256, e.comparisonSha256].some(v => !/^[a-f0-9]{64}$/.test(v)))
    throw new Error('public workshop finding fingerprints unavailable')
  const context = { ...structuredClone(observation.context), findingReference,
    workshop: structuredClone(observation.workshop), finding: structuredClone(f),
    meaning: 'ordinary-public-coauthor-drafts', participantResponseProfile: PUBLIC_PARTICIPANT_PROFILE, typedFindingDisposition: false,
    sourceApply: 'source-owner-copy-only', semanticSupport: 'unassessed' }
  return { flow: PUBLIC_WORKSHOP_FLOW, context, ref: 'records/checklist.md',
    sourceDigest: f.source.sha256, contextDigest: contentDigest(canonicalize(context)) }
}

// Validate only this consumer's ordinary draft fields. The owning engine still
// owns revisions, confirmation, event identity, saves, receipts and recovery.
function validateLegacyPublicWorkshopEvent(record, state, event) {
  if (record.flow !== PUBLIC_WORKSHOP_FLOW.id || !['answer', 'propose'].includes(event?.type)) return
  const field = state.fields[state.index]?.id
  if (field === 'choice' && !LEGACY_WORKSHOP_CHOICES.includes(event.text))
    throw new Error('choose an exact public workshop response')
  if (field === 'authored-revision') {
    const choice = state.saved.find(s => s.fieldId === 'choice')?.text
    if (event.text !== (choice === 'revision' ? '["devday:workshop"]' : 'none'))
      throw new Error('revision wording must match the retained explicit choice')
  }
}

function prepareLegacyPublicWorkshopHandoff(session) {
  const { record, state, current } = session
  if (!current || record.flow !== PUBLIC_WORKSHOP_FLOW.id || state.phase !== 'complete')
    throw new Error('a complete current public workshop draft is required')
  const values = Object.fromEntries(state.saved.map(s => [s.fieldId, s.text]))
  if (values.choice !== 'revision' || values['authored-revision'] !== '["devday:workshop"]')
    throw new Error('an explicitly retained revision choice is required')
  const anchor = record.context.workshop.binding.field
  return { sessionId: record.id, viewId: 'knowledge-workshop', path: 'records/checklist.md',
    action: 'copy.repoPath', actor: record.author,
    intent: 'Source owner reviews one supporting declaration.', directWrite: false, applyEndpoint: null,
    diff: { source: record.context.workshop.binding.source, anchor, replacement: values['authored-revision'] },
    proposal: { directWrite: false, applyEndpoint: null,
      reason: 'Retained participant wording; source-owner editing and readback remain explicit.',
      originalWords: values['original-words'], interpretation: values.interpretation, choice: values.choice,
      authoredRevision: values['authored-revision'], findingReference: record.context.findingReference,
      source: record.context.workshop.binding.source, anchor,
      readSet: record.context.assessment.evidence.readSet,
      savedDraftReceipts: state.saved.map(s => s.receipt), sourceEditsApplied: false,
      typedFindingDisposition: false, semanticAcceptance: false } }
}


// An inert consumer encoding lets the existing nonempty-text draft store retain
// an explicitly empty interpretation. It changes no owning draft schema.
export function encodePublicWorkshopInterpretation(text) {
  checkWords(text, true)
  return JSON.stringify({ text })
}
export function decodePublicWorkshopInterpretation(value) {
  const parsed = JSON.parse(value)
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).join(',') !== 'text')
    throw new Error('one separately labeled interpretation required')
  checkWords(parsed.text, true)
  return parsed.text
}
function checkWords(text, optional = false) {
  if (typeof text !== 'string' || (!optional && !text.trim())
    || Buffer.byteLength(text, 'utf8') > 512 || Buffer.from(text, 'utf8').toString('utf8') !== text)
    throw new Error('lossless participant wording exceeds its 512 UTF-8 byte limit')
}
export function validatePublicWorkshopEvent(record, state, event) {
  if (record.context?.participantResponseProfile !== PUBLIC_PARTICIPANT_PROFILE)
    return validateLegacyPublicWorkshopEvent(record, state, event)
  if (!['answer', 'propose'].includes(event?.type)) return
  const field = state.fields[state.index]?.id
  if (record.flow === 'workshop-review') {
    if (field !== 'authored-revision' || event.text !== '["devday:workshop"]')
      throw new Error('only the explicitly selected workshop declaration is supported')
    return
  }
  if (record.flow !== 'workshop') throw new Error('unsupported participant flow')
  if (field === 'original-words') {
    if (event.type === 'propose') throw new Error('interpretation must not replace original words')
    checkWords(event.text)
  } else if (field === 'interpretation') decodePublicWorkshopInterpretation(event.text)
  else if (field === 'choice' && (event.type === 'propose' || !PUBLIC_WORKSHOP_CHOICES.includes(event.text)))
    throw new Error('choose one of the four participant responses yourself; Review is separate')
}
export function readPublicWorkshopContribution(session) {
  const { record, state } = session
  if (record.flow !== 'workshop' || record.context?.participantResponseProfile !== PUBLIC_PARTICIPANT_PROFILE)
    throw new Error('four-response participant session required; legacy history stays readable')
  const saved = Object.fromEntries(state.saved.map(value => [value.fieldId, value]))
  const lastAnswer = field => state.answers.filter(value => value.fieldId === field).at(-1)
  const currentChoice = state.fields[state.index]?.id === 'choice' ? state.proposal : null
  return { sessionId: record.id, originalContributionId: lastAnswer('original-words')?.eventId ?? null,
    originalChoiceId: lastAnswer('choice')?.eventId ?? null,
    originalWords: saved['original-words']?.text ?? lastAnswer('original-words')?.text ?? null,
    interpretation: saved.interpretation ? decodePublicWorkshopInterpretation(saved.interpretation.text) : null,
    interpretationRecorded: Boolean(saved.interpretation),
    choice: saved.choice?.text ?? currentChoice?.text ?? null,
    choiceStatus: saved.choice && session.owningReadbacks?.verified === true ? 'confirmed'
      : currentChoice ? 'unconfirmed' : 'not-recorded',
    receipts: state.saved.map(value => value.receipt),
    owningReadbacks: session.owningReadbacks ?? null,
    findingReference: structuredClone(record.context.findingReference),
    typedFindingDisposition: false, semanticAcceptance: false }
}
export function publicWorkshopReviewProfile(workspaceRoot, participant) {
  const contribution = readPublicWorkshopContribution(participant)
  if (!participant.current || participant.state.phase !== 'complete'
    || contribution.choiceStatus !== 'confirmed' || !PUBLIC_WORKSHOP_CHOICES.includes(contribution.choice)
    || !contribution.originalContributionId || !contribution.originalChoiceId)
    throw new Error('current contribution and both owning readbacks required before separate Review')
  const profile = publicWorkshopProfile(workspaceRoot)
  if (canonicalize(profile.context.findingReference) !== canonicalize(participant.record.context.findingReference))
    throw new Error('finding changed; refresh before selecting a new draft')
  const context = { ...profile.context, participant: structuredClone(contribution) }
  return { ...profile, flow: PUBLIC_WORKSHOP_REVIEW_FLOW, context,
    contextDigest: contentDigest(canonicalize(context)) }
}
export function preparePublicWorkshopHandoff(session) {
  if (session.record.flow !== 'workshop-review') return prepareLegacyPublicWorkshopHandoff(session)
  const { record, state, current } = session
  const selected = state.saved.find(value => value.fieldId === 'authored-revision')
  const participant = record.context.participant
  if (!current || state.phase !== 'complete' || session.owningReadbacks?.verified !== true
    || !participant || participant.choiceStatus !== 'confirmed'
    || !selected || selected.text !== '["devday:workshop"]')
    throw new Error('current selected draft and both owning readbacks required')
  const anchor = record.context.workshop.binding.field
  return { sessionId: record.id, viewId: 'knowledge-workshop', path: 'records/checklist.md',
    action: 'copy.repoPath', actor: record.author, intent: 'Source owner reviews one supporting declaration.',
    directWrite: false, applyEndpoint: null,
    diff: { source: record.context.workshop.binding.source, anchor, replacement: selected.text },
    proposal: { directWrite: false, applyEndpoint: null, sourceEditsApplied: false,
      originalWords: participant.originalWords, interpretation: participant.interpretation,
      choice: participant.choice, originalContributionId: participant.originalContributionId,
      originalChoiceId: participant.originalChoiceId, contributionSessionId: participant.sessionId,
      authoredRevision: selected.text, findingReference: record.context.findingReference,
      source: record.context.workshop.binding.source, anchor, readSet: record.context.assessment.evidence.readSet,
      savedDraftReceipts: [...participant.receipts, selected.receipt],
      selectedDraftReceipt: selected.receipt, declarationBytes: { encoding: 'utf8', before: anchor.quote, after: selected.text },
      typedFindingDisposition: false, semanticAcceptance: false } }
}
