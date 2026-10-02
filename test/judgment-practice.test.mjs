import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { contentDigest, harnessRef, validateHarnessDocument } from '../src/harnesses/contracts.mjs'
import { evidenceJson } from '../src/evidence-navigation/contracts.mjs'
import { inspectKnowledge } from '../src/knowledge/ledger.mjs'
import { validateDecisionPractice, prepareDecisionPracticeContribution, readAdoptedDecisionPractice } from '../src/judgment/practice.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/atelier-judgment/practice-reconsideration/definition.json', import.meta.url)))
const template = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url))).knowledge
function adopted(edit = () => {}) {
  const records = [structuredClone(template[0])]
  const draft = prepareDecisionPracticeContribution({ records, definition: fixture, title: 'Invented reconsideration practice', term: 'material' })
  assert.equal(draft.status, 'prepared')
  edit(draft.data)
  draft.data.origin.contentDigest = contentDigest(draft.data.body)
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

function record(kind, id, data) {
  const source = template.find(item => item.kind === kind) ?? template[0]
  return { ...structuredClone(source), kind, id, data }
}

function addAcceptedSource(records, id, body, activate = false) {
  const data = { ...structuredClone(template[1].data), body,
    origin: { method: 'captured', locator: `invented:${id}`, contentDigest: contentDigest(body), rightsBasis: 'Invented fixture.' }, basedOn: [] }
  const contribution = record('contribution', id, data)
  const evaluation = record('evaluation', `${id}-evaluation`, { ...structuredClone(template.find(item => item.kind === 'evaluation').data), contribution: harnessRef(contribution) })
  const review = record('review', `${id}-review`, { target: harnessRef(contribution), disposition: 'accepted', basis: 'Invented review.', evaluations: [harnessRef(evaluation)] })
  records.push(contribution, evaluation, review)
  if (activate) records.push(record('activation', `${id}-activation`, { ...structuredClone(template.find(item => item.kind === 'activation').data), reviews: [harnessRef(review)] }))
}

function rereviewed() {
  const value = adopted(), prior = value.records.find(item => item.kind === 'evaluation')
  const evaluation = record('evaluation', 'practice-evaluation-two', { ...structuredClone(prior.data), contribution: value.definitionRef })
  const review = record('review', 'practice-review-two', { target: value.definitionRef, disposition: 'accepted', basis: 'Invented new review.', evaluations: [harnessRef(prior), harnessRef(evaluation)] })
  value.records.push(evaluation, review)
  assert.ok(inspectKnowledge(value.records).accepted.includes(value.contribution.id))
  return { ...value, review }
}

test('valid Knowledge history beyond this portable profile has a distinct bounds refusal', () => {
  const value = adopted()
  addAcceptedSource(value.records, 'large-source', 'x'.repeat(260000))
  assert.ok(inspectKnowledge(value.records).accepted.includes('large-source'))
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 262144)
  const input = { records: value.records, definitionRef: value.definitionRef }
  assert.equal(readAdoptedDecisionPractice(input).reason, 'practice-input-exceeds-bounds')
  assert.equal(prepareDecisionPracticeContribution({ records: value.records, definition: fixture, title: 'Invented bounded practice', term: 'material' }).reason, 'practice-input-exceeds-bounds')
})

for (const [name, body] of [['astral', '\u{1f331}'.repeat(140000)], ['nul', 'Invented\u0000captured source']]) test(`valid ${name} Knowledge history has a typed portable profile refusal`, () => {
  const value = adopted()
  addAcceptedSource(value.records, `${name}-source`, body)
  assert.ok(inspectKnowledge(value.records).accepted.includes(`${name}-source`))
  assert.equal(readAdoptedDecisionPractice({ records: value.records, definitionRef: value.definitionRef }).reason, 'practice-input-exceeds-bounds')
  assert.equal(prepareDecisionPracticeContribution({ records: value.records, definition: fixture, title: 'Invented profile check', term: 'material' }).reason, 'practice-input-exceeds-bounds')
})

test('preparation distinguishes malformed Knowledge history from an invalid definition', () => {
  const records = [structuredClone(template[0])]; records[0].schema = 'invalid-invented-schema'
  assert.equal(prepareDecisionPracticeContribution({ records, definition: fixture, title: 'Invented history check', term: 'material' }).reason, 'invalid-definition-history')
})

function expandedExtension() {
  let value = Object.fromEntries(Array.from({ length: 6000 }, (_, index) => [`leaf-${index}`, 1]))
  for (let depth = 0; depth < 18; depth++) value = { inside: value }
  return value
}

test('an in-profile definition whose prepared body exceeds the Knowledge bound refuses before returning data', () => {
  const definition = structuredClone(fixture); definition.rubric.ext = expandedExtension()
  const input = { records: [structuredClone(template[0])], definition, title: 'Invented output bound', term: 'material' }
  assert.doesNotThrow(() => evidenceJson(input))
  assert.equal(validateDecisionPractice(definition).valid, true)
  assert.ok([...JSON.stringify(definition, null, 2)].length > 262144)
  const result = prepareDecisionPracticeContribution(input)
  assert.equal(result.reason, 'practice-output-exceeds-bounds')
  assert.equal(Object.hasOwn(result, 'data'), false)
})

test('a successfully prepared draft fits the ordinary Knowledge contribution shape', () => {
  const data = prepareDecisionPracticeContribution({ records: [structuredClone(template[0])], definition: fixture, title: 'Invented shape check', term: 'material' }).data
  assert.deepEqual(validateHarnessDocument({ ...structuredClone(template[1]), data }, 'knowledge', 'contribution'), [])
})

test('malformed and duplicate-key adopted bodies refuse as invalid definitions', () => {
  const marker = `"revision": ${JSON.stringify(fixture.revision)}`
  for (const body of ['not JSON', JSON.stringify(fixture), JSON.stringify(fixture, null, 2).replace(marker, `"revision": "ignored", ${marker}`)]) {
    const { records, definitionRef } = adopted(data => { data.body = body })
    assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).reason, 'invalid-definition')
  }
})

test('an adopted practice must retain its declared category and origin meaning', () => {
  for (const edit of [data => { data.category = 'source' }, data => { data.origin.locator = 'invented:other-purpose' }]) {
    const { records, definitionRef } = adopted(edit)
    assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).reason, 'invalid-definition')
  }
})

test('re-review after a new evaluation requires a fresh activation', () => {
  const { records, definitionRef, review } = rereviewed()
  assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).reason, 'unadopted-definition')
  records.push(record('activation', 'practice-activation-two', { ...structuredClone(template.find(item => item.kind === 'activation').data), reviews: [harnessRef(review)] }))
  assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).status, 'resolved')
})

function unrelatedActivation() {
  const value = adopted(); value.records.pop()
  addAcceptedSource(value.records, 'other-source', 'Invented unrelated accepted source.', true)
  assert.ok(inspectKnowledge(value.records).accepted.includes(value.contribution.id))
  return value
}

test('an unrelated contribution activation cannot adopt an accepted practice', () => {
  const { records, definitionRef } = unrelatedActivation()
  assert.equal(readAdoptedDecisionPractice({ records, definitionRef }).reason, 'unadopted-definition')
})

test('definition supersession and domain revision invalidate the old exact definition', () => {
  const first = adopted()
  first.records.push(record('contribution', 'practice-successor', { ...structuredClone(first.contribution.data), supersedes: first.definitionRef, revisionReason: 'Invented successor.' }))
  assert.equal(readAdoptedDecisionPractice({ records: first.records, definitionRef: first.definitionRef }).reason, 'unadopted-definition')
  const second = adopted(), domain = second.records[0]
  second.records.push(record('domain-revision', 'domain-two', { ...structuredClone(domain.data), supersedes: harnessRef(domain), migration: 'Invented domain revision.' }))
  assert.equal(readAdoptedDecisionPractice({ records: second.records, definitionRef: second.definitionRef }).reason, 'unadopted-definition')
})

test('mutation controls detect each omitted current-activation predicate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-adoption-mutations-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const moduleUrl = new URL('../src/judgment/practice.mjs', import.meta.url)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '(\.[^']+)'/g, (_match, specifier) => `from '${new URL(specifier, moduleUrl).href}'`)
  for (const [name, guard, replacement, setup] of [
    ['stale-activation', '!stale.has(record.id) && ', '', rereviewed],
    ['unrelated-activation', 'return review?.data.target.id === contribution.id', 'return true', unrelatedActivation],
  ]) {
    const { records, definitionRef } = setup(), input = { records, definitionRef }
    assert.equal(readAdoptedDecisionPractice(input).reason, 'unadopted-definition')
    assert.equal(source.split(guard).length - 1, 1)
    const file = path.join(root, `${name}.mjs`); fs.writeFileSync(file, source.replace(guard, replacement))
    const mutant = await import(pathToFileURL(file).href)
    assert.equal(mutant.readAdoptedDecisionPractice(input).status, 'resolved')
  }
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
