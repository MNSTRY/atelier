#!/usr/bin/env node
// Verifies a directory of desktop acceptance receipts: schema, raw-evidence
// hashes against the files beside each receipt, version pins, candidate
// identity, completeness and signature. Prints a table and exits non-zero
// when any required gate's receipt is missing, incomplete, hash-mismatched or
// unsigned. A receipt that passes everything is "schema-valid and signed";
// this verifier never treats that as a closed gate. Closing is the owner's
// recorded decision in the parent matrix after inspecting the evidence.
//
// Usage:
//   node scripts/obsidian/verify-receipts.mjs --required G07,G13,G14,G15,G16,G17 --receipt-dir DIR
//       [--candidate-commit SHA] [--json]

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { OBSIDIAN_EXT_KEY } from '../../src/projection/obsidian/contracts.mjs'
import { RECEIPT_GATES, RECEIPT_GATE_IDS, validateAcceptanceReceipt } from '../../src/projection/obsidian/selection-ui/receipt.mjs'
import { OutputRefusal, parseArgs, sha256Digest } from './lib/common.mjs'
import { desktopExtension, receiptFileName } from './lib/receipts.mjs'

export const VERIFY_STATUSES = Object.freeze(['missing', 'schema-invalid', 'hash-mismatch', 'wrong-candidate', 'incomplete', 'requirements-missing', 'unsigned', 'ok'])
export const UNSIGNED_NOTE = 'schema-valid; closing owner must sign'
export const SIGNED_NOTE = 'schema-valid and signed; closing owner records the gate in the parent matrix (this verifier closes nothing)'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function checkEvidenceHashes(receipt, readEvidence) {
  const problems = []
  for (const item of receipt.evidence ?? []) {
    let bytes = null
    try { bytes = readEvidence(item.name) } catch { bytes = null }
    if (bytes === null) { problems.push({ code: 'evidence-file-missing', name: item.name }); continue }
    if (bytes.length !== item.byteLength) problems.push({ code: 'evidence-length-mismatch', name: item.name, expected: item.byteLength, actual: bytes.length })
    if (sha256Digest(bytes) !== item.digest) problems.push({ code: 'evidence-digest-mismatch', name: item.name })
  }
  return problems
}

// Signed: the gate's separately recorded acceptance is present and valid
// where the gate needs one, and the desktop tooling extension (when the
// receipt was produced by it) carries the closing owner's signature.
export function signatureOf(receipt, validation) {
  const spec = RECEIPT_GATES[receipt.gate]
  const acceptanceProblems = validation.missing.filter((item) => item.code.startsWith('acceptance-'))
  const desktop = desktopExtension(receipt)
  const signature = desktop?.signature ?? null
  const acceptance = receipt.ext?.[OBSIDIAN_EXT_KEY]?.acceptance ?? null
  const signed = acceptanceProblems.length === 0 && (desktop === null || isPlainObject(signature)) && (spec.acceptance === null || isPlainObject(acceptance))
  return { signed, signedBy: signature?.actor ?? acceptance?.actor ?? null, problems: acceptanceProblems.map((item) => item.code) }
}

export function classifyReceipt({ gate, receipt, readEvidence, candidateCommit = null, checkHashes = true, validate = validateAcceptanceReceipt }) {
  const row = { gate, status: null, ok: false, outcome: null, evidence: 0, signedBy: null, detail: [], note: null, closes: false }
  if (!receipt) { row.status = 'missing'; row.note = 'no receipt file'; return row }
  row.outcome = receipt.outcome ?? null
  row.evidence = Array.isArray(receipt.evidence) ? receipt.evidence.length : 0
  const validation = validate(receipt, { gate })
  if (!validation.schemaValid) { row.status = 'schema-invalid'; row.detail = validation.missing.map((item) => item.message); row.note = 'not a receipt of this gate'; return row }
  if (checkHashes) {
    const hashes = checkEvidenceHashes(receipt, readEvidence)
    if (hashes.length > 0) { row.status = 'hash-mismatch'; row.detail = hashes.map((item) => `${item.code}: ${item.name}`); row.note = 'raw evidence beside the receipt does not match its recorded hash'; return row }
  }
  if (candidateCommit !== null && receipt.candidate?.commit !== candidateCommit) { row.status = 'wrong-candidate'; row.detail = [`receipt candidate ${receipt.candidate?.commit}, expected ${candidateCommit}`]; row.note = 'the receipt is for another candidate'; return row }
  const desktop = desktopExtension(receipt)
  const roleProblems = validation.missing.filter((item) => item.code === 'evidence-role-missing')
  if (desktop?.status === 'incomplete' || (desktop?.manualStepsRequired?.length ?? 0) > 0 || (desktop?.pendingRoles?.length ?? 0) > 0 || roleProblems.length > 0) {
    row.status = 'incomplete'
    row.detail = [...(desktop?.pendingRoles ?? []).map((role) => `pending role ${role}`), ...roleProblems.map((item) => item.pointer)]
    row.note = 'manual steps or evidence roles are outstanding'
    return row
  }
  const other = validation.missing.filter((item) => !item.code.startsWith('acceptance-') && item.code !== 'evidence-role-missing')
  if (other.length > 0) { row.status = 'requirements-missing'; row.detail = other.map((item) => `${item.code} ${item.pointer ?? ''}`.trim()); row.note = 'pins, host, operator, wall clock or dataset are missing'; return row }
  const signature = signatureOf(receipt, validation)
  row.signedBy = signature.signedBy
  if (!signature.signed) { row.status = 'unsigned'; row.detail = signature.problems; row.note = UNSIGNED_NOTE; return row }
  row.status = 'ok'
  row.ok = true
  row.note = SIGNED_NOTE
  return row
}

export function createReceiptVerifierForOracleTests({ checkHashes = true, validate = validateAcceptanceReceipt } = {}) {
  return function verifyReceiptSet({ receiptDir, required, candidateCommit = null, readFile = (file) => fs.readFileSync(file) } = {}) {
    if (typeof receiptDir !== 'string' || !path.isAbsolute(receiptDir)) throw new OutputRefusal('usage', '--receipt-dir is an absolute directory')
    const gates = Array.isArray(required) ? required : String(required ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    if (gates.length === 0) throw new OutputRefusal('usage', '--required names at least one gate')
    for (const gate of gates) if (!RECEIPT_GATE_IDS.includes(gate)) throw new OutputRefusal('usage', `unknown gate ${gate.slice(0, 8)}; known: ${RECEIPT_GATE_IDS.join(', ')}`)
    const rows = []
    let reference = candidateCommit
    for (const gate of gates) {
      const file = path.join(receiptDir, receiptFileName(gate))
      let receipt = null
      let parseError = null
      try { receipt = JSON.parse(String(readFile(file))) } catch (error) { receipt = null; parseError = error.code === 'ENOENT' ? null : error.message }
      if (receipt && reference === null && typeof receipt.candidate?.commit === 'string') reference = receipt.candidate.commit
      const row = classifyReceipt({ gate, receipt, readEvidence: (name) => readFile(path.join(receiptDir, name)), candidateCommit: reference, checkHashes, validate })
      if (parseError) { row.status = 'schema-invalid'; row.detail = [parseError]; row.note = 'the receipt file is not JSON' }
      rows.push(row)
    }
    return { receiptDir, required: gates, candidateCommit: reference, rows, ok: rows.every((row) => row.ok), closes: false, note: 'A verified receipt set is an input to the closing owner; it closes no gate.' }
  }
}

export const verifyReceiptSet = createReceiptVerifierForOracleTests()

export function formatTable(result) {
  const header = ['gate', 'status', 'outcome', 'evidence', 'signed by', 'note']
  const rows = result.rows.map((row) => [row.gate, row.status, row.outcome ?? '-', String(row.evidence), row.signedBy ?? '-', row.note ?? ''])
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()
  const lines = [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)]
  for (const row of result.rows) for (const detail of row.detail) lines.push(`  ${row.gate}: ${detail}`)
  lines.push(`candidate: ${result.candidateCommit ?? '(none recorded)'}`)
  lines.push(result.ok ? `all required receipts are ${SIGNED_NOTE}` : 'not all required receipts are complete, hashed and signed')
  return lines.join('\n')
}

async function main(argv) {
  const args = parseArgs(argv, { flags: ['json', 'help'], values: ['required', 'receipt-dir', 'candidate-commit'] })
  if (args.help || !args.required || !args['receipt-dir']) {
    console.log('Usage: node scripts/obsidian/verify-receipts.mjs --required G07,G13,G14,G15,G16,G17 --receipt-dir DIR [--candidate-commit SHA] [--json]')
    return args.help ? 0 : 2
  }
  const result = verifyReceiptSet({ receiptDir: path.resolve(args['receipt-dir']), required: args.required, candidateCommit: args['candidate-commit'] ?? null })
  console.log(args.json ? JSON.stringify(result, null, 2) : formatTable(result))
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => { console.error(`[verify-receipts] ${error?.message ?? error}`); process.exitCode = error instanceof OutputRefusal ? 2 : 1 })
}
