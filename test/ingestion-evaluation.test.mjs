import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateIngestionTrial, ingestionEvaluationDigest as digest } from '../src/ingestion/evaluation.mjs'

const item = text => ({ locator: { kind: 'line', value: '1' }, text })
function fixture() {
  const suite = { id: 'sample-extraction', revision: '1', thresholds: { minimumRecall: 1, maximumUnexpected: 0, maximumFailed: 0 },
    cases: [
      { id: 'normal', stratum: 'text', split: 'calibration', sourceDigest: `sha256:${'a'.repeat(64)}`, expected: [item('Replace the filter monthly.')] },
      { id: 'exception', stratum: 'text', split: 'held-out', sourceDigest: `sha256:${'b'.repeat(64)}`, expected: [item('Replace monthly except during winter storage.')] },
      { id: 'table', stratum: 'table', split: 'held-out', sourceDigest: `sha256:${'c'.repeat(64)}`, expected: [{ locator: { kind: 'csv-cell', value: 'row:2,column:1' }, text: 'spare filter' }] },
    ] }
  const trial = { id: 'sample-trial', suiteDigest: digest(suite), processor: { id: 'sample', version: '1', configurationDigest: digest({}) }, currency: 'USD',
    outcomes: suite.cases.map(c => ({ caseId: c.id, sourceDigest: c.sourceDigest, status: 'complete', evidence: structuredClone(c.expected), attempts: 1,
      elapsedMs: 2, cost: 0.01, humanAssessment: { verdict: 'accepted', actorId: 'sample-owner', evidenceRef: 'private-review' } })) }
  return { suite, trial }
}
test('structural evaluation keeps held-out strata, exact evidence and declared human cost separate', () => {
  const report = evaluateIngestionTrial(fixture())
  assert.equal(report.structuralThresholdsPassed, true)
  assert.equal(report.heldOut.cases, 2)
  assert.equal(report.strata.length, 2)
  assert.equal(report.costs.costPerAcceptedResult, 0.01)
  assert.equal(report.semanticQualification, 'not-assessed')
  assert.equal(report.grantsAuthority, false)
})
test('a missing rare exception, duplicate evidence or bad locator cannot pass through cheap output', () => {
  for (const mutation of [
    c => { c.evidence[0].text = 'Replace monthly.' },
    c => { c.evidence.push(structuredClone(c.evidence[0])) },
    c => { c.evidence[0].locator.value = '2' },
  ]) {
    const input = fixture(); mutation(input.trial.outcomes[1])
    assert.equal(evaluateIngestionTrial(input).structuralThresholdsPassed, false)
  }
})
test('failed, missing and uncertain cases retain denominators and unknown cost rather than zero', () => {
  const input = fixture()
  input.trial.outcomes.splice(2, 1)
  Object.assign(input.trial.outcomes[1], { status: 'uncertain', evidence: [], cost: null, humanAssessment: null })
  const report = evaluateIngestionTrial(input)
  assert.equal(report.heldOut.failed, 2)
  assert.equal(report.heldOut.expected, 2)
  assert.equal(report.heldOut.recall, 0)
  assert.equal(report.costs.unknownCostCases, 2)
  assert.equal(report.costs.totalCost, null)
  assert.equal(report.costs.costPerAcceptedResult, null)
})
test('suite/source substitution and silent duplicate or unknown cases refuse', () => {
  for (const mutate of [
    x => { x.suite.thresholds.minimumRecall = 0 },
    x => { x.trial.outcomes[0].sourceDigest = `sha256:${'d'.repeat(64)}` },
    x => { x.trial.outcomes[1] = structuredClone(x.trial.outcomes[0]) },
    x => { x.trial.outcomes[0].caseId = 'unknown' },
  ]) {
    const input = fixture(); mutate(input); assert.throws(() => evaluateIngestionTrial(input))
  }
})
test('empty evidence and calibration-only cases cannot qualify a processor', () => {
  const input = fixture()
  input.suite.cases = input.suite.cases.slice(0, 1)
  input.trial.outcomes = input.trial.outcomes.slice(0, 1)
  input.trial.suiteDigest = digest(input.suite)
  assert.equal(evaluateIngestionTrial(input).structuralThresholdsPassed, false)
  input.suite.cases[0].split = 'held-out'; input.suite.cases[0].expected = []
  input.trial.outcomes[0].evidence = []; input.trial.suiteDigest = digest(input.suite)
  assert.equal(evaluateIngestionTrial(input).structuralThresholdsPassed, false)
})

test('invalid or overflowing cost accounting refuses rather than producing a null total', () => {
  const input = fixture()
  for (const outcome of input.trial.outcomes) outcome.cost = 1e308
  assert.throws(() => evaluateIngestionTrial(input), /numeric bounds/)
  input.trial.outcomes[0].cost = -1
  assert.throws(() => evaluateIngestionTrial(input), /invalid ingestion evaluation/)
})
