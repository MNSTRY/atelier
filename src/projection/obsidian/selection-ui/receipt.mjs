import { OBSIDIAN_EXT_KEY, validateObsidianContract } from '../contracts.mjs'

// Acceptance receipt validation for the gates AOP-4 owns. This is schema
// validation and required-field checking of a document. It proves that a
// receipt is shaped as a receipt of that gate: exact candidate, pinned
// versions, host and operator identity, hashed raw evidence in every role
// the procedure calls for, and the separately recorded human or adopter
// acceptance where the gate needs one.
//
// It proves nothing about what happened in the app, on the host or with the
// adopter. `gateClosed` is always false. A gate is closed by its owner
// inspecting the actual evidence and recording that in the parent matrix; a
// document that passes here is an input to that inspection, never its result.

export const RECEIPT_VALIDATION_LABEL = 'schema-validation-only'
export const RECEIPT_EXT_KEY = OBSIDIAN_EXT_KEY
export const ACCEPTANCE_KINDS = Object.freeze(['human', 'adopter'])

// Per gate: the procedure of ACCEPTANCE.md that produces it, the evidence
// type the receipt carries, the evidence roles that must each name a hashed
// raw-evidence entry, and what is separately recorded.
export const RECEIPT_GATES = Object.freeze({
  G07: Object.freeze({ procedure: 'AP-01', evidenceType: 'real-app', roles: Object.freeze(['cli-link-inspection', 'app-observation']), acceptance: 'human', wallClock: false, dataset: false, tarball: false }),
  G13: Object.freeze({ procedure: 'AP-02', evidenceType: 'real-app', roles: Object.freeze(['on-disk-membership', 'app-index-membership', 'graph-filter-observation']), acceptance: 'human', wallClock: false, dataset: false, tarball: false }),
  G14: Object.freeze({ procedure: 'AP-03', evidenceType: 'host', roles: Object.freeze(['source-refresh-trace', 'dropped-event-recovery', 'sleep-wake-clock']), acceptance: null, wallClock: true, dataset: false, tarball: false }),
  G15: Object.freeze({ procedure: 'AP-03', evidenceType: 'host', roles: Object.freeze(['ownership-health', 'terminal-closure']), acceptance: null, wallClock: true, dataset: false, tarball: false }),
  G16: Object.freeze({ procedure: 'AP-04', evidenceType: 'real-app', roles: Object.freeze(['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies']), acceptance: null, wallClock: true, dataset: true, tarball: false }),
  G17: Object.freeze({ procedure: 'AP-05', evidenceType: 'real-app', roles: Object.freeze(['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention']), acceptance: 'human', wallClock: false, dataset: false, tarball: false }),
  G18: Object.freeze({ procedure: 'AP-06', evidenceType: 'human', roles: Object.freeze(['tarball-audit', 'adopter-acceptance']), acceptance: 'adopter', wallClock: false, dataset: false, tarball: true }),
})
export const RECEIPT_GATE_IDS = Object.freeze(Object.keys(RECEIPT_GATES))

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const PLACEHOLDER = /^(?:unknown|n\/a|na|none|null|tbd|todo|latest|-+|\?+|0)$/i
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isIdentifier = (value) => typeof value === 'string' && IDENTIFIER.test(value)
const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const pinned = (value) => typeof value === 'string' && value.trim() !== '' && !PLACEHOLDER.test(value.trim())

// Every check answers a list of { code, pointer, message }. Each is a
// separate rule so the mutation controls of the test suite can switch one
// off and prove the negative case that depends on it then passes.
export const RECEIPT_RULES = Object.freeze({
  gate(receipt, { gateId }) {
    return receipt.gate === gateId ? [] : [{ code: 'gate-mismatch', pointer: '/gate', message: `the receipt is for ${receipt.gate}, not ${gateId}` }]
  },
  procedure(receipt, { gate }) {
    const expected = new RegExp(`^${gate.procedure}(?:[.:-][A-Za-z0-9._:-]+)?$`)
    return expected.test(receipt.procedureId) ? [] : [{ code: 'procedure-mismatch', pointer: '/procedureId', message: `this gate is produced by ${gate.procedure}` }]
  },
  evidenceType(receipt, { gate }) {
    return receipt.evidenceType === gate.evidenceType ? [] : [{ code: 'evidence-type-mismatch', pointer: '/evidenceType', message: `this gate needs ${gate.evidenceType} evidence; a node result cannot stand for it` }]
  },
  versionPins(receipt) {
    const missing = []
    for (const [pointer, value] of [['/environment/os/name', receipt.environment.os.name], ['/environment/os/version', receipt.environment.os.version], ['/environment/app/name', receipt.environment.app.name], ['/environment/app/version', receipt.environment.app.version], ['/environment/cli/version', receipt.environment.cli.version]]) {
      if (!pinned(value)) missing.push({ code: 'version-not-pinned', pointer, message: 'an exact installed version is recorded, never a placeholder' })
    }
    return missing
  },
  candidateIdentity(receipt, { gate }) {
    const missing = []
    if (/^0{40}$/.test(receipt.candidate.commit)) missing.push({ code: 'candidate-not-pinned', pointer: '/candidate/commit', message: 'the candidate commit is a placeholder' })
    if (!DIGEST.test(String(receipt.candidate.treeDigest))) missing.push({ code: 'candidate-not-pinned', pointer: '/candidate/treeDigest', message: 'the candidate tree digest is missing' })
    if (gate.tarball && !DIGEST.test(String(receipt.candidate.tarballDigest ?? ''))) missing.push({ code: 'candidate-not-pinned', pointer: '/candidate/tarballDigest', message: 'this gate binds the exact tarball' })
    return missing
  },
  hostIdentity(receipt, { ext }) {
    const missing = []
    if (!isPlainObject(ext.host) || !isIdentifier(ext.host.id)) missing.push({ code: 'host-identity-missing', pointer: `/ext/${RECEIPT_EXT_KEY}/host/id`, message: 'the host the procedure ran on is identified' })
    if (!isPlainObject(ext.operator) || !isIdentifier(ext.operator.id)) missing.push({ code: 'operator-identity-missing', pointer: `/ext/${RECEIPT_EXT_KEY}/operator/id`, message: 'the operator who ran the procedure is identified' })
    return missing
  },
  evidenceHashes(receipt, { gate, ext }) {
    const missing = []
    const names = new Map(receipt.evidence.map((item) => [item.name, item]))
    receipt.evidence.forEach((item, index) => {
      if (!DIGEST.test(String(item.digest)) || !Number.isInteger(item.byteLength) || item.byteLength < 1) missing.push({ code: 'evidence-not-hashed', pointer: `/evidence/${index}`, message: 'every raw evidence file is hashed and non-empty' })
    })
    const roles = isPlainObject(ext.evidenceRoles) ? ext.evidenceRoles : {}
    for (const role of gate.roles) {
      const name = roles[role]
      if (typeof name !== 'string' || !names.has(name)) missing.push({ code: 'evidence-role-missing', pointer: `/ext/${RECEIPT_EXT_KEY}/evidenceRoles/${role}`, message: `the procedure records ${role} as hashed raw evidence` })
    }
    for (const role of Object.keys(roles)) if (!gate.roles.includes(role)) missing.push({ code: 'evidence-role-unknown', pointer: `/ext/${RECEIPT_EXT_KEY}/evidenceRoles/${role}`, message: 'this gate has no such evidence role' })
    return missing
  },
  acceptance(receipt, { gate, ext }) {
    const pointer = `/ext/${RECEIPT_EXT_KEY}/acceptance`
    if (gate.acceptance === null) return ext.acceptance === undefined ? [] : [{ code: 'acceptance-not-expected', pointer, message: 'this gate records automation and host evidence; a separate acceptance belongs to another gate' }]
    const acceptance = ext.acceptance
    if (!isPlainObject(acceptance)) return [{ code: 'acceptance-missing', pointer, message: `this gate needs the separately recorded ${gate.acceptance} acceptance` }]
    const missing = []
    if (acceptance.kind !== gate.acceptance) missing.push({ code: 'acceptance-kind-mismatch', pointer: `${pointer}/kind`, message: `this gate needs a ${gate.acceptance} acceptance` })
    if (!isIdentifier(acceptance.actor)) missing.push({ code: 'acceptance-missing', pointer: `${pointer}/actor`, message: 'the person who accepted is identified' })
    if (!isTime(acceptance.recordedAt)) missing.push({ code: 'acceptance-missing', pointer: `${pointer}/recordedAt`, message: 'when the acceptance was recorded' })
    if (typeof acceptance.evidenceName !== 'string' || !receipt.evidence.some((item) => item.name === acceptance.evidenceName)) missing.push({ code: 'acceptance-missing', pointer: `${pointer}/evidenceName`, message: 'the acceptance names its own hashed evidence entry' })
    if (isPlainObject(ext.operator) && isIdentifier(acceptance.actor) && acceptance.actor === ext.operator.id && gate.acceptance === 'adopter') missing.push({ code: 'acceptance-not-separate', pointer: `${pointer}/actor`, message: 'the adopter acceptance is recorded by the adopter, not the operator' })
    return missing
  },
  wallClock(receipt, { gate, ext }) {
    if (!gate.wallClock) return []
    const clock = ext.wallClock
    const pointer = `/ext/${RECEIPT_EXT_KEY}/wallClock`
    if (!isPlainObject(clock) || !isTime(clock.startedAt) || !isTime(clock.endedAt)) return [{ code: 'wall-clock-missing', pointer, message: 'host procedures record the wall clock before and after' }]
    return Date.parse(clock.endedAt) >= Date.parse(clock.startedAt) ? [] : [{ code: 'wall-clock-missing', pointer, message: 'the wall clock ends after it starts' }]
  },
  dataset(receipt, { gate, ext }) {
    if (!gate.dataset) return []
    const dataset = ext.dataset
    const pointer = `/ext/${RECEIPT_EXT_KEY}/dataset`
    if (!isPlainObject(dataset) || !Number.isInteger(dataset.nodes) || dataset.nodes < 1 || !Number.isInteger(dataset.edges) || dataset.edges < 0 || !DIGEST.test(String(dataset.fixtureDigest))) {
      return [{ code: 'dataset-missing', pointer, message: 'the generated dataset is described by node count, edge count and fixture digest' }]
    }
    return []
  },
})

const EXT_KEYS = new Set(['host', 'operator', 'evidenceRoles', 'acceptance', 'wallClock', 'dataset'])

function extensionOf(receipt) {
  const ext = receipt.ext?.[RECEIPT_EXT_KEY]
  if (ext === undefined) return { ext: {}, missing: [{ code: 'extension-missing', pointer: `/ext/${RECEIPT_EXT_KEY}`, message: 'host, operator, evidence roles and acceptance are recorded under the extension key' }] }
  if (!isPlainObject(ext)) return { ext: {}, missing: [{ code: 'extension-missing', pointer: `/ext/${RECEIPT_EXT_KEY}`, message: 'the extension member is an object' }] }
  const unknown = Object.keys(ext).filter((key) => !EXT_KEYS.has(key)).sort()
  return { ext, missing: unknown.map((key) => ({ code: 'extension-key-unknown', pointer: `/ext/${RECEIPT_EXT_KEY}/${key}`, message: 'the receipt extension is a closed shape' })) }
}

// Test seam: the mutation controls substitute a rule table with one rule
// switched off. Production uses validateAcceptanceReceipt.
export function createReceiptValidatorForOracleTests(rules = RECEIPT_RULES) {
  const table = { ...RECEIPT_RULES, ...rules }
  return function validateAcceptanceReceipt(receipt, { gate: gateId } = {}) {
    const constant = { label: RECEIPT_VALIDATION_LABEL, gateClosed: false, closes: 'nothing', note: 'A schema-valid receipt closes no gate. The gate owner inspects the actual app, host or adopter evidence and records the closing in the parent matrix.' }
    const requested = gateId ?? (isPlainObject(receipt) ? receipt.gate : undefined)
    if (!RECEIPT_GATE_IDS.includes(requested)) {
      return { ...constant, gate: typeof requested === 'string' ? requested.slice(0, 8) : null, schemaValid: false, requirementsMet: false, valid: false, outcome: null, evidenceType: null, missing: [{ code: 'gate-not-owned', pointer: '/gate', message: `this validator knows the gates ${RECEIPT_GATE_IDS.join(', ')}` }] }
    }
    const gate = RECEIPT_GATES[requested]
    const schemaErrors = validateObsidianContract('acceptance-receipt', receipt)
    if (schemaErrors.length > 0) {
      return { ...constant, gate: requested, schemaValid: false, requirementsMet: false, valid: false, outcome: null, evidenceType: null, missing: schemaErrors.map((error) => ({ code: error.code, pointer: null, message: error.message })) }
    }
    const { ext, missing: extensionShape } = extensionOf(receipt)
    const context = { gateId: requested, gate, ext }
    // The rules run in table order, gate identity first, so a receipt of another gate is told that before anything about its extension.
    const missing = []
    for (const name of Object.keys(RECEIPT_RULES)) missing.push(...table[name](receipt, context))
    missing.push(...extensionShape)
    const requirementsMet = missing.length === 0
    return { ...constant, gate: requested, schemaValid: true, requirementsMet, valid: requirementsMet, outcome: receipt.outcome, evidenceType: receipt.evidenceType, missing }
  }
}

export const validateAcceptanceReceipt = createReceiptValidatorForOracleTests()

// The field table, for documentation and for the test that pins it.
export function receiptRequirementsFor(gateId) {
  const gate = RECEIPT_GATES[gateId]
  if (!gate) return null
  return {
    gate: gateId,
    procedure: gate.procedure,
    evidenceType: gate.evidenceType,
    always: ['candidate.commit', 'candidate.treeDigest', 'environment.os.{name,version}', 'environment.app.{name,version}', 'environment.cli.version', 'evidence[].{name,digest,byteLength>0}', `ext.${RECEIPT_EXT_KEY}.host.id`, `ext.${RECEIPT_EXT_KEY}.operator.id`],
    evidenceRoles: [...gate.roles],
    acceptance: gate.acceptance,
    wallClock: gate.wallClock,
    dataset: gate.dataset,
    tarballDigest: gate.tarball,
  }
}
