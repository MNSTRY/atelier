import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runGraphCommand } from '../src/graph/graph.mjs'
import { runProjectCommand } from '../src/projection/project.mjs'
import { createProtocolRegistry, loadExtensionPacks } from '../src/extension-packs/loader.mjs'
import {
  buildReadinessExportDryRun,
  buildTenantPacket,
  listProtocolRuns,
  runProtocol,
  summarizeReadinessJourney,
  writeTenantPacket,
} from '../src/readiness-protocols/runtime.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACK_FIXTURES = path.join(ROOT, 'fixtures', 'atelier-extension-pack', 'valid')
const PACK_PROTOCOL_ID = 'sample.readiness:contract-gate'

function sampleProject(t) {
  const sample = makeSampleProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])
  return { sample, project }
}

// Sample project with the committed sample.readiness pack declared in the
// tracked config; gate is adjustable so required/advisory semantics are both
// exercised against the same fixture.
function packProject(t, { gate = 'required' } = {}) {
  const sample = makeSampleProject(t)
  const packDoc = JSON.parse(fs.readFileSync(path.join(PACK_FIXTURES, 'sample-pack.v1.json'), 'utf8'))
  packDoc.protocols[0].gate = gate
  fs.mkdirSync(path.join(sample.dir, 'packs', 'protocols'), { recursive: true })
  fs.writeFileSync(path.join(sample.dir, 'packs', 'sample.readiness.v1.json'), `${JSON.stringify(packDoc, null, 2)}\n`)
  fs.copyFileSync(
    path.join(PACK_FIXTURES, 'protocols', 'contract-gate.v1.json'),
    path.join(sample.dir, 'packs', 'protocols', 'contract-gate.v1.json')
  )
  const config = JSON.parse(fs.readFileSync(sample.config, 'utf8'))
  config.ext = {
    'mnstry.atelier': {
      extensionPacks: [{ id: 'sample.readiness', version: 'v1', path: 'packs/sample.readiness.v1.json', enabled: true }],
    },
  }
  fs.writeFileSync(sample.config, `${JSON.stringify(config, null, 2)}\n`)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  const registry = createProtocolRegistry({ packs: loadExtensionPacks(project).packs })
  return { sample, project, registry }
}

const packAnswers = {
  scope: { name: 'Neutral scope', sourceRef: 'source:readiness-notes' },
}

test('readiness journey reports all bundled dimensions before protocol runs', (t) => {
  const { project } = sampleProject(t)
  const journey = summarizeReadinessJourney(project)

  assert.equal(journey.dimensions.length, 12)
  assert.equal(journey.ready, false)
  assert.equal(journey.score, 0)
  assert.equal(journey.nextProtocol, 'mnstry.readiness:identity-map')
  assert.ok(journey.dimensions.every((dimension) => dimension.status === 'missing'))
})

test('protocol run with missing answers reports blockers and does not mutate canonical graph', (t) => {
  const { project } = sampleProject(t)
  const beforeGraph = fs.readFileSync(project.graphPath, 'utf8')
  const result = runProtocol(project, 'mnstry.readiness:offer-map', { answers: { offer: { name: 'Draft Offer' } } })

  assert.equal(result.run.status, 'draft')
  assert.ok(result.run.blockers.includes('missing-answer:commitmentPath.steps[]'))
  assert.equal(fs.readFileSync(project.graphPath, 'utf8'), beforeGraph)
  assert.ok(result.file.includes(`${path.sep}.atelier-local${path.sep}readiness${path.sep}runs${path.sep}`))
  assert.equal(result.proposal.ok, true)
  assert.equal(result.proposal.record.proposal.authority.copyOnly, true)
})

test('complete protocol answers create proposed claims in ignored local state', (t) => {
  const { project } = sampleProject(t)
  const result = runProtocol(project, 'mnstry.readiness:identity-map', {
    answers: {
      actors: [{
        localId: 'actor-primary',
        role: 'facilitator',
        displayName: 'Primary facilitator',
        sourceRef: 'source:readiness-notes',
        runtimeOwner: 'identity',
        ownerRationale: 'Owns identity review.',
      }],
    },
  })

  assert.equal(result.run.status, 'review-needed')
  assert.equal(result.run.score, 100)
  assert.equal(result.run.safety.runtimeMutation, false)
  assert.equal(result.run.safety.canonicalWrites, false)
  assert.equal(result.run.safety.claimOnly, true)
  assert.ok(result.run.claims.length > 0)
  assert.ok(result.run.claims.every((claim) => claim.status === 'proposed' && claim.promoted === false))

  const runs = listProtocolRuns(project)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].runId, result.run.runId)
})

test('tenant packet and readiness export are draft-only and non-importable', (t) => {
  const { project } = sampleProject(t)
  runProtocol(project, 'mnstry.readiness:identity-map', {
    answers: {
      actors: [{
        localId: 'actor-primary',
        role: 'operator',
        displayName: 'Readiness operator',
        sourceRef: 'source:readiness-notes',
        runtimeOwner: 'identity',
        ownerRationale: 'Accountable for packet review.',
      }],
    },
  })

  const packet = buildTenantPacket(project)
  const file = writeTenantPacket(project, packet)
  const report = buildReadinessExportDryRun(project)

  assert.equal(packet.schema, 'mnstry.tenant-readiness-packet@v1')
  assert.ok(file.includes(`${path.sep}.atelier-local${path.sep}readiness${path.sep}packets${path.sep}`))
  assert.equal(report.accepted, true)
  assert.equal(report.importable, false)
  assert.equal(report.runtimeMutation, false)
  assert.equal(report.runtimeImport, false)
  assert.ok(report.blockers.includes('runtime-import-not-implemented'))
})

test('journey without a registry keeps bundled shape and empty pack arrays', (t) => {
  const { project } = packProject(t)
  const journey = summarizeReadinessJourney(project)

  assert.equal(journey.dimensions.length, 12)
  assert.deepEqual(journey.packDimensions, [])
  assert.deepEqual(journey.packs, [])
})

test('journey with a loaded pack keeps the twelve bundled dimensions and gains packDimensions', (t) => {
  const { project, registry } = packProject(t)
  const journey = summarizeReadinessJourney(project, { registry })

  assert.equal(journey.dimensions.length, 12)
  assert.equal(journey.score, 0)
  assert.equal(journey.ready, false)
  assert.equal(journey.nextProtocol, 'mnstry.readiness:identity-map')
  assert.deepEqual(journey.packs, [{ id: 'sample.readiness', version: 'v1', protocolCount: 1 }])
  assert.equal(journey.packDimensions.length, 1)

  const dimension = journey.packDimensions[0]
  assert.equal(dimension.key, PACK_PROTOCOL_ID)
  assert.equal(dimension.packId, 'sample.readiness')
  assert.equal(dimension.gate, 'required')
  assert.equal(dimension.protocolId, PACK_PROTOCOL_ID)
  assert.equal(dimension.title, 'Sample contract gate')
  assert.equal(dimension.status, 'missing')
  assert.equal(dimension.score, 0)
  assert.deepEqual(dimension.blockers, [`not-run:${PACK_PROTOCOL_ID}`])
  assert.deepEqual(dimension.sourceRefs, [])
  assert.deepEqual(dimension.proposedClaims, [])
})

test('runProtocol resolves a pack protocol by namespaced id only, and only through a registry', (t) => {
  const { project, registry } = packProject(t)

  assert.throws(() => runProtocol(project, PACK_PROTOCOL_ID), /unknown readiness protocol/)
  assert.throws(() => runProtocol(project, 'contract-gate', { registry }), /unknown readiness protocol/)

  const result = runProtocol(project, PACK_PROTOCOL_ID, { registry, answers: packAnswers })
  assert.equal(result.run.protocolId, PACK_PROTOCOL_ID)
  assert.equal(result.run.status, 'review-needed')
  assert.equal(result.run.score, 100)
  assert.deepEqual(result.run.blockers, [])
  assert.ok(result.run.claims.length > 0)

  const journey = summarizeReadinessJourney(project, { registry })
  assert.equal(journey.packDimensions[0].status, 'review-needed')
  assert.deepEqual(journey.packDimensions[0].sourceRefs, [`readiness-run:${result.run.runId}`])
})

test('tenant packet carries the generic pack contribution under ext and blocks on unfinished required gates', (t) => {
  const { project, registry } = packProject(t)

  let packet = buildTenantPacket(project, { registry })
  assert.ok(packet.exportBlockers.includes(`readiness-incomplete:${PACK_PROTOCOL_ID}`))
  assert.deepEqual(packet.ext['mnstry.atelier'].extensionPacks, [{
    id: 'sample.readiness',
    version: 'v1',
    protocols: [{
      protocolId: PACK_PROTOCOL_ID,
      gate: 'required',
      status: 'missing',
      score: 0,
      blockers: [`not-run:${PACK_PROTOCOL_ID}`],
      warnings: [],
      proposedClaims: [],
    }],
  }])

  const result = runProtocol(project, PACK_PROTOCOL_ID, { registry, answers: packAnswers })
  packet = buildTenantPacket(project, { registry })
  assert.ok(!packet.exportBlockers.includes(`readiness-incomplete:${PACK_PROTOCOL_ID}`))
  const contribution = packet.ext['mnstry.atelier'].extensionPacks[0].protocols[0]
  assert.equal(contribution.status, 'review-needed')
  assert.equal(contribution.score, 100)
  assert.deepEqual(contribution.proposedClaims, result.run.claims.map((claim) => claim.claimId))
})

test('advisory pack protocols report through the packet but never block export', (t) => {
  const { project, registry } = packProject(t, { gate: 'advisory' })
  const packet = buildTenantPacket(project, { registry })

  assert.ok(!packet.exportBlockers.includes(`readiness-incomplete:${PACK_PROTOCOL_ID}`))
  const contribution = packet.ext['mnstry.atelier'].extensionPacks[0].protocols[0]
  assert.equal(contribution.gate, 'advisory')
  assert.equal(contribution.status, 'missing')
})

test('tenant packet without a registry keeps an empty ext contribution', (t) => {
  const { project } = sampleProject(t)
  const packet = buildTenantPacket(project)
  assert.deepEqual(packet.ext, { 'mnstry.atelier': { extensionPacks: [] } })
})
