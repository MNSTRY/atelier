import fs from 'node:fs'
import path from 'node:path'
import { OBSIDIAN_EXT_KEY, validateObsidianContract } from '../../../src/projection/obsidian/contracts.mjs'
import { RECEIPT_GATES, validateAcceptanceReceipt } from '../../../src/projection/obsidian/selection-ui/receipt.mjs'
import { TOOLING_VERSION, isIdentifier, sha256Digest, toIdentifier, writeJson } from './common.mjs'

// Receipt writing for the desktop procedures. A receipt written here is a
// schema-valid document that names its gate, candidate, environment, host,
// operator and the hashed raw evidence recorded so far. It never closes a
// gate: `closes` is false, `humanAcceptance` and `signature` are null until
// the closing owner inspects the evidence and signs (scripts/obsidian/
// sign-receipt.mjs), and even a signed receipt is an input to the parent
// matrix, not a closing.

export const DESKTOP_EXT_KEY = 'mnstry.atelier.obsidian.desktop-receipts'
export const RECEIPT_STATUSES = Object.freeze(['complete', 'incomplete'])
// The gates the desktop procedures produce. G18 (package and adopter) is
// recorded by the adopter and the release gates, never by this tooling.
export const DESKTOP_GATES = Object.freeze(['G07', 'G13', 'G14', 'G15', 'G16', 'G17'])
export const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const receiptFileName = (gate) => `${gate}.json`
export const evidenceFileName = (gate, role, extension = 'txt') => `${gate}-${role}.${extension}`

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export class ReceiptRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'ReceiptRefusal'
    this.code = code
    this.detail = detail
  }
}

// Builds the receipt document from recorded evidence. Pure: it hashes the
// bytes it is given and writes nothing.
export function buildReceipt({ gate, candidate, environment, host, operator, evidence, recordedAt, outcome, wallClock = null, dataset = null, manualStepsRequired = [], capabilities = null, timings = null, notes = [], toolVersion = TOOLING_VERSION }) {
  const spec = DESKTOP_GATES.includes(gate) ? RECEIPT_GATES[gate] : null
  if (!spec) throw new ReceiptRefusal('gate-not-owned', `no desktop procedure produces ${String(gate).slice(0, 8)}`)
  if (!isPlainObject(candidate) || !/^[0-9a-f]{40}$/.test(String(candidate.commit)) || !/^sha256:[0-9a-f]{64}$/.test(String(candidate.treeDigest))) throw new ReceiptRefusal('candidate-missing', 'the receipt binds an exact candidate commit and tree digest')
  if (!isIdentifier(operator)) throw new ReceiptRefusal('operator-missing', 'the operator is a contract identifier')
  if (!isPlainObject(host) || !isIdentifier(host.id)) throw new ReceiptRefusal('host-missing', 'the host is identified')
  const names = new Set()
  const entries = []
  const roles = {}
  for (const item of evidence) {
    if (!EVIDENCE_NAME.test(String(item.name))) throw new ReceiptRefusal('evidence-name-invalid', `evidence name ${String(item.name).slice(0, 40)} is not a plain file name`)
    if (names.has(item.name)) throw new ReceiptRefusal('evidence-name-repeated', `evidence ${item.name} is recorded twice`)
    if (!Buffer.isBuffer(item.bytes) || item.bytes.length === 0) throw new ReceiptRefusal('evidence-empty', `evidence ${item.name} has no bytes; an empty observation is not evidence`)
    names.add(item.name)
    entries.push({ name: item.name, digest: sha256Digest(item.bytes), byteLength: item.bytes.length })
    if (item.role !== undefined && item.role !== null) {
      if (!spec.roles.includes(item.role)) throw new ReceiptRefusal('evidence-role-unknown', `${gate} has no evidence role ${String(item.role).slice(0, 40)}`)
      roles[item.role] = item.name
    }
  }
  const pendingRoles = spec.roles.filter((role) => roles[role] === undefined)
  const pendingSteps = manualStepsRequired.filter((step) => step.gate === gate)
  const status = pendingRoles.length === 0 && pendingSteps.length === 0 ? 'complete' : 'incomplete'
  const extension = { host: { id: host.id }, operator: { id: operator }, evidenceRoles: roles }
  if (spec.wallClock) {
    if (!isPlainObject(wallClock)) throw new ReceiptRefusal('wall-clock-missing', `${gate} records the wall clock before and after`)
    extension.wallClock = { startedAt: wallClock.startedAt, endedAt: wallClock.endedAt }
  }
  if (spec.dataset) {
    if (!isPlainObject(dataset)) throw new ReceiptRefusal('dataset-missing', `${gate} records the generated dataset`)
    extension.dataset = { nodes: dataset.nodes, edges: dataset.edges, fixtureDigest: dataset.fixtureDigest }
  }
  const receipt = {
    schema: 'atelier-obsidian-acceptance-receipt/v1',
    contractVersion: '1.0.0',
    receiptId: toIdentifier(`desktop-${gate}-${recordedAt.replace(/[^0-9]/g, '').slice(0, 14)}`),
    gate,
    procedureId: spec.procedure,
    candidate: { commit: candidate.commit, treeDigest: candidate.treeDigest, ...(candidate.ext ? { ext: candidate.ext } : {}) },
    environment,
    evidenceType: spec.evidenceType,
    evidence: entries,
    outcome,
    recordedAt,
    ext: {
      [OBSIDIAN_EXT_KEY]: extension,
      [DESKTOP_EXT_KEY]: {
        tool: 'scripts/obsidian/desktop-receipts.mjs',
        toolVersion,
        closes: false,
        humanAcceptance: null,
        signature: null,
        status,
        pendingRoles,
        manualStepsRequired: pendingSteps,
        host: { ...host },
        capabilities,
        timings,
        notes: [...notes, 'This receipt closes no gate. The closing owner inspects the raw evidence beside it, signs with scripts/obsidian/sign-receipt.mjs, and records the closing in the parent matrix.'],
      },
    },
  }
  const schemaErrors = validateObsidianContract('acceptance-receipt', receipt)
  if (schemaErrors.length > 0) throw new ReceiptRefusal('receipt-schema-invalid', 'the writer produced a receipt that does not satisfy its schema', { errors: schemaErrors })
  return receipt
}

// Writes the evidence files beside the receipt first, then the receipt: a
// receipt refused after a long desktop run still leaves its raw evidence on
// disk. The validator's answer is returned so a caller can show what is
// still missing.
export function writeGateReceipt({ receiptDir, ...input }) {
  if (typeof receiptDir !== 'string' || !path.isAbsolute(receiptDir)) throw new ReceiptRefusal('receipt-dir-not-absolute', 'the receipt directory is an absolute path')
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const item of input.evidence ?? []) if (Buffer.isBuffer(item.bytes) && EVIDENCE_NAME.test(String(item.name))) fs.writeFileSync(path.join(receiptDir, item.name), item.bytes)
  const receipt = buildReceipt(input)
  const receiptPath = path.join(receiptDir, receiptFileName(input.gate))
  writeJson(receiptPath, receipt)
  return { receiptPath, receipt, validation: validateAcceptanceReceipt(receipt, { gate: input.gate }) }
}

export const desktopExtension = (receipt) => (isPlainObject(receipt?.ext?.[DESKTOP_EXT_KEY]) ? receipt.ext[DESKTOP_EXT_KEY] : null)

export function readReceipt(receiptDir, gate) {
  const file = path.join(receiptDir, receiptFileName(gate))
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
