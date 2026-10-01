import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { decisionRequestDigest } from '../src/decisions/contracts.mjs'
import { evaluateDecisionPractice } from '../src/judgment/practice-evaluation.mjs'

const read = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url)))
function scenario() { return read('../fixtures/atelier-judgment/practice-reconsideration/scenario.json') }

test('current evidence and a valid bound assessment prepare only a reconsideration draft', () => {
  const value = scenario(), before = JSON.stringify(value), outcome = evaluateDecisionPractice(value)
  assert.equal(outcome.status, 'proceed')
  assert.equal(outcome.proposal.semanticAcceptance, 'pending')
  assert.equal(outcome.executionAuthorized, false)
  assert.equal(outcome.authorityTransferred, false)
  assert.equal(outcome.semanticTruthVerified, false)
  assert.equal(JSON.stringify(value), before)
})

const negatives = [
  ['missing-evidence', value => { value.instance.evidence.pop() }],
  ['stale-evidence', value => { value.instance.snapshots[0].currency = 'requires-reconsideration' }],
  ['stale-evidence', value => { value.instance.snapshots[0].reference.revision = 'two' }],
  ['changed-evidence-text', value => { value.instance.evidence[0].text += 'Altered.' }],
  ['unknown-prerequisite', value => { value.instance.prerequisites[0].value = 'unknown' }],
  ['unknown-prerequisite', value => { value.instance.prerequisites.push({ id: 'unlisted', value: true }) }],
  ['changed-definition', value => { value.definitionRef.digest = `sha256:${'0'.repeat(64)}` }],
  ['unadopted-definition', value => { value.records = value.records.slice(0, 4) }],
  ['budget-exhausted', value => { value.instance.spent.stages = 3 }],
  ['budget-exhausted', value => { value.instance.spent.evidence = 3 }],
  ['budget-exhausted', value => { value.instance.spent.assessments = 1 }],
  ['budget-exhausted', value => { value.instance.spent.proposals = 1 }],
  ['unsupported-proposal-type', value => { value.instance.proposal.type = 'activate' }],
  ['self-definition-proposal', value => { value.instance.proposal.target = value.definitionRef }],
  ['invalid-rubric-result', value => { value.instance.result.requestDigest = '0'.repeat(64) }],
  ['invalid-rubric-result', value => { value.instance.result.authority = 'execution' }],
  ['changed-rubric', value => { value.instance.request.questions.priority.instructions += 'Changed rubric.'; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
  ['unbound-request-evidence', value => { value.instance.request.state += 'Unattributed material.'; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
]
for (const [reason, edit] of negatives) test(`typed refusal: ${reason}`, () => {
  const value = scenario(); edit(value)
  const outcome = evaluateDecisionPractice(value)
  assert.equal(outcome.status, 'refuse'); assert.equal(outcome.reason, reason)
  assert.equal(Object.hasOwn(outcome, 'proposal'), false)
})

test('a false known prerequisite stops without preparing a draft', () => {
  const value = scenario(); value.instance.prerequisites[0].value = false
  const outcome = evaluateDecisionPractice(value)
  assert.equal(outcome.status, 'stop'); assert.equal(outcome.reason, 'prerequisite-false')
  assert.equal(Object.hasOwn(outcome, 'proposal'), false)
})

test('a valid explicit abstention escalates and prepares no draft', () => {
  const value = scenario(); value.instance.result.status = 'abstained'; value.instance.result.answers = {}; value.instance.result.reason = 'insufficient-evidence'
  const outcome = evaluateDecisionPractice(value)
  assert.equal(outcome.status, 'escalate'); assert.equal(outcome.reason, 'rubric-abstained')
  assert.equal(Object.hasOwn(outcome, 'proposal'), false)
})

for (const [choice, status] of [['hours', 'stop'], ['unmatched', 'escalate']]) test(`the adopted rubric maps ${choice} to ${status} without a proposal`, () => {
  const value = scenario(), answer = value.instance.result.answers.priority
  answer.choice = choice; answer.probabilities = { maintenance: 0, hours: Number(choice === 'hours'), unmatched: Number(choice === 'unmatched') }
  const outcome = evaluateDecisionPractice(value)
  assert.equal(outcome.status, status); assert.equal(Object.hasOwn(outcome, 'proposal'), false)
})

test('definition review and activation cannot be targeted by their operating instance', () => {
  for (const kind of ['review', 'activation']) {
    const value = scenario(), record = value.records.find(record => record.id === `decision-practice-${kind}`)
    value.instance.proposal.target = { id: record.id, digest: 'irrelevant' }
    assert.equal(evaluateDecisionPractice(value).reason, 'self-definition-proposal')
  }
})

test('the final declared budget unit is usable and leaves zero remaining counts', () => {
  const value = scenario(); value.instance.spent = { stages: 2, evidence: 2, assessments: 0, proposals: 0 }
  const outcome = evaluateDecisionPractice(value)
  assert.equal(outcome.status, 'proceed')
  assert.deepEqual(outcome.declaredRemaining, { stages: 0, evidence: 0, assessments: 0, proposals: 0 })
})

test('mutation controls demonstrate that the refusal cases detect omitted checks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-mutations-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const moduleUrl = new URL('../src/judgment/practice-evaluation.mjs', import.meta.url)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '(\.[^']+)'/g, (_match, specifier) => `from '${new URL(specifier, moduleUrl).href}'`)
  const cases = [
    ['budget-exhausted', value => { value.instance.spent.stages = 3 }],
    ['unknown-prerequisite', value => { value.instance.prerequisites[0].value = 'unknown' }],
    ['stale-evidence', value => { value.instance.snapshots[0].reference.revision = 'two' }],
    ['changed-evidence-text', value => { value.instance.evidence[0].text += 'Changed.'; value.instance.request.state = value.instance.evidence.map(item => `${item.requestId}: ${item.text}`).join('\n'); value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
    ['unsupported-proposal-type', value => { value.instance.proposal.type = 'activate' }],
    ['self-definition-proposal', value => { value.instance.proposal.target = value.definitionRef }],
    ['invalid-rubric-result', value => { value.instance.result.requestDigest = '0'.repeat(64) }],
    ['changed-rubric', value => { value.instance.request.questions.priority.instructions += 'Changed.'; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
    ['unbound-request-evidence', value => { value.instance.request.state += 'Unattributed.'; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
  ]
  for (const [reason, edit] of cases) {
    const value = scenario(); edit(value)
    assert.equal(evaluateDecisionPractice(value).reason, reason)
    const guard = reason === 'unsupported-proposal-type'
      ? "if (!definition.allowedProposals.includes(instance.proposal.type)) return outcome('refuse', 'unsupported-proposal-type')"
      : `return outcome('refuse', '${reason}')`
    assert.equal(source.split(guard).length - 1, 1, `${reason}: unique mutation site`)
    const file = path.join(root, `${reason}.mjs`)
    fs.writeFileSync(file, source.replace(guard, 'void 0'))
    const mutant = await import(pathToFileURL(file).href)
    assert.equal(mutant.evaluateDecisionPractice(value).status, 'proceed', `${reason}: the omitted check must fail its original refusal assertion`)
  }
})
