import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Serialized into the bare consumer: every Atelier import resolves through the
// installed export map. Neither source-checkout imports nor test seams are used.
async function templateJourney(installedRoot, root) {
  const { default: assert } = await import('node:assert/strict')
  const { default: fs } = await import('node:fs')
  const { default: path } = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { execFileSync } = await import('node:child_process')
  const { resolveProjectConfig } = await import('@mnstry/atelier/project')
  const { templateReference, validateTemplateDefinition, validateTemplateBinding, validateTemplateRelease, validateTemplateHost, validateTemplateDecision } = await import('@mnstry/atelier/templates')
  const { decisionRequestDigest } = await import('@mnstry/atelier/decisions')
  const { createTemplateProjectView } = await import('@mnstry/atelier/template-bindings')
  const { createSourceApply } = await import('@mnstry/atelier/obsidian/edits')
  const { createEditorAdapter } = await import('@mnstry/atelier/obsidian/publication')
  const { createMaintenanceEngine, createMaintenanceStateStore, ensureWorkspaceIdentity, workspaceStateRoot, protectedRoots, writeMachineSettings } = await import('@mnstry/atelier/obsidian')
  await assert.rejects(import('@mnstry/atelier/src/intake/read-scope.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  const profile = JSON.parse(fs.readFileSync(path.join(installedRoot, 'fixtures/templates/local-library.v1.json')))
  const version = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'))).version
  const projectDir = path.join(root, 'project'), repo = path.join(projectDir, 'library'), dataRoot = path.join(root, 'data')
  fs.mkdirSync(repo, { recursive: true })
  const put = (file, document) => fs.writeFileSync(file, JSON.stringify(document))
  const note = (id, body) => `---\ntitle: "${id}"\nkg:\n  id: "library:${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${id}\n\n${body}\n`
  const paper = path.join(repo, 'paper.md'), thread = path.join(repo, 'thread.md')
  fs.writeFileSync(paper, note('paper', 'Three paper shapes share a table.'))
  fs.writeFileSync(thread, note('thread', 'Two colors remain independent.'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|MNSTRY_ATELIER_|NODE_OPTIONS$|NODE_PATH$)/.test(key)))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Synthetic Author', '-c', 'user.email=author@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, stdio: 'pipe' })
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'Synthetic library')
  execFileSync('git', ['init', '-q', projectDir], { env, stdio: 'pipe' })
  fs.writeFileSync(path.join(projectDir, '.gitignore'), '.atelier-local/\nlibrary/\natelier-output/\n')
  const configPath = path.join(projectDir, 'atelier.project.json')
  const scopeId = 'scope-library'
  put(configPath, {
    schema: 'mnstry.atelier-project-config@v1', name: 'template-consumer', roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'library', path: 'library', readBoundary: 'team' }],
    ext: { 'mnstry.atelier.obsidian': { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [{ scopeId, mode: 'full', selector: { all: true } }] } },
  })
  put(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: { library: { readBoundary: 'team' } } })
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  const view = (extra = {}) => createTemplateProjectView(loadProject(), JSON.stringify({ profile, projectRef: 'sample.project', roleNodeIds: { items: ['library:paper', 'library:thread'] }, target: 'local', ...extra }))
  const inventory = () => {
    const result = {}
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), name = path.relative(projectDir, file)
      if (entry.isDirectory()) { result[name] = 'directory'; walk(file) }
      else result[name] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    } }
    walk(projectDir); return result
  }
  const original = inventory(), before = view()
  assert.equal(validateTemplateDefinition(profile).ok, true)
  assert.equal(before.ok, true, JSON.stringify(before))
  assert.equal(validateTemplateBinding(profile, before.binding, before.records).ok, true)
  assert.match(before.html, /Three paper shapes/)
  assert.equal(before.artifacts.web, before.artifacts.documents)
  assert.equal(before.executionAuthority, false)
  assert.equal(before.publicationAuthority, false)
  assert.equal(view({ target: 'public' }).ok, false)
  assert.deepEqual(inventory(), original)
  assert.deepEqual(before.optionalDecisions, [{ id: 'reading-priority', status: 'absent', fallback: 'deterministic-or-manual', invocationAuthorized: false }])
  const request = { schema: 'atelier-decision-request@v1', id: 'sample', task: 'reading-priority', rubricVersion: 'v1', scope: { workspaceId: 'sample', authorizationRef: 'scope-synthetic' }, state: 'Synthetic text', evidence: [{ id: 'a', sourceRef: 'source:a' }], questions: { relevant: { type: 'boolean', instructions: 'Is it relevant?', criteria: { true: 'Relevant', false: 'Unrelated' }, evidenceIds: ['a'] } } }
  const result = { schema: 'atelier-decision-result@v1', requestId: request.id, requestDigest: decisionRequestDigest(request), task: request.task, rubricVersion: request.rubricVersion, scope: request.scope, provider: { id: 'synthetic', model: 'synthetic' }, authority: 'proposal-only', mode: 'advisory', elapsedMs: 0, usage: null, status: 'abstained', reason: 'provider-unavailable', answers: {} }
  assert.equal(validateTemplateDecision(profile, 'reading-priority', request, result).ok, true)
  assert.equal(validateTemplateDecision(profile, 'reading-priority', request, { ...result, authority: 'accepted' }).ok, false)
  const records = structuredClone(before.records)
  const record = (kind, id, document) => { const ref = templateReference(kind, id, '1.0.0', document); records.push({ ref, document }); return ref }
  const policyRef = record('PolicyRef', 'policy.synthetic', { posture: 'synthetic-only' })
  const decisionRef = record('AuthorityDecisionRef', 'decision.synthetic', { authority: 'no-real-approval' })
  const capabilityRef = record('CapabilityRef', 'capability.synthetic', { proof: 'synthetic-declaration-only' })
  const projectionRefs = ['web', 'documents'].map(carrier => record('ProjectionRef', `projection.${carrier}`, {
    schema: 'atelier-template-projection@v1', id: `projection.${carrier}`, version: '1.0.0', templateRef: before.templateRef, bindingRef: before.bindingRef, carrier,
    sourceRefs: before.records.map(item => item.ref), policyRefs: [policyRef], authorityDecisionRefs: [decisionRef], capabilityRef,
    payloadRef: record('PayloadRef', `payload.${carrier}`, { text: before.artifacts[carrier] }),
  }))
  const release = { schema: 'atelier-template-release@v1', id: 'release.synthetic', version: '1.0.0', templateRef: before.templateRef, bindingRef: before.bindingRef, projectionRefs }
  const releaseCheck = validateTemplateRelease(profile, before.binding, release, records)
  assert.equal(releaseCheck.ok, true, JSON.stringify(releaseCheck))
  assert.equal(releaseCheck.publicationAuthority, false)
  assert.equal(validateTemplateRelease(profile, before.binding, { ...release, projectionRefs: projectionRefs.slice(0, 1) }, records).ok, false)
  const host = { schema: 'atelier-template-host@v1', templateRef: templateReference('TemplateRef', profile.id, profile.version, profile), carrier: 'web', atelierVersion: version, packRefs: [], semanticPrimitives: ['Resource'], surfacePrimitives: ['CollectionView', 'StatusView'], runtimeProfileRef: null, optionalDecisions: [] }
  for (const status of ['absent', 'disabled', 'unqualified']) {
    const checked = validateTemplateHost(profile, { ...host, optionalDecisions: [{ id: 'reading-priority', status, capabilityRef: null }] })
    assert.equal(checked.ok, true, JSON.stringify(checked))
    assert.equal(checked.diagnostics.find(item => item.id === 'reading-priority').invocationAuthorized, false)
  }
  if (!['darwin', 'linux'].includes(process.platform)) {
    const { prepareTemplateUpgrade } = await import('@mnstry/atelier/upgrade')
    assert.throws(() => prepareTemplateUpgrade({ project: loadProject(), profileFile: 'profile.json', selectionFile: 'selection.json' }), /host is unsupported/)
    assert.deepEqual(inventory(), original)
    console.log('[consumer:templates] installed binding, fallback and audience refusal passed; source apply not exercised on unsupported atomic-exchange host')
    return
  }
  let now = Date.parse('2026-01-05T10:00:00.000Z')
  const clock = () => new Date(now), project = loadProject()
  const { workspaceId } = ensureWorkspaceIdentity({ project })
  const workspaceRoot = workspaceStateRoot(dataRoot, workspaceId)
  writeMachineSettings({ workspaceRoot, workspaceId, repositoryRoots: protectedRoots(project), settings: { schema: 'atelier-obsidian-machine-settings/v1', workspaceId, applyPolicy: null, maintenanceMode: 'manual', audienceAllow: ['team'], updatedAt: clock().toISOString() } })
  const engine = createMaintenanceEngine({ loadProject, dataRoot, clock, env, quietPeriodMs: 0, adapterFactory: () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' }) })
  const currentManifest = () => {
    const dir = path.join(workspaceRoot, 'state', 'manifests', scopeId)
    return JSON.parse(fs.readFileSync(path.join(dir, JSON.parse(fs.readFileSync(path.join(dir, 'current.json'))).manifestFile)))
  }
  const noteFile = () => path.join(workspaceRoot, 'vaults', scopeId, currentManifest().notes.find(item => item.nodeId === 'library:paper').path)
  try {
    assert.equal((await engine.tick()).scopes[0].state, 'current')
    const untouched = fs.readFileSync(thread)
    fs.writeFileSync(noteFile(), fs.readFileSync(noteFile(), 'utf8').replace('Three paper shapes', 'Four paper shapes'))
    now += 1000
    assert.equal((await engine.tick()).scopes[0].state, 'held-for-your-edit')
    const edit = createMaintenanceStateStore({ workspaceRoot, workspaceId }).readPendingEdits().edits.find(item => item.identity.nodeId === 'library:paper' && item.closedAt === null)
    assert.ok(edit)
    const apply = createSourceApply({ loadProject, dataRoot, env, clock, quietPeriodMs: 0 })
    const command = { editId: edit.editId, mode: 'manual', actor: 'person-synthetic' }
    const applied = await apply.apply(command)
    assert.equal(applied.status, 'applied', JSON.stringify(applied))
    assert.match(fs.readFileSync(paper, 'utf8'), /Four paper shapes/)
    assert.deepEqual(fs.readFileSync(thread), untouched)
    const after = view()
    assert.equal(after.ok, true, JSON.stringify(after))
    assert.match(after.html, /Four paper shapes/)
    assert.match(after.textPreview, /Four paper shapes/)
    assert.notDeepEqual(before.bindingRef, after.bindingRef)
    assert.deepEqual(before.records[1].ref, after.records[1].ref)
    assert.equal(validateTemplateBinding(profile, before.binding, after.records).ok, false)
    assert.equal((await apply.apply(command)).code, 'already-applied')
    now += 1000; await engine.tick()
    now += 1000; assert.equal((await engine.tick()).scopes[0].state, 'current')
    assert.match(fs.readFileSync(noteFile(), 'utf8'), /Four paper shapes/)
    console.log('[consumer:templates] installed canonical binding, optional fallback, audience refusal, source apply, stale binding, idempotence and refreshed view passed; product-host acceptance remains separate')
  } finally { await engine.stop() }
}

export function verifyInstalledTemplates({ installedRoot, consumerRoot }) {
  const script = path.join(consumerRoot, 'template-smoke.mjs')
  fs.writeFileSync(script, `${templateJourney.toString()}\nawait templateJourney(${JSON.stringify(installedRoot)}, ${JSON.stringify(path.join(consumerRoot, 'template-proof'))})\n`)
  process.stdout.write(execFileSync(process.execPath, [script], { cwd: consumerRoot, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }))
}
