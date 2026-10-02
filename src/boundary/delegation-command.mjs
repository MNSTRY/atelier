import fs from 'node:fs'
import { loadSigningKey, signDocument, verifyDocument } from '../attestation/sign.mjs'
import { commandProject, firstString, parseArgs } from '../project/config.mjs'
import { draftDelegation, loadOwnerKeysFile, ownerKeysForCommand, validateDelegation } from './delegation.mjs'
import { loadBoundaryPolicy } from './policy.mjs'

export const DELEGATION_USAGE = `Usage: atelier boundary delegation <draft|sign|verify>

  draft --id ID --owner ACTOR --operator ACTOR --repos A[,B] --operations pre-commit[,boundary-check]
        --expires RFC3339 [--not-before RFC3339] [--out FILE] [--project-config FILE]
      Write an unsigned delegation for the owner to read and sign. Its policy
      binding is computed from the current boundary policy.

  sign <delegation.json> --key FILE [--out FILE]
      The OWNER signs with their own private key file (from attestation keygen).
      Nobody else should hold that key.

  verify <delegation.json> --owner-keys FILE [--json]
      Check the signature against the host-supplied owner keys file, which must
      not be writable by the current user.

Exit codes: 0 success or valid, 1 invalid, 2 usage or input error.`

function fail(message) {
  console.error(message)
  process.exit(2)
}

const list = (value) => (typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [])

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    fail(`cannot read ${label} JSON: ${file}`)
  }
  return null
}

function writeOutput(out, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (!out) return process.stdout.write(text)
  try {
    fs.writeFileSync(out, text, { flag: 'wx' })
  } catch {
    fail(`refusing to write ${out}: it exists or cannot be created`)
  }
  return console.log(`written to ${out}`)
}

function runDraft(args, argv) {
  const project = commandProject({ argv })
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) fail(loaded.errors.join('\n'))
  const expiresAt = firstString(args.expires)
  if (!expiresAt) fail(`delegation draft requires --expires\n\n${DELEGATION_USAGE}`)
  const draft = draftDelegation({
    policy: loaded.policy,
    id: firstString(args.id),
    owner: firstString(args.owner),
    operator: firstString(args.operator),
    repos: list(args.repos),
    operations: list(args.operations),
    notBefore: firstString(args['not-before']) ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt,
  })
  if (!draft.ok) fail(draft.errors.join('\n'))
  writeOutput(firstString(args.out), draft.delegation)
}

function runSign(args) {
  const [file] = args._
  if (!file) fail(`delegation sign requires a delegation file\n\n${DELEGATION_USAGE}`)
  const keyPath = firstString(args.key)
  if (!keyPath) fail(`delegation sign requires --key FILE (the owner's own private key)\n\n${DELEGATION_USAGE}`)
  const doc = readJsonFile(file, 'delegation')
  // Shape only: the signer may not have the project. The policy check happens where it is used.
  const shapePolicy = { actors: { [doc?.owner]: {}, [doc?.operator]: {} }, repos: Object.fromEntries((Array.isArray(doc?.repos) ? doc.repos : []).map((name) => [name, { kind: 'private_domain', ownerActor: doc.owner }])) }
  if (doc?.signature !== null) fail('delegation sign requires an unsigned delegation (signature: null)')
  const shapeErrors = validateDelegation({ ...doc, signature: { algorithm: 'ed25519', keyId: 'unsigned', value: 'unsigned' } }, shapePolicy)
  if (shapeErrors.length) fail(shapeErrors.join('\n'))
  let signed
  try {
    // An explicit key file only: the environment and working-directory fallbacks are not used for delegations.
    const key = loadSigningKey({ keyPath, env: {}, cwd: '/nonexistent' })
    if (key.algorithm !== 'ed25519') fail('delegations are signed with ed25519 keys')
    signed = signDocument(doc, { privateKey: key.privateKeyJwk, keyId: key.keyId, algorithm: key.algorithm })
  } catch (error) {
    fail(error.message)
  }
  writeOutput(firstString(args.out), signed)
}

function runVerify(args, argv) {
  const [file] = args._
  if (!file) fail(`delegation verify requires a delegation file\n\n${DELEGATION_USAGE}`)
  const doc = readJsonFile(file, 'delegation')
  const project = args['project-config'] || args.project ? commandProject({ argv }) : null
  const ownerKeys = firstString(args['owner-keys']) ? loadOwnerKeysFile(firstString(args['owner-keys']), { project }) : (project ? ownerKeysForCommand(project, args) : null)
  if (!ownerKeys) fail(`delegation verify requires --owner-keys FILE\n\n${DELEGATION_USAGE}`)
  let report
  if (!ownerKeys.ok) {
    report = { valid: false, reasons: [{ code: ownerKeys.reason, message: ownerKeys.errors.join('; ') }] }
  } else {
    const key = ownerKeys.keys.find((item) => item.actorId === doc?.owner && item.keyId === doc?.signature?.keyId)
    report = key
      ? { ...verifyDocument(doc, { publicKey: key }), keyId: key.keyId, owner: key.actorId, revoked: ownerKeys.revoked.has(doc?.id) }
      : { valid: false, reasons: [{ code: 'delegation-owner-key-missing', message: 'no host-supplied key for this owner and keyId' }] }
    if (report.revoked) report = { ...report, valid: false, reasons: [...(report.reasons ?? []), { code: 'delegation-revoked', message: 'the host has revoked this delegation' }] }
  }
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(report.valid ? `valid: signed by ${report.owner} key ${report.keyId}` : `invalid: ${report.reasons.map((item) => item.code).join(', ')}`)
  process.exit(report.valid ? 0 : 1)
}

export function runBoundaryDelegationCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const [subcommand, ...rest] = args._
  const sub = { ...args, _: rest }
  if (args.help || args.h) return console.log(DELEGATION_USAGE)
  if (subcommand === 'draft') return runDraft(sub, argv)
  if (subcommand === 'sign') return runSign(sub)
  if (subcommand === 'verify') return runVerify(sub, argv)
  return fail(DELEGATION_USAGE)
}
