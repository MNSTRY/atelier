import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildSupportBundlePreview,
  validateSupportBundlePayload,
} from '../src/support/support-bundle.mjs'

const fixtureRoot = new URL('../fixtures/support/', import.meta.url)

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
