import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'
import { loadPublishedWorkspaceManifest } from '../src/server/security.mjs'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-server-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Atelier</title>\n')
  fs.mkdirSync(path.join(root, 'app'), { recursive: true })
  fs.writeFileSync(path.join(root, 'app', 'page.html'), '<!doctype html><title>Page</title>\n')
  fs.writeFileSync(path.join(root, 'atelier.manifest.json'), `${JSON.stringify({
    schema: 'mnstry.atelier-manifest@v1',
    entry: 'index.html',
    assets: ['app/page.html'],
  })}\n`)
  return root
}

function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers: { 'Sec-Fetch-Site': 'none', ...headers } }, (res) => {
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
  assert.equal(health.status, 403)
  assert.equal(health.headers.get('access-control-allow-origin'), null)
  const trustedHealth = await fetch(`${base}/api/health`, {
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' },
  })
  assert.equal(trustedHealth.status, 200)
  const healthBody = await trustedHealth.json()
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
    const response = await rawGet(`${base}${route}`)
    assert.equal(response.status, 403, `${route} must not be statically served`)
  }

  fs.symlinkSync(path.join(workspaceRoot, '.atelier-nonce'), path.join(workspaceRoot, 'state-link.txt'))
  const stateLink = await rawGet(`${base}/state-link.txt`)
  assert.equal(stateLink.status, 403)

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-outside-'))
  fs.writeFileSync(path.join(outsideDir, 'escape.html'), '<!doctype html><title>Outside</title>\n')
  fs.symlinkSync(path.join(outsideDir, 'escape.html'), path.join(workspaceRoot, 'escape.html'))
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }))
  const escape = await rawGet(`${base}/escape.html`)
  assert.equal(escape.status, 403)

  const traversal = await rawGet(`${base}/..%2fsecret.html`)
  assert.equal(traversal.status, 403)

  const staticHtml = await fetch(`${base}/index.html`, {
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' },
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

  const noBrowserClassification = await rawGet(`${base}/api/health`, { 'Sec-Fetch-Site': '' })
  assert.equal(noBrowserClassification.status, 403)

  const disallowedMethod = await fetch(`${base}/api/health`, {
    method: 'PUT',
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' },
  })
  assert.equal(disallowedMethod.status, 405)
  assert.equal(disallowedMethod.headers.get('allow'), 'GET, HEAD, POST')

  fs.writeFileSync(path.join(workspaceRoot, 'app', 'unknown.html'), '<title>Unknown</title>\n')
  const unknown = await rawGet(`${base}/app/unknown.html`)
  assert.equal(unknown.status, 404)

  fs.writeFileSync(path.join(workspaceRoot, 'app', 'data.txt'), 'not published\n')
  const unknownType = await rawGet(`${base}/app/data.txt`)
  assert.equal(unknownType.status, 403)
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
      res.status === 200 || res.status === 404 || res.status === 422,
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
  assert.equal(driveBy.status, 403)
  const stillServing = await rawGet(`${base}/index.html`)
  assert.equal(stillServing.status, 200, 'sidecar died on a cross-origin proposal request')

  // The list route has always guarded its parse; the read route now matches it.
  const list = await rawGet(`${base}/api/proposals`)
  assert.equal(list.status, 422)
  assert.match(list.json().error, /snapshot cannot be read/)

  fs.writeFileSync(path.join(proposalsDir, 'events.ndjson'), '{partial\n', { mode: 0o600 })
  const corruptLedger = await rawGet(`${base}/api/proposals`)
  assert.equal(corruptLedger.status, 422)
  assert.equal(corruptLedger.json().diagnostics[0].code, 'ledger-json-invalid')
  assert.equal((await rawGet(`${base}/api/health`)).status, 200)
})

test('local sidecar requires a generated manifest and loopback listen host', async (t) => {
  const withoutManifest = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-no-manifest-'))
  fs.writeFileSync(path.join(withoutManifest, 'index.html'), '<title>Unbound</title>\n')
  t.after(() => fs.rmSync(withoutManifest, { recursive: true, force: true }))
  assert.throws(() => createAtelierSidecarServer({ workspaceRoot: withoutManifest }), /atelier\.manifest\.json/)

  const workspaceRoot = makeWorkspace()
  const sidecar = createAtelierSidecarServer({ workspaceRoot })
  t.after(async () => {
    await sidecar.close()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  await assert.rejects(() => sidecar.listen(0, '0.0.0.0'), /non-loopback listen host refused/)
})

test('publication manifests refuse malformed, hidden, unavailable, and symlink-enrolled paths', (t) => {
  function fixture(manifest, files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-manifest-invalid-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.writeFileSync(path.join(root, 'index.html'), '<title>Atelier</title>\n')
    for (const [relative, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
      fs.writeFileSync(path.join(root, relative), contents)
    }
    fs.writeFileSync(path.join(root, 'atelier.manifest.json'), typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest)}\n`)
    return root
  }

  const valid = { schema: 'mnstry.atelier-manifest@v1', entry: 'index.html' }
  for (const [label, manifest, files, expected] of [
    ['invalid JSON', '{', {}, /valid JSON/],
    ['invalid schema', { ...valid, schema: 'unsupported' }, {}, /schema must be/],
    ['non-string entry', { ...valid, entry: 7 }, {}, /entry must be/],
    ['non-HTML entry', { ...valid, entry: 'index.svg' }, { 'index.svg': '<svg></svg>' }, /entry must be an HTML/],
    ['non-array files', { ...valid, files: {} }, {}, /files must be an array/],
    ['non-array assets', { ...valid, assets: {} }, {}, /assets must be an array/],
    ['hidden file', { ...valid, assets: ['.draft.html'] }, { '.draft.html': '<title>Draft</title>' }, /hidden, state, or secret-shaped/],
    ['state file', { ...valid, assets: ['.atelier-presence.json'] }, { '.atelier-presence.json': '{}' }, /hidden, state, or secret-shaped/],
    ['credential-shaped file', { ...valid, assets: ['credential-note.html'] }, { 'credential-note.html': '<title>Note</title>' }, /hidden, state, or secret-shaped/],
    ['unsupported type', { ...valid, assets: ['data.txt'] }, { 'data.txt': 'text' }, /unsupported static file type/],
    ['unavailable file', { ...valid, assets: ['missing.html'] }, {}, /enrolled path is unavailable/],
  ]) {
    const root = fixture(manifest, files)
    assert.throws(() => loadPublishedWorkspaceManifest(root), expected, label)
    assert.throws(() => createAtelierSidecarServer({ workspaceRoot: root }), expected, `${label} must block server startup`)
  }

  const symlinkRoot = fixture(valid)
  fs.symlinkSync(path.join(symlinkRoot, 'index.html'), path.join(symlinkRoot, 'linked.html'))
  fs.writeFileSync(path.join(symlinkRoot, 'atelier.manifest.json'), `${JSON.stringify({ ...valid, assets: ['linked.html'] })}\n`)
  assert.throws(() => loadPublishedWorkspaceManifest(symlinkRoot), /must not be a symlink/)

  const escapingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-manifest-link-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-manifest-outside-'))
  t.after(() => fs.rmSync(escapingRoot, { recursive: true, force: true }))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(escapingRoot, 'index.html'), '<title>Atelier</title>\n')
  fs.writeFileSync(path.join(outside, 'manifest.json'), `${JSON.stringify(valid)}\n`)
  fs.symlinkSync(path.join(outside, 'manifest.json'), path.join(escapingRoot, 'atelier.manifest.json'))
  assert.throws(() => loadPublishedWorkspaceManifest(escapingRoot), /realpath escapes/)
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
