import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  MNSTRY_READINESS_PACK_SCHEMA,
  READINESS_PROTOCOL_IDS,
  READINESS_PROTOCOL_SLUGS,
  bundledReadinessPack,
  bundledMnstryReadinessPackV1,
  bundledReadinessProtocols,
  getBundledReadinessProtocol,
  protocolById,
} from '@mnstry/atelier/readiness-protocols'
import {
  ALLOWED_RUNTIME_TARGETS,
  RUNTIME_OWNERS,
} from '../src/export/atelier-export-contract.mjs'

const requiredSections = [
  'questions',
  'inputFields',
  'outputHints',
  'readinessRules',
  'claimMappings',
  'exportMappings',
]

const allowedClaimPredicates = new Set([
  'related',
  'supports',
  'supersedes',
  'implements',
  'depends_on',
  'evidences',
  'contradicts',
  'belongs_to',
])

test('bundled readiness pack exposes all v1 protocols for import', () => {
  assert.equal(MNSTRY_READINESS_PACK_SCHEMA, 'mnstry-readiness-pack@v1')
  assert.equal(bundledMnstryReadinessPackV1.schema, MNSTRY_READINESS_PACK_SCHEMA)
  assert.equal(bundledReadinessPack, bundledMnstryReadinessPackV1)
  assert.deepEqual(bundledMnstryReadinessPackV1.protocolIds, READINESS_PROTOCOL_IDS)
  assert.deepEqual(bundledMnstryReadinessPackV1.protocolSlugs, READINESS_PROTOCOL_SLUGS)
  assert.deepEqual(
    bundledReadinessProtocols.map((protocol) => protocol.id),
    READINESS_PROTOCOL_IDS
  )
  assert.deepEqual(
    bundledReadinessProtocols.map((protocol) => protocol.slug),
    READINESS_PROTOCOL_SLUGS
  )
  assert.equal(READINESS_PROTOCOL_IDS.length, 12)
  assert.equal(getBundledReadinessProtocol('runtime-readiness')?.id, 'mnstry.readiness:runtime-readiness')
  assert.equal(protocolById('mnstry.readiness:runtime-readiness')?.slug, 'runtime-readiness')
  assert.equal(getBundledReadinessProtocol('missing-protocol'), null)
})

test('each bundled readiness protocol has the required review sections', () => {
  const runtimeTargets = new Set(ALLOWED_RUNTIME_TARGETS)
  const runtimeOwners = new Set(RUNTIME_OWNERS)

  for (const protocol of bundledReadinessProtocols) {
    assert.match(protocol.id, /^mnstry\.readiness:[a-z][a-z0-9-]*$/)
    assert.ok(READINESS_PROTOCOL_SLUGS.includes(protocol.slug))
    assert.equal(typeof protocol.title, 'string')
    assert.equal(typeof protocol.purpose, 'string')
    assert.equal(protocol.outputs.runSchema, 'atelier-readiness-run@v1')
    assert.ok(Array.isArray(protocol.outputs.artifacts))
    assert.ok(protocol.outputs.artifacts.length > 0)
    assert.equal(typeof protocol.ui.agentPrompt, 'string')

    for (const section of requiredSections) {
      assert.ok(Array.isArray(protocol[section]), `${protocol.id}.${section} must be an array`)
      assert.ok(protocol[section].length > 0, `${protocol.id}.${section} must not be empty`)
    }

    for (const question of protocol.questions) {
      assert.equal(typeof question.prompt, 'string')
      assert.ok(Array.isArray(question.inputFields))
      assert.ok(question.inputFields.length > 0)
    }

    for (const field of protocol.inputFields) {
      assert.equal(typeof field.id, 'string')
      assert.equal(typeof field.required, 'boolean')
      assert.equal(typeof field.description, 'string')
    }

    for (const rule of protocol.readinessRules) {
      assert.ok(rule.id.startsWith(protocol.id), `${rule.id} must start with ${protocol.id}`)
      assert.ok(['info', 'warning', 'blocker'].includes(rule.severity))
      assert.equal(typeof rule.condition, 'string')
      assert.equal(typeof rule.remediation, 'string')
      assert.equal(typeof rule.failClosed, 'boolean')
    }

    for (const claimMapping of protocol.claimMappings) {
      assert.equal(claimMapping.target, 'atelier-claim@v1')
      assert.ok(allowedClaimPredicates.has(claimMapping.claimPredicate))
      assert.ok(Array.isArray(claimMapping.sourceFields))
      assert.equal(typeof claimMapping.evidence, 'string')
    }

    for (const exportMapping of protocol.exportMappings) {
      assert.ok(runtimeTargets.has(exportMapping.target), `${exportMapping.id} target must be export-contract compatible`)
      assert.ok(runtimeOwners.has(exportMapping.runtimeOwner), `${exportMapping.id} owner must be export-contract compatible`)
      assert.equal(typeof exportMapping.sourceField, 'string')
      assert.equal(typeof exportMapping.targetCollection, 'string')
    }

    assert.equal(protocol.safetyPosture.runtimeMutation, false)
    assert.equal(protocol.safetyPosture.externalEgress, false)
    assert.equal(protocol.safetyPosture.defaultVisibility, 'private')
    assert.equal(protocol.safetyPosture.authority, 'proposal-only')
    assert.equal(protocol.safetyPosture.reviewMode, 'static-inspection')
    assert.equal(protocol.safetyPosture.failClosedOnMissingEvidence, true)
    assert.ok(protocol.safetyPosture.refuses.includes('runtime writes'))
  }
})

test('bundled readiness pack stays neutral and package-safe', () => {
  const serialized = JSON.stringify(bundledMnstryReadinessPackV1)
  // Private name patterns live in the gitignored local denylist so this guard
  // enforces without the committed test disclosing what it protects.
  const denylistUrl = new URL('../release-denylist.local.json', import.meta.url)
  if (fs.existsSync(denylistUrl)) {
    for (const { pattern, flags = '', label } of JSON.parse(fs.readFileSync(denylistUrl, 'utf8')).patterns) {
      assert.doesNotMatch(serialized, new RegExp(pattern, flags), `pack must not contain ${label}`)
    }
  }
  assert.doesNotMatch(serialized, /\/Users\//)
  assert.doesNotMatch(serialized, /\.codex/)
  assert.doesNotMatch(serialized, /BEGIN (RSA|OPENSSH|PRIVATE) KEY/)
  assert.equal(bundledMnstryReadinessPackV1.packageSafe, true)
  assert.equal(bundledMnstryReadinessPackV1.safetyPosture.projectSpecificContent, false)
  assert.equal(bundledMnstryReadinessPackV1.safetyPosture.runtimeMutation, false)
  assert.equal(bundledMnstryReadinessPackV1.safetyPosture.externalEgress, false)
})
