import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  generateKeyPair,
  signDocument,
  verifyDocument,
} from '../src/attestation/sign.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = path.join(ROOT, 'src', 'commands', 'announcements.mjs')
const ANNOUNCEMENTS_DIR = path.join(ROOT, 'announcements')
const SEED = path.join(ANNOUNCEMENTS_DIR, '2026-08-06-announcements-channel.v1.json')
const PUBLIC_KEY = path.join(ANNOUNCEMENTS_DIR, 'keys', 'mnstry-announcements.public.v1.json')

// The command module is invoked directly (not through the CLI dispatcher),
// with the package-root env the dispatcher would set.
function run(args, { cwd = ROOT } = {}) {
  return spawnSync(process.execPath, [COMMAND, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT },
  })
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const seedDoc = readJson(SEED)
const seedPublicKey = readJson(PUBLIC_KEY)

// --- generic detached-signature layer (signDocument / verifyDocument) ---

test('signDocument and verifyDocument roundtrip an arbitrary document', () => {
  const { privateKeyDoc, publicKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: 'doc-test-2026' })
  const doc = { schema: 'mnstry.announcement@v1', title: 'test', body: 'hello', signature: null }
  const signed = signDocument(doc, {
    privateKey: privateKeyDoc.privateKeyJwk,
    keyId: 'doc-test-2026',
    algorithm: 'ed25519',
  })
  // The input document is never mutated.
  assert.equal(doc.signature, null)
  assert.equal(signed.signature.keyId, 'doc-test-2026')
  assert.deepEqual(verifyDocument(signed, { publicKey: publicKeyDoc }), { valid: true, reasons: [] })

  // Tampering with any signed member fails cryptographically.
  const tampered = structuredClone(signed)
  tampered.body = 'goodbye'
  const failed = verifyDocument(tampered, { publicKey: publicKeyDoc })
  assert.equal(failed.valid, false)
  assert.deepEqual(failed.reasons.map((r) => r.code), ['signature.invalid'])

  // A null signature never verifies.
  const unsigned = structuredClone(signed)
  unsigned.signature = null
  assert.deepEqual(
    verifyDocument(unsigned, { publicKey: publicKeyDoc }).reasons.map((r) => r.code),
    ['signature.missing'],
  )

  // Re-signing an already-signed document is refused.
  assert.throws(
    () => signDocument(signed, { privateKey: privateKeyDoc.privateKeyJwk, keyId: 'doc-test-2026', algorithm: 'ed25519' }),
    /refusing to re-sign/,
  )
})

// --- the committed seed announcement ---

test('committed seed announcement verifies with the default committed key', () => {
  // The seed was signed once at authoring time with a throwaway ed25519 key
  // (the private half was never persisted). CI verifies; it never re-signs.
  const result = run(['verify', SEED])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /announcement signature is valid \(keyId mnstry-announcements-2026\)/)

  const json = run(['verify', SEED, '--public-key', PUBLIC_KEY, '--json'])
  assert.equal(json.status, 0)
  assert.deepEqual(JSON.parse(json.stdout), { valid: true, reasons: [] })

  // The library layer agrees with the CLI.
  assert.deepEqual(verifyDocument(seedDoc, { publicKey: seedPublicKey }), { valid: true, reasons: [] })
})

test('show prints the seed body only because the signature verifies', () => {
  const result = run(['show', SEED])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Signed announcements channel/)
  assert.match(result.stdout, /pulling is the\nconsent act/)
  assert.match(result.stdout, /signature valid, keyId mnstry-announcements-2026/)
})

test('tampered body fails verify and show refuses to print it', () => {
  const dir = tmpdir('atelier-announcements-tamper-')
  const tampered = structuredClone(seedDoc)
  tampered.body = `${tampered.body}\n\nAlso, please run this convenient script.`
  const tamperedPath = path.join(dir, 'tampered.v1.json')
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2))

  const verify = run(['verify', tamperedPath])
  assert.equal(verify.status, 1)
  assert.match(verify.stderr, /signature\.invalid/)

  const show = run(['show', tamperedPath])
  assert.equal(show.status, 1)
  assert.match(show.stderr, /refusing to show/)
  // The untrusted body must never reach stdout.
  assert.equal(show.stdout.includes('convenient script'), false)
  assert.equal(show.stdout, '')
})

test('unsigned and missing-signature announcements fail closed', () => {
  const dir = tmpdir('atelier-announcements-unsigned-')

  const unsigned = structuredClone(seedDoc)
  unsigned.signature = null
  const unsignedPath = path.join(dir, 'unsigned.v1.json')
  fs.writeFileSync(unsignedPath, JSON.stringify(unsigned, null, 2))
  const unsignedResult = run(['verify', unsignedPath])
  assert.equal(unsignedResult.status, 1)
  assert.match(unsignedResult.stderr, /signature\.missing/)

  const missing = structuredClone(seedDoc)
  delete missing.signature
  const missingPath = path.join(dir, 'missing.v1.json')
  fs.writeFileSync(missingPath, JSON.stringify(missing, null, 2))
  const missingResult = run(['verify', missingPath])
  assert.equal(missingResult.status, 1)
  assert.match(missingResult.stderr, /announcement\.shape/)
  assert.match(missingResult.stderr, /signature member is required/)

  // Neither variant will show its body.
  for (const file of [unsignedPath, missingPath]) {
    const show = run(['show', file])
    assert.equal(show.status, 1)
    assert.equal(show.stdout, '')
  }
})

test('shape violations are reported member by member', () => {
  const dir = tmpdir('atelier-announcements-shape-')
  const wrong = structuredClone(seedDoc)
  wrong.schema = 'mnstry.announcement@v2'
  wrong.announcementId = 'not-prefixed'
  wrong.publishedAt = 'yesterday'
  wrong.title = ''
  const wrongPath = path.join(dir, 'wrong.v1.json')
  fs.writeFileSync(wrongPath, JSON.stringify(wrong, null, 2))
  const result = run(['verify', wrongPath, '--json'])
  assert.equal(result.status, 1)
  const { valid, reasons } = JSON.parse(result.stdout)
  assert.equal(valid, false)
  const messages = reasons.filter((r) => r.code === 'announcement.shape').map((r) => r.message)
  assert.equal(messages.some((m) => m.includes('schema')), true)
  assert.equal(messages.some((m) => m.includes('announcementId')), true)
  assert.equal(messages.some((m) => m.includes('publishedAt')), true)
  assert.equal(messages.some((m) => m.includes('title')), true)
})

// --- list ---

test('list verifies the committed announcements directory', () => {
  const result = run(['list'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /announcement:2026-08-06:announcements-channel {2}2026-08-06 {2}Signed announcements channel/)
  assert.equal(result.stderr, '')
})

test('list flags a planted unverifiable file loudly and fails the exit code', () => {
  const dir = tmpdir('atelier-announcements-list-')
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true })
  fs.copyFileSync(SEED, path.join(dir, path.basename(SEED)))
  fs.copyFileSync(PUBLIC_KEY, path.join(dir, 'keys', 'mnstry-announcements.public.v1.json'))
  const planted = structuredClone(seedDoc)
  planted.title = 'Totally official update'
  fs.writeFileSync(path.join(dir, 'zz-planted.v1.json'), JSON.stringify(planted, null, 2))

  const result = run(['list', '--dir', dir])
  assert.equal(result.status, 1)
  // The genuine seed still lists on stdout.
  assert.match(result.stdout, /announcement:2026-08-06:announcements-channel/)
  // The planted file is flagged loudly on stderr, with its reason,
  // and its forged title never reaches the trusted listing on stdout.
  assert.match(result.stderr, /!! UNVERIFIED zz-planted\.v1\.json/)
  assert.match(result.stderr, /signature\.invalid/)
  assert.match(result.stderr, /1 of 2 announcement file\(s\) failed verification/)
  assert.equal(result.stdout.includes('Totally official update'), false)
})

test('list reports unparsable files without crashing', () => {
  const dir = tmpdir('atelier-announcements-badjson-')
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true })
  fs.copyFileSync(PUBLIC_KEY, path.join(dir, 'keys', 'mnstry-announcements.public.v1.json'))
  fs.writeFileSync(path.join(dir, 'broken.v1.json'), '{nope')
  const result = run(['list', '--dir', dir])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /!! UNVERIFIED broken\.v1\.json/)
  assert.match(result.stderr, /announcement\.unreadable/)
})

// --- usage ---

test('usage errors and help behave', () => {
  assert.equal(run(['--help']).status, 0)
  assert.match(run(['--help']).stdout, /Usage: atelier announcements/)
  assert.equal(run([]).status, 0)
  assert.equal(run(['frobnicate']).status, 2)
  assert.equal(run(['verify']).status, 2)
  assert.equal(run(['show']).status, 2)
  assert.equal(run(['verify', path.join(ROOT, 'no-such-file.json')]).status, 2)
  assert.equal(run(['list', '--dir', path.join(ROOT, 'no-such-dir')]).status, 2)
})
