import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { requestHeader, sameOrigin } from '../../server/security.mjs'
import { isPlainObject } from './documents.mjs'
import { HEALTH_SCHEMA, LOOPBACK_HOSTS, authorityOf } from './service-client.mjs'

// The listener of the maintenance service: four fixed operations and nothing
// else. There is no file serving, no command, no evaluation and no route that
// takes a path, a name or code from a request.
//
//   GET  /health   who answers here; open, and says nothing else
//   GET  /status   service and per-view freshness summary; bearer required
//   POST /tick     run one tick now; bearer required
//   POST /stop     finish the tick in flight and exit; bearer required
//
// Every request, before its operation is even looked up:
//
//   - `Host` is exactly the literal loopback authority this listener is bound
//     to, so a name that resolves to loopback (DNS rebinding) is refused;
//   - a `Sec-Fetch-Site` other than `none` or `same-origin`, or an `Origin`
//     that is not this listener itself, is refused: no web page drives this;
//   - the path is one of the four, exactly, with no query; the method is the
//     one that path has.
//
// Everything but health needs the per-runtime random bearer that exists only
// in the owner-only record. A POST body is JSON of at most 1 KiB naming the
// runtime it is meant for, so a request aimed at an earlier runtime on the
// same port does nothing. A tick may also name one view (`scopeId`, a contract
// identifier), which is then prepared and published once more on that tick.

export const MAX_REQUEST_BYTES = 1024
const SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const SERVICE_OPERATIONS = Object.freeze({ '/health': 'GET', '/status': 'GET', '/tick': 'POST', '/stop': 'POST' })

const digestOf = (value) => createHash('sha256').update(String(value)).digest()

// The decisions the request oracles are sensitive to; tests substitute broken ones to prove the oracles can fail.
export const SERVER_PRIMITIVES = Object.freeze({
  bearerMatches: (presented, expected) => typeof presented === 'string' && presented !== '' && timingSafeEqual(digestOf(presented), digestOf(expected)),
  hostMatches: (header, authority) => header === authority,
  originAllowed(headers, authority) {
    const site = requestHeader(headers, 'sec-fetch-site').toLowerCase()
    if (site !== '' && site !== 'none' && site !== 'same-origin') return false
    const origin = requestHeader(headers, 'origin')
    return origin === '' || sameOrigin(origin, `http://${authority}`)
  },
  maxRequestBytes: MAX_REQUEST_BYTES,
})

function send(response, statusCode, body) {
  const text = JSON.stringify(body)
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' })
  response.end(text)
}

function readBoundedJson(request, limit) {
  return new Promise((resolve) => {
    const declared = Number(request.headers['content-length'] ?? 0)
    if (!Number.isFinite(declared) || declared > limit) return resolve({ ok: false, statusCode: 413, code: 'payload-too-large' })
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { finish({ ok: false, statusCode: 413, code: 'payload-too-large' }); request.resume() } else chunks.push(chunk)
    })
    request.on('end', () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = null }
      finish(isPlainObject(body) ? { ok: true, body } : { ok: false, statusCode: 400, code: 'payload-not-json-object' })
    })
    request.on('error', () => finish({ ok: false, statusCode: 400, code: 'payload-unreadable' }))
  })
}

// identity: { serviceName, workspaceId, runtimeId, pid, host, port, executableDigest, startedAt }
// operations: { healthStatus(), status(), tick(), stop() }
export function createServiceServerForOracleTests({ identity, bearer, operations }, primitives = SERVER_PRIMITIVES) {
  if (!LOOPBACK_HOSTS.includes(identity?.host)) throw new TypeError('the service listens on a literal loopback address only')
  if (typeof bearer !== 'string' || bearer.length < 32) throw new TypeError('the service needs its random bearer')
  const rules = { ...SERVER_PRIMITIVES, ...primitives }

  async function handle(request, response) {
    const authority = authorityOf(identity.host, identity.port)
    if (!rules.hostMatches(requestHeader(request.headers, 'host'), authority)) return send(response, 403, { error: 'host-not-this-loopback-listener' })
    if (!rules.originAllowed(request.headers, authority)) return send(response, 403, { error: 'cross-site-request' })
    const method = Object.hasOwn(SERVICE_OPERATIONS, request.url) ? SERVICE_OPERATIONS[request.url] : null
    if (method === null) return send(response, 404, { error: 'unknown-operation' })
    if (request.method !== method) return send(response, 405, { error: 'method-not-allowed' })
    if (request.url === '/health') {
      const { serviceName, workspaceId, runtimeId, pid, host, port, executableDigest, startedAt } = identity
      return send(response, 200, { schema: HEALTH_SCHEMA, serviceName, workspaceId, runtimeId, pid, host, port, executableDigest, startedAt, status: operations.healthStatus() })
    }
    const presented = /^Bearer ([A-Za-z0-9_-]+)$/.exec(requestHeader(request.headers, 'authorization'))?.[1] ?? null
    if (!rules.bearerMatches(presented, bearer)) return send(response, 401, { error: 'bearer-required' })
    if (request.url === '/status') return send(response, 200, await operations.status())
    const payload = await readBoundedJson(request, rules.maxRequestBytes)
    if (!payload.ok) return send(response, payload.statusCode, { error: payload.code })
    const { runtimeId, scopeId, ...unknown } = payload.body
    if (runtimeId !== identity.runtimeId || Object.keys(unknown).length > 0 || (scopeId !== undefined && request.url !== '/tick')) return send(response, 409, { error: 'request-names-another-runtime' })
    if (scopeId !== undefined && (typeof scopeId !== 'string' || !SCOPE_IDENTIFIER.test(scopeId))) return send(response, 400, { error: 'request-invalid' })
    if (request.url === '/tick') return send(response, 200, await operations.tick(scopeId === undefined ? {} : { scopeId }))
    // The answer leaves first; the service then finishes its tick and exits.
    response.once('finish', () => { void operations.stop() })
    return send(response, 202, { stopping: true, runtimeId: identity.runtimeId, pid: identity.pid })
  }

  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 1_000, maxHeaderSize: 8 * 1024 }, (request, response) => {
    handle(request, response).catch(() => { if (!response.headersSent) send(response, 500, { error: 'operation-failed' }); else response.destroy() })
  })
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      // A literal address and `ipv6Only`: never a wildcard, never a name.
      server.listen({ host: identity.host, port: identity.port, ipv6Only: identity.host === '::1', exclusive: true }, () => { server.off('error', reject); resolve(server.address()) })
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

export function createServiceServer(options) {
  return createServiceServerForOracleTests(options, SERVER_PRIMITIVES)
}
