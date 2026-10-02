import fs from 'node:fs'
import { loadSigningKey, safeLabel, signDocument, verifyDocument } from '../attestation/sign.mjs'
import { commandProject, firstString, parseArgs } from '../project/config.mjs'
import { HOST_OWNER_KEYS_PATH, delegationBindings, draftDelegation, loadOwnerKeysFile, validateDelegation } from './delegation.mjs'
import { loadBoundaryPolicy, validateBoundaryPolicy } from './policy.mjs'

export const DELEGATION_USAGE = `Usage: atelier boundary delegation <draft|sign|verify>

  draft --id ID --owner ACTOR --operator ACTOR --repos A[,B] --operations pre-commit[,boundary-check]
        --expires RFC3339 [--not-before RFC3339] [--out FILE] [--project-config FILE]
      Write an unsigned delegation. It binds the current boundary policy, the
      managed repository set and each listed repository's root commit.

  sign <delegation.json> --key FILE [--out FILE] [--project-config FILE]
      The OWNER signs with their own private key file (from attestation keygen).
      The project is required: sign recomputes the bindings from it, refuses a
      draft that does not match, and prints what is being authorized.

  verify <delegation.json> [--owner-keys FILE] [--json]
      Report the signature against the host owner-keys file
      (${HOST_OWNER_KEYS_PATH}), or against FILE to inspect a candidate host
      file, together with that file's trust result and revocation. This is a
      diagnostic; boundary check decides whether a delegation applies.

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
  return console.error(`written to ${out}`)
}

function projectAndPolicy(argv) {
  const project = commandProject({ argv })
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) fail(loaded.errors.join('\n'))
  // Never draft or sign against a policy the check itself would reject.
  const invalid = validateBoundaryPolicy(loaded.policy, project)
  if (invalid.length) fail(`the boundary policy is invalid:\n${invalid.join('\n')}`)
  return { project, policy: loaded.policy }
}

function runDraft(args, argv) {
  const { project, policy } = projectAndPolicy(argv)
  const expiresAt = firstString(args.expires)
  if (!expiresAt) fail(`delegation draft requires --expires\n\n${DELEGATION_USAGE}`)
  const draft = draftDelegation({
    policy,
    project,
    id: firstString(args.id),
    owner: firstString(args.owner),
    operator: firstString(args.operator),
    repos: list(args.repos),
    operations: list(args.operations),
    notBefore: firstString(args['not-before']) ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt,
  })
  if (!draft.ok && !draft.errors.every((message) => /repoRoots/.test(message))) fail(draft.errors.join('\n'))
  if (Object.values(draft.delegation.repoRoots).some((root) => !root)) fail('every listed repository needs at least one commit before it can be delegated')
  if (!draft.ok) fail(draft.errors.join('\n'))
  writeOutput(firstString(args.out), draft.delegation)
}

function runSign(args, argv) {
  const [file] = args._
  if (!file) fail(`delegation sign requires a delegation file\n\n${DELEGATION_USAGE}`)
  const keyPath = firstString(args.key)
  if (!keyPath) fail(`delegation sign requires --key FILE (the owner's own private key)\n\n${DELEGATION_USAGE}`)
  const doc = readJsonFile(file, 'delegation')
  if (doc?.signature !== null) fail('delegation sign requires an unsigned delegation (signature: null)')
  const { project, policy } = projectAndPolicy(argv)
  const shapeErrors = validateDelegation({ ...doc, signature: { algorithm: 'ed25519', keyId: 'unsigned', value: 'unsigned' } }, policy)
  if (shapeErrors.length) fail(shapeErrors.join('\n'))
  // The owner signs what the current project binds, never an opaque digest.
  const expected = delegationBindings({ policy, project, repos: doc.repos })
  if (doc.policyDigest !== expected.policyDigest) fail('the draft does not bind the current boundary policy; draft it again from this project')
  if (doc.repos.some((name) => !expected.repoRoots[name] || doc.repoRoots[name] !== expected.repoRoots[name])) {
    fail('the draft does not bind these repositories\' root commits; draft it again from this project')
  }
  // Every value is printed through safeLabel: ids come from operator-editable files.
  const operatorActor = policy.actors[doc.operator] ?? {}
  const label = (value) => safeLabel(value, 160)
  console.error([
    `Authorizing delegation ${label(doc.id)}:`,
    `  operator ${label(doc.operator)} may pass the actor check owned by ${label(doc.owner)}`,
    `  the operator is recognised by githubLogin ${label(operatorActor.githubLogin ?? '(none)')} and gitEmails ${(operatorActor.gitEmails ?? []).map((email) => label(email)).join(', ') || '(none)'}`,
    ...doc.repos.map((name) => `  repository ${label(name)} with root commit ${label(doc.repoRoots[name])}`),
    `  operations: ${doc.operations.map((op) => label(op)).join(', ')}`,
    `  from ${label(new Date(Date.parse(doc.notBefore)).toISOString())} until ${label(new Date(Date.parse(doc.expiresAt)).toISOString())}`,
    `  while the boundary policy and repository set stay ${label(doc.policyDigest)}`,
  ].join('\n'))
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

function runVerify(args) {
  const [file] = args._
  if (!file) fail(`delegation verify requires a delegation file\n\n${DELEGATION_USAGE}`)
  const doc = readJsonFile(file, 'delegation')
  const keysFile = firstString(args['owner-keys']) ?? HOST_OWNER_KEYS_PATH
  const ownerKeys = loadOwnerKeysFile(keysFile)
  const report = { ownerKeysFile: keysFile, hostTrust: ownerKeys.ok ? { ok: true } : { ok: false, reason: ownerKeys.reason }, signatureValid: false, revoked: false, reasons: [] }
  if (ownerKeys.ok) {
    const key = ownerKeys.keys.find((item) => item.actorId === doc?.owner && item.keyId === doc?.signature?.keyId)
    if (key) {
      const checked = verifyDocument(doc, { publicKey: key })
      report.signatureValid = checked.valid
      report.reasons.push(...checked.reasons)
      report.keyId = key.keyId
      report.owner = key.actorId
    } else report.reasons.push({ code: 'delegation-owner-key-missing', message: 'no host key for this owner and keyId' })
    report.revoked = ownerKeys.revoked.has(doc?.id)
  } else report.reasons.push({ code: ownerKeys.reason, message: ownerKeys.errors.join('; ') })
  report.valid = report.hostTrust.ok && report.signatureValid && !report.revoked
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(report.valid ? `signature valid for ${report.owner} key ${report.keyId}; scope, time and bindings are decided by boundary check` : `invalid: ${report.reasons.map((item) => item.code).join(', ') || (report.revoked ? 'delegation-revoked' : 'unknown')}`)
  process.exit(report.valid ? 0 : 1)
}

export function runBoundaryDelegationCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const [subcommand, ...rest] = args._
  const sub = { ...args, _: rest }
  if (args.help || args.h) return console.log(DELEGATION_USAGE)
  if (subcommand === 'draft') return runDraft(sub, argv)
  if (subcommand === 'sign') return runSign(sub, argv)
  if (subcommand === 'verify') return runVerify(sub)
  return fail(DELEGATION_USAGE)
}
