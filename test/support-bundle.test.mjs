import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildSupportBundlePreview,
  validateSupportBundlePayload,
} from '../src/support/support-bundle.mjs'

const fixtureRoot = new URL('../fixtures/support/', import.meta.url)

// PEM headers are assembled at runtime and never written as literals: the
// repo-wide disclosure checker scans every tracked file for exactly this shape,
// so a literal here would make this test file its own finding.
const DASHES = '-'.repeat(5)
const pemHeader = (...words) => `${DASHES}${['BEGIN', ...words].join(' ')}${DASHES}`

function bannedValueErrors(value) {
  return validateSupportBundlePayload({
    schema: 'mnstry.atelier-support-bundle-preview@v1',
    state: 'support_bundle',
    sendPath: false,
    background: false,
    telemetry: 'none',
    note: value,
  }).join('\n')
}

test('support bundle preview is local, hashable, and has no send path', () => {
  const payload = buildSupportBundlePreview({ state: 'support_bundle' })
  assert.equal(payload.schema, 'mnstry.atelier-support-bundle-preview@v1')
  assert.equal(payload.state, 'support_bundle')
  assert.equal(payload.telemetry, 'none')
  assert.equal(payload.sendPath, false)
  assert.equal(payload.background, false)
  assert.match(payload.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(validateSupportBundlePayload(payload), [])
})

test('support bundle none state carries no artifacts', () => {
  const payload = buildSupportBundlePreview({ state: 'none' })
  assert.equal(payload.state, 'none')
  assert.deepEqual(payload.artifacts, [])
  assert.deepEqual(validateSupportBundlePayload(payload), [])
})

test('support bundle rejects banned data classes and fixtures cover both sides', () => {
  const bad = {
    schema: 'mnstry.atelier-support-bundle-preview@v1',
    state: 'support_bundle',
    sendPath: false,
    promptText: 'copy this prompt',
    leaked: [
      '/home/operator/code/project-app/src/private.md',
      'project-app/private/item.md',
      'project-app:private-node',
      'git@github.com:owner/project.git',
      'person@example.com',
      'https://mnstry.example/support',
      'sk-test_secretsecret',
    ],
  }
  const errors = validateSupportBundlePayload(bad).join('\n')
  assert.match(errors, /banned key promptText/)
  assert.match(errors, /absolute-path/)
  assert.match(errors, /repo-file-path/)
  assert.match(errors, /kg-node-id/)
  assert.match(errors, /git-remote/)
  assert.match(errors, /email/)
  assert.match(errors, /hostname-or-url/)
  assert.match(errors, /secret/)

  for (const file of fs.readdirSync(new URL('valid/', fixtureRoot)).filter((name) => name.endsWith('.json'))) {
    const payload = JSON.parse(fs.readFileSync(new URL(`valid/${file}`, fixtureRoot), 'utf8'))
    assert.deepEqual(validateSupportBundlePayload(payload), [], `${file} should be safe`)
  }
  for (const file of fs.readdirSync(new URL('invalid/', fixtureRoot)).filter((name) => name.endsWith('.json'))) {
    const payload = JSON.parse(fs.readFileSync(new URL(`invalid/${file}`, fixtureRoot), 'utf8'))
    assert.notDeepEqual(validateSupportBundlePayload(payload), [], `${file} should fail`)
  }
})

test('the private-key pattern covers every real PEM header, not only bare PKCS#8', () => {
  // Reviewer demo: the pattern allowed exactly one word between BEGIN and KEY,
  // so ssh-keygen's default header and every algorithm-qualified header walked
  // through the scan untouched.
  const headers = [
    ['OPENSSH', 'PRIVATE', 'KEY'],
    ['RSA', 'PRIVATE', 'KEY'],
    ['EC', 'PRIVATE', 'KEY'],
    ['DSA', 'PRIVATE', 'KEY'],
    ['ENCRYPTED', 'PRIVATE', 'KEY'],
    ['SSH2', 'ENCRYPTED', 'PRIVATE', 'KEY'],
    ['PGP', 'PRIVATE', 'KEY', 'BLOCK'],
    ['PRIVATE', 'KEY'],
    // Bare forms the previous pattern happened to cover; kept so the widened
    // pattern is a strict superset.
    ['RSA', 'KEY'],
    ['OPENSSH', 'KEY'],
  ]
  for (const words of headers) {
    assert.match(bannedValueErrors(pemHeader(...words)), /banned value private-key at note/, words.join(' '))
  }
  assert.doesNotMatch(bannedValueErrors('the design doc explains where private keys are meant to live'), /private-key/)
})

test('a large address-shaped value is rejected promptly, not by backtracking', () => {
  // The email pattern's local part and domain runs were unbounded, so a few
  // hundred KB of address-shaped characters with no "@" backtracked for about
  // a minute — enough to stall any command that scans a capped attachment.
  // RFC 5321 bounds both parts, so real addresses are unaffected.
  assert.match(bannedValueErrors('reach me at person@example.com'), /banned value email at note/)
  assert.match(bannedValueErrors(`${'a'.repeat(64)}@example.com`), /banned value email at note/)
  // The bound is asserted by elapsed time on purpose: node:test's own timeout
  // option cannot interrupt a synchronous regex, so a reintroduced unbounded
  // pattern would stall here and still pass. Bounded it is single-digit
  // milliseconds against the minute the unbounded form took.
  const started = Date.now()
  assert.doesNotMatch(bannedValueErrors('ab.c-d_'.repeat(37449)), /banned value email/)
  assert.ok(Date.now() - started < 5000, `scanning a capped value took ${Date.now() - started}ms`)
})

test('the private-key pattern is bounded against header-shaped input', () => {
  // The widened pattern repeats a repeated group. Unbounded, that is
  // quadratic: 256 KiB of header-shaped text took about ten seconds to
  // reject, which the size cap alone would not have prevented — it is the
  // cap that made the worst case reachable. Bounded at four algorithm words
  // (real headers carry at most two) it is a couple of milliseconds.
  const headerShaped = 'BEGIN AAAA '.repeat(24000)
  const started = Date.now()
  assert.doesNotMatch(bannedValueErrors(headerShaped), /banned value private-key/)
  assert.ok(Date.now() - started < 5000, `scanning header-shaped input took ${Date.now() - started}ms`)
})
