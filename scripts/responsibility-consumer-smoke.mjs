import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export async function verifyInstalledResponsibilities({ installedRoot, consumerRoot }) {
  const load = relative => import(pathToFileURL(path.join(installedRoot, relative)).href)
  const [trackables, reflection, interaction, coordination, capabilities, learning] = await Promise.all([
    'src/trackables/store.mjs', 'src/reflection/index.mjs', 'src/interaction/index.mjs', 'src/coordination/index.mjs', 'src/capabilities/index.mjs', 'src/learning/store.mjs',
  ].map(load))
  const fixture = (profile, shape) => JSON.parse(fs.readFileSync(path.join(installedRoot, `fixtures/atelier-${profile}/${shape}/valid/document.json`)))
  const root = path.join(consumerRoot, 'responsibility-consumer'); fs.mkdirSync(root)
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  const definition = fixture('trackable', 'definition'), at = '2026-01-02T15:00:00Z'
  const store = trackables.createTrackableStore({ workspaceRoot: root, scope: 'workshop', actor: 'owner' })
  const execute = (operation, input) => store.execute({ schema: 'atelier-trackable-command@v1', requestId: `op-${store.snapshot().revision}`, expectedRevision: store.snapshot().revision, operation, input })
  execute('release', { definition }); execute('instantiate', { instanceId: 'practice', subject: 'participant', definitionDigest: trackables.releaseTrackable(definition).digest, effectiveAt: at })
  execute('record', { instanceId: 'practice', evidence: { id: 'session-result', source: { kind: 'session', ref: 'session:one', digest: `sha256:${'1'.repeat(64)}` }, occurredAt: at, assistance: 'assisted', result: 'completed', value: true } })
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(installedRoot, 'bin/atelier.mjs'), ...args], { cwd: root, encoding: 'utf8', input: JSON.stringify({ scope: 'workshop', actor: 'owner', instanceId: 'practice', at }) }))
  const view = cli('trackable', 'view')
  assert.equal(view.completedOccurrences, 1); assert.equal(view.abilityAssessed, false)
  const observation = fixture('interaction', 'observation'), assessment = fixture('interaction', 'assessment'), act = fixture('interaction', 'act'), policy = fixture('interaction', 'policy')
  assert.equal(reflection.prepareReflectiveAct({ assessment, observations: [observation], act }).deliverable, false)
  const context = { observations: [observation], assessments: [assessment], orientations: [] }
  const read = key => JSON.parse(fs.readFileSync(path.join(root, `${key.slice(7)}.json`)))
  const write = record => fs.writeFileSync(path.join(root, `${record.key.slice(7)}.json`), JSON.stringify(record))
  let sends = 0
  const host = { authorityId: 'local-conversation',
    async current() { return { policy, context, at, state: { floor: 'assistant', paused: false, busy: false, requestedReflection: true } } },
    async authorize() { return true },
    async reserve({ key, actDigest }) {
      const target = path.join(root, `${key.slice(7)}.json`)
      if (fs.existsSync(target)) return { created: false }
      fs.writeFileSync(target, JSON.stringify({ key, actDigest, authorityId: this.authorityId, status: 'reserved', deliveredText: '' }), { flag: 'wx' }); return { created: true }
    },
    async send({ key, act }) { sends++; write({ ...read(key), status: 'completed', deliveredText: act.text }) },
    async read(key) { return read(key) }, async interrupt({ key }) { write({ ...read(key), status: 'interrupted' }) },
  }
  const controller = interaction.createInteractionController({ authorityId: host.authorityId, host })
  assert.equal((await controller.deliver(act)).delivery.status, 'completed')
  assert.equal((await controller.deliver(act)).replayed, true); assert.equal(sends, 1)
  context.observations = [{ ...observation, status: 'withdrawn' }]
  assert.equal((await controller.deliver({ ...act, id: 'later' })).selection.selection, 'declined')
  const outcome = fixture('coordination', 'outcome')
  assert.equal(coordination.coordinationView({ records: [outcome], at }).completionVerified, false)

  // A scoped practice reaches the installed instruction adapter and is consumed
  // by an explicit local workflow. This is not proof that a model obeyed prose.
  if (process.platform !== 'win32') {
    const source = learning.createLearningStore({ workspaceRoot: root, workspaceId: 'workshop' })
    const actor = { id: 'owner', kind: 'human' }, scope = { project: 'workshop', activity: 'summary' }
    const step = (operation, input) => source.execute({ requestId: `learn-${source.snapshot().revision}`, expectedRevision: source.snapshot().revision, operation, input }, { actor }).record
    step('capture', { id: 'observation', signal: 'user-correction', text: 'An uncertainty was omitted.', interpretation: 'explicit', scope, source: { ref: 'manual-entry', digest: null } })
    const lesson = step('propose', { id: 'uncertainty', title: 'Retain uncertainty', principle: 'Retain uncertainty alongside the claim.', rationale: 'Readers need it to assess the recommendation.', exceptions: ['Do not invent uncertainty.'], evidenceIds: ['observation'], scope, artifact: { kind: 'instruction', name: 'uncertainty', content: 'Retain material uncertainty in summaries.' } })
    const decision = step('decide', { lessonId: lesson.id, lessonDigest: lesson.digest, verdict: 'accepted', reason: 'Use in summaries.' })
    step('activate', { id: 'activation', lessonId: lesson.id, lessonDigest: lesson.digest, decisionId: decision.id, harnessId: 'summary' })
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Local\nPreserve local terminology.\n')
    const options = { workspaceRoot: root, workspaceId: 'workshop', scope, harnessId: 'summary', lessonId: lesson.id, target: 'AGENTS.md', slot: 'uncertainty' }
    const plan = capabilities.planInstructionAdoption(options)
    capabilities.applyInstructionAdoption({ ...options, confirm: plan.digest })
    const actual = capabilities.consumeInstructionContext({ ...options, session: 'next-local-task' })
    assert.equal(actual.context.pin.lessonDigest, lesson.digest)
    assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /Preserve local terminology/)
    step('withdraw', { activationId: 'activation', reason: 'Reconsider this practice.' })
    assert.throws(() => capabilities.consumeInstructionContext({ ...options, session: 'later-task' }), /current scoped/)
  }
  console.log('[consumer:responsibilities] installed definition-to-record-to-CLI-view, reflective qualification, native file delivery/readback, coordination and scoped instruction context passed; product-host adoption remains separate')
}
