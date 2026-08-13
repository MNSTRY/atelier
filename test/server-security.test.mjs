import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-server-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Atelier</title>\n')
  fs.mkdirSync(path.join(root, 'app'), { recursive: true })
  fs.writeFileSync(path.join(root, 'app', 'page.html'), '<!doctype html><title>Page</title>\n')
  return root
}

function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: raw,
          json: () => JSON.parse(raw),
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

test('local sidecar refuses untrusted reads, state files, symlink escapes, and apply paths', async (t) => {
  const workspaceRoot = makeWorkspace()
  const sidecar = createAtelierSidecarServer({ workspaceRoot })
  t.after(async () => {
    await sidecar.close()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  const address = await sidecar.listen()
  const base = `http://127.0.0.1:${address.port}`

  const health = await fetch(`${base}/api/health`, {
    headers: {
      Origin: 'https://example.invalid',
    },
  })
  assert.equal(health.status, 200)
  assert.equal(health.headers.get('access-control-allow-origin'), null)
  const healthBody = await health.json()
  assert.equal(healthBody.ok, true)
  assert.match(healthBody.workspaceId, /^[a-f0-9]{16}$/)
  assert.equal(Object.hasOwn(healthBody, 'mutationNonce'), false)

  const foreignHost = await rawGet(`${base}/api/current`, {
    Host: `example.invalid:${address.port}`,
  })
  assert.equal(foreignHost.status, 403)

  const sameOriginAuth = await fetch(`${base}/api/session-auth?sessionId=s1&viewId=v1&path=index.html`, {
    headers: {
      Origin: base,
      'Sec-Fetch-Site': 'same-origin',
    },
  })
  assert.equal(sameOriginAuth.status, 200)
  const sameOriginBody = await sameOriginAuth.json()
  assert.match(sameOriginBody.mutationNonce, /^[a-f0-9]{64}$/)

  const crossOriginAuth = await fetch(`${base}/api/session-auth?sessionId=s2&viewId=v2&path=index.html`, {
    headers: {
      Origin: 'https://example.invalid',
      'Sec-Fetch-Site': 'cross-site',
    },
  })
  assert.equal(crossOriginAuth.status, 403)

  for (const route of [
    '/.atelier-nonce',
    '/.atelier-presence.json',
    '/.atelier-proposals/fake.json',
  ]) {
    const response = await fetch(`${base}${route}`)
    assert.equal(response.status, 403, `${route} must not be statically served`)
  }

  fs.symlinkSync(path.join(workspaceRoot, '.atelier-nonce'), path.join(workspaceRoot, 'state-link.txt'))
  const stateLink = await fetch(`${base}/state-link.txt`)
  assert.equal(stateLink.status, 403)

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-outside-'))
  fs.writeFileSync(path.join(outsideDir, 'escape.html'), '<!doctype html><title>Outside</title>\n')
  fs.symlinkSync(path.join(outsideDir, 'escape.html'), path.join(workspaceRoot, 'escape.html'))
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }))
  const escape = await fetch(`${base}/escape.html`)
  assert.equal(escape.status, 403)

  const traversal = await fetch(`${base}/..%2fsecret.html`)
  assert.equal(traversal.status, 403)

  const staticHtml = await fetch(`${base}/index.html`, {
    headers: { 'Sec-Fetch-Site': 'none' },
  })
  assert.equal(staticHtml.status, 200)
  assert.match(staticHtml.headers.get('content-security-policy') || '', /default-src 'self'/)
  assert.match(staticHtml.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  // The CSP applies to arbitrary workspace HTML, so any allowlisted external
  // origin is an author-controllable egress channel: a URL path leaves the
  // machine even when the kit itself never uses the origin.
  assert.doesNotMatch(
    staticHtml.headers.get('content-security-policy') || '',
    /(?:https?:)?\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i,
    'CSP must not authorize any external origin'
  )
  assert.equal(staticHtml.headers.get('x-content-type-options'), 'nosniff')

  const apply = await fetch(`${base}/api/apply`, { method: 'POST', body: '{}' })
  assert.equal(apply.status, 403)

  const prototype = await fetch(`${base}/api/__proto__`, { method: 'POST', body: '{}' })
  assert.equal(prototype.status, 403)
})

// Regression: a request must never be able to end the process. Before the
// handler gained a catch, `GET /proposals/_` threw out of readProposal (the id
// cleans to empty) and killed the sidecar — reachable from any page the user
// visited, and self-inflicted by any half-written file in .atelier-proposals.
test('local sidecar survives unusable proposal ids and unreadable proposal files', async (t) => {
  const workspaceRoot = makeWorkspace()
  const proposalsDir = path.join(workspaceRoot, '.atelier-proposals')
  fs.mkdirSync(proposalsDir, { recursive: true })
  fs.writeFileSync(path.join(proposalsDir, 'proposal-truncated.json'), '{ not json')

  const sidecar = createAtelierSidecarServer({ workspaceRoot })
  t.after(async () => {
    await sidecar.close()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  const address = await sidecar.listen()
  const base = `http://127.0.0.1:${address.port}`

  // Ids that clean to nothing, and ids that name a file we cannot parse.
  const survivable = [
    '/proposals/_',
    '/proposals/%20',
    '/api/proposals/@@@',
    '/api/proposals/_',
    '/proposals/proposal-truncated',
    '/api/proposals/proposal-truncated',
  ]
  for (const route of survivable) {
    const res = await rawGet(`${base}${route}`)
    assert.ok(
      res.status === 200 || res.status === 404,
      `${route} answered ${res.status}; expected a response, not a dead socket`
    )
    const alive = await rawGet(`${base}/api/health`)
    assert.equal(alive.status, 200, `sidecar died after ${route}`)
  }

  // The drive-by shape: a cross-origin image request from an attacker page.
  const driveBy = await rawGet(`${base}/proposals/_`, {
    Origin: 'https://attacker.invalid',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
  })
  assert.ok(driveBy.status === 200 || driveBy.status === 404)
  const stillServing = await rawGet(`${base}/index.html`)
  assert.equal(stillServing.status, 200, 'sidecar died on a cross-origin proposal request')

  // The list route has always guarded its parse; the read route now matches it.
  const list = await rawGet(`${base}/api/proposals`)
  assert.equal(list.status, 200)
  assert.deepEqual(list.json().proposals, [])
})

// Regression: a busy port is an ordinary condition. It used to surface as an
// unhandled 'error' event that killed the process with a raw stack trace.
test('local sidecar reports a busy port as a rejection, not a crash', async (t) => {
  const workspaceRoot = makeWorkspace()
  const first = createAtelierSidecarServer({ workspaceRoot })
  const second = createAtelierSidecarServer({ workspaceRoot })
  t.after(async () => {
    await first.close()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  const address = await first.listen()

  await assert.rejects(
    () => second.listen(address.port),
    (error) => {
      assert.match(error.message, /already in use/)
      assert.match(error.message, /--port=/)
      return true
    }
  )
})
