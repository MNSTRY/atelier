import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

// Called by the existing consumer gate against its exact installed tarball.
export async function verifyInstalledReview({ installedRoot, consumerRoot }) {
  const work = fs.realpathSync(consumerRoot),
    adapter = path.join(work, 'review-adapter'),
    source = path.join(work, 'source-first')
  const cli = (args) =>
    execFileSync(
      process.execPath,
      [path.join(installedRoot, 'bin/atelier.mjs'), ...args],
      { cwd: work, encoding: 'utf8' },
    )
  const load = (relative) =>
    import(pathToFileURL(path.join(installedRoot, relative)))
  cli(['init', '--template', 'external-project', '--target', adapter])
  fs.renameSync(path.join(adapter, 'source'), source)
  let flags = [
    '--project',
    path.join(adapter, 'atelier.project.json'),
    '--repo-path',
    `source=${source}`,
  ]
  for (const args of [
    ['config', 'check', '--explain'],
    ['extension-pack', 'validate'],
    ['graph'],
    ['project'],
    ['readiness'],
    ['lock', 'check'],
    ['review', 'packs'],
    ['dev', '--smoke', '--review'],
  ])
    cli([...args, ...flags])
  const declaration = JSON.parse(cli(['lock', 'provenance']))
  assert.equal(declaration.sourceVerified, false)
  assert.ok(declaration.inventory.digest)
  assert.throws(() =>
    cli(['lock', 'check', '--exact-source-required', ...flags]),
  )
  const runReport = JSON.parse(
    cli([
      'review',
      'run',
      'sample.readiness:contract-gate',
      '--answers',
      path.join(adapter, 'answers.example.json'),
      ...flags,
    ]),
  )
  const { commandProject } = await load('src/project/config.mjs'),
    { createReviewStore } = await load('src/collaboration/review-store.mjs'),
    { loadBoundRun, currentRunEligibility } = await load(
      'src/readiness-protocols/evidence.mjs',
    )
  let project = commandProject({ argv: flags, env: {} }),
    store = createReviewStore(project),
    bound = loadBoundRun(project, runReport.runId)
  assert.equal(bound.ok, true)
  const decision = {
    requestId: 'consumer-decision',
    kind: 'decision',
    targetId: bound.run.claims[0].claimId,
    expectedVersion: 0,
    reviewer: 'Example Reader',
    rationale: 'Inspected the source observation.',
    runId: bound.run.runId,
    evidenceDigest: bound.snapshot.digest,
    decision: 'accepted',
  }
  const original = fs.readFileSync(path.join(source, 'README.md'))
  assert.equal(store.contribute(decision).ok, true)
  assert.equal(store.contribute(decision).replayed, true)
  const doc = store.document('source', 'README.md'),
    anchor = doc.text.slice(0, 40)
  const response = {
    requestId: 'consumer-response',
    kind: 'response',
    targetId: 'opening',
    expectedVersion: 0,
    reviewer: 'Example Reader',
    repo: 'source',
    path: 'README.md',
    documentDigest: doc.digest,
    anchor,
    responseType: 'question',
    wording: 'What evidence could change this conclusion?',
  }
  assert.equal(store.contribute(response).ok, true)
  assert.equal(
    store.contribute({
      requestId: 'consumer-position',
      kind: 'position',
      targetId: 'reading-position',
      expectedVersion: 0,
      reviewer: 'Example Reader',
      repo: 'source',
      path: 'README.md',
      documentDigest: doc.digest,
      anchor,
      position: 0,
    }).ok,
    true,
  )
  assert.deepEqual(fs.readFileSync(path.join(source, 'README.md')), original)
  const handoff = JSON.parse(
    cli(['review', 'handoff', 'consumer-decision', ...flags]),
  )
  assert.equal(handoff.current, true)
  assert.equal(handoff.sourceChangesApplied, false)
  const second = path.join(work, 'source-second')
  fs.renameSync(source, second)
  flags = [
    '--project',
    path.join(adapter, 'atelier.project.json'),
    '--repo-path',
    `source=${second}`,
  ]
  project = commandProject({ argv: flags, env: {} })
  store = createReviewStore(project)
  assert.equal(store.records().records.length, 3)
  assert.equal(store.records().records[1].input.wording, response.wording)
  assert.equal(currentRunEligibility(project, bound), true)
  const policy = path.join(work, 'synthetic-disclosure.json')
  fs.writeFileSync(policy, JSON.stringify({ patterns: [] }))
  const bundle = path.join(work, 'inspection.json')
  cli([
    'review',
    'export',
    '--runs',
    bound.run.runId,
    '--responses',
    'consumer-response,consumer-position',
    '--denylist',
    policy,
    '--write',
    '--out',
    bundle,
    ...flags,
  ])
  const inspection = JSON.parse(cli(['review', 'inspect', bundle]))
  assert.equal(inspection.approvalAuthority, false)
  assert.equal(inspection.writes, false)
  fs.appendFileSync(
    path.join(second, 'README.md'),
    '\nA later source revision.\n',
  )
  assert.equal(
    store.contribute({
      ...decision,
      requestId: 'consumer-stale',
      expectedVersion: 1,
    }).status,
    409,
  )
  assert.equal(
    store.contribute({
      ...response,
      requestId: 'consumer-reassociate',
      expectedVersion: 1,
    }).status,
    409,
  )
  assert.equal(store.records().records.length, 3)
  console.log(
    '[consumer:review] installed starter, two source layouts, evidence, decisions, response/resume, stale refusal and inspection-only bundle passed',
  )
}
