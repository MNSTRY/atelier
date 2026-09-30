import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
export async function verifyInstalledKnowledgeIngestion({ installedRoot, consumerRoot }) {
  if (process.platform === 'win32') return
  const load = relative => import(pathToFileURL(path.join(installedRoot, relative)).href)
  const [ingestion, knowledge, harness, graph, project] = await Promise.all([
    'src/ingestion/store.mjs', 'src/knowledge/index.mjs', 'src/harnesses/index.mjs', 'src/graph/graph.mjs', 'src/project/config.mjs',
  ].map(load))
  const root = path.join(consumerRoot, 'knowledge-ingestion-consumer')
  fs.cpSync(path.join(installedRoot, 'fixtures/projects/sample-workspace'), root, { recursive: true })
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'research-return.txt'), 'An invented workshop opens at noon. This is a synthetic research return, not an external finding.\n')
  const store = ingestion.createIngestionStore({ workspaceRoot: root, workspaceId: 'research-workshop' })
  const plan = store.plan({ sources: [{ id: 'hours', ref: 'research-return.txt' }], scope: { project: 'workshop', activity: 'research' }, purpose: 'Find the reported opening hour.', budget: { maxInputBytes: 10000, maxOutputBytes: 20000, maxAttempts: 2 } })
  store.run({ planId: plan.planId, planDigest: plan.planDigest })
  const fixture = JSON.parse(fs.readFileSync(path.join(installedRoot, 'fixtures/harnesses/learning-cycle.json'))).knowledge
  const records = []; let head = harness.EMPTY_HARNESS_HEAD
  const append = record => { head = harness.appendHarness({ workspaceRoot: root, profile: 'knowledge', record, confirm: head }).head; records.push(record); return record }
  fixture[0].data.questions = [{ id: 'workshop', question: 'What opening hour does the source report?', acceptance: 'A reviewed source identifies the reported hour and its limits.' }]
  append(fixture[0])
  const prepared = knowledge.prepareIngestionContribution({ workspaceRoot: root, workspaceId: 'research-workshop', records, planId: plan.planId, planDigest: plan.planDigest, sourceId: 'hours', title: 'Reported workshop opening hour', term: 'material' })
  const contribution = append({ ...fixture[1], id: 'research-hours', data: prepared.data })
  const baseEvaluation = fixture.find(r => r.kind === 'evaluation')
  const evaluation = append({ ...baseEvaluation, id: 'hours-evaluation', data: { ...baseEvaluation.data, contribution: harness.harnessRef(contribution) } })
  const review = append({ ...fixture.find(r => r.kind === 'review'), id: 'hours-review', data: { target: harness.harnessRef(contribution), disposition: 'accepted', basis: 'Synthetic reviewer checked this source and purpose.', evaluations: [harness.harnessRef(evaluation)] } })
  const activation = append({ ...fixture.find(r => r.kind === 'activation'), id: 'hours-context', data: { reviews: [harness.harnessRef(review)], purpose: 'Answer the opening-hour question.', destination: 'local-context', questions: ['workshop'] } })
  const options = { workspaceRoot: root, workspaceId: 'research-workshop', records: harness.readHarness({ workspaceRoot: root, profile: 'knowledge', run: fixture[0].id }).records, sourceBindings: [prepared.sourceBinding], query: 'workshop' }
  assert.equal(knowledge.localKnowledgeContext(options).hits.length, 1)
  const proposal = knowledge.localKnowledgeGraphProposal({ ...options, namespace: 'research', activationId: activation.id })
  // Explicit receiving-fixture admission. The library supplies inert proposals;
  // this owner writes only its new disposable private graph-source files.
  for (const file of proposal.files) fs.writeFileSync(path.join(root, 'content', file.path), file.content, { flag: 'wx' })
  const config = project.resolveProjectConfig({ argv: [`--project=${path.join(root, 'atelier.project.json')}`], cwd: root })
  const built = graph.buildGraph(config)
  assert.deepEqual(built.errors, [])
  assert.ok(built.nodes.some(n => n.id === `research:knowledge-${fixture[0].id}-research-hours`))
  fs.writeFileSync(path.join(root, 'research-return.txt'), 'The reported opening hour was corrected.\n')
  assert.equal(knowledge.localKnowledgeContext(options).hits.length, 0)
  assert.throws(() => knowledge.localKnowledgeGraphProposal({ ...options, namespace: 'research', activationId: activation.id }), /current local sources/)
  assert.equal(harness.readHarness({ workspaceRoot: root, profile: 'knowledge', run: fixture[0].id }).head, head)
  console.log('[consumer:knowledge-ingestion] installed capture, durable review, active retrieval, explicit private graph admission and source-correction withholding passed; research and reviewer judgments are synthetic')
}
