import { verifyVaultPrivacy } from './privacy.mjs'
import { renderVaultHome, vaultHomePolicy } from './interface.mjs'
/** Optional hosted artifact service. No default network, storage, or identity provider. */
const TYPES = Object.freeze({ html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', txt: 'text/plain; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' })
const LIMIT = 4 * 1024 * 1024
const encoder = new TextEncoder()
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value)
const validPath = value => typeof value === 'string' && value.length <= 512 && value.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p) && p !== '.' && p !== '..')
const validExt = value => value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
const sameOwner = (a, b) => a && b && typeof a.issuer === 'string' && a.issuer.length > 0 && typeof a.subject === 'string' && a.subject.length > 0 && a.issuer === b.issuer && a.subject === b.subject
const headers = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}
export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}
function reply(status, text = '') { return new Response(text, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } }) }
async function boundedBody(request) {
  if (!request.body) throw new Error('invalid')
  const reader = request.body.getReader()
  let size = 0
  const chunks = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > LIMIT) { await reader.cancel(); throw new Error('too-large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
export async function preparePublication(input) {
  if (!input || input.schema !== 'atelier-vault-publication/v1' || (input.contractVersion !== undefined && (typeof input.contractVersion !== 'string' || !/^1\.[0-9]+\.[0-9]+$/.test(input.contractVersion))) || !validExt(input.ext) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER || Object.keys(input).some(key => !['schema', 'contractVersion', 'expectedRevision', 'files', 'ext'].includes(key)) || !Array.isArray(input.files) || !input.files.length || input.files.length > 100) throw new Error('invalid')
  if (encoder.encode(JSON.stringify(input)).length > LIMIT) throw new Error('too-large')
  const seen = new Set()
  const files = []
  let total = 0
  for (const file of input.files) {
    if (!file || !validExt(file.ext) || Object.keys(file).some(key => !['path', 'base64', 'ext'].includes(key)) || !validPath(file.path) || seen.has(file.path) || typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('invalid')
    const type = TYPES[file.path.split('.').at(-1)]
    if (typeof type !== 'string') throw new Error('invalid')
    seen.add(file.path)
    const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))
    total += bytes.length
    if (total > LIMIT) throw new Error('too-large')
    files.push({ path: file.path, type, size: bytes.length, sha256: await digest(bytes), bytes })
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const manifest = files.map(({ bytes, ...record }) => record)
  return { files, manifest, publication: await digest(encoder.encode(JSON.stringify(manifest))) }
}
/**
 * identity.read(request) -> verified {issuer,subject}, or null (revocation checked).
 * identity.publish(request,vault) -> verified owner identity, or null; MUST use
 * a revocable vault-scoped machine credential, never browser cookies.
 * metadata.get(vault) -> {owner, revision, manifest}, or null.
 * metadata.commit(vault,{owner,expectedRevision,manifest,publication}) -> boolean;
 * MUST atomically compare both owner and revision before replacing manifest.
 * storage.get/put accepts service-generated keys only and uses private storage.
 */
export function createVaultService({ identity, metadata, storage, privacy }) {
  for (const [object, methods] of [[identity, ['read', 'publish']], [metadata, ['get', 'commit']], [storage, ['get', 'put']]]) {
    if (!object || methods.some(method => typeof object[method] !== 'function')) throw new TypeError('Incomplete vault adapter')
  }
  return async function handle(request) {
    try {
      const url = new URL(request.url)
      if (/%|\\/.test(url.pathname)) return reply(400)
      const parts = url.pathname.slice(1).split('/')
      const publishing = parts[0] === '_publish'
      const vault = publishing ? parts[1] : parts[0]
      if (!validId(vault)) return reply(404)
      const home = !publishing && (parts.length === 1 || (parts.length === 2 && parts[1] === ''))
      if (url.search && (!home || [...url.searchParams.keys()].some(key => key !== 'q') || url.searchParams.getAll('q').length > 1 || (url.searchParams.get('q') || '').length > 200)) return reply(400)
      if (publishing) {
        if (parts.length !== 2 || !['GET', 'POST'].includes(request.method)) return reply(405)
        // Browser-originated writes are not a machine publication channel.
        if (request.headers.has('origin') || request.headers.has('cookie')) return reply(403)
        const principal = await identity.publish(request, vault)
        if (!principal) return reply(401)
        const record = await metadata.get(vault)
        if (!sameOwner(principal, record?.owner)) return reply(404)
        if (request.method === 'GET') {
          return new Response(JSON.stringify({ schema: 'atelier-vault-status/v1', vault, revision: record.revision, publication: record.publication ?? null }), { headers: { ...headers, 'Content-Type': 'application/json' } })
        }
        if (request.headers.get('content-type') !== 'application/json') return reply(415)
        let input, prepared
        try { input = await boundedBody(request); prepared = await preparePublication(input) }
        catch (error) { return reply(error.message === 'too-large' ? 413 : 400) }
        if (input.expectedRevision !== record.revision) return reply(409)
        const context = { vault, publication: prepared.publication, manifest: prepared.manifest }
        const before = await verifyVaultPrivacy(privacy, { ...context, phase: 'before-upload' })
        if (before.status !== 'verified') return reply(503, before.reason)
        for (const file of prepared.files) await storage.put(`${vault}/${file.sha256}`, file.bytes)
        // Revalidate the credential after potentially slow uploads, before commit.
        const current = await identity.publish(request, vault)
        if (!sameOwner(principal, current)) return reply(401)
        const after = await verifyVaultPrivacy(privacy, { ...context, phase: 'before-activation' })
        if (after.status !== 'verified' || after.policyRevision !== before.policyRevision) return reply(503, 'Protection changed or could not be verified. Publication was not activated.')
        const committed = await metadata.commit(vault, { owner: principal, expectedRevision: input.expectedRevision, manifest: prepared.manifest, publication: prepared.publication })
        if (!committed) return reply(409)
        return new Response(JSON.stringify({ schema: 'atelier-vault-receipt/v1', vault, revision: input.expectedRevision + 1, publication: prepared.publication }), { status: 201, headers: { ...headers, 'Content-Type': 'application/json' } })
      }
      if (!['GET', 'HEAD'].includes(request.method)) return reply(405)
      const principal = await identity.read(request)
      if (!principal) return reply(401)
      const record = await metadata.get(vault)
      if (!sameOwner(principal, record?.owner)) return reply(404)
      const protection = await verifyVaultPrivacy(privacy, { vault, publication: record.publication ?? null, manifest: record.manifest, phase: 'read' })
      if (home) return new Response(request.method === 'HEAD' ? null : renderVaultHome({ vault, revision: record.revision, manifest: record.manifest, privacy: protection, query: url.searchParams.get('q') || '' }), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': vaultHomePolicy } })
      if (protection.status !== 'verified') return reply(503, protection.reason)
      const path = parts.slice(1).join('/')
      if (!validPath(path)) return reply(404)
      const file = record.manifest.find(entry => entry.path === path)
      if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Object.values(TYPES).includes(file.type)) return reply(404)
      const bytes = await storage.get(`${vault}/${file.sha256}`)
      if (!bytes || bytes.length !== file.size || await digest(bytes) !== file.sha256) return reply(503)
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...headers, 'Content-Type': file.type, 'Content-Length': String(bytes.length), ...(file.type === 'application/pdf' ? { 'Content-Disposition': 'attachment' } : {}) } })
    } catch { return reply(503) }
  }
}
