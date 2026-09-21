#!/usr/bin/env node
// The closing owner's signature on a desktop receipt, after inspecting the raw
// evidence beside it. Attaches the human-recorded evidence for roles the
// automation could not produce, writes an acceptance record naming what was
// inspected, records the separately kept human acceptance where the gate
// needs one, and sets the tooling signature. `closes` stays false: signing
// makes the receipt an input to the parent matrix, where the closing is
// recorded by its owner.
//
// Usage:
//   node scripts/obsidian/sign-receipt.mjs --receipt-dir DIR --gate G07 --actor ID --note "what was inspected"
//       [--attach ROLE=FILE ...] [--outcome passed|failed]

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { OBSIDIAN_EXT_KEY, validateObsidianContract } from '../../src/projection/obsidian/contracts.mjs'
import { RECEIPT_GATES, validateAcceptanceReceipt } from '../../src/projection/obsidian/selection-ui/receipt.mjs'
import { OutputRefusal, TOOLING_VERSION, isIdentifier, isoNow, parseArgs, sha256Digest, toIdentifier, writeJson } from './lib/common.mjs'
import { DESKTOP_EXT_KEY, ReceiptRefusal, evidenceFileName, readReceipt, receiptFileName } from './lib/receipts.mjs'

export const ACCEPTANCE_RECORD_ROLE = 'acceptance-record'

export function signReceipt({ receiptDir, gate, actor, note, attach = [], outcome = null, signedAt = isoNow(), readFile = (file) => fs.readFileSync(file) } = {}) {
  if (typeof receiptDir !== 'string' || !path.isAbsolute(receiptDir)) throw new ReceiptRefusal('receipt-dir-not-absolute', 'the receipt directory is an absolute path')
  const spec = RECEIPT_GATES[gate]
  if (!spec) throw new ReceiptRefusal('gate-not-owned', `no desktop receipt exists for ${String(gate).slice(0, 8)}`)
  if (spec.acceptance === 'adopter') throw new ReceiptRefusal('adopter-acceptance-separate', 'the adopter acceptance of G18 is recorded by the adopter, not by this tool')
  if (!isIdentifier(actor)) throw new ReceiptRefusal('actor-missing', 'the signing actor is a contract identifier')
  if (typeof note !== 'string' || note.trim() === '') throw new ReceiptRefusal('note-missing', 'the signature says what was inspected')
  const receipt = readReceipt(receiptDir, gate)
  if (!receipt) throw new ReceiptRefusal('receipt-missing', `no ${receiptFileName(gate)} under the receipt directory`)
  const extension = receipt.ext?.[OBSIDIAN_EXT_KEY]
  if (!extension || typeof extension !== 'object') throw new ReceiptRefusal('receipt-schema-invalid', 'the receipt carries no Obsidian extension')
  const desktop = receipt.ext[DESKTOP_EXT_KEY] ?? { tool: 'hand-written', toolVersion: TOOLING_VERSION, closes: false, humanAcceptance: null, signature: null, status: 'complete', pendingRoles: [], manualStepsRequired: [], notes: [] }
  if (desktop.signature) throw new ReceiptRefusal('already-signed', `the receipt was signed by ${desktop.signature.actor}`)
  const names = new Set(receipt.evidence.map((item) => item.name))
  const written = []
  for (const { role, file } of attach) {
    if (!spec.roles.includes(role)) throw new ReceiptRefusal('evidence-role-unknown', `${gate} has no evidence role ${String(role).slice(0, 40)}`)
    if (extension.evidenceRoles?.[role]) throw new ReceiptRefusal('evidence-role-recorded', `${role} is already recorded; it is not replaced`)
    const bytes = readFile(file)
    if (!bytes || bytes.length === 0) throw new ReceiptRefusal('evidence-empty', `${file} is empty; an empty observation is not evidence`)
    const name = evidenceFileName(gate, role)
    if (names.has(name)) throw new ReceiptRefusal('evidence-name-repeated', `${name} already exists beside the receipt`)
    written.push({ name, bytes })
    names.add(name)
    receipt.evidence.push({ name, digest: sha256Digest(bytes), byteLength: bytes.length })
    extension.evidenceRoles = { ...(extension.evidenceRoles ?? {}), [role]: name }
    desktop.pendingRoles = (desktop.pendingRoles ?? []).filter((item) => item !== role)
    desktop.manualStepsRequired = (desktop.manualStepsRequired ?? []).filter((item) => item.role !== role)
  }
  const outstanding = spec.roles.filter((role) => !extension.evidenceRoles?.[role])
  if (outstanding.length > 0 || (desktop.manualStepsRequired ?? []).length > 0) throw new ReceiptRefusal('manual-steps-outstanding', `attach evidence for ${outstanding.join(', ') || (desktop.manualStepsRequired ?? []).map((item) => item.role).join(', ')} before signing`)
  desktop.status = 'complete'
  desktop.pendingRoles = []
  if (receipt.outcome === 'blocked') {
    if (outcome !== 'passed' && outcome !== 'failed') throw new ReceiptRefusal('outcome-required', 'the receipt was blocked on manual steps; state --outcome passed|failed from what you observed')
    receipt.outcome = outcome
  } else if (outcome !== null && outcome !== receipt.outcome) throw new ReceiptRefusal('outcome-fixed', `the recorded outcome is ${receipt.outcome}; signing does not change it`)
  const recordName = evidenceFileName(gate, ACCEPTANCE_RECORD_ROLE)
  if (names.has(recordName)) throw new ReceiptRefusal('evidence-name-repeated', `${recordName} already exists beside the receipt`)
  const record = Buffer.from([`# ${gate} acceptance record`, `actor: ${actor}`, `signedAt: ${signedAt}`, `outcome: ${receipt.outcome}`, `closes: false (recorded in the parent matrix by the closing owner)`, '', 'Inspected evidence:', ...receipt.evidence.map((item) => `- ${item.name} ${item.digest} (${item.byteLength} bytes)`), '', 'Note:', note.trim(), ''].join('\n'), 'utf8')
  written.push({ name: recordName, bytes: record })
  receipt.evidence.push({ name: recordName, digest: sha256Digest(record), byteLength: record.length })
  if (spec.acceptance === 'human') extension.acceptance = { kind: 'human', actor, recordedAt: signedAt, evidenceName: recordName }
  desktop.signature = { actor, signedAt, evidenceName: recordName, note: note.trim() }
  desktop.humanAcceptance = spec.acceptance === 'human' ? { kind: 'human', actor, recordedAt: signedAt, evidenceName: recordName } : null
  desktop.closes = false
  receipt.ext[DESKTOP_EXT_KEY] = desktop
  const schemaErrors = validateObsidianContract('acceptance-receipt', receipt)
  if (schemaErrors.length > 0) throw new ReceiptRefusal('receipt-schema-invalid', 'signing produced a receipt that does not satisfy its schema', { errors: schemaErrors })
  for (const item of written) fs.writeFileSync(path.join(receiptDir, item.name), item.bytes)
  writeJson(path.join(receiptDir, receiptFileName(gate)), receipt)
  return { receiptPath: path.join(receiptDir, receiptFileName(gate)), receipt, validation: validateAcceptanceReceipt(receipt, { gate }), closes: false }
}

async function main(argv) {
  const args = parseArgs(argv, { flags: ['help', 'json'], values: ['receipt-dir', 'gate', 'actor', 'note', 'attach', 'outcome'] })
  if (args.help || !args['receipt-dir'] || !args.gate || !args.actor || !args.note) {
    console.log('Usage: node scripts/obsidian/sign-receipt.mjs --receipt-dir DIR --gate G07 --actor ID --note "what was inspected" [--attach ROLE=FILE[,ROLE=FILE...]] [--outcome passed|failed]')
    return args.help ? 0 : 2
  }
  const attach = String(args.attach ?? '').split(',').filter(Boolean).map((pair) => { const [role, file] = pair.split(/=(.*)/s); if (!role || !file) throw new OutputRefusal('usage', '--attach takes ROLE=FILE'); return { role, file: path.resolve(file) } })
  const result = signReceipt({ receiptDir: path.resolve(args['receipt-dir']), gate: args.gate, actor: toIdentifier(args.actor), note: args.note, attach, outcome: args.outcome ?? null })
  console.log(args.json ? JSON.stringify(result.receipt, null, 2) : `[sign-receipt] ${args.gate} signed by ${result.receipt.ext[DESKTOP_EXT_KEY].signature.actor}; requirementsMet ${result.validation.requirementsMet}; closes false`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => { console.error(`[sign-receipt] ${error?.message ?? error}`); process.exitCode = error instanceof OutputRefusal || error instanceof ReceiptRefusal ? 2 : 1 })
}
