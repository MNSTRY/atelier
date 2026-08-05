import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runGraphCommand } from '../src/graph/graph.mjs'
import { runProjectCommand } from '../src/projection/project.mjs'
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

function sampleProject(t) {
  const sample = makeSampleProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])
  return { sample, project }
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
