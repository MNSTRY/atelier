import test from 'node:test'
import assert from 'node:assert/strict'
import { assessVaultPrivacy } from '../src/vault/privacy.mjs'
import { renderVaultHome } from '../src/vault/interface.mjs'
import { protectionEvidence } from './vault-privacy-fixture.mjs'
const context = { vault: 'sample-vault', publication: 'example-digest', phase: 'read', owner: { issuer: 'https://identity.example', subject: 'synthetic-author' } }
test('privacy evidence must cover every surface, identity, configuration and fresh publication', () => {
  assert.equal(assessVaultPrivacy(protectionEvidence(context), context).status, 'verified')
  const mutations = [e => { e.phase = 'before-upload' }, e => { e.owner = { ...context.owner, subject: 'other' } }, e => { e.vault = 'another-vault' }, e => { e.publication = 'old' }, e => { e.validUntil = 0 }, e => { e.checkedAt += 600000 }, e => { e.configuration.completeInventory = false }, e => { e.targets.pop() }, e => { e.targets[0].owner = 'denied' }, e => { e.targets[0].anonymous = 'error' }, e => { e.targets[0].otherUser = 'redirect' }, e => { e.targets[0].url = 'https://example.test/?credential=redacted' }]
  for (const mutate of mutations) { const evidence = protectionEvidence(context); mutate(evidence); assert.equal(assessVaultPrivacy(evidence, context).status, 'unknown') }
})
test('observed unauthorized content is an exposure, even if config inventory is incomplete', () => {
  const evidence = protectionEvidence(context)
  evidence.configuration.completeInventory = false
  evidence.targets[1].otherUser = 'content'
  assert.equal(assessVaultPrivacy(evidence, context).status, 'exposed')
})
test('vault shell escapes source metadata and search terms and has no script execution', () => {
  const html = renderVaultHome({ vault: 'sample-vault', revision: 1, manifest: [{ path: 'report.html', type: 'text/html' }], privacy: assessVaultPrivacy(protectionEvidence(context), context), query: '<script>example</script>' })
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /name="q"/)
  assert.match(html, /Skip to artifacts/)
})
