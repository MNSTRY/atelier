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
  buildReadinessRun,
  buildTenantPacket,
  listProtocolRuns,
  runProtocol,
  readinessRunsDir,
  summarizeReadinessJourney,
  writeTenantPacket,
  writeReadinessRun,
} from '../src/readiness-protocols/runtime.mjs'
import { protocolById } from '../src/readiness-protocols/bundled-pack.mjs'
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

// These ordering cases need only the existing protocol evaluator and scratch-local run records, not a graph build.
function syntheticRun(project, { createdAt, label = 'Synthetic actor', complete = true } = {}) {
  const answers = { actors: [{
    displayName: label,
    ...(complete ? { localId: 'synthetic-actor', role: 'operator', sourceRef: 'source:readiness-notes', runtimeOwner: 'identity', ownerRationale: 'Owns the synthetic review.' } : {}),
  }] }
  return buildReadinessRun({ project, protocol: protocolById('mnstry.readiness:identity-map'), answers, createdAt })
}

function runProject(t) {
  const sample = makeSampleProject(t)
  return { config: { name: 'Synthetic readiness project' }, configDir: sample.dir, workspaceRoot: sample.dir }
}

test('journey and tenant packet choose creation time when generated run hashes sort in the opposite order', (t) => {
  const project = runProject(t)
  const candidates = Array.from({ length: 32 }, (_, index) => syntheticRun(project, {
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), label: `Synthetic actor ${index}`, complete: index % 2 === 0,
  }))
  let pair
  for (let index = 0; index < candidates.length - 1; index += 2) {
    if (candidates[index].runId > candidates[index + 1].runId) { pair = candidates.slice(index, index + 2); break }
  }
  assert.ok(pair, 'the deterministic generated fixture includes a hash order opposed to creation time')
  const [older, newer] = pair
  assert.equal(older.status, 'review-needed')
  assert.equal(newer.status, 'draft')
  writeReadinessRun(project, newer)
  writeReadinessRun(project, older)
  const listed = listProtocolRuns(project)
  assert.deepEqual(listed.map((run) => run.runId), [older.runId, newer.runId])
  for (const runs of [undefined, [newer, older], [older, newer]]) {
    const options = runs === undefined ? {} : { runs }
    const journey = summarizeReadinessJourney(project, options)
    assert.equal(journey.dimensions[0].status, 'draft')
    assert.deepEqual(journey.dimensions[0].sourceRefs, [`readiness-run:${newer.runId}`])
    assert.equal(buildTenantPacket(project, options).tenantCandidate, newer.answers.actors[0].displayName)
  }
  const supplied = [newer, older]
  assert.deepEqual(buildTenantPacket(project, { runs: supplied }), buildTenantPacket(project, { runs: [older, newer] }))
  assert.deepEqual(supplied, [newer, older], 'selection never sorts caller-owned arrays in place')
})

test('equal creation instants use runId as a deterministic tie-break, independent of timezone spelling or input order', (t) => {
  const project = runProject(t)
  const runs = [
    syntheticRun(project, { createdAt: '2026-01-02T00:00:00.000Z', label: 'First synthetic actor' }),
    syntheticRun(project, { createdAt: '2026-01-02T08:00:00+08:00', label: 'Second synthetic actor' }),
  ]
  const winner = [...runs].sort((left, right) => left.runId < right.runId ? -1 : 1).at(-1)
  for (const input of [runs, [...runs].reverse()]) {
    assert.deepEqual(summarizeReadinessJourney(project, { runs: input }).dimensions[0].sourceRefs, [`readiness-run:${winner.runId}`])
    assert.equal(buildTenantPacket(project, { runs: input }).tenantCandidate, winner.answers.actors[0].displayName)
  }
})

test('submillisecond creation fractions retain chronological order rather than collapsing into a runId tie', (t) => {
  const project = runProject(t)
  const earlier = { ...syntheticRun(project, { createdAt: '2026-01-02T00:00:00.0001Z', label: 'Earlier actor' }), runId: `readiness-run-${'f'.repeat(24)}` }
  const later = { ...syntheticRun(project, { createdAt: '2026-01-02T00:00:00.0002Z', label: 'Later actor' }), runId: `readiness-run-${'0'.repeat(24)}` }
  const runs = [later, earlier]
  assert.equal(buildTenantPacket(project, { runs }).tenantCandidate, 'Later actor')
  assert.deepEqual(summarizeReadinessJourney(project, { runs }).dimensions[0].sourceRefs, [`readiness-run:${later.runId}`])
})

test('invalid creation times refuse selection, construction and persistence instead of choosing a fallback run', (t) => {
  const project = runProject(t)
  const good = syntheticRun(project, { createdAt: '2026-01-02T00:00:00.000Z' })
  for (const createdAt of [undefined, null, 0, '', 'not-a-time', '2026-01-02', '2026-02-30T00:00:00Z', '2026-01-02T00:00:00', '2026-01-02T00:00:60Z']) {
    const invalid = { ...good, createdAt }
    for (const runs of [[good, invalid], [invalid, good]]) {
      assert.throws(() => summarizeReadinessJourney(project, { runs }), /invalid-readiness-run-created-at/)
      assert.throws(() => buildTenantPacket(project, { runs }), /invalid-readiness-run-created-at/)
    }
    if (createdAt !== undefined) assert.throws(() => syntheticRun(project, { createdAt }), /invalid-readiness-run-created-at/)
    assert.throws(() => writeReadinessRun(project, invalid), /invalid-readiness-run-created-at/)
  }
  assert.equal(fs.existsSync(readinessRunsDir(project)), false, 'refused writes create no run directory')
  const directory = readinessRunsDir(project)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, `${good.runId}.json`), JSON.stringify({ ...good, createdAt: 'invalid' }))
  assert.throws(() => listProtocolRuns(project), /invalid-readiness-run-created-at/)
})

test('conflicting copies of one run identity cannot let caller array order decide readiness', (t) => {
  const project = runProject(t)
  const original = syntheticRun(project, { createdAt: '2026-01-02T00:00:00Z' })
  const changed = { ...original, status: 'draft' }
  for (const runs of [[original, changed], [changed, original]]) {
    assert.throws(() => summarizeReadinessJourney(project, { runs }), /conflicting-readiness-run-id/)
    assert.throws(() => buildTenantPacket(project, { runs }), /conflicting-readiness-run-id/)
  }
})

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

test('extension-pack journey and packet contribution use the same chronological run selection', (t) => {
  const { project, registry } = packProject(t)
  const protocol = registry.protocolById(PACK_PROTOCOL_ID)
  const older = buildReadinessRun({ project, protocol, answers: packAnswers, createdAt: '2026-01-01T00:00:00Z' })
  const newer = buildReadinessRun({ project, protocol, answers: {}, createdAt: '2026-01-02T00:00:00Z' })
  for (const runs of [[newer, older], [older, newer]]) {
    assert.equal(summarizeReadinessJourney(project, { runs, registry }).packDimensions[0].status, 'draft')
    const packet = buildTenantPacket(project, { runs, registry })
    assert.equal(packet.ext['mnstry.atelier'].extensionPacks[0].protocols[0].status, 'draft')
    assert.ok(packet.exportBlockers.includes(`readiness-incomplete:${PACK_PROTOCOL_ID}`))
  }
})

test('advisory pack protocols report through the packet but never block export', (t) => {
  const { project, registry } = packProject(t, { gate: 'advisory' })
  const packet = buildTenantPacket(project, { registry })

  assert.ok(!packet.exportBlockers.includes(`readiness-incomplete:${PACK_PROTOCOL_ID}`))
  const contribution = packet.ext['mnstry.atelier'].extensionPacks[0].protocols[0]
  assert.equal(contribution.gate, 'advisory')
  assert.equal(contribution.status, 'missing')
})

test('tenant packet without a registry explains its legacy score', (t) => {
  const { project } = sampleProject(t)
  const packet = buildTenantPacket(project)
  assert.deepEqual(packet.ext['mnstry.atelier'].extensionPacks, [])
  assert.match(packet.ext['mnstry.atelier'].scoreMeaning, /not evidence confidence/)
})

test('readiness export dry-run carries pack blockers when built with a registry', (t) => {
  const { project, registry } = packProject(t, { gate: 'required' })

  const report = buildReadinessExportDryRun(project, { registry })

  const packBlocker = 'readiness-incomplete:sample.readiness:contract-gate'
  assert.equal(report.worstOperationStatus, 'blocked')
  assert.ok(
    report.blockers.includes(packBlocker),
    'an unfinished required pack protocol must block the export dry-run',
  )
  assert.ok(Array.isArray(report.tenantPacket.ext?.['mnstry.atelier']?.extensionPacks))
  assert.notEqual(report.tenantPacket.ext['mnstry.atelier'].extensionPacks.length, 0)

  const bare = buildReadinessExportDryRun(project)
  assert.ok(
    !bare.blockers.includes(packBlocker),
    'precondition: without a registry the pack blocker is invisible — the CLI must pass one',
  )
})


test('an explicit custom registry runs independently of bundled protocol selection', (t) => {
  const { project, registry } = packProject(t)
  const customProtocol = registry.protocolById(PACK_PROTOCOL_ID)
  const selectedRegistry = {
    protocolById(id) {
      return id === PACK_PROTOCOL_ID ? customProtocol : null
    },
  }

  const result = runProtocol(project, PACK_PROTOCOL_ID, {
    registry: selectedRegistry,
    answers: packAnswers,
    write: false,
    createProposal: false,
  })

  assert.equal(result.run.protocolId, PACK_PROTOCOL_ID)
  assert.equal(result.run.status, 'review-needed')
  assert.equal(result.run.score, 100)
  assert.deepEqual(result.run.blockers, [])
  assert.deepEqual(result.run.answers, packAnswers)
  assert.equal(result.file, null)
  assert.equal(result.proposal, null)
  assert.deepEqual(listProtocolRuns(project), [])

  // An explicit registry is authoritative: a miss must not silently select
  // a bundled protocol. Omitting the registry retains the existing default.
  assert.throws(() => runProtocol(project, 'identity-map', {
    registry: selectedRegistry,
    write: false,
    createProposal: false,
  }), /unknown readiness protocol/)
  assert.equal(runProtocol(project, 'identity-map', {
    write: false,
    createProposal: false,
  }).run.protocolId, 'mnstry.readiness:identity-map')
})
