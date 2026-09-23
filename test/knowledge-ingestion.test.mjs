import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createIngestionStore } from '../src/ingestion/store.mjs'
import { prepareIngestionContribution, localKnowledgeContext, localKnowledgeGraphProposal } from '../src/knowledge/ingestion.mjs'
import { harnessRef, appendHarness, EMPTY_HARNESS_HEAD, readHarness } from '../src/harnesses/index.mjs'

test('bounded ingestion reaches reviewed graph/context, and a source correction withholds only dependent activations', { skip: process.platform === 'win32' ? 'Harness writes require the qualified POSIX reference profile.' : false }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-knowledge-ingestion-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'first.txt'), 'The invented workshop opens at noon.\n')
  fs.writeFileSync(path.join(root, 'second.txt'), 'The invented workshop closes at dusk.\n')
  const workspaceId = 'workshop', store = createIngestionStore({ workspaceRoot: root, workspaceId })
  const plan = store.plan({ sources: [{ id: 'first', ref: 'first.txt' }, { id: 'second', ref: 'second.txt' }], scope: { project: 'workshop', activity: 'research' }, purpose: 'Find workshop hours.', budget: { maxInputBytes: 10000, maxOutputBytes: 20000, maxAttempts: 2 } })
  store.run({ planId: plan.planId, planDigest: plan.planDigest })
  const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url))).knowledge
  let head = EMPTY_HARNESS_HEAD
  const records = [], bindings = []
  function append(record) {
    head = appendHarness({ workspaceRoot: root, profile: 'knowledge', record, confirm: head }).head
    records.push(record); return record
  }
  append(fixture[0])
  const record = (kind, id, data) => ({ schema: 'atelier-knowledge-record@v1', run: records[0].id, kind, id, at: '2026-01-01T00:00:00Z', by: 'synthetic-owner', data })
  for (const sourceId of ['first', 'second']) {
    const prepared = prepareIngestionContribution({ workspaceRoot: root, workspaceId, records, planId: plan.planId, planDigest: plan.planDigest, sourceId, title: `Workshop ${sourceId}`, term: 'material' })
    bindings.push(prepared.sourceBinding)
    const c = append(record('contribution', sourceId, prepared.data))
    const e = append(record('evaluation', `${sourceId}-evaluation`, { ...fixture.find(r => r.kind === 'evaluation').data, contribution: harnessRef(c) }))
    const r = append(record('review', `${sourceId}-review`, { target: harnessRef(c), disposition: 'accepted', basis: 'Synthetic review of the source trace.', evaluations: [harnessRef(e)] }))
    append(record('activation', `${sourceId}-active`, { reviews: [harnessRef(r)], purpose: 'Retrieve hours.', destination: 'local-context', questions: ['return'] }))
  }
  const options = { workspaceRoot: root, workspaceId, records: readHarness({ workspaceRoot: root, profile: 'knowledge', run: records[0].id }).records, sourceBindings: bindings, query: 'workshop' }
  assert.deepEqual(localKnowledgeContext(options).hits.map(h => h.reference.id), ['first', 'second'])
  assert.ok(localKnowledgeGraphProposal({ ...options, namespace: 'sample', activationId: 'first-active' }).files.length)
  fs.writeFileSync(path.join(root, 'first.txt'), 'Corrected opening time.\n')
  const after = localKnowledgeContext(options)
  assert.deepEqual(after.hits.map(h => h.reference.id), ['second'])
  assert.ok(after.reconsider.some(r => r.id === 'first-active'))
  assert.throws(() => localKnowledgeGraphProposal({ ...options, namespace: 'sample', activationId: 'first-active' }), /current local sources/)
  assert.ok(localKnowledgeGraphProposal({ ...options, namespace: 'sample', activationId: 'second-active' }).files.length)
  assert.deepEqual(localKnowledgeContext({ ...options, sourceBindings: [] }).hits, [])
  assert.equal(readHarness({ workspaceRoot: root, profile: 'knowledge', run: records[0].id }).head, head)
})
