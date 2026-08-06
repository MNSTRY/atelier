// Attestation signing and verification reference implementation.
//
// The normative signing input (docs/attestation.md, "Signing procedure"):
// the UTF-8 encoding of the RFC 8785 (JCS) canonicalization of the
// attestation document with its `signature` member set to null.
//
// Key handling is JWK-only — never PEM. es256 signatures use the 64-byte
// IEEE P1363 concatenation of r and s, not DER; the dsaEncoding flag below is
// load-bearing for interop and is asserted by tests (64 bytes / 86 base64url
// characters).
//
// Log-safety contract: every error and reason message in this module may name
// keyId and algorithm, and must never include any JWK member value or the
// signing input bytes.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { canonicalize } from './jcs.mjs'

const SCHEMA_PATH = fileURLToPath(new URL('../../contracts/atelier-attestation.v1.schema.json', import.meta.url))
const SUPPORTED_ALGORITHMS = new Set(['ed25519', 'es256'])
export const LOCAL_KEY_FILE = 'atelier-attestation-key.local.json'
export const KEY_ENV_VAR = 'ATELIER_ATTESTATION_KEY_JSON'

let cachedValidate = null

function attestationValidator() {
  if (!cachedValidate) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    cachedValidate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')))
  }
  return cachedValidate
}

function schemaErrors(doc) {
  const validate = attestationValidator()
  if (validate(doc)) return []
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'failed schema validation'}`)
}

// Compute the canonical payload hash object for a payload document.
export function payloadHashOf(document) {
  const digest = crypto.createHash('sha256').update(Buffer.from(canonicalize(document), 'utf8')).digest('hex')
  return { algorithm: 'sha-256', canonicalization: 'RFC8785-JCS', digest }
}

// The bytes an attestation signature covers (normative definition above).
export function signingInput(attestation) {
  if (!attestation || typeof attestation !== 'object') {
    throw new TypeError('signingInput requires an attestation object')
  }
  const unsigned = structuredClone(attestation)
  unsigned.signature = null
  return Buffer.from(canonicalize(unsigned), 'utf8')
}

function importPrivateKey(jwk) {
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' })
}

function importPublicKey(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' })
}

function signBytes(algorithm, input, keyObject) {
  if (algorithm === 'ed25519') return crypto.sign(null, input, keyObject)
  if (algorithm === 'es256') return crypto.sign('sha256', input, { key: keyObject, dsaEncoding: 'ieee-p1363' })
  throw new Error(`unsupported attestation signature algorithm: ${algorithm}`)
}

function verifyBytes(algorithm, input, keyObject, signatureBytes) {
  if (algorithm === 'ed25519') return crypto.verify(null, input, keyObject, signatureBytes)
  if (algorithm === 'es256') return crypto.verify('sha256', input, { key: keyObject, dsaEncoding: 'ieee-p1363' }, signatureBytes)
  throw new Error(`unsupported attestation signature algorithm: ${algorithm}`)
}

function jwkMatchesAlgorithm(jwk, algorithm) {
  if (!jwk || typeof jwk !== 'object') return false
  if (algorithm === 'ed25519') return jwk.kty === 'OKP' && jwk.crv === 'Ed25519'
  if (algorithm === 'es256') return jwk.kty === 'EC' && jwk.crv === 'P-256'
  return false
}

// Generate a fresh signing key pair. Returns the private key document (shape
// of the local key file) and the freely shareable public key document.
export function generateKeyPair({ algorithm = 'ed25519', keyId } = {}) {
  if (!keyId || typeof keyId !== 'string') throw new TypeError('generateKeyPair requires a keyId')
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw new Error(`unsupported attestation signature algorithm: ${algorithm}`)
  }
  const pair = algorithm === 'ed25519'
    ? crypto.generateKeyPairSync('ed25519')
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    privateKeyDoc: { keyId, algorithm, privateKeyJwk: pair.privateKey.export({ format: 'jwk' }) },
    publicKeyDoc: { keyId, algorithm, publicKeyJwk: pair.publicKey.export({ format: 'jwk' }) },
  }
}

// Load the signing key with fail-closed precedence:
// env JSON -> explicit key file path -> ./atelier-attestation-key.local.json.
export function loadSigningKey({ keyPath = null, env = process.env, cwd = process.cwd() } = {}) {
  let raw = null
  let source = null
  if (env[KEY_ENV_VAR]) {
    raw = env[KEY_ENV_VAR]
    source = `env ${KEY_ENV_VAR}`
  } else if (keyPath) {
    if (!fs.existsSync(keyPath)) throw new Error(`signing key file not found: ${keyPath}`)
    raw = fs.readFileSync(keyPath, 'utf8')
    source = keyPath
  } else {
    const localPath = path.join(cwd, LOCAL_KEY_FILE)
    if (fs.existsSync(localPath)) {
      raw = fs.readFileSync(localPath, 'utf8')
      source = localPath
    }
  }
  if (raw === null) {
    throw new Error(
      'no attestation signing key available. Provide one of: '
      + `the ${KEY_ENV_VAR} environment variable (key file JSON), `
      + '--key <file>, '
      + `or ${LOCAL_KEY_FILE} in the current directory (gitignored).`,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Never echo the content: it may be (or contain) private key material.
    throw new Error(`signing key from ${source} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.keyId !== 'string' || !parsed.keyId) {
    throw new Error(`signing key from ${source} is missing a keyId`)
  }
  if (!SUPPORTED_ALGORITHMS.has(parsed.algorithm)) {
    throw new Error(`signing key ${parsed.keyId} has an unsupported algorithm`)
  }
  if (!jwkMatchesAlgorithm(parsed.privateKeyJwk, parsed.algorithm)) {
    throw new Error(`signing key ${parsed.keyId} privateKeyJwk does not match algorithm ${parsed.algorithm}`)
  }
  return { keyId: parsed.keyId, algorithm: parsed.algorithm, privateKeyJwk: parsed.privateKeyJwk }
}

// Sign a schema-valid, unsigned attestation. Returns a new signed document;
// never mutates the input. Refuses (throws) on schema-invalid input, an
// already-signed document, or an issuer/key mismatch.
export function signAttestation({ attestation, key } = {}) {
  if (!attestation || typeof attestation !== 'object') throw new TypeError('signAttestation requires an attestation object')
  if (!key || typeof key !== 'object' || !key.privateKeyJwk) throw new TypeError('signAttestation requires a signing key document')
  if (!SUPPORTED_ALGORITHMS.has(key.algorithm)) {
    throw new Error(`unsupported attestation signature algorithm: ${key.algorithm}`)
  }
  const errors = schemaErrors(attestation)
  if (errors.length) {
    throw new Error(`attestation is not schema-valid; refusing to sign:\n${errors.join('\n')}`)
  }
  if (attestation.signature !== null) {
    throw new Error('attestation already carries a signature; refusing to re-sign. Set signature to null first if that is intended.')
  }
  if (attestation.issuer?.keyId && attestation.issuer.keyId !== key.keyId) {
    throw new Error(`issuer.keyId ${attestation.issuer.keyId} does not match signing key ${key.keyId}; refusing to sign`)
  }
  const input = signingInput(attestation)
  const signatureBytes = signBytes(key.algorithm, input, importPrivateKey(key.privateKeyJwk))
  const signed = structuredClone(attestation)
  signed.signature = {
    algorithm: key.algorithm,
    keyId: key.keyId,
    value: signatureBytes.toString('base64url'),
  }
  return signed
}

// Verify an attestation signature against a public key document.
// Never throws on bad documents — returns { valid, reasons } with every
// applicable reason collected. Throws only on programmer error.
export function verifyAttestation({ attestation, publicKey } = {}) {
  if (!attestation || typeof attestation !== 'object') throw new TypeError('verifyAttestation requires an attestation object')
  if (!publicKey || typeof publicKey !== 'object' || !publicKey.publicKeyJwk) {
    throw new TypeError('verifyAttestation requires a public key document with publicKeyJwk')
  }
  const reasons = []
  for (const message of schemaErrors(attestation)) {
    reasons.push({ code: 'schema.invalid', message })
  }
  const signature = attestation.signature
  if (!signature || typeof signature !== 'object') {
    reasons.push({ code: 'signature.missing', message: 'signature is null; an unsigned attestation is non-authoritative and never verifies' })
    return { valid: false, reasons }
  }
  if (signature.algorithm !== publicKey.algorithm || !jwkMatchesAlgorithm(publicKey.publicKeyJwk, signature.algorithm)) {
    reasons.push({
      code: 'signature.algorithm-mismatch',
      message: `signature algorithm ${signature.algorithm} does not match public key algorithm ${publicKey.algorithm}`,
    })
  }
  if (signature.keyId !== publicKey.keyId) {
    reasons.push({
      code: 'signature.key-id-mismatch',
      message: `signature keyId ${signature.keyId} does not match public key keyId ${publicKey.keyId}`,
    })
  }
  if (attestation.issuer?.keyId && attestation.issuer.keyId !== signature.keyId) {
    reasons.push({
      code: 'issuer.key-id-mismatch',
      message: `issuer.keyId ${attestation.issuer.keyId} does not match signature keyId ${signature.keyId}`,
    })
  }
  let cryptoValid = false
  try {
    const input = signingInput(attestation)
    const signatureBytes = Buffer.from(String(signature.value ?? ''), 'base64url')
    cryptoValid = verifyBytes(signature.algorithm, input, importPublicKey(publicKey.publicKeyJwk), signatureBytes)
  } catch {
    cryptoValid = false
  }
  if (!cryptoValid) {
    reasons.push({ code: 'signature.invalid', message: 'cryptographic verification failed over the canonical signing input' })
  }
  return { valid: reasons.length === 0, reasons }
}

// Verify that an attestation is bound to a specific payload document.
// Independent of signature validity so the two can be reported separately.
export function verifyPayloadBinding({ attestation, payload } = {}) {
  if (!attestation || typeof attestation !== 'object') throw new TypeError('verifyPayloadBinding requires an attestation object')
  if (payload === undefined) throw new TypeError('verifyPayloadBinding requires a payload document')
  const reasons = []
  const subject = attestation.subject ?? {}
  const payloadSchema = payload && typeof payload === 'object' ? payload.schema : undefined
  if (typeof subject.schema === 'string' && payloadSchema !== subject.schema) {
    reasons.push({
      code: 'payload.schema-field-mismatch',
      message: `payload schema field ${String(payloadSchema)} does not match subject.schema ${subject.schema}`,
    })
  }
  let digest = null
  try {
    digest = payloadHashOf(payload).digest
  } catch (error) {
    reasons.push({ code: 'payload.digest-mismatch', message: `payload cannot be canonicalized: ${error.message}` })
  }
  if (digest !== null && digest !== subject.payloadHash?.digest) {
    reasons.push({
      code: 'payload.digest-mismatch',
      message: 'recomputed payload digest does not match subject.payloadHash.digest',
    })
  }
  return { valid: reasons.length === 0, reasons }
}
