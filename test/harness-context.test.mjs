import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { atelierContextFlow, requestSessionNonce } from '../src/harness/context-client.mjs'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'

test('harness flow proves session-bound local context without direct write authority', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-harness-'))
  fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<!doctype html><title>Atelier</title>\n')
  fs.writeFileSync(path.join(workspaceRoot, 'atelier.manifest.json'), '{"schema":"mnstry.atelier-manifest@v1","entry":"index.html"}\n')
  const sidecar = createAtelierSidecarServer({ workspaceRoot })
  t.after(async () => {
    await sidecar.close()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  const address = await sidecar.listen()
  const base = `http://127.0.0.1:${address.port}`
  const sessionId = 'harness-session'
  const viewId = 'harness-view'

  const auth = await requestSessionNonce(base, { sessionId, viewId, path: 'index.html' })
  assert.match(auth.mutationNonce, /^[a-f0-9]{64}$/)

  const report = await atelierContextFlow(base, {
    sessionId,
    viewId,
    path: 'index.html',
    expectedWorkspaceId: auth.workspaceId,
  })
  assert.equal(report.ok, true)
  assert.equal(report.context.presence.authoritative, true)
  assert.equal(report.context.capabilities.directWrite, false)
  assert.equal(report.context.capabilities.applyEndpoint, null)
  assert.equal(report.capabilities.directWrite, false)
  assert.equal(report.capabilities.applyEndpoint, null)
})
