#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expectedOriginForRequest,
  htmlDocumentHeaders,
  requestHeader,
  resolveWorkspacePath,
  staticHeaders,
  trustedFetchSite,
  trustedHost,
  trustedMutationRequest,
  trustedReadRequest,
} from './security.mjs'
import { createProposalStore } from '../collaboration/proposals.mjs'
import {
  renderProposalDetailPageHtml,
  renderProposalListPageHtml,
} from '../ui/html-primitives.mjs'

export const ATELIER_CONTEXT_SCHEMA = 'atelier-context@v1'
export const ATELIER_PRESENCE_SCHEMA = 'atelier-presence@v1'
export const ATELIER_RESOLVE_SCHEMA = 'atelier-resolve@v1'
export const ATELIER_DOCTOR_SCHEMA = 'atelier-doctor@v1'
export const ATELIER_CAPABILITIES_SCHEMA = 'atelier-capabilities@v1'
export const ATELIER_SESSION_AUTH_SCHEMA = 'atelier-session-auth@v1'

function workspaceIdForRoot(workspaceRoot) {
  return crypto.createHash('sha256').update(fs.realpathSync(workspaceRoot)).digest('hex').slice(0, 16)
}

function cleanIdentity(value, max = 160) {
  return String(value || '').trim().slice(0, max)
}

function nowMs() {
  return Date.now()
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function secureWriteJson(file, payload, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, mode)
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

function readOrCreateNonce(noncePath) {
  const existing = fs.existsSync(noncePath) ? fs.readFileSync(noncePath, 'utf8').trim() : ''
  if (/^[a-f0-9]{64}$/.test(existing)) return existing
  const nonce = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(noncePath, `${nonce}\n`, { mode: 0o600 })
  return nonce
}

function json(res, code, obj) {
  const body = Buffer.from(`${JSON.stringify(obj, null, 2)}\n`)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function text(res, code, body, headers = {}) {
  const buffer = Buffer.from(body)
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(buffer)
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const textBody = Buffer.concat(chunks).toString('utf8')
      if (!textBody) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(textBody))
      } catch {
        reject(new Error('request body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}

function requestNonce(req, body = {}) {
  return requestHeader(req.headers, 'x-atelier-nonce') || body.mutationNonce || body.nonce || ''
}

function nonceMatches(value, mutationNonce) {
  return typeof value === 'string' && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(mutationNonce))
}

function requireMutationAuth(req, body, mutationNonce) {
  if (!trustedMutationRequest(req.headers)) {
    return { ok: false, status: 403, error: 'cross-origin mutation refused' }
  }
  const nonce = requestNonce(req, body)
  if (!/^[a-f0-9]{64}$/.test(nonce) || !nonceMatches(nonce, mutationNonce)) {
    return { ok: false, status: 403, error: 'mutation nonce required' }
  }
  return { ok: true }
}

function defaultPresence() {
  return {
    schema: ATELIER_PRESENCE_SCHEMA,
    entries: [],
  }
}

function presenceKey(entry) {
  return [entry.sessionId, entry.viewId, entry.path].filter(Boolean).join('\0')
}

function rankedEntries(entries, ttlMs, now = nowMs()) {
  return entries
    .map((entry) => ({
      ...entry,
      stale: Number(entry.seenAtMs || 0) + ttlMs < now,
    }))
    .sort((left, right) => Number(right.seenAtMs || 0) - Number(left.seenAtMs || 0))
}

function capabilityContract() {
  return {
    ok: true,
    schema: ATELIER_CAPABILITIES_SCHEMA,
    read: [
      { id: 'context.current', endpoint: '/api/current' },
      { id: 'context.resolve', endpoint: '/api/resolve' },
      { id: 'doctor.status', endpoint: '/api/doctor' },
      { id: 'capabilities.contract', endpoint: '/api/capabilities' },
    ],
    mutate: [
      { id: 'presence.seen', endpoint: '/api/seen', copyOnly: true },
      { id: 'proposal.create', endpoint: '/api/proposals', copyOnly: true },
      { id: 'proposal.review', endpoint: '/api/proposals/:id/review', copyOnly: true },
    ],
    directWrite: false,
    applyEndpoint: null,
    summary: {
      read: true,
      mutate: false,
      directWrite: false,
    },
    grantEndpoint: '/api/session-auth',
    proposalEndpoint: '/api/proposals',
  }
}

function doctorEnvelope() {
  return {
    ok: true,
    schema: ATELIER_DOCTOR_SCHEMA,
    status: 'ok',
    checkedBeforeRepair: true,
    errors: [],
    warnings: [],
  }
}

export function createAtelierSidecarServer({
  workspaceRoot = process.cwd(),
  stateDir = workspaceRoot,
  port = 0,
  presenceTtlMs = Number(process.env.ATELIER_PRESENCE_TTL_MS || 5 * 60 * 1000),
} = {}) {
  const root = path.resolve(workspaceRoot)
  const rootReal = fs.realpathSync(root)
  const workspaceId = workspaceIdForRoot(root)
  const noncePath = path.join(stateDir, '.atelier-nonce')
  const presencePath = path.join(stateDir, '.atelier-presence.json')
  const mutationNonce = readOrCreateNonce(noncePath)
  const proposals = createProposalStore({
    workspaceRoot: root,
    proposalsDir: path.join(stateDir, '.atelier-proposals'),
    workspaceId,
  })

  function readPresence() {
    const presence = readJsonFile(presencePath, defaultPresence())
    return {
      ...defaultPresence(),
      ...presence,
      entries: Array.isArray(presence?.entries) ? presence.entries : [],
    }
  }

  function writePresence(presence) {
    secureWriteJson(presencePath, presence)
  }

  function recordView(rel, hints = {}) {
    const resolved = resolveWorkspacePath({
      workspaceRoot: root,
      workspaceRootReal: rootReal,
      rel,
      requireHtml: true,
    })
    if (!resolved.ok) return { ok: false, error: 'unknown workspace html file' }
    const entry = {
      sessionId: cleanIdentity(hints.sessionId, 120),
      viewId: cleanIdentity(hints.viewId, 120),
      path: resolved.path,
      seenAt: new Date().toISOString(),
      seenAtMs: nowMs(),
      workspaceId,
    }
    const presence = readPresence()
    const byKey = new Map(presence.entries.map((item) => [presenceKey(item), item]))
    byKey.set(presenceKey(entry), entry)
    presence.entries = rankedEntries([...byKey.values()], presenceTtlMs).slice(0, 100)
    writePresence(presence)
    return { ok: true, entry }
  }

  function resolveCurrentContext(hints = {}) {
    const entries = rankedEntries(readPresence().entries, presenceTtlMs)
    const sessionId = cleanIdentity(hints.sessionId, 120)
    if (sessionId) {
      const candidates = entries.filter((entry) => entry.sessionId === sessionId)
      const fresh = candidates.find((entry) => !entry.stale)
      if (fresh) {
        return {
          ok: true,
          schema: ATELIER_CONTEXT_SCHEMA,
          confidence: 'bound',
          current: { path: fresh.path },
          session: { sessionId: fresh.sessionId, viewId: fresh.viewId },
          candidates,
        }
      }
      if (candidates[0]) {
        return {
          ok: true,
          schema: ATELIER_CONTEXT_SCHEMA,
          confidence: 'fallback',
          stale: true,
          current: { path: candidates[0].path },
          session: { sessionId: candidates[0].sessionId, viewId: candidates[0].viewId },
          candidates,
        }
      }
    }
    return {
      ok: true,
      schema: ATELIER_CONTEXT_SCHEMA,
      confidence: entries.length === 1 && !entries[0].stale ? 'single-candidate' : 'ambiguous',
      current: entries[0] ? { path: entries[0].path } : null,
      fallback: entries[0] ? { path: entries[0].path } : null,
      candidates: entries,
    }
  }

  function contextEnvelope(req, url) {
    const sessionId = cleanIdentity(url.searchParams.get('sessionId'), 120)
    const viewId = cleanIdentity(url.searchParams.get('viewId'), 120)
    const rel = cleanIdentity(url.searchParams.get('path') || 'index.html', 500)
    const expectedWorkspaceId = cleanIdentity(url.searchParams.get('expectedWorkspaceId'), 120)
    const resolved = resolveWorkspacePath({
      workspaceRoot: root,
      workspaceRootReal: rootReal,
      rel,
      requireHtml: true,
    })
    const current = resolveCurrentContext({ sessionId })
    const workspaceVerified = Boolean(expectedWorkspaceId && expectedWorkspaceId === workspaceId)
    const caps = capabilityContract()
    caps.summary = {
      ...caps.summary,
      mutate: workspaceVerified && current.confidence === 'bound',
    }
    return {
      ok: true,
      schema: ATELIER_CONTEXT_SCHEMA,
      workspaceId,
      origin: {
        host: requestHeader(req.headers, 'host'),
        trustedHost: trustedHost(req.headers),
      },
      sessionId,
      viewId,
      view: { path: rel },
      presence: {
        authoritative: workspaceVerified && current.confidence === 'bound',
        sessionBound: current.confidence === 'bound',
        workspaceVerified,
        workspaceMismatch: Boolean(expectedWorkspaceId && expectedWorkspaceId !== workspaceId),
        expectedWorkspaceId: expectedWorkspaceId || null,
        candidates: current.candidates || [],
      },
      current: current.current,
      resolve: resolved.ok ? {
        ok: true,
        schema: ATELIER_RESOLVE_SCHEMA,
        path: resolved.path,
        workspaceContained: true,
      } : {
        ok: false,
        schema: ATELIER_RESOLVE_SCHEMA,
        path: rel,
        workspaceContained: false,
        error: resolved.error,
      },
      doctor: doctorEnvelope(),
      capabilities: caps,
    }
  }

  async function handlePost(req, res, url) {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      json(res, 400, { ok: false, error: error.message })
      return
    }
    const auth = requireMutationAuth(req, body, mutationNonce)
    if (!auth.ok) {
      json(res, auth.status, { ok: false, error: auth.error })
      return
    }

    if (url.pathname === '/api/seen') {
      const result = recordView(body.rel || body.path, body)
      json(res, 200, result.ok ? { ok: true, entry: result.entry } : result)
      return
    }

    if (url.pathname === '/api/proposals') {
      const resolved = resolveWorkspacePath({
        workspaceRoot: root,
        workspaceRootReal: rootReal,
        rel: body.path || body.rel,
        requireHtml: true,
      })
      if (!resolved.ok) {
        json(res, 200, { ok: false, error: 'unknown workspace html file' })
        return
      }
      let result
      try {
        result = proposals.createProposal({ ...body, path: resolved.path })
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (!result.ok) {
        json(res, result.status, { ok: false, error: result.error })
        return
      }
      json(res, 200, {
        ok: true,
        schema: result.record.schema,
        workspaceId,
        proposal: result.record.proposal,
      })
      return
    }

    const reviewMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/review$/)
    if (reviewMatch) {
      const id = reviewMatch[1]
      let result
      try {
        result = proposals.reviewProposal(id, body)
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (!result.ok) {
        json(res, result.status, { ok: false, error: result.error })
        return
      }
      json(res, 200, {
        ok: true,
        schema: result.record.schema,
        proposal: result.record.proposal,
        diff: result.record.diff,
        copyable: result.record.copyable,
      })
      return
    }

    json(res, 404, { ok: false, error: 'unknown action' })
  }

  function serveStatic(req, res, url) {
    if (!trustedReadRequest(req.headers)) {
      text(res, 403, 'forbidden\n')
      return
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const resolved = resolveWorkspacePath({
      workspaceRoot: root,
      workspaceRootReal: rootReal,
      rel,
      requireFile: true,
    })
    if (!resolved.ok) {
      text(res, resolved.status || 403, `${resolved.error || 'forbidden'}\n`)
      return
    }

    const sessionId = url.searchParams.get('sessionId')
    const viewId = url.searchParams.get('viewId')
    if (sessionId && trustedFetchSite(req.headers)) {
      recordView(resolved.path, { sessionId, viewId })
    }

    const headers = path.extname(resolved.real).toLowerCase() === '.html'
      ? htmlDocumentHeaders(resolved.stat.size)
      : staticHeaders(resolved.real, resolved.stat)
    res.writeHead(200, headers)
    fs.createReadStream(resolved.real).pipe(res)
  }

  const server = http.createServer(async (req, res) => {
    const expectedOrigin = expectedOriginForRequest(req.headers, port)
    const url = new URL(req.url || '/', expectedOrigin || 'http://127.0.0.1')

    if (!trustedHost(req.headers)) {
      json(res, 403, { ok: false, error: 'non-loopback Host refused' })
      return
    }

    if (req.method === 'POST') {
      await handlePost(req, res, url)
      return
    }

    if (url.pathname === '/api/health') {
      json(res, 200, { ok: true, workspaceId })
      return
    }
    if (url.pathname === '/api/session-auth') {
      if (!trustedMutationRequest(req.headers)) {
        json(res, 403, { ok: false, error: 'cross-origin session auth refused' })
        return
      }
      const rel = url.searchParams.get('path') || 'index.html'
      const resolved = resolveWorkspacePath({
        workspaceRoot: root,
        workspaceRootReal: rootReal,
        rel,
        requireHtml: true,
      })
      if (!resolved.ok) {
        json(res, 404, { ok: false, error: 'unknown workspace html file' })
        return
      }
      recordView(resolved.path, {
        sessionId: url.searchParams.get('sessionId'),
        viewId: url.searchParams.get('viewId'),
      })
      json(res, 200, {
        ok: true,
        schema: ATELIER_SESSION_AUTH_SCHEMA,
        workspaceId,
        mutationNonce,
      })
      return
    }
    if (url.pathname === '/api/current') {
      json(res, 200, resolveCurrentContext({ sessionId: url.searchParams.get('sessionId') }))
      return
    }
    if (url.pathname === '/api/context') {
      json(res, 200, contextEnvelope(req, url))
      return
    }
    if (url.pathname === '/api/resolve') {
      const resolved = resolveWorkspacePath({
        workspaceRoot: root,
        workspaceRootReal: rootReal,
        rel: url.searchParams.get('path') || 'index.html',
        requireHtml: true,
      })
      json(res, resolved.ok ? 200 : (resolved.status || 404), {
        ok: resolved.ok,
        schema: ATELIER_RESOLVE_SCHEMA,
        path: resolved.path || url.searchParams.get('path') || 'index.html',
        workspaceContained: Boolean(resolved.ok),
        error: resolved.ok ? undefined : resolved.error,
      })
      return
    }
    if (url.pathname === '/api/doctor') {
      json(res, 200, doctorEnvelope())
      return
    }
    if (url.pathname === '/api/capabilities') {
      json(res, 200, capabilityContract())
      return
    }
    if (url.pathname === '/api/proposals') {
      json(res, 200, {
        ok: true,
        schema: 'atelier-proposals@v1',
        workspaceId,
        proposals: proposals.listProposals(),
      })
      return
    }
    const proposalReadMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)$/)
    if (proposalReadMatch) {
      const record = proposals.readProposal(proposalReadMatch[1])
      json(res, record ? 200 : 404, record ? {
        ok: true,
        schema: record.schema,
        workspaceId,
        proposal: record.proposal,
        diff: record.diff,
        copyable: record.copyable,
      } : { ok: false, error: 'proposal not found' })
      return
    }
    if (url.pathname === '/proposals') {
      const body = renderProposalListPageHtml(proposals.listProposals())
      res.writeHead(200, htmlDocumentHeaders(Buffer.byteLength(body)))
      res.end(body)
      return
    }
    const proposalPageMatch = url.pathname.match(/^\/proposals\/([^/]+)$/)
    if (proposalPageMatch) {
      const body = renderProposalDetailPageHtml(proposals.readProposal(proposalPageMatch[1]))
      res.writeHead(200, htmlDocumentHeaders(Buffer.byteLength(body)))
      res.end(body)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      json(res, 404, { ok: false, error: 'unknown action' })
      return
    }
    serveStatic(req, res, url)
  })

  return {
    server,
    workspaceRoot: root,
    workspaceRootReal: rootReal,
    workspaceId,
    mutationNonce,
    proposals,
    listen(listenPort = port, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(listenPort, host, () => resolve(server.address()))
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

function main() {
  const port = Number(process.argv[2] || process.env.PORT || 8137)
  const workspaceRoot = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd()
  const sidecar = createAtelierSidecarServer({ workspaceRoot, port })
  sidecar.listen(port).then((address) => {
    console.log(`[atelier-server] http://127.0.0.1:${address.port}`)
  })
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main()
}
