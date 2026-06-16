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
  assert.equal(staticHtml.headers.get('x-content-type-options'), 'nosniff')

  const apply = await fetch(`${base}/api/apply`, { method: 'POST', body: '{}' })
  assert.equal(apply.status, 403)

  const prototype = await fetch(`${base}/api/__proto__`, { method: 'POST', body: '{}' })
  assert.equal(prototype.status, 403)
})
