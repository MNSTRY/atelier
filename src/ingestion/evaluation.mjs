import { createHash } from 'node:crypto'

const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const invalid = () => { throw new Error('invalid ingestion evaluation document') }
function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) invalid()
}
function text(value, max = 512) { if (typeof value !== 'string' || !value.trim() || value.length > max) invalid() }
function count(value) { if (!Number.isSafeInteger(value) || value < 0) invalid() }
function measure(value) { if (value !== null && (!Number.isFinite(value) || value < 0)) invalid() }
function evidence(items) {
  if (!Array.isArray(items) || items.length > 10000) invalid()
  for (const item of items) {
    object(item, ['locator', 'text']); object(item.locator, ['kind', 'value'])
    if (!['line', 'csv-cell', 'json-pointer'].includes(item.locator.kind)) invalid()
    if (typeof item.locator.value !== 'string' || item.locator.value.length > 2048
      || typeof item.text !== 'string' || item.text.length > 65536) invalid()
  }
}
function key(item) { return JSON.stringify([item.locator.kind, item.locator.value, item.text]) }
function score(expected, actual) {
  const remaining = new Map()
  for (const item of expected) remaining.set(key(item), (remaining.get(key(item)) ?? 0) + 1)
  let matched = 0
  for (const item of actual) {
    const k = key(item)
    if (remaining.get(k) > 0) { matched++; remaining.set(k, remaining.get(k) - 1) }
  }
  return { expected: expected.length, returned: actual.length, matched,
    missed: expected.length - matched, unexpected: actual.length - matched }
}

/** Score exact structural evidence against a predeclared local suite. This does
 * not judge semantic support, authenticate supplied human assessments, execute a
 * provider or grant model qualification. Unknown costs remain unknown. */
export function evaluateIngestionTrial({ suite, trial }) {
  let serialized
  try { serialized = JSON.stringify({ suite, trial }) } catch { invalid() }
  if (!serialized || Buffer.byteLength(serialized) > 4 * 1024 * 1024) invalid()
  object(suite, ['id', 'revision', 'thresholds', 'cases'])
  text(suite.id); text(suite.revision)
  object(suite.thresholds, ['minimumRecall', 'maximumUnexpected', 'maximumFailed'])
  if (!Number.isFinite(suite.thresholds.minimumRecall) || suite.thresholds.minimumRecall < 0
    || suite.thresholds.minimumRecall > 1) invalid()
  count(suite.thresholds.maximumUnexpected); count(suite.thresholds.maximumFailed)
  if (!Array.isArray(suite.cases) || !suite.cases.length || suite.cases.length > 256) invalid()
  const ids = new Set()
  for (const item of suite.cases) {
    object(item, ['id', 'stratum', 'split', 'sourceDigest', 'expected'])
    text(item.id); text(item.stratum)
    if (ids.has(item.id) || !['calibration', 'held-out'].includes(item.split)
      || !/^sha256:[0-9a-f]{64}$/.test(item.sourceDigest)) invalid()
    ids.add(item.id); evidence(item.expected)
  }
  object(trial, ['id', 'suiteDigest', 'processor', 'currency', 'outcomes'])
  text(trial.id)
  if (trial.suiteDigest !== digest(suite)) throw new Error('evaluation suite digest mismatch')
  object(trial.processor, ['id', 'version', 'configurationDigest'])
  text(trial.processor.id); text(trial.processor.version)
  if (!/^sha256:[0-9a-f]{64}$/.test(trial.processor.configurationDigest)
    || !/^[A-Z]{3}$/.test(trial.currency)) invalid()
  if (!Array.isArray(trial.outcomes) || trial.outcomes.length > suite.cases.length) invalid()
  const outcomes = new Map()
  for (const item of trial.outcomes) {
    object(item, ['caseId', 'sourceDigest', 'status', 'evidence', 'attempts', 'elapsedMs', 'cost', 'humanAssessment'])
    if (!ids.has(item.caseId) || outcomes.has(item.caseId)
      || !['complete', 'failed', 'uncertain'].includes(item.status)) invalid()
    if (item.sourceDigest !== suite.cases.find(c => c.id === item.caseId).sourceDigest) {
      throw new Error('evaluation source digest mismatch')
    }
    evidence(item.evidence); count(item.attempts); measure(item.elapsedMs); measure(item.cost)
    if (item.attempts < 1 || (item.status !== 'complete' && item.evidence.length)) invalid()
    if (item.humanAssessment !== null) {
      object(item.humanAssessment, ['verdict', 'actorId', 'evidenceRef'])
      if (!['accepted', 'rejected', 'deferred'].includes(item.humanAssessment.verdict)) invalid()
      text(item.humanAssessment.actorId); text(item.humanAssessment.evidenceRef)
      if (item.humanAssessment.verdict === 'accepted' && item.status !== 'complete') invalid()
    }
    outcomes.set(item.caseId, item)
  }
  const cases = suite.cases.map(item => {
    const outcome = outcomes.get(item.id)
    return { caseId: item.id, stratum: item.stratum, split: item.split,
      status: outcome?.status ?? 'missing', ...score(item.expected, outcome?.evidence ?? []),
      attempts: outcome?.attempts ?? null, elapsedMs: outcome?.elapsedMs ?? null,
      cost: outcome?.cost ?? null, humanVerdict: outcome?.humanAssessment?.verdict ?? 'unassessed' }
  })
  function summarize(rows) {
    const totals = { cases: rows.length, expected: 0, returned: 0, matched: 0, missed: 0, unexpected: 0, failed: 0 }
    for (const row of rows) {
      for (const k of ['expected', 'returned', 'matched', 'missed', 'unexpected']) totals[k] += row[k]
      if (row.status !== 'complete') totals.failed++
    }
    const recall = totals.expected ? totals.matched / totals.expected : null
    // A zero-evidence sample cannot establish extraction recall.
    const passed = recall !== null && recall >= suite.thresholds.minimumRecall
      && totals.unexpected <= suite.thresholds.maximumUnexpected && totals.failed <= suite.thresholds.maximumFailed
    return { ...totals, recall, passed }
  }
  const strata = [...new Set(cases.filter(c => c.split === 'held-out').map(c => c.stratum))]
    .map(stratum => ({ stratum, ...summarize(cases.filter(c => c.split === 'held-out' && c.stratum === stratum)) }))
  const heldOut = summarize(cases.filter(c => c.split === 'held-out'))
  const accepted = cases.filter(c => c.humanVerdict === 'accepted').length
  const unknownCostCases = cases.filter(c => c.cost === null).length
  const knownCost = cases.reduce((total, c) => total + (c.cost ?? 0), 0)
  if (!Number.isFinite(knownCost)) throw new Error('evaluation cost total exceeds numeric bounds')
  const totalCost = unknownCostCases ? null : knownCost
  return { schema: 'mnstry.atelier-ingestion-evaluation@v1', suiteDigest: digest(suite),
    trialDigest: digest(trial), processor: structuredClone(trial.processor), cases,
    calibration: summarize(cases.filter(c => c.split === 'calibration')), heldOut, strata,
    structuralThresholdsPassed: heldOut.passed && strata.length > 0 && strata.every(s => s.passed),
    costs: { currency: trial.currency, knownCost, unknownCostCases, totalCost, acceptedResults: accepted,
      costPerAcceptedResult: accepted && totalCost !== null ? totalCost / accepted : null },
    semanticQualification: 'not-assessed', humanAssessmentIdentity: 'caller-asserted', grantsAuthority: false }
}

export function ingestionEvaluationDigest(value) { return digest(value) }
