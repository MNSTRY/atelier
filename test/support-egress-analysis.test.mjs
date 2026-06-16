import assert from 'node:assert/strict'
import test from 'node:test'
import { analysisDryRun } from '../src/analysis/analysis.mjs'
import { checkForbiddenEgress } from '../src/egress/forbidden-egress.mjs'
import { buildSupportBundlePreview, validateSupportBundlePayload } from '../src/support/support-bundle.mjs'

test('support, egress, and analysis adapter gates stay no-send and claim-only', () => {
  const support = buildSupportBundlePreview({ state: 'support_bundle' })
  assert.equal(support.sendPath, false)
  assert.equal(support.telemetry, 'none')
  assert.deepEqual(validateSupportBundlePayload(support), [])
  assert.deepEqual(checkForbiddenEgress(), [])
  const analysis = analysisDryRun()
  assert.equal(analysis.enabled, false)
  assert.equal(analysis.canonicalMutation, false)
  assert.match(analysis.output, /claim/)
})
