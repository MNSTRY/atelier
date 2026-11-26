import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { compileDisclosurePatterns } from '../../src/disclosure/content-scan.mjs'
import { bundledMnstryReadinessPackV1 } from '../../src/readiness-protocols/bundled-pack.mjs'

// Maintainer-only private-boundary check. Runs in `prepublishOnly` and CI's
// `secret-sweep` lane. Always fails closed when the private denylist is absent,
// empty, or malformed so fresh-clone `npm test` stays green for outside
// contributors without weakening release-time private-name enforcement.

function loadValidatedDenylist(rawEnv, denylistUrl) {
  let rawText = rawEnv
  if (!rawText) {
    if (!fs.existsSync(denylistUrl)) {
      throw new Error('release-denylist unavailable: provide ATELIER_DENYLIST_JSON or restore release-denylist.local.json')
    }
    rawText = fs.readFileSync(denylistUrl, 'utf8')
  }

  let doc
  try {
    doc = JSON.parse(rawText)
  } catch {
    throw new Error('release-denylist configuration error: invalid JSON')
  }

  if (!doc || !Array.isArray(doc.patterns) || doc.patterns.length === 0) {
    throw new Error('release-denylist configuration error: denylist must contain at least one pattern')
  }

  try {
    return compileDisclosurePatterns(doc.patterns)
  } catch {
    throw new Error('release-denylist configuration error: one or more patterns failed to compile')
  }
}

function assertPackClean(serialized, compiledRules) {
  for (const rule of compiledRules) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(serialized)) {
      assert.fail(`pack must not contain ${rule.label}`)
    }
  }
}

test('denylist loader rejects empty, malformed, and invalid-regex inputs without echoing secrets', () => {
  const missingUrl = new URL('../../nonexistent-denylist.local.json', import.meta.url)

  assert.throws(
    () => loadValidatedDenylist(undefined, missingUrl),
    /release-denylist unavailable/,
  )
  assert.throws(
    () => loadValidatedDenylist('{"patterns":[]}', missingUrl),
    /must contain at least one pattern/,
  )
  assert.throws(
    () => loadValidatedDenylist('{SECRET_TOKEN_CANARY', missingUrl),
    (err) => /invalid JSON/.test(err.message) && !err.message.includes('SECRET_TOKEN_CANARY'),
  )
  assert.throws(
    () => loadValidatedDenylist('{"patterns":[{"label":"canary","pattern":"[SECRET_REGEX_CANARY"}]}', missingUrl),
    (err) => /failed to compile/.test(err.message) && !err.message.includes('SECRET_REGEX_CANARY'),
  )

  const compiled = loadValidatedDenylist(
    JSON.stringify({ patterns: [{ label: 'synthetic-canary', pattern: 'synthetic_private_marker', flags: 'i' }] }),
    missingUrl,
  )
  assert.throws(
    () => assertPackClean('contains SYNTHETIC_PRIVATE_MARKER here', compiled),
    /pack must not contain synthetic-canary/,
  )
})

test('bundled readiness pack contains no private denylist matches (fail-closed)', () => {
  const serialized = JSON.stringify(bundledMnstryReadinessPackV1)
  const denylistUrl = new URL('../../release-denylist.local.json', import.meta.url)
  const compiled = loadValidatedDenylist(process.env.ATELIER_DENYLIST_JSON, denylistUrl)
  assertPackClean(serialized, compiled)
})
