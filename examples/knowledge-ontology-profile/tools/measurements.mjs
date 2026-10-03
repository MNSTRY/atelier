// Consumer-local reported measurements. These records confer no acceptance or
// host authority and are not a portable Atelier contract.
import fs from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const schema = JSON.parse(fs.readFileSync(new URL('./measurement.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const validateFloorSchema = ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: '#/$defs/floor' });
const known = value => typeof value === 'number' && Number.isFinite(value);
export const ratio = (numerator, denominator) => known(numerator) && known(denominator) && denominator > 0
  ? numerator / denominator : null;
const shapeErrors = validator => (validator.errors ?? []).map(e => `${e.instancePath || '/'}: ${e.message}`);
const experimentKeys = ['sourceSetSha256', 'modelSha256', 'questionSetSha256', 'procedureSha256', 'cohort', 'runKind'];
const sameExperiment = (a, b) => experimentKeys.every(k => a[k] === b[k]);

export function measurementErrors(record) {
  if (!validate(record)) return shapeErrors(validate);
  const errors = [];
  const bounded = (n, limit, name) => {
    if (known(n) && known(limit) && n > limit) errors.push(`${name} exceeds its denominator`);
  };
  const i = record.ingestion, q = record.quality, c = record.cost, t = record.time;
  bounded(i.sourcesParsed, i.sourcesSelected, 'sourcesParsed');
  bounded(i.admittedAssertions, i.proposedAssertions, 'admittedAssertions');
  bounded(i.verifiedReadbacks, i.admittedAssertions, 'verifiedReadbacks');
  const sourceParts = [i.sourcesParsed, i.sourcesFailed, i.sourcesOmitted];
  if (known(i.sourcesSelected) && sourceParts.every(known) && sourceParts.reduce((a, b) => a + b, 0) !== i.sourcesSelected)
    errors.push('parsed, failed, and omitted sources must partition sourcesSelected');
  bounded(q.supportedAssertions, q.reviewedAssertions, 'supportedAssertions');
  if ([q.supportedAnswers, q.correctAbstentions].every(known))
    bounded(q.supportedAnswers + q.correctAbstentions, q.evaluatedQuestions, 'successful questions');
  bounded(t.firstSupportedResultMs, t.totalElapsedMs, 'firstSupportedResultMs');
  bounded(t.ingestionMs, t.totalElapsedMs, 'ingestionMs');
  const costParts = [c.providerAmount, c.computeAmount, c.humanAmount];
  if (known(c.totalAmount) && (!c.currency || !costParts.every(known)))
    errors.push('totalAmount requires a currency and all task cost components');
  if (known(c.totalAmount) && costParts.every(known) && Math.abs(costParts.reduce((a, b) => a + b, 0) - c.totalAmount) > 1e-7)
    errors.push('totalAmount must equal provider, compute, and human amounts');
  if (Object.values(c).some(known) && !c.currency) errors.push('measured cost requires currency');
  if ([record.outcome.userAccepted, record.outcome.observedUsefulResult, record.outcome.laterAppropriateReuse].some(v => v === true) && !record.outcome.evidenceRef)
    errors.push('a reported positive outcome requires an evidenceRef');
  if (!record.evidenceRefs.length) errors.push('measurement requires at least one evidenceRef');
  return errors;
}

export function floorErrors(floor) {
  return validateFloorSchema(floor) ? [] : shapeErrors(validateFloorSchema);
}

export function deriveMeasurement(record) {
  const errors = measurementErrors(record);
  if (errors.length) throw new Error(`invalid measurement ${record?.id ?? '(unnamed)'}: ${errors.join('; ')}`);
  const q = record.quality, i = record.ingestion;
  return {
    id: record.id, method: record.method, experiment: record.experiment,
    observedAt: record.observedAt, attribution: 'reported; source and review evidence not independently authenticated by this tool',
    qualityCounts: { ...q }, ingestionCounts: { ...i },
    supportedPrecision: ratio(q.supportedAssertions, q.reviewedAssertions),
    taskSuccessRatio: ratio(known(q.supportedAnswers) && known(q.correctAbstentions) ? q.supportedAnswers + q.correctAbstentions : null, q.evaluatedQuestions),
    parseCoverage: ratio(i.sourcesParsed, i.sourcesSelected),
    admissionReadbackCoverage: ratio(i.verifiedReadbacks, i.admittedAssertions),
    admittedAssertionsPerSecond: ratio(i.admittedAssertions, known(record.time.ingestionMs) ? record.time.ingestionMs / 1000 : null),
    totalTaskCost: record.cost.totalAmount,
    currency: record.cost.currency,
    correctionMinutes: record.time.correctionMinutes,
    totalElapsedMs: record.time.totalElapsedMs,
    firstSupportedResultMs: record.time.firstSupportedResultMs,
    actualUsage: record.usage, outcome: record.outcome, evidenceRefs: record.evidenceRefs,
    // Provider accounting differs; cache buckets are deliberately not summed.
  };
}

export function assessQuality(record, floor) {
  const m = deriveMeasurement(record);
  if (!floor) return { status: 'unknown', reasons: ['No prespecified quality floor supplied.'] };
  const errors = floorErrors(floor);
  if (errors.length) throw new Error(`invalid quality floor: ${errors.join('; ')}`);
  const reasons = [];
  if (!sameExperiment(record.experiment, floor.experiment)) reasons.push('Quality floor belongs to a different experiment.');
  if (Date.parse(floor.declaredAt) > Date.parse(record.observedAt)) reasons.push('Quality floor was declared after this observation.');
  const q = record.quality;
  const missing = ['reviewedAssertions', 'supportedAssertions', 'wrongMerges', 'qualificationErrors', 'evaluatedQuestions', 'supportedAnswers', 'correctAbstentions'].filter(k => !known(q[k]));
  if (missing.length) reasons.push(`Unmeasured quality: ${missing.join(', ')}.`);
  if (m.supportedPrecision === null || m.taskSuccessRatio === null) reasons.push('Quality ratios have an empty or unknown denominator.');
  if (reasons.length) return { status: 'unknown', reasons };
  if (q.reviewedAssertions < floor.minReviewedAssertions) reasons.push('Too few reviewed assertions.');
  if (q.evaluatedQuestions < floor.minEvaluatedQuestions) reasons.push('Too few evaluated questions.');
  if (m.supportedPrecision < floor.minSupportedPrecision) reasons.push('Supported assertion precision is below the floor.');
  if (m.taskSuccessRatio < floor.minTaskSuccessRatio) reasons.push('Supported answer or correct abstention ratio is below the floor.');
  if (q.wrongMerges > floor.maxWrongMerges) reasons.push('Wrong identity merges exceed the floor.');
  if (q.qualificationErrors > floor.maxQualificationErrors) reasons.push('Lost negation, possibility, time, or scope exceeds the floor.');
  return { status: reasons.length ? 'fail' : 'pass', reasons };
}

export function summarizeMeasurements(records, floor = null) {
  if (!Array.isArray(records) || records.length > 100) throw new Error('Supply at most 100 measurement records.');
  if (new Set(records.map(r => r?.id)).size !== records.length) throw new Error('Duplicate measurement IDs.');
  if (floor) {
    const errors = floorErrors(floor);
    if (errors.length) throw new Error(`invalid quality floor: ${errors.join('; ')}`);
  }
  const measurements = records.map(r => ({ ...deriveMeasurement(r), quality: assessQuality(r, floor) }));
  const comparisons = [];
  for (let a = 0; a < records.length; a++) for (let b = a + 1; b < records.length; b++) {
    const left = records[a], right = records[b], lm = measurements[a], rm = measurements[b];
    const reasons = [];
    if (!sameExperiment(left.experiment, right.experiment)) reasons.push('Sources, model, questions, procedure, cohort, or cold/warm mode differ.');
    if (left.experiment.cohort !== 'held-out' || right.experiment.cohort !== 'held-out') reasons.push('These are worked examples or regressions, not held-out evaluation.');
    if (lm.quality.status !== 'pass' || rm.quality.status !== 'pass') reasons.push('Both runs must meet the same prespecified quality floor.');
    if (lm.totalTaskCost === null || rm.totalTaskCost === null) reasons.push('Complete task cost is unmeasured.');
    if (!lm.currency || lm.currency !== rm.currency) reasons.push('Comparable cost requires the same currency.');
    const eligible = reasons.length === 0;
    comparisons.push({ left: left.id, right: right.id, eligible, reasons,
      rightMinusLeftTaskCost: eligible ? rm.totalTaskCost - lm.totalTaskCost : null,
      rightMinusLeftElapsedMs: eligible && known(lm.totalElapsedMs) && known(rm.totalElapsedMs) ? rm.totalElapsedMs - lm.totalElapsedMs : null,
      scope: 'Recorded trials only; no general method superiority, owner acceptance, or authorization inferred.' });
  }
  return { schema: 'atelier-enablement-metrics/local-v1', measurements, comparisons,
    qualityFloor: floor, aggregateProviderTokens: null,
    scope: 'Reported measurements and derived ratios. Unknown is not zero; evidence authenticity and statistical generalization are not established.' };
}
