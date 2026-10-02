import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { decisionRequestDigest, validateDecisionResult } from '../src/decisions/contracts.mjs'
import { contentDigest, harnessRef, validateHarnessDocument } from '../src/harnesses/contracts.mjs'
import { inspectKnowledge } from '../src/knowledge/ledger.mjs'
import { evidenceJson, validateEvidenceDocument } from '../src/evidence-navigation/contracts.mjs'
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
  assert.deepEqual(validateHarnessDocument({ ...value.records.find(record => record.kind === 'contribution'), data: outcome.proposal.data }, 'knowledge', 'contribution'), [])
  assert.equal(JSON.stringify(value), before)
})

const negatives = [
  ['missing-evidence', value => { value.instance.evidence.pop() }],
  ['stale-evidence', value => { value.instance.snapshots[0].currency = 'stale' }],
  ['stale-evidence', value => { value.instance.snapshots[0].currency = 'superseded' }],
  ['stale-evidence', value => { value.instance.snapshots[0].currency = 'withdrawn-from-use' }],
  ['stale-evidence', value => { value.instance.snapshots[0].validUntil = '2025-01-01T00:00:00Z' }],
  ['stale-evidence', value => { value.instance.snapshots = [] }],
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
  ['changed-rubric', value => { value.instance.request.ext = { unadopted: 'invented' }; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
  ['changed-rubric', value => { value.instance.request.contractVersion = '1.0.1'; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
  ['unbound-request-evidence', value => { value.instance.request.evidence[0].ext = { unadopted: 'invented' }; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
  ['unbound-request-evidence', value => { value.instance.request.state += 'Unattributed material.'; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request) }],
  ['changed-proposal-target', value => { value.instance.proposal.target.digest = `sha256:${'0'.repeat(64)}` }],
  ['changed-proposal-target', value => { value.instance.proposal.target.id = 'unknown-invented-target' }],
  ['changed-proposal-target', value => { value.instance.proposal.target = harnessRef(value.records.find(record => record.kind === 'domain')) }],
  ['changed-proposal-target', value => { value.instance.proposal.target.ext = { unbound: true } }],
  ['invalid-proposal', value => { value.instance.proposal.term = 'unknown-invented-term' }],
  ['invalid-proposal', value => { value.instance.proposal.title = '   ' }],
  ['invalid-proposal', value => { value.instance.proposal.title = 'x'.repeat(4001) }],
]
for (const [reason, edit] of negatives) test(`typed refusal: ${reason}`, () => {
  const value = scenario(); edit(value)
  const outcome = evaluateDecisionPractice(value)
  assert.equal(outcome.status, 'refuse'); assert.equal(outcome.reason, reason)
  assert.equal(Object.hasOwn(outcome, 'proposal'), false)
})

test('a valid large Knowledge history is distinct from malformed operating input', () => {
  const value = scenario(), contribution = structuredClone(value.records.find(item => item.kind === 'contribution'))
  contribution.id = 'large-invented-source'; contribution.data.body = 'x'.repeat(260000); contribution.data.basedOn = []
  contribution.data.origin = { method: 'captured', locator: 'invented:large-source', contentDigest: contentDigest(contribution.data.body), rightsBasis: 'Invented fixture.' }
  value.records.push(contribution)
  assert.doesNotThrow(() => inspectKnowledge(value.records))
  assert.equal(evaluateDecisionPractice(value).reason, 'practice-input-exceeds-bounds')
})

for (const [name, body] of [['astral', '\u{1f331}'.repeat(140000)], ['nul', 'Invented\u0000captured source']]) test(`valid ${name} history refuses with the portable profile reason during evaluation`, () => {
  const value = scenario(), contribution = structuredClone(value.records.find(item => item.kind === 'contribution'))
  contribution.id = `${name}-invented-source`; contribution.data.body = body; contribution.data.basedOn = []
  contribution.data.origin = { method: 'captured', locator: `invented:${name}-source`, contentDigest: contentDigest(body), rightsBasis: 'Invented fixture.' }
  value.records.push(contribution)
  assert.doesNotThrow(() => inspectKnowledge(value.records))
  assert.equal(evaluateDecisionPractice(value).reason, 'practice-input-exceeds-bounds')
})

test('an unsupported string does not hide a non-JSON accessor or invoke it', () => {
  const value = scenario(); value.instance.result.ext = { note: 'Invented\u0000metadata' }
  let reads = 0
  Object.defineProperty(value, 'extra', { enumerable: true, get() { reads++; return 'untrusted' } })
  assert.equal(evaluateDecisionPractice(value).reason, 'invalid-instance')
  assert.equal(reads, 0)
})

test('an unsupported string does not hide cycles, custom prototypes or sparse arrays', () => {
  for (const malformed of [() => { const value = {}; value.self = value; return value },
    () => Object.create({ inherited: true }), () => new Array(1)]) {
    const value = scenario(); value.instance.result.ext = { note: 'Invented\u0000metadata', malformed: malformed() }
    assert.equal(evaluateDecisionPractice(value).reason, 'invalid-instance')
  }
})

test('an in-profile result with an oversized pretty-printed draft refuses before returning a proposal', () => {
  const value = scenario()
  let ext = Object.fromEntries(Array.from({ length: 6000 }, (_, index) => [`leaf-${index}`, 1]))
  for (let depth = 0; depth < 18; depth++) ext = { inside: ext }
  value.instance.result.ext = ext
  assert.doesNotThrow(() => evidenceJson(value))
  assert.equal(validateDecisionResult(value.instance.request, value.instance.result).ok, true)
  assert.ok([...JSON.stringify({ assessment: value.instance.result }, null, 2)].length > 262144)
  const result = evaluateDecisionPractice(value)
  assert.equal(result.reason, 'practice-output-exceeds-bounds')
  assert.equal(Object.hasOwn(result, 'proposal'), false)
})

test('stale and expired cases use valid snapshots rather than schema failures', () => {
  for (const edit of [snapshot => { snapshot.currency = 'stale' }, snapshot => { snapshot.currency = 'superseded' }, snapshot => { snapshot.currency = 'withdrawn-from-use' }, snapshot => { snapshot.validUntil = '2025-01-01T00:00:00Z' }]) {
    const value = scenario(); edit(value.instance.snapshots[0])
    assert.equal(validateEvidenceDocument('snapshot', value.instance.snapshots[0]).valid, true)
    assert.equal(evaluateDecisionPractice(value).reason, 'stale-evidence')
  }
})

function changeAdoptedRubric(value, edit) {
  const contribution = value.records.find(item => item.id === value.definitionRef.id), definition = JSON.parse(contribution.data.body)
  edit(definition.rubric); contribution.data.body = JSON.stringify(definition, null, 2); contribution.data.origin.contentDigest = contentDigest(contribution.data.body)
  value.definitionRef = harnessRef(contribution)
  for (const item of value.records) {
    if (item.kind === 'evaluation' && item.data.contribution.id === contribution.id) item.data.contribution = harnessRef(contribution)
    if (item.kind === 'review' && item.data.target.id === contribution.id) {
      item.data.target = harnessRef(contribution)
      item.data.evaluations = item.data.evaluations.map(pin => harnessRef(value.records.find(record => record.id === pin.id)))
    }
    if (item.kind === 'activation') item.data.reviews = item.data.reviews.map(pin => harnessRef(value.records.find(record => record.id === pin.id)))
  }
  assert.ok(inspectKnowledge(value.records).accepted.includes(contribution.id))
}

for (const [field, content] of [['ext', { adopted: 'invented' }], ['contractVersion', '1.0.0']]) test(`request cannot drop adopted ${field}`, () => {
  const value = scenario(); changeAdoptedRubric(value, rubric => { rubric[field] = content })
  value.instance.request[field] = structuredClone(content); value.instance.result.requestDigest = decisionRequestDigest(value.instance.request)
  assert.equal(evaluateDecisionPractice(value).status, 'proceed')
  delete value.instance.request[field]; value.instance.result.requestDigest = decisionRequestDigest(value.instance.request)
  assert.equal(evaluateDecisionPractice(value).reason, 'changed-rubric')
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
    ['changed-proposal-target', value => { value.instance.proposal.target.digest = `sha256:${'0'.repeat(64)}` }],
    ['invalid-proposal', value => { value.instance.proposal.term = 'unknown-invented-term' }],
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
