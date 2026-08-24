import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-proposals-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Atelier</title>\n')
  return root
}

function fingerprint(file) {
  const stat = fs.statSync(file)
  return {
    hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

async function postJson(route, body, base, nonce = null) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      'Sec-Fetch-Site': 'same-origin',
      ...(nonce ? { 'X-Atelier-Nonce': nonce } : {}),
    },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json().catch(() => ({})) }
}

test('proposal lifecycle is nonce-protected, local, and copy-only', async (t) => {
  const workspaceRoot = makeWorkspace()
  const sourceFile = path.join(workspaceRoot, 'index.html')
  const before = fingerprint(sourceFile)
  const sidecar = createAtelierSidecarServer({ workspaceRoot })
  t.after(async () => {
    await sidecar.close()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  const address = await sidecar.listen()
  const base = `http://127.0.0.1:${address.port}`

  const unauthenticated = await postJson('/api/proposals', {
    sessionId: 'proposal-session',
    viewId: 'proposal-view',
    path: 'index.html',
    action: 'metadata.status',
  }, base)
  assert.equal(unauthenticated.response.status, 403)
  assert.match(unauthenticated.body.error, /nonce/i)

  const auth = await fetch(`${base}/api/session-auth?sessionId=proposal-session&viewId=proposal-view&path=index.html`, {
    headers: {
      Origin: base,
      'Sec-Fetch-Site': 'same-origin',
    },
  })
  const authBody = await auth.json()
  const nonce = authBody.mutationNonce

  const directWrite = await postJson('/api/proposals', {
    sessionId: 'proposal-session',
    viewId: 'proposal-view',
    path: 'index.html',
    action: 'apply.patch',
  }, base, nonce)
  assert.equal(directWrite.response.status, 409)
  assert.match(directWrite.body.error, /direct-write/i)

  const diff = [
    'diff --git a/index.html b/index.html',
    '--- a/index.html',
    '+++ b/index.html',
    '@@ -1 +1 @@',
    '-<title>Atelier</title>',
    '+<title>MNSTRY Atelier</title>',
  ].join('\n')
  const created = await postJson('/api/proposals', {
    sessionId: 'proposal-session',
    viewId: 'proposal-view',
    path: 'index.html',
    action: 'metadata.status',
    diff,
    proposal: {
      reason: 'review-only handoff',
    },
  }, base, nonce)
  assert.equal(created.response.status, 200)
  assert.equal(created.body.ok, true)
  assert.equal(created.body.proposal.status, 'proposed')
  assert.equal(created.body.proposal.storage.ignored, true)
  assert.equal(created.body.proposal.authority.directWrite, false)
  assert.equal(created.body.proposal.authority.applyEndpoint, null)
  assert.deepEqual(fingerprint(sourceFile), before)

  const id = created.body.proposal.id
  const prematureAccept = await postJson(`/api/proposals/${id}/review`, {
    status: 'accepted',
    reviewer: 'test',
  }, base, nonce)
  assert.equal(prematureAccept.response.status, 409)
  assert.match(prematureAccept.body.error, /proposed -> accepted/)

  const reviewed = await postJson(`/api/proposals/${id}/review`, {
    status: 'reviewed',
    reviewer: 'test',
    notes: 'metadata-only review',
  }, base, nonce)
  assert.equal(reviewed.response.status, 200)
  assert.equal(reviewed.body.proposal.status, 'reviewed')
  assert.equal(reviewed.body.copyable, undefined)

  const accepted = await postJson(`/api/proposals/${id}/review`, {
    status: 'accepted',
    reviewer: 'test',
    notes: 'accepted for normal editing',
  }, base, nonce)
  assert.equal(accepted.response.status, 200)
  assert.equal(accepted.body.proposal.status, 'accepted')
  assert.equal(accepted.body.copyable.directWrite, false)
  assert.equal(accepted.body.copyable.applyEndpoint, null)
  assert.equal(accepted.body.copyable.diff, diff)
  assert.match(accepted.body.copyable.agentInstructions, /normal repo editing/)
  assert.deepEqual(fingerprint(sourceFile), before)
  const ledgerPath = path.join(workspaceRoot, '.atelier-proposals', 'events.ndjson')
  const events = fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.deepEqual(events.map((event) => event.type), [
    'proposal-created',
    'proposal-reviewed',
    'proposal-reviewed',
  ])
  assert.equal(events.at(-1).version, 3)
  assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600)

  const page = await fetch(`${base}/proposals/${id}`)
  const pageText = await page.text()
  assert.equal(page.status, 200)
  assert.match(pageText, /Copy Handoff/)
  assert.match(pageText, /no browser apply endpoint/i)
})
