import { createHash, verify } from 'node:crypto'
import { canonicalJson, exact, ExtensionError, parseManifest, text } from './contracts.mjs'

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
const unauthorized = () => { throw new ExtensionError('unauthorized', 401) }
const claimNames = ['iss', 'aud', 'iat', 'nbf', 'exp', 'jti', 'purpose', 'installationId', 'tenantRef', 'subjectRef', 'generation', 'releaseDigest', 'operationId', 'actionId', 'payloadDigest', 'rootWrites']
const opaque = value => /^[A-Za-z0-9_-]{16,128}$/.test(text(value))
function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return unauthorized()
  const bytes = Buffer.from(part, 'base64url')
  if (bytes.toString('base64url') !== part) return unauthorized()
  const string = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(string)
}
function verifiedClaims(delegation, options) {
  try {
    text(delegation, 16384)
    const parts = delegation.split('.')
    if (parts.length !== 3) return unauthorized()
    const header = exact(decode(parts[0]), ['alg', 'typ', 'kid'])
    if (header.alg !== 'ES256' || header.typ !== 'JWT') return unauthorized()
    const key = options.keys.get(text(header.kid))
    if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return unauthorized()
    const signature = Buffer.from(parts[2], 'base64url')
    if (signature.length !== 64 || signature.toString('base64url') !== parts[2] ||
        !verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, signature)) return unauthorized()
    const claims = exact(decode(parts[1]), claimNames)
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
  } catch { return unauthorized() }
}
export function createRootAdmissionConsumer({ origin, allowLocalTesting = false, fetch: hostFetch = globalThis.fetch }) {
  const target = new URL(origin)
  const local = allowLocalTesting && ['test', 'development'].includes(process.env.NODE_ENV) &&
    target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname)
  if ((target.protocol !== 'https:' && !local) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new ExtensionError('invalid-input')
  const endpoint = new URL('/api/root-runtime/extensions/admissions/consume', target)
  return async (_claims, delegation) => {
    const response = await hostFetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' }, body: canonicalJson({ delegation }) })
    if (response.status === 401 || response.status === 403) return false
    if (response.status != 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new ExtensionError('unavailable', 503)
    const reader = response.body?.getReader()
    if (!reader) throw new ExtensionError('unavailable', 503)
    try {
      let size = 0
      const chunks = []
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024) throw new ExtensionError('unavailable', 503)
        chunks.push(value)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      exact(body, ['admitted'])
      if (body.admitted !== true) throw new ExtensionError('unavailable', 503)
      return true
    } catch { throw new ExtensionError('unavailable', 503) } finally { await reader.cancel().catch(() => {}) }
  }
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
      if (claims.installationId !== extension.verifier.installationId || claims.releaseDigest !== manifest.releaseDigest ||
          claims.releaseDigest !== extension.verifier.releaseDigest || claims.rootWrites.length !== manifest.permissions.rootWrites.length ||
          claims.rootWrites.some(value => !manifest.permissions.rootWrites.includes(value))) return unauthorized()
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
