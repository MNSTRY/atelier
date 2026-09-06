import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { commandProject } from '../src/project/config.mjs'
import {
  loadExtensionPacks,
  createProtocolRegistry,
  computePackDigest,
} from '../src/extension-packs/loader.mjs'
import { inspectPackLifecycle } from '../src/extension-packs/lifecycle.mjs'
import { runProtocol } from '../src/readiness-protocols/runtime.mjs'
import {
  recordReviewEvidence,
  currentRunEligibility,
  hashEvidence,
  loadBoundRun,
} from '../src/readiness-protocols/evidence.mjs'
import { createReviewStore } from '../src/collaboration/review-store.mjs'
import {
  prepareInspectionBundle,
  inspectBundle,
  writeInspectionBundle,
  readInspectionBundle,
} from '../src/collaboration/inspection-bundle.mjs'
import { validReviewArtifact } from '../src/collaboration/review-contracts.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
function setup(t) {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'atelier-external-review-'),
  )
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const adapter = path.join(dir, 'adapter'),
    result = spawnSync(
      process.execPath,
      [
        path.join(root, 'bin/atelier.mjs'),
        'init',
        '--template',
        'external-project',
        '--target',
        adapter,
      ],
      { encoding: 'utf8' },
    )
  assert.equal(result.status, 0, result.stderr)
  const source = path.join(dir, 'different-source')
  fs.renameSync(path.join(adapter, 'source'), source)
  const argv = [
    '--project',
    path.join(adapter, 'atelier.project.json'),
    '--repo-path',
    `source=${source}`,
  ]
  const project = commandProject({ argv, env: {} }),
    packs = loadExtensionPacks(project).packs,
    registry = createProtocolRegistry({ packs }),
    answers = read(path.join(adapter, 'answers.example.json'))
  const { run } = runProtocol(project, 'sample.readiness:contract-gate', {
    answers,
    registry,
    write: false,
    createProposal: false,
  })
  const bound = recordReviewEvidence(project, run),
    store = createReviewStore(project)
  return { dir, adapter, source, project, packs, run, bound, store, argv }
}
test('external starter refuses overwrite, binds moved source, and qualifies pack lifecycle', (t) => {
  const { adapter, project, packs, bound, store } = setup(t)
  const again = spawnSync(
    process.execPath,
    [
      path.join(root, 'bin/atelier.mjs'),
      'init',
      '--template',
      'external-project',
      '--target',
      adapter,
    ],
    { encoding: 'utf8' },
  )
  assert.notEqual(again.status, 0)
  assert.equal(bound.snapshot.claimEvidence[0].status, 'linked-source')
  assert.match(
    bound.snapshot.claimEvidence[0].resolved[0].excerpt,
    /observation/,
  )
  assert.equal(inspectPackLifecycle(project, packs).ok, true)
  const policyPath = path.join(adapter, 'pack-lifecycle.json'),
    original = read(policyPath)
  for (const change of [
    { status: 'deprecated' },
    { status: 'retired' },
    { compatibleRootVersions: ['0.0.0'] },
    { digest: 'sha256:' + '0'.repeat(64) },
  ]) {
    const policy = structuredClone(original)
    Object.assign(policy.packs[0], change)
    fs.writeFileSync(policyPath, JSON.stringify(policy))
    assert.equal(
      inspectPackLifecycle(project, packs).ok,
      change.status === 'deprecated',
    )
    assert.equal(currentRunEligibility(project, bound), false)
    assert.equal(loadBoundRun(project, bound.run.runId).ok, true)
  }
  fs.writeFileSync(policyPath, JSON.stringify(original))
  assert.equal(currentRunEligibility(project, bound), true)
  const config = structuredClone(project.config)
  delete config.ext['mnstry.atelier'].extensionPackLifecycle
  assert.equal(
    inspectPackLifecycle({ ...project, config }, packs).entries[0].status,
    'legacy-unqualified',
  )
  assert.equal(store.records().ok, true)
})
test('selected inspection bundles preserve attribution, refuse disclosure/tampering and never import approval', (t) => {
  const { dir, project, run, bound, store } = setup(t)
  const accepted = store.contribute({
    requestId: 'accepted-one',
    targetId: run.claims[0].claimId,
    kind: 'decision',
    expectedVersion: 0,
    reviewer: 'Example Reader',
    rationale: 'Inspected the cited observation.',
    runId: run.runId,
    evidenceDigest: bound.snapshot.digest,
    decision: 'accepted',
  })
  assert.equal(accepted.ok, true, accepted.error)
  const doc = store.document('source', 'README.md'),
    response = store.contribute({
      requestId: 'question-one',
      targetId: 'opening',
      kind: 'response',
      expectedVersion: 0,
      reviewer: 'Example Reader',
      repo: 'source',
      path: 'README.md',
      documentDigest: doc.digest,
      anchor: doc.text.slice(0, 30),
      wording: 'Which observation would change this conclusion?',
      responseType: 'question',
    })
  assert.equal(response.ok, true, response.error)
  assert.throws(
    () => prepareInspectionBundle(project, [run.runId]),
    /disclosure policy required/,
  )
  assert.throws(
    () =>
      prepareInspectionBundle(project, [run.runId], {
        denylistDocument: {
          patterns: [
            { pattern: 'Example Reader', label: 'synthetic withheld identity' },
          ],
        },
      }),
    /disclosure policy/,
  )
  const bundle = prepareInspectionBundle(project, [run.runId], {
    denylistDocument: { patterns: [] },
    responseIds: ['question-one'],
  })
  assert.equal(validReviewArtifact('bundle', bundle), true)
  const before = store.records(),
    file = path.join(dir, 'inspection.json')
  writeInspectionBundle(file, bundle)
  const report = readInspectionBundle(file)
  assert.equal(report.approvalAuthority, false)
  assert.equal(report.writes, false)
  assert.equal(report.responses[0].input.wording, response.record.input.wording)
  assert.deepEqual(store.records(), before)
  assert.throws(() => writeInspectionBundle(file, bundle))
  const tamper = structuredClone(bundle)
  tamper.members[0].value.run.score = 0
  assert.throws(() => inspectBundle(tamper), /digest/)
  const unknown = structuredClone(bundle)
  unknown.schema = 'atelier-inspection-bundle@v99'
  assert.throws(() => inspectBundle(unknown), /contract/)
  const duplicate = structuredClone(bundle)
  duplicate.members.push(duplicate.members[0])
  const { digest, ...body } = duplicate
  duplicate.digest = hashEvidence(body)
  assert.throws(() => inspectBundle(duplicate), /duplicate/)
  const link = path.join(dir, 'link.json')
  fs.symlinkSync(file, link)
  assert.throws(() => readInspectionBundle(link), /regular/)
  const truncated = path.join(dir, 'truncated.json')
  fs.writeFileSync(truncated, '{"schema":')
  assert.throws(() => readInspectionBundle(truncated))
})
test('contract schemas refuse authority and kind confusion in contribution input', () => {
  const input = {
    kind: 'response',
    requestId: 'sample',
    targetId: 'sample',
    expectedVersion: 0,
    reviewer: 'Example',
    repo: 'source',
    path: 'README.md',
    documentDigest: 'sha256:' + '0'.repeat(64),
    anchor: 'passage',
    responseType: 'question',
    wording: 'Why?',
  }
  assert.equal(validReviewArtifact('input', input), true)
  assert.equal(
    validReviewArtifact('input', { ...input, decision: 'accepted' }),
    false,
  )
  assert.equal(
    validReviewArtifact('input', { ...input, expectedVersion: -1 }),
    false,
  )
  assert.equal(validReviewArtifact('input', { ...input, reviewer: '' }), false)
})
test('pack replacement uses the existing lock migration and rollback preserves historical review', async (t) => {
  const { adapter, project, bound } = setup(t)
  const { writeAtelierLock, applyMigration, BASE_MIGRATIONS } = await import(
    '../src/upgrade/upgrade.mjs'
  )
  const files = [
      'atelier.project.json',
      'atelier.lock.json',
      'pack-lifecycle.json',
      'packs/sample-pack.v1.json',
      'packs/protocols/contract-gate.v1.json',
    ],
    saved = new Map(
      files.map((file) => [file, fs.readFileSync(path.join(adapter, file))]),
    )
  const config = read(path.join(adapter, files[0]))
  config.ext['mnstry.atelier'].extensionPacks[0].version = 'v2'
  fs.writeFileSync(path.join(adapter, files[0]), JSON.stringify(config))
  const pack = read(path.join(adapter, files[3]))
  pack.version = 'v2'
  fs.writeFileSync(path.join(adapter, files[3]), JSON.stringify(pack))
  // The existing lock mismatch gate prevents execution until explicit owner work.
  const changed = commandProject({
    argv: [
      '--project',
      path.join(adapter, files[0]),
      '--repo-path',
      `source=${project.repos[0].path}`,
    ],
    env: {},
  })
  assert.throws(() => loadExtensionPacks(changed), /lock/)
  fs.unlinkSync(path.join(adapter, 'atelier.lock.json'))
  const candidate = loadExtensionPacks(changed).packs[0],
    policy = read(path.join(adapter, 'pack-lifecycle.json'))
  policy.packs[0].version = candidate.version
  policy.packs[0].digest = candidate.digest
  policy.packs[0].migrationId = 'extension-pack-sync@0.2.0-alpha.0'
  fs.writeFileSync(
    path.join(adapter, 'pack-lifecycle.json'),
    JSON.stringify(policy),
  )
  applyMigration(
    changed,
    BASE_MIGRATIONS.find((entry) => entry.id === policy.packs[0].migrationId),
  )
  assert.equal(
    inspectPackLifecycle(changed, loadExtensionPacks(changed).packs).ok,
    true,
  )
  assert.equal(currentRunEligibility(changed, bound), false)
  assert.equal(
    loadBoundRun(changed, bound.run.runId).snapshot.protocol.version,
    'v1',
  )
  for (const [file, bytes] of saved)
    fs.writeFileSync(path.join(adapter, file), bytes)
  assert.equal(currentRunEligibility(project, bound), true)
})
