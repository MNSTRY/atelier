// Authored source only. Run after Foundation applies and qualifies the public candidate.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initializeKnowledgeHealthWorkshop } from '../src/knowledge-health/workshop.mjs'
import { createPublicWorkshopComposition } from '../src/knowledge-health/workshop-composition.mjs'
import { PUBLIC_WORKSHOP_CHOICES, PUBLIC_WORKSHOP_FLOW, PUBLIC_WORKSHOP_REVIEW_FLOW,
  encodePublicWorkshopInterpretation, decodePublicWorkshopInterpretation,
  readPublicWorkshopContribution, validatePublicWorkshopEvent } from '../src/knowledge-health/workshop-profile.mjs'

function setup(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'public-participant-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const root = initializeKnowledgeHealthWorkshop(path.join(parent, 'workshop'))
  const api = createPublicWorkshopComposition({ workspaceRoot: root })
  const requestId = '11111111-1111-4111-8111-111111111111'
  const profile = api.profile()
  let current = api.start({ requestId, flow: 'workshop', questionId: 'workshop-readiness',
    snapshot: profile.snapshot, author: 'Invented participant' })
  const event = (id, type, extra = {}) => {
    current = api.event({ sessionId: current.record.id,
      event: { id, type, expectedRevision: current.state.revision, ...extra } })
    return current
  }
  const field = (name, text) => {
    event(name + '-answer', 'answer', { text })
    event(name + '-save', 'save')
    event(name + '-advance', 'advance')
  }
  const complete = choice => {
    field('words', 'I would like more context.\nKeep my words exactly.')
    field('interpretation', encodePublicWorkshopInterpretation(''))
    field('choice', choice)
    return current
  }
  return { root, api, event, field, complete, current: () => current }
}

test('four responses are separate from the one-field Review draft', () => {
  assert.deepEqual(PUBLIC_WORKSHOP_CHOICES, ['note', 'perspective-only', 'disagreement', 'pause'])
  assert.deepEqual(PUBLIC_WORKSHOP_FLOW.prompts.map(p => p[0]), ['original-words', 'interpretation', 'choice'])
  assert.deepEqual(PUBLIC_WORKSHOP_REVIEW_FLOW.prompts.map(p => p[0]), ['authored-revision'])
})

test('optional interpretation retains blank, whitespace and exact UTF-8 boundary', () => {
  for (const text of ['', ' \n ', 'é'.repeat(256)])
    assert.equal(decodePublicWorkshopInterpretation(encodePublicWorkshopInterpretation(text)), text)
  assert.throws(() => encodePublicWorkshopInterpretation('é'.repeat(257)), /512/)
  assert.throws(() => encodePublicWorkshopInterpretation('\ud800'), /lossless/)
  assert.throws(() => decodePublicWorkshopInterpretation('{"text":"","extra":true}'), /separately labeled/)
})

test('machine proposal refuses to replace original words or choose a response', t => {
  const s = setup(t)
  assert.throws(() => s.event('machine-words', 'propose', { text: 'Replacement' }), /original words/)
  assert.equal(s.api.read(s.current().record.id).state.revision, 0)
  s.field('words', 'Exact words')
  s.field('interpretation', encodePublicWorkshopInterpretation('A separate reading'))
  assert.throws(() => s.event('machine-choice', 'propose', { text: 'note' }), /yourself/)
  assert.throws(() => s.event('fifth-choice', 'answer', { text: 'revision' }), /four/)
})

for (const choice of PUBLIC_WORKSHOP_CHOICES) test('durable public response reopens exact words and IDs: ' + choice, t => {
  const s = setup(t), complete = s.complete(choice)
  const reopened = createPublicWorkshopComposition({ workspaceRoot: s.root }).read(complete.record.id)
  const contribution = readPublicWorkshopContribution(reopened)
  assert.equal(contribution.originalWords, 'I would like more context.\nKeep my words exactly.')
  assert.equal(contribution.interpretation, '')
  assert.equal(contribution.interpretationRecorded, true)
  assert.equal(contribution.originalContributionId, 'words-answer')
  assert.equal(contribution.originalChoiceId, 'choice-answer')
  assert.equal(contribution.choice, choice)
  assert.equal(contribution.choiceStatus, 'confirmed')
  assert.equal(reopened.owningReadbacks.immutableValues.length, 3)
  assert.deepEqual(reopened.owningReadbacks.immutableValues.map(v => v.receipt), contribution.receipts)
  assert.equal(reopened.sourceEditsApplied, false)
  assert.equal(contribution.typedFindingDisposition, false)
})

test('unsaved choice remains unconfirmed and cannot start Review', t => {
  const s = setup(t)
  s.field('words', 'Original')
  s.field('interpretation', encodePublicWorkshopInterpretation(''))
  s.event('original-choice', 'answer', { text: 'disagreement' })
  assert.equal(readPublicWorkshopContribution(s.current()).choiceStatus, 'unconfirmed')
  assert.throws(() => s.api.workshopReview({ requestId: '22222222-2222-4222-8222-222222222222',
    sessionId: s.current().record.id }), /both owning readbacks/)
  assert.equal(s.api.list().total, 1)
})

test('separate Review preserves contributor, original lookup and selected save after reopen', t => {
  const s = setup(t), participant = s.complete('perspective-only')
  const input = { requestId: '22222222-2222-4222-8222-222222222222', sessionId: participant.record.id }
  const before = fs.readFileSync(path.join(s.root, 'records/checklist.md'))
  const selected = s.api.workshopReview(input)
  assert.notEqual(selected.record.id, participant.record.id)
  assert.equal(selected.record.context.participant.originalChoiceId, 'choice-answer')
  const ledger = path.join(s.root, '.atelier-local/coauthor/events.ndjson')
  const once = fs.readFileSync(ledger)
  assert.equal(s.api.workshopReview(input).record.id, selected.record.id)
  assert.deepEqual(fs.readFileSync(ledger), once)
  assert.equal(s.api.lookup({ sessionId: selected.record.id, eventId: null }).outcome, 'observed')
  let state = s.api.event({ sessionId: selected.record.id, event: { id: 'selected-answer',
    type: 'answer', expectedRevision: selected.state.revision, text: '["devday:workshop"]' } })
  state = s.api.event({ sessionId: selected.record.id, event: { id: 'selected-save', type: 'save', expectedRevision: state.state.revision } })
  s.api.event({ sessionId: selected.record.id, event: { id: 'selected-advance', type: 'advance', expectedRevision: state.state.revision } })
  const reopened = createPublicWorkshopComposition({ workspaceRoot: s.root })
  const handoff = reopened.prepareHandoff(selected.record.id)
  assert.equal(handoff.proposal.originalContributionId, 'words-answer')
  assert.equal(handoff.proposal.originalChoiceId, 'choice-answer')
  assert.equal(handoff.proposal.choice, 'perspective-only')
  assert.equal(handoff.proposal.selectedDraftReceipt.requestId, 'selected-save')
  assert.equal(handoff.proposal.savedDraftReceipts.length, 4)
  assert.equal(handoff.diff.anchor.quote, '[]')
  assert.equal(handoff.diff.replacement, '["devday:workshop"]')
  assert.equal(handoff.directWrite, false)
  assert.equal(handoff.applyEndpoint, null)
  assert.deepEqual(fs.readFileSync(path.join(s.root, 'records/checklist.md')), before)
  assert.deepEqual(reopened.read(participant.record.id).state, participant.state)
})

test('observed and absent original event lookup append nothing; lost custody stays unknown', t => {
  const s = setup(t)
  s.event('original-answer', 'answer', { text: 'Keep this original' })
  const ledger = path.join(s.root, '.atelier-local/coauthor/events.ndjson'), before = fs.readFileSync(ledger)
  assert.equal(s.api.lookup({ sessionId: s.current().record.id, eventId: 'original-answer' }).outcome, 'observed')
  assert.equal(s.api.lookup({ sessionId: s.current().record.id, eventId: 'absent-answer' }).outcome, 'not-found')
  assert.deepEqual(fs.readFileSync(ledger), before)
  fs.renameSync(ledger, ledger + '.retained')
  assert.equal(s.api.lookup({ sessionId: s.current().record.id, eventId: 'original-answer' }).outcome, 'unknown')
  assert.equal(fs.existsSync(ledger), false)
})

test('changed source refuses separate Review while prior contribution stays readable', t => {
  const s = setup(t), participant = s.complete('note')
  fs.appendFileSync(path.join(s.root, 'records/checklist.md'), '\nChanged source.\n')
  const history = s.api.read(participant.record.id)
  assert.equal(history.current, false)
  assert.equal(readPublicWorkshopContribution(history).originalChoiceId, 'choice-answer')
  assert.throws(() => s.api.workshopReview({ requestId: '33333333-3333-4333-8333-333333333333',
    sessionId: participant.record.id }), /current contribution/)
})

test('legacy descriptors keep legacy revision validation without entering new four-response profile', () => {
  const record = { flow: 'workshop', context: {} }
  assert.doesNotThrow(() => validatePublicWorkshopEvent(record, { index: 0, fields: [{ id: 'choice' }] },
    { type: 'answer', text: 'revision' }))
  assert.throws(() => readPublicWorkshopContribution({ record, state: {} }), /legacy history/)
})

test('separate proposed interpretation requires confirmation and preserves original words', t => {
  const s = setup(t)
  s.field('words', 'My original words')
  s.event('interpretation-answer', 'answer', { text: encodePublicWorkshopInterpretation('My reading') })
  s.event('interpretation-proposal', 'propose', { text: encodePublicWorkshopInterpretation('Another reading') })
  assert.equal(s.current().state.phase, 'confirmation')
  assert.throws(() => s.event('premature-save', 'save'), /refused in confirmation/)
  s.event('keep-my-reading', 'reject')
  s.event('interpretation-save', 'save')
  assert.equal(decodePublicWorkshopInterpretation(s.current().state.saved[1].text), 'My reading')
  assert.equal(s.current().state.saved[0].text, 'My original words')
  assert.equal(s.current().state.answers[0].eventId, 'words-answer')
})
