// One delegation contract shared by Node and provider-native runtimes.
import { exact, ExtensionError, text } from './contracts.mjs'

export const unauthorized = () => { throw new ExtensionError('unauthorized', 401) }
const claimNames = ['iss', 'aud', 'iat', 'nbf', 'exp', 'jti', 'purpose', 'installationId', 'tenantRef', 'subjectRef', 'generation', 'releaseDigest', 'operationId', 'actionId', 'payloadDigest', 'rootWrites']
const opaque = value => /^[A-Za-z0-9_-]{16,128}$/.test(text(value))
export function decodeBase64Url(part) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) return unauthorized()
  const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
  if (btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== part) return unauthorized()
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
function decodeJson(part) {
  const bytes = decodeBase64Url(part)
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const encoded = new TextEncoder().encode(value)
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) return unauthorized()
  return JSON.parse(value)
}
export function decodeDelegation(delegation) {
  text(delegation, 16384)
  const parts = delegation.split('.')
  if (parts.length !== 3) return unauthorized()
  const header = exact(decodeJson(parts[0]), ['alg', 'typ', 'kid'])
  if (header.alg !== 'ES256' || header.typ !== 'JWT') return unauthorized()
  text(header.kid)
  const signature = decodeBase64Url(parts[2])
  if (signature.length !== 64) return unauthorized()
  return { header, claims: decodeJson(parts[1]), signature, signed: new TextEncoder().encode(`${parts[0]}.${parts[1]}`) }
}
export function validateDelegationClaims(value, options) {
  const claims = exact(value, claimNames)
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000)
  if (claims.iss !== options.issuer || claims.aud !== options.audience || claims.purpose !== 'extension.invoke/v1' ||
      ![claims.iat, claims.nbf, claims.exp].every(Number.isSafeInteger) || claims.iat > now || claims.nbf !== claims.iat ||
      claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 60) return unauthorized()
  for (const field of ['jti', 'installationId', 'operationId', 'tenantRef', 'subjectRef']) if (!opaque(claims[field])) return unauthorized()
  text(claims.actionId)
  if (typeof claims.generation !== 'string' || typeof claims.releaseDigest !== 'string' || typeof claims.payloadDigest !== 'string' || !/^[1-9][0-9]{0,18}$/.test(claims.generation) || BigInt(claims.generation) > 9223372036854775807n ||
      !/^[a-f0-9]{64}$/.test(claims.releaseDigest) || !/^[a-f0-9]{64}$/.test(claims.payloadDigest) ||
      !Array.isArray(claims.rootWrites) || claims.rootWrites.length > 64 || new Set(claims.rootWrites).size !== claims.rootWrites.length) return unauthorized()
  claims.rootWrites.forEach(value => text(value, 256))
  return Object.freeze({ ...claims, rootWrites: Object.freeze([...claims.rootWrites]) })
}
export function assertDelegationBinding(claims, manifest, verifier) {
  if (claims.installationId !== verifier.installationId || claims.releaseDigest !== manifest.releaseDigest ||
      claims.releaseDigest !== verifier.releaseDigest || claims.rootWrites.length !== manifest.permissions.rootWrites.length ||
      claims.rootWrites.some(value => !manifest.permissions.rootWrites.includes(value))) return unauthorized()
}
export function delegationScope(claims) {
  return Object.freeze({ installationId: claims.installationId, generation: claims.generation, releaseDigest: claims.releaseDigest,
    operationId: claims.operationId, actionId: claims.actionId, payloadDigest: claims.payloadDigest,
    tenantRef: claims.tenantRef, subjectRef: claims.subjectRef, rootWrites: claims.rootWrites })
}
