import http from 'node:http'
import { isPlainObject } from './documents.mjs'
import { refuse } from './errors.mjs'

// The only client of the maintenance service, and the only place this runtime
// opens a connection. It connects to a literal loopback address and nothing
// else: a hostname, a wildcard address or any other value refuses before a
// socket exists, so no name is ever resolved and nothing leaves the machine.

export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1'])
export const HEALTH_SCHEMA = 'atelier-obsidian-service-health/v1'
// Long enough for a closed port to refuse on every platform: some answer a refused loopback connection only after retrying for about two seconds.
export const DEFAULT_PROBE_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 64 * 1024

export const authorityOf = (host, port) => (host === '::1' ? `[::1]:${port}` : `${host}:${port}`)

function assertLoopback(host, port) {
  if (!LOOPBACK_HOSTS.includes(host)) refuse('service-address-not-loopback', 'the maintenance service is reached at a literal loopback address only')
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('service-address-not-loopback', 'the maintenance service port is not a port')
}

// { kind: 'refused' }              nothing listens there
// { kind: 'timeout' }              something accepted the connection and did not answer in time
// { kind: 'error', code }          the connection failed some other way
// { kind: 'response', statusCode, body }   body is parsed JSON, or null
export function requestLoopback({ host, port, method = 'GET', path = '/health', bearer = null, payload = null, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  assertLoopback(host, port)
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
    const text = payload === null ? null : JSON.stringify(payload)
    const headers = { Host: authorityOf(host, port), Connection: 'close', ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), ...(text === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }) }
    // @atelier-egress-local-computed
    const request = http.request({ host, port, family: host === '::1' ? 6 : 4, method, path, headers, agent: false, timeout: timeoutMs }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) { request.destroy(); settle({ kind: 'response', statusCode: response.statusCode, body: null }) } else chunks.push(chunk)
      })
      response.on('end', () => {
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = null }
        settle({ kind: 'response', statusCode: response.statusCode, body: isPlainObject(body) ? body : null })
      })
      response.on('error', () => settle({ kind: 'error', code: 'response-failed' }))
    })
    const timer = setTimeout(() => { request.destroy(); settle({ kind: 'timeout' }) }, timeoutMs)
    request.on('timeout', () => { request.destroy(); settle({ kind: 'timeout' }) })
    request.on('error', (error) => settle(error.code === 'ECONNREFUSED' ? { kind: 'refused' } : { kind: 'error', code: error.code ?? 'request-failed' }))
    request.on('close', () => clearTimeout(timer))
    request.end(text ?? undefined)
  })
}

// { kind: 'health', body } only for a well-formed health document; any other
// answer on the port is { kind: 'foreign' }: occupied, by something else.
export async function probeHealth({ host, port, timeoutMs }) {
  const answer = await requestLoopback({ host, port, method: 'GET', path: '/health', ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  if (answer.kind !== 'response') return answer
  const body = answer.body
  const wellFormed = answer.statusCode === 200 && body?.schema === HEALTH_SCHEMA && typeof body.serviceName === 'string' && typeof body.workspaceId === 'string' && typeof body.runtimeId === 'string'
    && Number.isInteger(body.pid) && typeof body.host === 'string' && Number.isInteger(body.port) && typeof body.executableDigest === 'string'
  return wellFormed ? { kind: 'health', body } : { kind: 'foreign', statusCode: answer.statusCode }
}
