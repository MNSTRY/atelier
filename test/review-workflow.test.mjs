import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeSampleProject } from './helpers/sample-project.mjs'
import { commandProject } from '../src/project/config.mjs'
import { getBundledReadinessProtocol } from '../src/readiness-protocols/bundled-pack.mjs'
import { buildReadinessRun } from '../src/readiness-protocols/runtime.mjs'
import {
  recordReviewEvidence,
  currentRunEligibility,
} from '../src/readiness-protocols/evidence.mjs'
import { createReviewStore } from '../src/collaboration/review-store.mjs'
import { createProposalStore } from '../src/collaboration/proposals.mjs'
import { createCollaborationEventLedger } from '../src/collaboration/event-ledger.mjs'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'
import { buildGraph } from '../src/graph/graph.mjs'
import { renderReviewPage } from '../src/ui/review-page.mjs'

function setup(t) {
  const sample = makeSampleProject(t)
  const project = commandProject({
    argv: ['--project', sample.config],
    cwd: sample.dir,
    env: {},
  })
  const protocol = getBundledReadinessProtocol('offer-map')
  const answers = Object.fromEntries(
    protocol.inputFields.map((field) => [field.id, 'Synthetic answer']),
  )
  answers['offer.sourceRef'] = buildGraph(project).nodes[0].id
  const run = buildReadinessRun({ project, protocol, answers })
  const bound = recordReviewEvidence(project, run),
    store = createReviewStore(project)
  return { sample, project, run, bound, store }
}
test('decisions refuse stale evidence and versions, replay once, and survive compaction', (t) => {
  const { sample, project, run, bound, store } = setup(t)
  const decision = {
    requestId: 'decision-one',
    kind: 'decision',
    targetId: run.claims[0].claimId,
    expectedVersion: 0,
    reviewer: 'Sample Reader',
    rationale: 'Compared with source',
    runId: run.runId,
    evidenceDigest: bound.snapshot.digest,
    decision: 'accepted',
  }
  const saved = store.contribute(decision)
  assert.equal(saved.ok, true, saved.error)
  assert.equal(store.contribute(decision).replayed, true)
  assert.equal(
    store.contribute({ ...decision, rationale: 'different' }).status,
    409,
  )
  assert.equal(
    store.contribute({ ...decision, requestId: 'stale' }).status,
    409,
  )
  const next = {
    ...decision,
    requestId: 'decision-two',
    expectedVersion: 1,
    decision: 'rejected',
  }
  assert.equal(store.contribute(next).ok, true)
  assert.equal(store.handoff('decision-one').current, false)
  assert.equal(store.handoff('decision-one').supersededBy, 'decision-two')
  const ledger = createCollaborationEventLedger({
    workspaceRoot: sample.dir,
    ledgerPath: path.join(
      sample.dir,
      '.atelier-local/review/contributions.ndjson',
    ),
  })
  assert.equal(
    ledger.compact({
      now: '2099-01-01T00:00:00Z',
      retainDays: 1,
      retainPerAggregate: 2,
    }).ok,
    true,
  )
  assert.equal(createReviewStore(project).records().records.length, 2)
  assert.deepEqual(
    createProposalStore({ workspaceRoot: sample.dir }).listProposals()
      .proposals,
    [],
  )
  fs.appendFileSync(
    path.join(sample.dir, 'content/README.md'),
    '\nChanged evidence.\n',
  )
  assert.equal(currentRunEligibility(project, bound), false)
  assert.equal(
    store.contribute({
      ...next,
      requestId: 'changed-source',
      expectedVersion: 2,
    }).status,
    409,
  )
  const handoff = store.handoff('decision-one')
  assert.equal(handoff.sourceChangesApplied, false)
  assert.equal(handoff.current, false)
})
test('responses preserve wording and old revision; locked writes do not claim success', (t) => {
  const { sample, project, store } = setup(t),
    doc = store.document('content', 'README.md')
  assert.equal(doc.ok, true, doc.error)
  const input = {
    requestId: 'response-one',
    kind: 'response',
    targetId: 'passage-one',
    expectedVersion: 0,
    reviewer: 'Sample Reader',
    repo: 'content',
    path: 'README.md',
    documentDigest: doc.digest,
    anchor: doc.text.slice(0, 25),
    responseType: 'question',
    wording: 'What supports this?',
  }
  const lock = path.join(
    sample.dir,
    '.atelier-local/review/contributions.ndjson.lock',
  )
  fs.writeFileSync(lock, 'owned test lock')
  assert.equal(store.contribute(input).status, 423)
  fs.unlinkSync(lock)
  assert.equal(store.contribute(input).ok, true)
  assert.equal(
    createReviewStore(project).records().records[0].input.wording,
    input.wording,
  )
  fs.appendFileSync(
    path.join(sample.dir, 'content/README.md'),
    '\nNew revision.\n',
  )
  assert.equal(
    store.contribute({
      ...input,
      requestId: 'response-two',
      expectedVersion: 1,
    }).status,
    409,
  )
  assert.equal(store.document('content', '../atelier.project.json').ok, false)
  assert.equal(store.document('undeclared', 'README.md').ok, false)
})
test('review API preserves sidecar origin/nonce protection and opt-in', async (t) => {
  const { sample, project, run } = setup(t)
  const output = path.join(sample.dir, 'output')
  fs.mkdirSync(output)
  fs.writeFileSync(
    path.join(output, 'index.html'),
    '<h1>Synthetic workspace</h1>',
  )
  fs.writeFileSync(
    path.join(output, 'atelier.manifest.json'),
    JSON.stringify({
      schema: 'mnstry.atelier-manifest@v1',
      entry: 'index.html',
    }),
  )
  const server = createAtelierSidecarServer({
    workspaceRoot: output,
    reviewProject: project,
  })
  t.after(() => server.close())
  const address = await server.listen(),
    base = 'http://127.0.0.1:' + address.port
  const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin' }
  assert.equal(
    (
      await fetch(base + '/api/review/records', {
        headers: {
          Origin: 'https://example.invalid',
          'Sec-Fetch-Site': 'cross-site',
        },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await fetch(base + '/api/review/contributions', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  )
  for (const denied of [
    {},
    { Origin: 'https://example.invalid', 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-origin' },
  ])
    assert.equal(
      (
        await fetch(base + '/api/review/session', {
          method: 'POST',
          headers: { ...denied, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    )
  const session = await fetch(base + '/api/review/session', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json())
  assert.equal(session.ok, true)
  assert.match(session.mutationNonce, /^[a-f0-9]{64}$/)
  const invalid = await fetch(base + '/api/review/contributions', {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'X-Atelier-Nonce': session.mutationNonce,
    },
    body: '{}',
  })
  assert.equal(invalid.status, 400)
  const bound = await fetch(
    base + '/api/review/run?id=' + encodeURIComponent(run.runId),
    { headers },
  ).then((r) => r.json())
  assert.equal(bound.ok, true)
  assert.equal(bound.current, true)
  const page = await fetch(base + '/review', { headers }).then((r) => r.text())
  assert.match(page, /Recorded contributions/)
})
test('review browser script parses and restricts its computed request targets', (t) => {
  const sample = makeSampleProject(t),
    script = renderReviewPage().match(
      /<script type="module">([\s\S]*?)<\/script>/,
    )[1]
  const file = path.join(sample.dir, 'review-ui.mjs')
  fs.writeFileSync(file, script)
  const checked = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  })
  assert.equal(checked.status, 0, checked.stderr)
  assert.match(script, /url.startsWith\('\/api\/review\/'\)/)
  assert.doesNotMatch(script, /innerHTML/)
})
