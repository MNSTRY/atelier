import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  generateKeyPair,
  loadSigningKey,
  payloadHashOf,
  signAttestation,
  verifyAttestation,
  verifyPayloadBinding,
  KEY_ENV_VAR,
  LOCAL_KEY_FILE,
} from '../src/attestation/sign.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = path.join(ROOT, 'fixtures', 'atelier-attestation')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const sampleExport = readJson(path.join(ROOT, 'fixtures', 'atelier-export', 'sample-studio-offer.v1.json'))
const roundtripFixture = readJson(path.join(FIXTURES, 'valid', 'signed-roundtrip.v1.json'))
const roundtripPublicKey = readJson(path.join(FIXTURES, 'keys', 'roundtrip-issuer.public.v1.json'))

function compileAttestationSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  return ajv.compile(readJson(path.join(ROOT, 'contracts', 'atelier-attestation.v1.schema.json')))
}

function unsignedAttestation() {
  return {
    schema: 'atelier-attestation@v1',
    contractVersion: '1.0.0',
    attestationId: 'attestation:test:export:sample-studio-offer:0001',
    issuedAt: '2026-08-06T00:00:00Z',
    issuer: { id: 'atelier-test-issuer', role: 'admission-authority' },
    subject: {
      schema: 'atelier-export@v1',
      ref: sampleExport.exportId,
      payloadHash: payloadHashOf(sampleExport),
    },
    verdict: { scope: 'admission', decision: 'admitted' },
    signature: null,
  }
}

function reasonCodes(result) {
  return result.reasons.map((reason) => reason.code)
}

function captureThrow(fn, matcher) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'expected the call to throw')
  if (matcher) assert.match(caught.message, matcher)
  return caught
}

for (const algorithm of ['ed25519', 'es256']) {
  test(`${algorithm}: generate, sign, schema-validate, verify, tamper`, () => {
    const { privateKeyDoc, publicKeyDoc } = generateKeyPair({ algorithm, keyId: `test-${algorithm}-key-2026` })
    const signed = signAttestation({ attestation: unsignedAttestation(), key: privateKeyDoc })

    // The signed document remains schema-valid.
    const validate = compileAttestationSchema()
    assert.equal(validate(signed), true, JSON.stringify(validate.errors))

    // Both algorithms produce raw 64-byte signatures (es256 via ieee-p1363,
    // NOT DER — a DER signature would also pass the schema pattern, so this
    // length assertion is the interop tripwire).
    assert.equal(Buffer.from(signed.signature.value, 'base64url').byteLength, 64)
    assert.equal(signed.signature.value.length, 86)

    const verified = verifyAttestation({ attestation: signed, publicKey: publicKeyDoc })
    assert.deepEqual(verified, { valid: true, reasons: [] })

    // Tamper matrix, one reason code per mutation.
    const tamperedDecision = structuredClone(signed)
    tamperedDecision.verdict.decision = 'rejected'
    assert.ok(reasonCodes(verifyAttestation({ attestation: tamperedDecision, publicKey: publicKeyDoc })).includes('signature.invalid'))

    const unsigned = structuredClone(signed)
    unsigned.signature = null
    assert.deepEqual(reasonCodes(verifyAttestation({ attestation: unsigned, publicKey: publicKeyDoc })), ['signature.missing'])

    const wrongKeyId = { ...publicKeyDoc, keyId: 'someone-else-2026' }
    assert.ok(reasonCodes(verifyAttestation({ attestation: signed, publicKey: wrongKeyId })).includes('signature.key-id-mismatch'))

    const otherAlgorithm = algorithm === 'ed25519' ? 'es256' : 'ed25519'
    const wrongAlgorithm = generateKeyPair({ algorithm: otherAlgorithm, keyId: privateKeyDoc.keyId }).publicKeyDoc
    assert.ok(reasonCodes(verifyAttestation({ attestation: signed, publicKey: wrongAlgorithm })).includes('signature.algorithm-mismatch'))

    const issuerMismatch = structuredClone(signed)
    issuerMismatch.issuer.keyId = 'a-different-issuer-key'
    assert.ok(reasonCodes(verifyAttestation({ attestation: issuerMismatch, publicKey: publicKeyDoc })).includes('issuer.key-id-mismatch'))

    const schemaInvalid = structuredClone(signed)
    schemaInvalid.verdict.scope = 'conformance'
    assert.ok(reasonCodes(verifyAttestation({ attestation: schemaInvalid, publicKey: publicKeyDoc })).includes('schema.invalid'))
  })
}

test('signAttestation refuses bad inputs without leaking key material', () => {
  const { privateKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: 'refusal-key-2026' })
  const failures = []

  const alreadySigned = signAttestation({ attestation: unsignedAttestation(), key: privateKeyDoc })
  failures.push(captureThrow(() => signAttestation({ attestation: alreadySigned, key: privateKeyDoc }), /refusing to re-sign/))

  const invalid = unsignedAttestation()
  delete invalid.verdict
  failures.push(captureThrow(() => signAttestation({ attestation: invalid, key: privateKeyDoc }), /not schema-valid/))

  const issuerConflict = unsignedAttestation()
  issuerConflict.issuer.keyId = 'some-other-key-2026'
  failures.push(captureThrow(() => signAttestation({ attestation: issuerConflict, key: privateKeyDoc }), /does not match signing key/))

  failures.push(captureThrow(
    () => signAttestation({ attestation: unsignedAttestation(), key: { ...privateKeyDoc, algorithm: 'rsa' } }),
    /unsupported attestation signature algorithm/,
  ))

  // Log-safety: no failure message may contain any private JWK member value.
  const { d, x } = privateKeyDoc.privateKeyJwk
  for (const error of failures) {
    assert.equal(error.message.includes(d), false, 'error message leaked the private JWK d value')
    assert.equal(error.message.includes(x), false, 'error message leaked the JWK x value')
  }
})

test('committed roundtrip fixture verifies with the committed public key', () => {
  // The fixture pair was generated once at authoring time with a throwaway
  // key (the private half was never persisted) via, from the package root:
  //   node --input-type=module -e "import { payloadHashOf, generateKeyPair,
  //     signAttestation } from './src/attestation/sign.mjs'; ..."
  // CI verifies the committed signature; it never re-signs.
  const verified = verifyAttestation({ attestation: roundtripFixture, publicKey: roundtripPublicKey })
  assert.deepEqual(verified, { valid: true, reasons: [] })

  const binding = verifyPayloadBinding({ attestation: roundtripFixture, payload: sampleExport })
  assert.deepEqual(binding, { valid: true, reasons: [] })

  // The committed digest is the real canonical hash of the sample export.
  assert.equal(payloadHashOf(sampleExport).digest, roundtripFixture.subject.payloadHash.digest)
})

test('roundtrip fixture tamper matrix fails with the exact reason code', () => {
  const mutatedDecision = structuredClone(roundtripFixture)
  mutatedDecision.verdict.decision = 'needs-review'
  assert.deepEqual(reasonCodes(verifyAttestation({ attestation: mutatedDecision, publicKey: roundtripPublicKey })), ['signature.invalid'])

  const mutatedDigest = structuredClone(roundtripFixture)
  const digest = mutatedDigest.subject.payloadHash.digest
  mutatedDigest.subject.payloadHash.digest = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
  assert.deepEqual(reasonCodes(verifyAttestation({ attestation: mutatedDigest, publicKey: roundtripPublicKey })), ['signature.invalid'])
  assert.deepEqual(reasonCodes(verifyPayloadBinding({ attestation: mutatedDigest, payload: sampleExport })), ['payload.digest-mismatch'])

  const flippedSignature = structuredClone(roundtripFixture)
  const value = flippedSignature.signature.value
  flippedSignature.signature.value = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
  assert.deepEqual(reasonCodes(verifyAttestation({ attestation: flippedSignature, publicKey: roundtripPublicKey })), ['signature.invalid'])

  // Wrong keyId in the public key doc: the crypto bytes still verify (same
  // key material), so the sole failure is the key identity check.
  const wrongKeyId = { ...roundtripPublicKey, keyId: 'not-the-roundtrip-issuer' }
  assert.deepEqual(reasonCodes(verifyAttestation({ attestation: roundtripFixture, publicKey: wrongKeyId })), ['signature.key-id-mismatch'])
})

test('loadSigningKey precedence: env beats file, missing both fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-signing-key-'))
  try {
    const fileKey = generateKeyPair({ algorithm: 'ed25519', keyId: 'from-file-2026' }).privateKeyDoc
    const envKey = generateKeyPair({ algorithm: 'ed25519', keyId: 'from-env-2026' }).privateKeyDoc
    const keyFile = path.join(dir, LOCAL_KEY_FILE)
    fs.writeFileSync(keyFile, JSON.stringify(fileKey))

    // Env wins over an explicit path and over the cwd default.
    const env = { [KEY_ENV_VAR]: JSON.stringify(envKey) }
    assert.equal(loadSigningKey({ keyPath: keyFile, env, cwd: dir }).keyId, 'from-env-2026')
    // Explicit path wins over the cwd default.
    assert.equal(loadSigningKey({ keyPath: keyFile, env: {}, cwd: os.tmpdir() }).keyId, 'from-file-2026')
    // The cwd default is found on its own.
    assert.equal(loadSigningKey({ env: {}, cwd: dir }).keyId, 'from-file-2026')
    // Missing everything fails closed, naming the three options.
    const error = captureThrow(() => loadSigningKey({ env: {}, cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-empty-')) }))
    assert.match(error.message, new RegExp(KEY_ENV_VAR))
    assert.match(error.message, /--key <file>/)
    assert.match(error.message, new RegExp(LOCAL_KEY_FILE.replace(/\./g, '\\.')))
    // A malformed key file fails without echoing its content.
    fs.writeFileSync(keyFile, '{not json')
    const parseError = captureThrow(() => loadSigningKey({ env: {}, cwd: dir }), /not valid JSON/)
    assert.equal(parseError.message.includes('{not json'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
