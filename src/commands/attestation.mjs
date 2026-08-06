#!/usr/bin/env node
// atelier attestation hash|sign|verify|keygen
//
// Self-contained subcommand parser (no shared CLI plumbing) so the module can
// be invoked directly: node src/commands/attestation.mjs <subcommand> ...
//
// Exit codes: 0 success (verify: valid), 1 verify found the attestation
// invalid, 2 usage or input error. No network access anywhere in this
// command. Log-safety contract: output may name keyId and algorithm, never
// any private JWK member and never file contents.

import fs from 'node:fs'
import path from 'node:path'
import {
  generateKeyPair,
  loadSigningKey,
  payloadHashOf,
  signAttestation,
  verifyAttestation,
  verifyPayloadBinding,
  LOCAL_KEY_FILE,
} from '../attestation/sign.mjs'

const USAGE = `Usage: atelier attestation <subcommand>

Subcommands:
  hash <payload.json>
      Print the canonical payload hash object (sha-256 over RFC 8785 JCS).

  sign <attestation.json> [--key FILE] [--out FILE]
      Sign an unsigned attestation (signature must be null) with the local
      signing key file. Writes the signed document to stdout, or to --out.

  verify <attestation.json> --public-key FILE [--payload FILE] [--json]
      Verify the signature against a public key file, and, when --payload is
      given, the payload binding. --json prints { valid, reasons }.

  keygen --key-id ID [--algorithm ed25519|es256] [--out FILE]
      Generate a signing key pair. Writes the private key file (default
      ${LOCAL_KEY_FILE}, mode 0600, refuses to overwrite)
      and prints only the public key document.

Exit codes: 0 success or valid, 1 verify judged the attestation invalid,
2 usage or input error.`

function fail(message) {
  console.error(message)
  process.exit(2)
}

function parseOptions(argv, spec) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      if (!(name in spec)) fail(`unknown option --${name}\n\n${USAGE}`)
      if (spec[name] === 'flag') {
        options[name] = true
      } else {
        i += 1
        if (argv[i] === undefined) fail(`--${name} requires a value`)
        options[name] = argv[i]
      }
    } else {
      options._.push(arg)
    }
  }
  return options
}

function readJsonFile(file, label) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    fail(`cannot read ${label} file: ${file}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    fail(`${label} file is not valid JSON: ${file}`)
  }
  return null
}

function runHash(argv) {
  const options = parseOptions(argv, {})
  const [file] = options._
  if (!file || options._.length !== 1) fail(`attestation hash requires exactly one payload file\n\n${USAGE}`)
  const payload = readJsonFile(file, 'payload')
  try {
    console.log(JSON.stringify(payloadHashOf(payload), null, 2))
  } catch (error) {
    fail(`payload cannot be canonicalized: ${error.message}`)
  }
}

function runSign(argv) {
  const options = parseOptions(argv, { key: 'value', out: 'value' })
  const [file] = options._
  if (!file || options._.length !== 1) fail(`attestation sign requires exactly one attestation file\n\n${USAGE}`)
  const attestation = readJsonFile(file, 'attestation')
  let signed
  try {
    const key = loadSigningKey({ keyPath: options.key ?? null })
    signed = signAttestation({ attestation, key })
  } catch (error) {
    fail(error.message)
  }
  const output = `${JSON.stringify(signed, null, 2)}\n`
  if (options.out) {
    fs.writeFileSync(options.out, output)
    console.log(`signed attestation written to ${options.out}`)
  } else {
    process.stdout.write(output)
  }
}

function runVerify(argv) {
  const options = parseOptions(argv, { 'public-key': 'value', payload: 'value', json: 'flag' })
  const [file] = options._
  if (!file || options._.length !== 1) fail(`attestation verify requires exactly one attestation file\n\n${USAGE}`)
  if (!options['public-key']) fail(`attestation verify requires --public-key FILE\n\n${USAGE}`)
  const attestation = readJsonFile(file, 'attestation')
  const publicKey = readJsonFile(options['public-key'], 'public key')
  if (!publicKey || typeof publicKey !== 'object' || !publicKey.publicKeyJwk) {
    fail(`public key file has no publicKeyJwk member: ${options['public-key']}`)
  }
  const signature = verifyAttestation({ attestation, publicKey })
  const reasons = [...signature.reasons]
  let payloadBinding = null
  if (options.payload) {
    const payload = readJsonFile(options.payload, 'payload')
    payloadBinding = verifyPayloadBinding({ attestation, payload })
    reasons.push(...payloadBinding.reasons)
  }
  const valid = signature.valid && (payloadBinding === null || payloadBinding.valid)
  if (options.json) {
    console.log(JSON.stringify({ valid, payloadBindingChecked: payloadBinding !== null, reasons }, null, 2))
  } else if (valid) {
    console.log(`attestation signature is valid (keyId ${attestation?.signature?.keyId ?? 'unknown'})`)
    if (payloadBinding === null) console.log('payload binding not checked (pass --payload FILE to check it)')
    else console.log('payload binding is valid')
  } else {
    for (const reason of reasons) console.error(`[${reason.code}] ${reason.message}`)
  }
  process.exit(valid ? 0 : 1)
}

function runKeygen(argv) {
  const options = parseOptions(argv, { 'key-id': 'value', algorithm: 'value', out: 'value' })
  if (options._.length) fail(`attestation keygen takes options only\n\n${USAGE}`)
  const keyId = options['key-id']
  if (!keyId) fail(`attestation keygen requires --key-id ID\n\n${USAGE}`)
  const algorithm = options.algorithm ?? 'ed25519'
  if (algorithm !== 'ed25519' && algorithm !== 'es256') {
    fail(`--algorithm must be ed25519 or es256, got ${algorithm}`)
  }
  const outPath = path.resolve(options.out ?? LOCAL_KEY_FILE)
  if (fs.existsSync(outPath)) {
    fail(`refusing to overwrite existing signing key file: ${outPath}`)
  }
  const { privateKeyDoc, publicKeyDoc } = generateKeyPair({ algorithm, keyId })
  fs.writeFileSync(outPath, `${JSON.stringify(privateKeyDoc, null, 2)}\n`, { mode: 0o600 })
  console.error(`signing key file written to ${outPath} (mode 0600). Keep it out of version control; ${LOCAL_KEY_FILE} is gitignored by default.`)
  console.log(JSON.stringify(publicKeyDoc, null, 2))
}

const argv = process.argv.slice(2)
const subcommand = argv[0]
if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  console.log(USAGE)
  process.exit(0)
}
if (subcommand === 'hash') runHash(argv.slice(1))
else if (subcommand === 'sign') runSign(argv.slice(1))
else if (subcommand === 'verify') runVerify(argv.slice(1))
else if (subcommand === 'keygen') runKeygen(argv.slice(1))
else fail(`unknown attestation subcommand: ${subcommand}\n\n${USAGE}`)
