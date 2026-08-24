import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  LOCAL_COMPUTED_ALLOW_MARKER,
  TEST_FIXTURE_ALLOW_MARKER,
  checkForbiddenEgress,
  discoverForbiddenEgressScanFiles,
  forbiddenEgressFindingsForText,
} from '../src/egress/forbidden-egress.mjs'
import { checkForbiddenEgress as compatibilityCheckForbiddenEgress } from '../src/egress/check.mjs'

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-egress-'))
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test('legacy egress module delegates to the canonical scanner', () => {
  assert.equal(compatibilityCheckForbiddenEgress, checkForbiddenEgress)
})

test('egress check allows explicit local sidecar calls', () => {
  assert.deepEqual(
    forbiddenEgressFindingsForText("await fetch('http://127.0.0.1:8137/api/health')"),
    [],
  )
  assert.deepEqual(
    forbiddenEgressFindingsForText('await fetch("http://localhost:8137/api/health")'),
    [],
  )
  assert.deepEqual(
    forbiddenEgressFindingsForText("const ws = new WebSocket('ws://localhost:8137/events')"),
    [],
  )
  assert.deepEqual(
    forbiddenEgressFindingsForText('curl -s -m 2 http://127.0.0.1:8137/api/health'),
    [],
  )
})

test('egress check rejects non-localhost JS and shell egress primitives', () => {
  const findings = forbiddenEgressFindingsForText(`
    await fetch('https://mnstry.example/api/support')
    https.request({
      hostname: 'mnstry.example',
      path: '/support',
    })
    const ws = new WebSocket('wss://mnstry.example/socket')
    net.connect({ host: 'mnstry.example', port: 443 })
    dns.resolve('mnstry.example')
    curl https://mnstry.example/support
    nc mnstry.example 443
  `)
  assert.ok(findings.some((item) => item.type === 'non-localhost-fetch'))
  assert.ok(findings.some((item) => item.type === 'non-localhost-http-request'))
  assert.ok(findings.some((item) => item.type === 'websocket-egress'))
  assert.ok(findings.some((item) => item.type === 'net-connect-egress'))
  assert.ok(findings.some((item) => item.type === 'dns-egress'))
  assert.ok(findings.some((item) => item.type === 'shell-http-egress'))
  assert.ok(findings.some((item) => item.type === 'shell-socket-egress'))
})

test('egress check fails closed for computed primitives unless marked local-computed', () => {
  const findings = forbiddenEgressFindingsForText(`
    const u = base + path
    await fetch(u)
    http.request(options)
  `)
  assert.ok(findings.some((item) => item.type === 'fetch-unresolved'))
  assert.ok(findings.some((item) => item.type === 'http-request-unresolved'))

  const allowed = forbiddenEgressFindingsForText(`
    const u = new URL('/api/health', location.origin)
    // ${LOCAL_COMPUTED_ALLOW_MARKER}
    await fetch(u.href)
    const options = { hostname: url.hostname, port: url.port }
    // ${LOCAL_COMPUTED_ALLOW_MARKER}
    http.request(options)
  `)
  assert.deepEqual(allowed, [])
})

test('egress scan discovery covers package paths and scans shipped test-like directories', () => {
  const root = makeTempRoot()
  writeFile(path.join(root, 'src', 'server', 'safe.mjs'), "await fetch('http://127.0.0.1:8137/api/health')\n")
  writeFile(path.join(root, 'src', 'ui', 'shell.js'), "await fetch('/api/context')\n")
  writeFile(path.join(root, 'src', 'support', 'unsafe.mjs'), "await fetch('https://mnstry.example/support')\n")
  writeFile(path.join(root, 'src', 'runtime', 'test', 'shipped-unsafe.mjs'), "await fetch('https://mnstry.example/shipped')\n")
  writeFile(path.join(root, 'test', 'unsafe.test.mjs'), "await fetch('https://mnstry.example/test-only')\n")
  writeFile(path.join(root, 'scripts', 'guard.sh'), 'curl http://127.0.0.1:8137/api/health\n')
  writeFile(path.join(root, 'scripts', 'bad.sh'), 'curl https://mnstry.example/fleet\n')

  const rels = discoverForbiddenEgressScanFiles({ root }).map((file) => path.relative(root, file))
  assert.ok(rels.includes(path.join('src', 'server', 'safe.mjs')))
  assert.ok(rels.includes(path.join('src', 'ui', 'shell.js')))
  assert.ok(rels.includes(path.join('src', 'support', 'unsafe.mjs')))
  assert.ok(rels.includes(path.join('src', 'runtime', 'test', 'shipped-unsafe.mjs')))
  assert.ok(rels.includes(path.join('scripts', 'guard.sh')))
  assert.ok(!rels.includes(path.join('test', 'unsafe.test.mjs')))

  const findings = checkForbiddenEgress({ root })
  assert.deepEqual(
    findings.map((item) => `${item.file}:${item.type}`).sort(),
    [
      `${path.join('scripts', 'bad.sh')}:shell-http-egress`,
      `${path.join('src', 'runtime', 'test', 'shipped-unsafe.mjs')}:non-localhost-fetch`,
      `${path.join('src', 'support', 'unsafe.mjs')}:non-localhost-fetch`,
    ].sort(),
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('an explicit pack inventory is the scan boundary and refuses traversal', () => {
  const root = makeTempRoot()
  writeFile(path.join(root, 'src', 'safe.mjs'), 'export {}\n')
  writeFile(path.join(root, 'src', 'test', 'packed.mjs'), "await fetch('https://mnstry.example/packed')\n")
  writeFile(path.join(root, 'not-packed.mjs'), "await fetch('https://mnstry.example/unpacked')\n")

  const files = discoverForbiddenEgressScanFiles({
    root,
    files: ['src/safe.mjs', 'src/test/packed.mjs', 'not-packed.mjs', '../outside.mjs'],
  })
  assert.deepEqual(
    files.map((file) => path.relative(root, file)).sort(),
    ['not-packed.mjs', path.join('src', 'safe.mjs'), path.join('src', 'test', 'packed.mjs')].sort(),
  )
  const findings = checkForbiddenEgress({ root, files: ['src/safe.mjs', 'src/test/packed.mjs'] })
  assert.deepEqual(findings.map((finding) => finding.file), [path.join('src', 'test', 'packed.mjs')])
  fs.rmSync(root, { recursive: true, force: true })
})

test('marked test fixtures can contain non-local examples', () => {
  const marked = forbiddenEgressFindingsForText(
    `
      // ${TEST_FIXTURE_ALLOW_MARKER}
      await fetch('https://mnstry.example/fixture')
    `,
    { file: 'test/example.test.mjs' },
  )
  assert.deepEqual(marked, [])

  const packed = forbiddenEgressFindingsForText(
    `
      // ${TEST_FIXTURE_ALLOW_MARKER}
      await fetch('https://mnstry.example/fixture')
    `,
    { file: 'src/test/example.test.mjs', allowTestFixtures: false },
  )
  assert.equal(packed.some((finding) => finding.type === 'non-localhost-fetch'), true)
})
