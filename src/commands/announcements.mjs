#!/usr/bin/env node
// atelier announcements list|verify|show
//
// Pull-only inbound channel: MNSTRY announcements are signed JSON documents
// committed under announcements/ in this repository. Users receive them by
// running `git pull` — pulling is the consent act — and verify them against
// the committed MNSTRY announcements public key. This command never fetches
// anything: it only reads local files. No network access anywhere.
//
// The announcement shape (mnstry.announcement@v1) is runtime-defined, not a
// contracts/ schema: it is validated structurally here in code so the
// governed contract corpus stays stable.
//
// Self-contained subcommand parser (no shared CLI plumbing) so the module can
// be invoked directly: node src/commands/announcements.mjs <subcommand> ...
//
// Exit codes: 0 success (all documents verified), 1 one or more documents
// failed verification, 2 usage or input error. Log-safety contract: output
// may name keyId, algorithm, file paths, and — only after a signature
// verifies — announcement content. An unverified document's body is never
// printed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyDocument } from '../attestation/sign.mjs'

const PACKAGE_ROOT = process.env.MNSTRY_ATELIER_PACKAGE_ROOT
  ?? fileURLToPath(new URL('../..', import.meta.url))
const DEFAULT_DIR = path.join(PACKAGE_ROOT, 'announcements')
const DEFAULT_PUBLIC_KEY = path.join(DEFAULT_DIR, 'keys', 'mnstry-announcements.public.v1.json')
const ANNOUNCEMENT_SCHEMA = 'mnstry.announcement@v1'

const USAGE = `Usage: atelier announcements <subcommand>

Subcommands:
  list [--dir DIR] [--public-key FILE]
      List every announcement in the announcements directory (default: the
      package's announcements/), verifying each against the public key.
      Documents that do not verify are flagged loudly and fail the exit code.

  verify <file> [--public-key FILE] [--json]
      Verify one announcement document. --public-key defaults to the
      committed MNSTRY announcements key. --json prints { valid, reasons }.

  show <file> [--public-key FILE]
      Print an announcement's title and body — only if its signature
      verifies. Refuses (exit 1) otherwise; an unverified body is never shown.

This channel is pull-only: announcements arrive via git pull and nothing in
this kit ever contacts a network to look for them.

Exit codes: 0 all documents verified, 1 verification failed, 2 usage or
input error.`

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

function loadPublicKey(keyPath) {
  const doc = readJsonFile(keyPath, 'public key')
  if (!doc || typeof doc !== 'object' || !doc.publicKeyJwk) {
    fail(`public key file has no publicKeyJwk member: ${keyPath}`)
  }
  return doc
}

// Structural validation of the runtime-defined announcement shape. Returns
// reason objects in the same { code, message } vocabulary the signature
// verifier uses, so callers can report one merged list.
function announcementShapeReasons(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return [{ code: 'announcement.shape', message: 'announcement is not a JSON object' }]
  }
  const reasons = []
  const push = (message) => reasons.push({ code: 'announcement.shape', message })
  if (doc.schema !== ANNOUNCEMENT_SCHEMA) {
    push(`schema must be the constant ${ANNOUNCEMENT_SCHEMA}`)
  }
  if (typeof doc.announcementId !== 'string' || !doc.announcementId.startsWith('announcement:')) {
    push("announcementId must be a string with the 'announcement:' prefix")
  }
  if (typeof doc.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(doc.publishedAt)
    || Number.isNaN(Date.parse(doc.publishedAt))) {
    push('publishedAt must be an ISO date string (YYYY-MM-DD, optionally with a time part)')
  }
  if (typeof doc.title !== 'string' || doc.title.length === 0) {
    push('title must be a non-empty string')
  }
  if (typeof doc.body !== 'string') {
    push('body must be a markdown string')
  }
  if (!('signature' in doc)) {
    push('signature member is required (null only while unsigned; an unsigned announcement never verifies)')
  }
  return reasons
}

// Verify one parsed announcement document: structural shape first, then the
// detached signature over the JCS bytes with signature set to null (the same
// normative rule the attestation flow uses). Never throws on bad documents.
function verifyAnnouncement(doc, publicKey) {
  const reasons = [...announcementShapeReasons(doc)]
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    reasons.push(...verifyDocument(doc, { publicKey }).reasons)
  }
  return { valid: reasons.length === 0, reasons }
}

function runVerify(argv) {
  const options = parseOptions(argv, { 'public-key': 'value', json: 'flag' })
  const [file] = options._
  if (!file || options._.length !== 1) fail(`announcements verify requires exactly one announcement file\n\n${USAGE}`)
  const publicKey = loadPublicKey(options['public-key'] ?? DEFAULT_PUBLIC_KEY)
  const doc = readJsonFile(file, 'announcement')
  const { valid, reasons } = verifyAnnouncement(doc, publicKey)
  if (options.json) {
    console.log(JSON.stringify({ valid, reasons }, null, 2))
  } else if (valid) {
    console.log(`announcement signature is valid (keyId ${doc.signature.keyId})`)
  } else {
    for (const reason of reasons) console.error(`[${reason.code}] ${reason.message}`)
  }
  process.exit(valid ? 0 : 1)
}

function runShow(argv) {
  const options = parseOptions(argv, { 'public-key': 'value' })
  const [file] = options._
  if (!file || options._.length !== 1) fail(`announcements show requires exactly one announcement file\n\n${USAGE}`)
  const publicKey = loadPublicKey(options['public-key'] ?? DEFAULT_PUBLIC_KEY)
  const doc = readJsonFile(file, 'announcement')
  const { valid, reasons } = verifyAnnouncement(doc, publicKey)
  if (!valid) {
    console.error(`refusing to show ${file}: the announcement does not verify, so its content is untrusted`)
    for (const reason of reasons) console.error(`[${reason.code}] ${reason.message}`)
    process.exit(1)
  }
  console.log(`${doc.title}`)
  console.log(`${doc.announcementId} — ${doc.publishedAt} (signature valid, keyId ${doc.signature.keyId})`)
  console.log('')
  console.log(doc.body)
  process.exit(0)
}

function runList(argv) {
  const options = parseOptions(argv, { dir: 'value', 'public-key': 'value' })
  if (options._.length) fail(`announcements list takes options only\n\n${USAGE}`)
  const dir = options.dir ?? DEFAULT_DIR
  const publicKey = loadPublicKey(options['public-key'] ?? path.join(dir, 'keys', 'mnstry-announcements.public.v1.json'))
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    fail(`cannot read announcements directory: ${dir}`)
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
  if (files.length === 0) {
    console.log(`no announcements found in ${dir}`)
    process.exit(0)
  }
  let failures = 0
  for (const name of files) {
    const file = path.join(dir, name)
    let doc = null
    let reasons = null
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      reasons = [{ code: 'announcement.unreadable', message: 'file is missing or not valid JSON' }]
    }
    if (!reasons) {
      const result = verifyAnnouncement(doc, publicKey)
      if (!result.valid) reasons = result.reasons
    }
    if (reasons) {
      failures += 1
      console.error(`!! UNVERIFIED ${name} — do not trust this file's content`)
      for (const reason of reasons) console.error(`   [${reason.code}] ${reason.message}`)
    } else {
      console.log(`${doc.announcementId}  ${doc.publishedAt}  ${doc.title}`)
    }
  }
  if (failures > 0) {
    console.error(`${failures} of ${files.length} announcement file(s) failed verification`)
  }
  process.exit(failures > 0 ? 1 : 0)
}

const argv = process.argv.slice(2)
const subcommand = argv[0]
if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  console.log(USAGE)
  process.exit(0)
}
if (subcommand === 'list') runList(argv.slice(1))
else if (subcommand === 'verify') runVerify(argv.slice(1))
else if (subcommand === 'show') runShow(argv.slice(1))
else fail(`unknown announcements subcommand: ${subcommand}\n\n${USAGE}`)
