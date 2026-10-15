import { createHash, verify } from 'node:crypto'
import { canonicalJson, ExtensionError, parseManifest } from './contracts.mjs'
import { assertDelegationBinding, decodeDelegation, unauthorized, validateDelegationClaims } from './delegation.mjs'
export { createRootAdmissionConsumer } from './admission.mjs'

export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
export function releaseDigest(value) {
  const { releaseDigest: omitted, ...rest } = parseManifest(value)
  return digest(rest)
}
const admittedScopes = new WeakMap()
const extensionDefinitions = new WeakMap()
function freezeJson(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeJson); Object.freeze(value) }
  return value
}
export function assertVerifiedScope(scope) {
  if (!scope || !admittedScopes.get(scope)?.()) throw new ExtensionError('unauthorized', 401)
}
function verifiedClaims(delegation, options) {
  try {
    const decoded = decodeDelegation(delegation)
    const key = options.keys.get(decoded.header.kid)
    if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
        !verify('sha256', decoded.signed, { key, dsaEncoding: 'ieee-p1363' }, decoded.signature)) return unauthorized()
    return validateDelegationClaims(decoded.claims, options)
  } catch { return unauthorized() }
}
export function defineAction(definition) {
  if (!definition || ['input', 'output', 'run'].some(key => typeof definition[key] !== 'function')) throw new ExtensionError('invalid-input')
  return Object.freeze({ input: definition.input, output: definition.output, run: definition.run })
}
export function defineExtension({ manifest, verifier, actions }) {
  const pinned = parseManifest(manifest)
  if (pinned.releaseDigest !== releaseDigest(pinned) || pinned.actions.some(action => !Object.hasOwn(actions,action.id)) ||
      Object.keys(actions).some(id => !pinned.actions.some(action => action.id === id)) || typeof verifier.consume !== 'function') throw new ExtensionError('invalid-input')
  const runtime = Object.freeze({ manifest: freezeJson(pinned), verifier: Object.freeze({ ...verifier, keys: new Map(verifier.keys) }),
    actions: Object.freeze(Object.fromEntries(Object.entries(actions).map(([id, action]) => [id, defineAction(action)]))) })
  const handle = Object.freeze({ manifest: runtime.manifest })
  extensionDefinitions.set(handle, runtime)
  return handle
}
export function createExtensionHandler(handle) {
  const extension = extensionDefinitions.get(handle)
  if (!extension) throw new ExtensionError('invalid-input')
  return async request => {
    let admitted = false
    try {
      if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return new Response(null, { status: 415 })
      const delegation = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1]
      if (!delegation) return unauthorized()
      const claims = verifiedClaims(delegation, extension.verifier)
      const manifest = extension.manifest
      assertDelegationBinding(claims, manifest, extension.verifier)
      const declared = manifest.actions.find(action => action.id === claims.actionId)
      const action = Object.hasOwn(extension.actions,claims.actionId) ? extension.actions[claims.actionId] : null
      if (!declared || !action) return unauthorized()
      const body = request.body?.getReader()
      if (!body) throw new ExtensionError('invalid-input')
      let input
      try {
        let size = 0
        const chunks = []
        for (;;) {
          const { value, done } = await body.read()
          if (done) break
          size += value.byteLength
          if (size > 65536) throw new ExtensionError('invalid-input')
          chunks.push(value)
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } finally { await body.cancel().catch(() => {}) }
      if (digest(input) !== claims.payloadDigest) throw new ExtensionError('invalid-input')
      input = action.input(input)
      if (digest(input) !== claims.payloadDigest) throw new ExtensionError('invalid-input')
      if (!await extension.verifier.consume(claims, delegation)) throw new ExtensionError('forbidden', 403)
      admitted = true
      const scope = Object.freeze({ installationId: claims.installationId, generation: claims.generation, releaseDigest: claims.releaseDigest,
        operationId: claims.operationId, actionId: claims.actionId, payloadDigest: claims.payloadDigest,
        tenantRef: claims.tenantRef, subjectRef: claims.subjectRef, rootWrites: claims.rootWrites })
      const deadline = Math.min(claims.exp * 1000, (extension.verifier.now?.() ?? Date.now()) + declared.timeoutMs)
      const controller = new AbortController()
      admittedScopes.set(scope, () => !controller.signal.aborted && deadline > (extension.verifier.now?.() ?? Date.now()))
      let expire
      const expired = new Promise((_, reject) => { expire = () => { const error = new ExtensionError('operation-unknown', 409); controller.abort(error); reject(error) } })
      const timer = setTimeout(expire, Math.max(0, deadline - (extension.verifier.now?.() ?? Date.now())))
      let result
      try {
        if (deadline <= (extension.verifier.now?.() ?? Date.now())) throw new ExtensionError('operation-unknown', 409)
        result = action.output(await Promise.race([Promise.resolve().then(() => action.run({ scope, signal: controller.signal }, input)), expired]))
        if (controller.signal.aborted || deadline <= (extension.verifier.now?.() ?? Date.now())) throw new ExtensionError('operation-unknown', 409)
      } finally { clearTimeout(timer); admittedScopes.delete(scope) }
      if (Buffer.byteLength(canonicalJson(result)) > 65536) throw new ExtensionError('operation-unknown', 409)
      return Response.json({ operationId: claims.operationId, state: 'succeeded', result, resultDigest: digest(result) }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      const statuses = { 'invalid-input': 400, unauthorized: 401, forbidden: 403, 'operation-unknown': 409, unavailable: 503 }
      const code = admitted ? 'operation-unknown' : error instanceof ExtensionError && Object.hasOwn(statuses, error.code) ? error.code : 'unavailable'
      return Response.json({ code }, { status: statuses[code],
        headers: { 'cache-control': 'no-store' } })
    }
  }
}
