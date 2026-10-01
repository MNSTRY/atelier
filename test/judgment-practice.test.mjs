import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { harnessRef } from '../src/harnesses/contracts.mjs'
import { validateDecisionPractice, prepareDecisionPracticeContribution, readAdoptedDecisionPractice } from '../src/judgment/practice.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/atelier-judgment/practice-reconsideration/definition.json', import.meta.url)))
const template = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url))).knowledge
function adopted() {
  const records = [structuredClone(template[0])]
  const draft = prepareDecisionPracticeContribution({ records, definition: fixture, title: 'Invented reconsideration practice', term: 'material' })
  assert.equal(draft.status, 'prepared')
  const contribution = { ...structuredClone(template[1]), data: draft.data }
  records.push(contribution)
  const evaluationTemplate = template.find(record => record.kind === 'evaluation')
  const evaluation = { ...structuredClone(evaluationTemplate), data: { ...evaluationTemplate.data, contribution: harnessRef(contribution) } }
  records.push(evaluation)
  const reviewTemplate = template.find(record => record.kind === 'review')
  const review = { ...structuredClone(reviewTemplate), data: { target: harnessRef(contribution), disposition: 'accepted', basis: 'Invented simulated review.', evaluations: [harnessRef(evaluation)] } }
  records.push(review)
  const activationTemplate = template.find(record => record.kind === 'activation')
  const activation = { ...structuredClone(activationTemplate), data: { ...activationTemplate.data, reviews: [harnessRef(review)] } }
  records.push(activation)
  return { records, definitionRef: harnessRef(contribution), contribution, activation }
}

test('an internal practice composes existing Knowledge and decision forms without adoption authority', () => {
  assert.deepEqual(validateDecisionPractice(fixture), { valid: true, reasons: [] })
  const { records, definitionRef } = adopted()
  const result = readAdoptedDecisionPractice({ records, definitionRef })
  assert.equal(result.status, 'resolved')
  assert.equal(result.definition.id, fixture.id)
  assert.equal(result.executionAuthorized, false)
  assert.equal(result.authorityTransferred, false)
  assert.equal(result.semanticTruthVerified, false)
})

test('unknown fields, invalid rubric, duplicate roles, and unbounded counts refuse', () => {
  for (const edit of [value => { value.activate = true }, value => { value.rubric.questions = {} }, value => { value.evidenceRoles.push('source') }, value => { value.limits.stages = 0 }, value => { value.allowedProposals = ['activate-definition'] }]) {
    const value = structuredClone(fixture); edit(value)
    assert.equal(validateDecisionPractice(value).valid, false)
  }
})

test('definition inspection refuses an accessor without reading it or changing input', () => {
  let reads = 0
  const value = { ...fixture }
  Object.defineProperty(value, 'purpose', { enumerable: true, get() { reads++; throw new Error('private details') } })
  assert.equal(validateDecisionPractice(value).valid, false)
  assert.equal(reads, 0)
  assert.equal(Object.getOwnPropertyDescriptor(value, 'purpose').get instanceof Function, true)
})

test('an accepted contribution without current activation is not an adopted definition', () => {
  const { records, definitionRef } = adopted(); records.pop()
  assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).reason, 'unadopted-definition')
})

test('a different exact contribution digest cannot reuse adopted definition evidence', () => {
  const { records, definitionRef } = adopted()
  definitionRef.digest = `sha256:${'0'.repeat(64)}`
  assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).reason, 'changed-definition')
})

test('withdrawal invalidates the definition and its prior activation through existing Knowledge', () => {
  const { records, definitionRef, contribution } = adopted()
  records.push({ schema: 'atelier-knowledge-record@v1', id: 'withdraw-practice', run: records[0].run, at: '2026-01-01T00:00:00Z', by: 'synthetic-owner', kind: 'withdrawal', data: { target: harnessRef(contribution), reason: 'Invented retirement.' } })
  assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).reason, 'unadopted-definition')
})
