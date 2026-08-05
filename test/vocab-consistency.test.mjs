import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_RUNTIME_TARGETS,
  LOCAL_AUDIENCES,
  OBJECT_CLASSES,
  RUNTIME_OWNERS,
  RUNTIME_VISIBILITIES,
} from '../src/export/atelier-export-contract.mjs'
import { VALID_AUDIENCES } from '../src/boundary/policy.mjs'
import { ATELIER_CONTEXT_SCHEMA } from '../src/server/local-sidecar.mjs'
import { ATELIER_CONTEXT_SCHEMA as CLIENT_CONTEXT_SCHEMA } from '../src/harness/context-client.mjs'
import { contextEnvelope } from '../src/harness/context.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function readContract(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', name), 'utf8'))
}

const exportSchema = readContract('atelier-export.v1.schema.json')
const claimSchema = readContract('atelier-claim.v1.schema.json')
const runSchema = readContract('atelier-readiness-run.v1.schema.json')
const protocolSchema = readContract('atelier-readiness-protocol.v1.schema.json')
const extensionPackSchema = readContract('atelier-extension-pack.v1.schema.json')
const semanticProfile = readContract('mnstry-atelier-semantic-profile.v1.json')

test('runtime target enums match ALLOWED_RUNTIME_TARGETS in every schema', () => {
  assert.deepEqual(
    protocolSchema.$defs.exportMapping.properties.target.enum,
    ALLOWED_RUNTIME_TARGETS,
    'readiness-protocol exportMapping.target enum diverged from ALLOWED_RUNTIME_TARGETS',
  )
  assert.deepEqual(
    extensionPackSchema.properties.exportMappings.items.properties.target.enum,
    ALLOWED_RUNTIME_TARGETS,
    'extension-pack exportMappings target enum diverged from ALLOWED_RUNTIME_TARGETS',
  )
})

test('export schema audience and visibility enums match the code constants', () => {
  assert.deepEqual(exportSchema.$defs.audience.enum, LOCAL_AUDIENCES)
  assert.deepEqual(exportSchema.$defs.visibility.enum, RUNTIME_VISIBILITIES)
})

test('export schema owner and object-class enums exactly equal the code constants', () => {
  // Exact equality, not subset: an appended enum member is a widening the
  // epoch forbids, and must fail here even though every document still passes.
  assert.deepEqual(exportSchema.$defs.runtimeOwnerName.enum, RUNTIME_OWNERS)
  assert.deepEqual(exportSchema.$defs.objectClass.enum, OBJECT_CLASSES)
})

test('boundary VALID_AUDIENCES set-equals LOCAL_AUDIENCES', () => {
  assert.deepEqual(new Set(VALID_AUDIENCES), new Set(LOCAL_AUDIENCES))
})

test('readiness-run claim providers form a superset of standalone claim providers', () => {
  const claimProviders = claimSchema.properties.provider.enum
  const runProviders = new Set(runSchema.$defs.claim.properties.provider.enum)
  assert.ok(
    runProviders.has('atelier-readiness'),
    'readiness-run claim provider enum must include atelier-readiness',
  )
  for (const provider of claimProviders) {
    assert.ok(runProviders.has(provider), `readiness-run claim provider enum missing ${provider}`)
  }
})

test('claim predicate enums are identical across the three declaring schemas', () => {
  const claimPredicates = claimSchema.properties.predicate.enum
  assert.deepEqual(runSchema.$defs.claim.properties.predicate.enum, claimPredicates)
  assert.deepEqual(protocolSchema.$defs.claimMapping.properties.claimPredicate.enum, claimPredicates)
})

test('atelier-context schema id is the same string in sidecar, client, and harness envelope', () => {
  assert.equal(ATELIER_CONTEXT_SCHEMA, CLIENT_CONTEXT_SCHEMA)
  const envelope = contextEnvelope({ config: { name: 'vocab-consistency' } }, {})
  assert.equal(envelope.schema, ATELIER_CONTEXT_SCHEMA)
})

test('semantic profile declares the normative allowedExportTargets list', () => {
  const found = []
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}/${index}`))
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'allowedExportTargets') found.push({ trail: `${trail}/${key}`, value })
        walk(value, `${trail}/${key}`)
      }
    }
  }
  walk(semanticProfile, '')
  assert.equal(found.length, 1, 'semantic profile must declare allowedExportTargets exactly once')
  assert.deepEqual(
    [...found[0].value].sort(),
    [...ALLOWED_RUNTIME_TARGETS].sort(),
    `semantic profile ${found[0].trail} diverged from ALLOWED_RUNTIME_TARGETS`,
  )
})
