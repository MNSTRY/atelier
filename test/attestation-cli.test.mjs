import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = path.join(ROOT, 'src', 'commands', 'attestation.mjs')
const SAMPLE_EXPORT = path.join(ROOT, 'fixtures', 'atelier-export', 'sample-studio-offer.v1.json')
const ROUNDTRIP_FIXTURE = path.join(ROOT, 'fixtures', 'atelier-attestation', 'valid', 'signed-roundtrip.v1.json')
const ROUNDTRIP_PUBLIC_KEY = path.join(ROOT, 'fixtures', 'atelier-attestation', 'keys', 'roundtrip-issuer.public.v1.json')
const LOCAL_KEY_FILE = 'atelier-attestation-key.local.json'

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

test('attestation hash prints the canonical payload hash of the sample export', () => {
  const result = run(['hash', SAMPLE_EXPORT])
  assert.equal(result.status, 0, result.stderr)
  const hash = JSON.parse(result.stdout)
  const committedDigest = JSON.parse(fs.readFileSync(ROUNDTRIP_FIXTURE, 'utf8')).subject.payloadHash.digest
  assert.deepEqual(hash, { algorithm: 'sha-256', canonicalization: 'RFC8785-JCS', digest: committedDigest })
})

test('attestation hash fails closed on unreadable and unparsable payloads', () => {
  assert.equal(run(['hash', path.join(ROOT, 'no-such-file.json')]).status, 2)
  const dir = tmpdir('atelier-attestation-hash-')
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{nope')
  assert.equal(run(['hash', bad]).status, 2)
})

test('keygen, sign, verify roundtrip in a scratch directory', () => {
  const dir = tmpdir('atelier-attestation-cli-')
  const publicKeyPath = path.join(dir, 'issuer.public.json')

  // keygen writes the private key file 0600 and prints only the public doc.
  const keygen = run(['keygen', '--key-id', 'cli-test-2026'], { cwd: dir })
  assert.equal(keygen.status, 0, keygen.stderr)
  const publicDoc = JSON.parse(keygen.stdout)
  assert.equal(publicDoc.keyId, 'cli-test-2026')
  assert.ok(publicDoc.publicKeyJwk?.x, 'public JWK should be printed')
  assert.equal('privateKeyJwk' in publicDoc, false)
  fs.writeFileSync(publicKeyPath, keygen.stdout)
  const keyFilePath = path.join(dir, LOCAL_KEY_FILE)
  const privateDoc = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'))
  // Windows does not expose its ACL security model through POSIX mode bits.
  // The installed-runtime gate must prove the Windows ACL separately.
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFilePath).mode & 0o777, 0o600)
  // keygen refuses to overwrite an existing key file.
  const again = run(['keygen', '--key-id', 'cli-test-2026'], { cwd: dir })
  assert.equal(again.status, 2)
  assert.match(again.stderr, /refusing to write signing key file/)

  // Build an unsigned attestation over the sample export.
  const hash = JSON.parse(run(['hash', SAMPLE_EXPORT]).stdout)
  const unsignedPath = path.join(dir, 'unsigned.json')
  fs.writeFileSync(unsignedPath, JSON.stringify({
    schema: 'atelier-attestation@v1',
    attestationId: 'attestation:cli-test:export:sample-studio-offer:0001',
    issuedAt: '2026-08-06T00:00:00Z',
    issuer: { id: 'cli-test-issuer', role: 'tool' },
    subject: { schema: 'atelier-export@v1', ref: 'export:sample-studio:guided-session:2026-06-11', payloadHash: hash },
    verdict: { scope: 'admission', decision: 'admitted' },
    signature: null,
  }, null, 2))

  // sign picks up the local key file from cwd and writes --out.
  const signedPath = path.join(dir, 'signed.json')
  const sign = run(['sign', unsignedPath, '--out', signedPath], { cwd: dir })
  assert.equal(sign.status, 0, sign.stderr)
  const signed = JSON.parse(fs.readFileSync(signedPath, 'utf8'))
  assert.equal(signed.signature.keyId, 'cli-test-2026')

  // verify accepts it, with and without payload binding, and as JSON.
  const verify = run(['verify', signedPath, '--public-key', publicKeyPath, '--payload', SAMPLE_EXPORT], { cwd: dir })
  assert.equal(verify.status, 0, verify.stderr)
  assert.match(verify.stdout, /payload binding is valid/)
  const bare = run(['verify', signedPath, '--public-key', publicKeyPath], { cwd: dir })
  assert.equal(bare.status, 0)
  assert.match(bare.stdout, /payload binding not checked/)
  const json = run(['verify', signedPath, '--public-key', publicKeyPath, '--payload', SAMPLE_EXPORT, '--json'], { cwd: dir })
  assert.equal(json.status, 0)
  assert.deepEqual(JSON.parse(json.stdout), { valid: true, payloadBindingChecked: true, reasons: [] })

  // Tampered document: exit 1 with the reason on stderr.
  const tamperedPath = path.join(dir, 'tampered.json')
  const tampered = structuredClone(signed)
  tampered.verdict.decision = 'rejected'
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2))
  const bad = run(['verify', tamperedPath, '--public-key', publicKeyPath], { cwd: dir })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /signature\.invalid/)

  // Log-safety: no invocation in this test ever printed private key material.
  const outputs = [keygen, again, sign, verify, bare, json, bad].flatMap((r) => [r.stdout, r.stderr])
  for (const output of outputs) {
    assert.equal(output.includes(privateDoc.privateKeyJwk.d), false, 'CLI output leaked the private JWK d value')
  }
})

// Replay of the demonstrated M5 attack: a planted dangling symlink at the key
// path used to pass the existsSync pre-check, so writeFileSync followed the
// link and exfiltrated the fresh private key to an attacker-chosen path. The
// 'wx' create-exclusive open must now fail on the symlink itself, atomically,
// and the link target must never receive a single byte.
test('keygen refuses a dangling symlink at the out path and never writes through it', () => {
  const dir = tmpdir('atelier-attestation-symlink-')
  const exfilDir = tmpdir('atelier-attestation-exfil-')
  const exfilTarget = path.join(exfilDir, 'stolen-key.json')

  // Default out path (cwd local key file) is a dangling symlink.
  fs.symlinkSync(exfilTarget, path.join(dir, LOCAL_KEY_FILE))
  const byDefault = run(['keygen', '--key-id', 'symlink-victim'], { cwd: dir })
  assert.equal(byDefault.status, 2)
  assert.match(byDefault.stderr, /refusing to write signing key file/)
  assert.equal(fs.existsSync(exfilTarget), false, 'dangling symlink target must never receive key bytes')

  // Explicit --out pointing at a dangling symlink fails identically.
  const outLink = path.join(dir, 'explicit-out.json')
  fs.symlinkSync(exfilTarget, outLink)
  const byOut = run(['keygen', '--key-id', 'symlink-victim', '--out', outLink], { cwd: dir })
  assert.equal(byOut.status, 2)
  assert.match(byOut.stderr, /refusing to write signing key file/)
  assert.equal(fs.existsSync(exfilTarget), false)

  // Error output stays path-only: no JWK members, no key bytes.
  for (const output of [byDefault.stdout, byDefault.stderr, byOut.stdout, byOut.stderr]) {
    assert.doesNotMatch(output, /privateKeyJwk|"d"\s*:/)
  }
})

// Module reachability (N6): a consumer resolving the package's export map
// must reach the attestation and extension-pack entry points, and the
// "./attestation" entry must expose canonicalize alongside payloadHashOf so
// one entry suffices.
test('package exports resolve ./attestation and ./extension-packs for a consumer', async () => {
  const consumerDir = tmpdir('atelier-exports-consumer-')
  fs.mkdirSync(path.join(consumerDir, 'node_modules', '@mnstry'), { recursive: true })
  fs.symlinkSync(ROOT, path.join(consumerDir, 'node_modules', '@mnstry', 'atelier'), 'dir')
  const consumerRequire = createRequire(path.join(consumerDir, 'consumer.mjs'))

  const attestationEntry = consumerRequire.resolve('@mnstry/atelier/attestation')
  assert.equal(fs.realpathSync(attestationEntry), fs.realpathSync(path.join(ROOT, 'src', 'attestation', 'sign.mjs')))
  const packsEntry = consumerRequire.resolve('@mnstry/atelier/extension-packs')
  assert.equal(fs.realpathSync(packsEntry), fs.realpathSync(path.join(ROOT, 'src', 'extension-packs', 'loader.mjs')))

  const attestation = await import(pathToFileURL(fs.realpathSync(attestationEntry)).href)
  assert.equal(typeof attestation.canonicalize, 'function')
  assert.equal(typeof attestation.payloadHashOf, 'function')
  assert.equal(typeof attestation.signAttestation, 'function')
  assert.equal(typeof attestation.verifyAttestation, 'function')
  const loader = await import(pathToFileURL(fs.realpathSync(packsEntry)).href)
  assert.equal(typeof loader.loadExtensionPacks, 'function')
  assert.equal(typeof loader.createProtocolRegistry, 'function')
})

test('sign with no key available fails closed with the precedence message', () => {
  const dir = tmpdir('atelier-attestation-nokey-')
  const unsignedPath = path.join(dir, 'unsigned.json')
  fs.copyFileSync(ROUNDTRIP_FIXTURE, unsignedPath)
  const env = { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT }
  delete env.ATELIER_ATTESTATION_KEY_JSON
  const result = spawnSync(process.execPath, [COMMAND, 'sign', unsignedPath], { cwd: dir, encoding: 'utf8', env })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /ATELIER_ATTESTATION_KEY_JSON/)
  assert.match(result.stderr, /--key <file>/)
  assert.match(result.stderr, /atelier-attestation-key\.local\.json/)
})

test('verify exercises the committed roundtrip fixture end to end', () => {
  const result = run(['verify', ROUNDTRIP_FIXTURE, '--public-key', ROUNDTRIP_PUBLIC_KEY, '--payload', SAMPLE_EXPORT, '--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, payloadBindingChecked: true, reasons: [] })
})

test('usage errors and help behave', () => {
  assert.equal(run(['--help']).status, 0)
  assert.match(run(['--help']).stdout, /Usage: atelier attestation/)
  assert.equal(run([]).status, 0)
  assert.equal(run(['frobnicate']).status, 2)
  assert.equal(run(['verify', ROUNDTRIP_FIXTURE]).status, 2)
  assert.equal(run(['keygen']).status, 2)
})
