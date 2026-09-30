// These reducers calculate conditional results. They do not estimate likelihoods,
// infer independence from wording, authenticate observations, or authorize actions.
const logistic = x => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x))
const logit = p => Math.log(p) - Math.log1p(-p)
export function calculateBelief(model, evidence) {
  if (model.kind === 'qualitative') return { kind: model.kind, judgment: model.judgment, probability: null, calibration: 'not-applicable' }
  const entries = model.kind === 'elicited-odds' ? model.likelihoods : model.observations
  const keys = evidence.map(e => e.key)
  if (new Set(keys).size !== keys.length || new Set(entries.map(e => e.key)).size !== entries.length || entries.length !== keys.length || entries.some(e => !keys.includes(e.key))) throw new Error('model contributions must match the evidence exactly')
  if (new Set(model.priorFamilies).size !== model.priorFamilies.length) throw new Error('duplicate prior evidence family')
  const families = new Map(), duplicateKeys = [], admittedKeys = []
  for (const item of [...evidence].sort((a, b) => a.key.localeCompare(b.key))) {
    if (item.verification !== 'verified') throw new Error('numerical assessment requires verified evidence')
    if (model.priorFamilies.includes(item.family)) throw new Error('evidence already incorporated in prior')
    const entry = entries.find(e => e.key === item.key)
    const contribution = model.kind === 'elicited-odds' ? entry.ratio : [entry.successes, entry.failures]
    if (families.has(item.family)) {
      if (JSON.stringify(families.get(item.family)) !== JSON.stringify(contribution)) throw new Error('dependent evidence family has conflicting contributions; use a joint model or qualitative assessment')
      duplicateKeys.push(item.key)
    } else { families.set(item.family, contribution); admittedKeys.push(item.key) }
  }
  const common = { kind: model.kind, admittedKeys, duplicateKeys, families: [...families.keys()], assumptions: model.assumptions, calibration: 'unverified', authority: 'none' }
  if (model.kind === 'elicited-odds') {
    const logEvidenceRatio = [...families.values()].reduce((sum, ratio) => sum + Math.log(ratio), 0)
    const posterior = p => logistic(logit(p) + logEvidenceRatio)
    return { ...common, interpretation: 'conditional-on-elicited-prior-likelihoods-and-independence', probability: posterior(model.prior), logOdds: logit(model.prior) + logEvidenceRatio, sensitivity: model.sensitivityPriors.map(prior => ({ prior, probability: posterior(prior) })) }
  }
  const [successes, failures] = [...families.values()].reduce(([s, f], [x, y]) => [s + x, f + y], [0, 0])
  if (!successes && !failures) throw new Error('rate model requires at least one trial')
  const alpha = model.alpha + successes, beta = model.beta + failures, total = alpha + beta
  return { ...common, interpretation: 'posterior-over-a-rate-not-probability-of-a-broad-hypothesis', distribution: 'beta', alpha, beta, mean: alpha / total, variance: (alpha / total) * (beta / total) / (total + 1), trials: successes + failures, priorPredictiveSuccess: model.alpha / (model.alpha + model.beta), posteriorPredictiveSuccess: alpha / total }
}
