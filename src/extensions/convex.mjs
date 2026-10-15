// Native Convex functions use Web Crypto and the existing delegation protocol.
// This module imports no Node runtime, database driver or Convex admin client.
import { canonicalJson, exact, ExtensionError, parseManifest, parseOperationReceipt, text } from './contracts.mjs'
import { assertDelegationBinding, decodeBase64Url, decodeDelegation, delegationScope, unauthorized, validateDelegationClaims } from './delegation.mjs'
import { createAdmissionConsumer, readInvocationBody } from './admission.mjs'

// Convex bundles may replace NODE_ENV at build time. Authorize the optional
// loopback test transport only when BOTH provider-owned deployment URLs are local.
export function createRootAdmissionConsumer(options) {
  const localRuntime = ['CONVEX_CLOUD_URL', 'CONVEX_SITE_URL'].every(name => {
    try {
      const url = new URL(process.env[name])
      return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
        !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
    } catch { return false }
  })
  return createAdmissionConsumer(options, options.allowLocalTesting === true && localRuntime)
}

const definitions = new WeakMap()
const scopes = new WeakMap()
const encoder = new TextEncoder()
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
export async function convexDigest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(value)))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export function assertConvexScope(scope) {
  if (!scope || !scopes.get(scope)?.()) return unauthorized()
}
export function defineConvexExtension({ manifest, verifier, actions }) {
  const pinned = parseManifest(manifest)
  if (pinned.deployment.profile !== 'convex-native' || pinned.actions.some(action => !Object.hasOwn(actions, action.id)) ||
      Object.keys(actions).some(id => !pinned.actions.some(action => action.id === id))) throw new ExtensionError('invalid-input')
  const keys = new Map()
  for (const [id, value] of verifier.keys) {
    text(id)
    const jwk = exact(JSON.parse(canonicalJson(value)), ['kty', 'crv', 'x', 'y'], ['alg', 'use', 'key_ops', 'ext', 'kid'])
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || (jwk.alg !== undefined && jwk.alg !== 'ES256') ||
        (jwk.use !== undefined && jwk.use !== 'sig') || (jwk.key_ops !== undefined && (jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify')) ||
        decodeBase64Url(jwk.x).length !== 32 || decodeBase64Url(jwk.y).length !== 32) throw new ExtensionError('invalid-input')
    keys.set(id, freeze(jwk))
  }
  const normalized = Object.fromEntries(Object.entries(actions).map(([id, action]) => {
    if (['input', 'output', 'run'].some(key => typeof action[key] !== 'function')) throw new ExtensionError('invalid-input')
    return [id, Object.freeze({ input: action.input, output: action.output, run: action.run })]
  }))
  const runtime = Object.freeze({ manifest: freeze(pinned), verifier: Object.freeze({ ...verifier, keys }), actions: Object.freeze(normalized) })
  const handle = Object.freeze({ manifest: runtime.manifest })
  definitions.set(handle, runtime)
  return handle
}
function definition(handle) {
  const extension = definitions.get(handle)
  if (!extension) throw new ExtensionError('invalid-input')
  return extension
}
async function invocation(extension, delegation, payload) {
  let claims
  try {
    const decoded = decodeDelegation(delegation)
    const jwk = extension.verifier.keys.get(decoded.header.kid)
    if (!jwk) return unauthorized()
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decoded.signature, decoded.signed)) return unauthorized()
    claims = validateDelegationClaims(decoded.claims, extension.verifier)
    assertDelegationBinding(claims, extension.manifest, extension.verifier)
  } catch { return unauthorized() }
  const { releaseDigest: ignored, ...manifestBody } = extension.manifest
  if (await convexDigest(manifestBody) !== extension.manifest.releaseDigest) throw new ExtensionError('invalid-input')
  const declared = extension.manifest.actions.find(action => action.id === claims.actionId)
  const action = Object.hasOwn(extension.actions, claims.actionId) ? extension.actions[claims.actionId] : null
  if (!declared || !action) return unauthorized()
  const encoded = canonicalJson(payload)
  if (encoder.encode(encoded).length > 65536 || await convexDigest(payload) !== claims.payloadDigest) throw new ExtensionError('invalid-input')
  const input = action.input(JSON.parse(encoded))
  if (await convexDigest(input) !== claims.payloadDigest) throw new ExtensionError('invalid-input')
  return { claims, declared, action, input }
}
function boundedResult(value, lookup = false) {
  const encoded = canonicalJson(value)
  if (encoder.encode(encoded).length > (lookup ? 65536 : 60 * 1024)) throw new ExtensionError('invalid-input')
  // Leave the same nesting headroom required by the host's result/proof wrappers.
  canonicalJson(lookup ? { result: value } : { result: { result: value } })
  return JSON.parse(encoded)
}
/** Call ONLY from a registered internalMutation. Never accept a serialized scope.
 * Convex's transaction atomically commits all native reads/writes or rolls back.
 * Date.now is Convex's transaction-start time; this does not revoke an in-flight commit. */
export async function runConvexInvocation(handle, context, args) {
  exact(args, ['delegation', 'payload'])
  const extension = definition(handle)
  const { claims, declared, action, input } = await invocation(extension, args.delegation, args.payload)
  const scope = delegationScope(claims)
  const deadline = Math.min(claims.exp * 1000, (extension.verifier.now?.() ?? Date.now()) + declared.timeoutMs)
  scopes.set(scope, () => deadline > (extension.verifier.now?.() ?? Date.now()))
  try {
    assertConvexScope(scope)
    const lookup = claims.actionId === extension.manifest.recovery?.lookupActionId
    const original = canonicalJson(boundedResult(await action.run({ context, scope }, input), lookup))
    const result = boundedResult(action.output(JSON.parse(original)), lookup)
    // Output validators may refuse a value, but cannot silently change the
    // durable result that onceConvexOperation will expose during recovery.
    if (canonicalJson(result) !== original) throw new ExtensionError('invalid-input')
    const resultDigest = await convexDigest(result)
    assertConvexScope(scope)
    return { operationId: claims.operationId, state: 'succeeded', result, resultDigest }
  } finally { scopes.delete(scope) }
}
/** HTTP action: check original delegation, consume Root admission once, then call
 * the private native mutation with the ORIGINAL token and canonical payload. */
export function createConvexHttpHandler(handle, invoke) {
  const extension = definition(handle)
  if (typeof invoke !== 'function' || typeof extension.verifier.consume !== 'function') throw new ExtensionError('invalid-input')
  return async request => {
    let admitted = false
    try {
      if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return new Response(null, { status: 415 })
      const delegation = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1]
      if (!delegation) return unauthorized()
      const { claims, declared, input } = await invocation(extension, delegation, await readInvocationBody(request))
      if (!await extension.verifier.consume(claims, delegation)) throw new ExtensionError('forbidden', 403)
      admitted = true
      const deadline = Math.min(claims.exp * 1000, (extension.verifier.now?.() ?? Date.now()) + declared.timeoutMs)
      if (deadline <= (extension.verifier.now?.() ?? Date.now())) throw new ExtensionError('operation-unknown', 409)
      const receipt = parseOperationReceipt(await invoke({ delegation, payload: input }))
      if (receipt.state !== 'succeeded' || receipt.operationId !== claims.operationId || await convexDigest(receipt.result) !== receipt.resultDigest ||
          deadline <= (extension.verifier.now?.() ?? Date.now())) throw new ExtensionError('operation-unknown', 409)
      boundedResult(receipt.result, claims.actionId === extension.manifest.recovery?.lookupActionId)
      return Response.json(receipt, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      const statuses = { 'invalid-input': 400, unauthorized: 401, forbidden: 403, 'operation-unknown': 409, unavailable: 503 }
      const code = admitted ? 'operation-unknown' : error instanceof ExtensionError && Object.hasOwn(statuses, error.code) ? error.code : 'unavailable'
      return Response.json({ code }, { status: statuses[code], headers: { 'cache-control': 'no-store' } })
    }
  }
}
function scopedQuery(context, table, index, scope, operationId) {
  assertConvexScope(scope)
  return context.db.query(table).withIndex(index, query => {
    const scoped = query.eq('installationId', scope.installationId).eq('tenantRef', scope.tenantRef).eq('subjectRef', scope.subjectRef)
    return operationId === undefined ? scoped : scoped.eq('operationId', operationId)
  })
}
/** Native indexed read/OCC conflict plus result insert, within ONE internal mutation. */
export async function onceConvexOperation(context, scope, input, run) {
  assertConvexScope(scope)
  if (await convexDigest(input) !== scope.payloadDigest) throw new ExtensionError('invalid-input')
  const row = await scopedQuery(context, 'extensionOperations', 'by_scope_operation', scope, scope.operationId).unique()
  assertConvexScope(scope)
  if (row) {
    if (row.actionId !== scope.actionId || row.generation !== scope.generation || row.releaseDigest !== scope.releaseDigest || row.payloadDigest !== scope.payloadDigest) throw new ExtensionError('idempotency-conflict', 409)
    if (await convexDigest(row.result) !== row.resultDigest) throw new ExtensionError('unavailable', 503)
    return boundedResult(row.result)
  }
  const result = boundedResult(await run(context))
  const resultDigest = await convexDigest(result)
  assertConvexScope(scope)
  const { rootWrites: omitted, ...identity } = scope
  await context.db.insert('extensionOperations', { ...identity, result, resultDigest })
  assertConvexScope(scope)
  return result
}
export async function lookupConvexOperation(context, scope, operationId) {
  assertConvexScope(scope)
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(text(operationId))) throw new ExtensionError('invalid-input')
  const row = await scopedQuery(context, 'extensionOperations', 'by_scope_operation', scope, operationId).unique()
  assertConvexScope(scope)
  if (!row) return null
  if (await convexDigest(row.result) !== row.resultDigest) throw new ExtensionError('unavailable', 503)
  return { schema: 'mnstry.extension-provider-operation/v1', installationId: scope.installationId,
    operationId: row.operationId, actionId: row.actionId, generation: row.generation, releaseDigest: row.releaseDigest,
    payloadDigest: row.payloadDigest, resultDigest: row.resultDigest, result: row.result }
}

/** Read-only native index readiness; the existing host health envelope carries
 * only immutable release/schema identities, never member rows or row counts. */
export async function convexHealth(context, value) {
  const manifest = parseManifest(value)
  const { releaseDigest: ignored, ...body } = manifest
  if (manifest.deployment.profile !== 'convex-native' || await convexDigest(body) !== manifest.releaseDigest) throw new ExtensionError('unavailable', 503)
  await context.db.query('extensionCounters').withIndex('by_scope').take(0)
  await context.db.query('extensionOperations').withIndex('by_scope_operation').take(0)
  return { schema: 'mnstry.extension-health/v1', ready: true, profile: 'convex-native',
    releaseDigest: manifest.releaseDigest, schemaDigest: manifest.deployment.schemaDigest }
}
