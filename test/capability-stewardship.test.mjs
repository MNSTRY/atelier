import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import * as capability from '../src/capabilities/index.mjs'
import { digest, jsonText, objectDigest } from '../src/capabilities/files.mjs'
import { buildKnowledgeGraph, REPO_ACCESS_SCHEMA } from '../src/graph/knowledge-graph.mjs'

const CLI = new URL('../bin/atelier.mjs', import.meta.url).pathname
const fixed = '2026-01-01T00:00:00.000Z'
for (const shape of ['package', 'release', 'adoption', 'state', 'plan', 'event', 'journal', 'notice']) {
  test(`capability ${shape} contract accepts its fixture and refuses undeclared authority`, () => {
    const read = lane => JSON.parse(fs.readFileSync(new URL(`../fixtures/atelier-capability-contract/${shape}/${lane}/document.json`, import.meta.url)))
    assert.deepEqual(capability.validateCapabilityDocument(read('valid'), shape), [])
    assert.match(capability.validateCapabilityDocument(read('invalid'), shape).join(' '), /additional property unexpectedAuthority/)
  })
}
function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-capability-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), typeof text === 'string' ? text : jsonText(text))
}
function repo(root, name = 'project') {
  const result = path.join(root, name)
  fs.mkdirSync(result)
  execFileSync('git', ['init', '-q', result])
  write(result, '.gitignore', '.atelier-local/\n')
  return result
}
function descriptor({ id = 'sample.publisher/research', version = '1.0.0', requirements = { tools: [], effects: ['read-workspace'] }, dependencies = [] } = {}) {
  return { schema: 'mnstry.atelier-capability-package@v1', id, version, title: 'Research preparation', summary: 'Prepare a bounded research question.', license: 'Apache-2.0', source: { repository: 'https://example.org/source', revision: 'example-revision' },
    capabilities: [{ id: 'inquiry', description: 'Turn a question into independent investigations.', inputs: ['Question and constraints'], outputs: ['Research brief'] }],
    skills: [{ id: 'inquire', name: 'research-inquire', path: 'skills/research-inquire', capabilities: ['inquiry'] }], hosts: ['codex-repo-v1', 'claude-repo-v1'], requirements, dependencies, evaluations: [{ id: 'fixture', kind: 'integration', path: 'evaluation.json', outcome: 'unknown' }], migrations: [], limitations: ['Fixture has no host execution evidence.'] }
}
function bundle(root, name = 'package', options = {}) {
  const directory = path.join(root, name)
  write(directory, 'capability-package.json', descriptor(options))
  write(directory, 'evaluation.json', { outcome: 'unknown', reason: 'No agent exercised this fixture.' })
  write(directory, 'skills/research-inquire/SKILL.md', '---\nname: research-inquire\ndescription: Prepare independent research questions when planning a research campaign.\n---\n\n# Inquiry\n\nRead [the contract](references/output.md).\n')
  write(directory, 'skills/research-inquire/references/output.md', '# Output\n\nRecord the question, constraints, disconfirming evidence and sources.\n')
  const release = capability.sealCapabilityRelease({ packageRoot: directory })
  return { directory, release }
}
function policy(release, { id = 'project', mode = 'managed', alias = 'research-inquire', hosts = ['codex-repo-v1', 'claude-repo-v1'] } = {}) {
  return { schema: 'mnstry.atelier-capability-adoption@v1', id, packages: [{ id: release.package.id, digest: release.digest, mode,
    bindings: mode === 'reference' || mode === 'retired' ? [] : hosts.map(host => ({ skill: 'inquire', host, alias })),
    allowedTools: [], allowedEffects: ['read-workspace'] }] }
}
function adopt(settings) {
  const plan = capability.planCapabilityAdoption(settings)
  assert.equal(plan.applyAllowed, true, plan.blockers.join('\n'))
  assert.deepEqual(capability.validateCapabilityDocument(plan, 'plan'), [])
  return capability.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest })
}
function event(state, { id = 'first-run', kind = 'exercise', session = 'session-one', outcome = 'passed', cause = 'unknown' } = {}) {
  const item = state.packages[0], binding = item.bindings[0]
  return { schema: 'mnstry.atelier-capability-event@v1', id, kind, package: item.id, releaseDigest: item.release.digest, generation: state.generation, binding: binding.target, bindingDigest: binding.digest, host: binding.host, session, observer: 'fixture-observer', outcome, cause, evidenceDigest: digest(id), at: fixed }
}

test('release integrity covers resources, identity and evidence; sealing never overwrites', t => {
  const root = sandbox(t), { directory, release } = bundle(root)
  assert.deepEqual(capability.verifyCapabilityRelease({ packageRoot: directory, expectedDigest: release.digest }), release)
  assert.throws(() => capability.sealCapabilityRelease({ packageRoot: directory }), /EEXIST/)
  write(directory, 'skills/research-inquire/references/output.md', 'Changed resource')
  assert.throws(() => capability.verifyCapabilityRelease({ packageRoot: directory }), /integrity mismatch/)
})

test('two repositories adopt alongside external skills on both host profiles; clean update and local customization diverge', t => {
  const root = sandbox(t), first = repo(root, 'first'), second = repo(root, 'second')
  const v1 = bundle(root), v2 = bundle(root, 'package-two', { version: '1.1.0' })
  for (const workspaceRoot of [first, second]) write(workspaceRoot, '.agents/skills/third-party/SKILL.md', 'Existing owner content')
  const one = { workspaceRoot: first, sources: [v1.directory], adoption: policy(v1.release, { id: 'first' }) }
  const two = { workspaceRoot: second, sources: [v1.directory], adoption: policy(v1.release, { id: 'second' }) }
  const firstInstall = adopt(one), secondInstall = adopt(two)
  for (const installation of [firstInstall, secondInstall]) assert.deepEqual(capability.validateCapabilityDocument(installation.state, 'state'), [])
  assert.equal(adopt(one).changed, false)
  assert.equal(capability.capabilityEvidenceStatus({ workspaceRoot: first }).packages[0].bindings[0].hostObserved, 'unknown')
  const hostEvent = event(firstInstall.state, { kind: 'host-observed' })
  capability.recordCapabilityEvent({ workspaceRoot: first, event: hostEvent })
  assert.equal(capability.capabilityEvidenceStatus({ workspaceRoot: first, session: 'session-one' }).packages[0].bindings[0].hostObserved, 'reported-passed')
  assert.equal(capability.capabilityEvidenceStatus({ workspaceRoot: first, session: 'session-two' }).packages[0].bindings[0].hostObserved, 'historical-or-other-session')
  fs.appendFileSync(path.join(second, '.agents/skills/research-inquire/SKILL.md'), '\nRepository-specific question.\n')
  const updatedTwo = { ...two, sources: [v2.directory], adoption: policy(v2.release, { id: 'second' }) }
  assert.match(capability.planCapabilityAdoption(updatedTwo).blockers.join(' '), /local-drift/)
  const customized = adopt({ ...two, adoption: policy(v1.release, { id: 'second', mode: 'customized' }) })
  assert.equal(customized.state.packages[0].mode, 'customized')
  assert.match(capability.planCapabilityAdoption(updatedTwo).blockers.join(' '), /customization-requires/)
  adopt({ ...one, sources: [v2.directory], adoption: policy(v2.release, { id: 'first' }) })
  assert.equal(capability.capabilityEvidenceStatus({ workspaceRoot: first, session: 'session-one' }).packages[0].bindings[0].hostObserved, 'historical-or-other-session')
  const fleet = capability.inspectCapabilityFleet({ workspaces: [first, second] })
  assert.deepEqual(fleet.repositories.map(entry => entry.status.packages[0].version), ['1.1.0', '1.0.0'])
  assert.equal(fleet.atomicAcrossRepositories, false)
  for (const workspaceRoot of [first, second]) assert.equal(fs.readFileSync(path.join(workspaceRoot, '.agents/skills/third-party/SKILL.md'), 'utf8'), 'Existing owner content')
})

test('multiple publishers coexist under explicit aliases and exact dependencies', t => {
  const root = sandbox(t), workspaceRoot = repo(root)
  const base = bundle(root, 'base', { id: 'other.publisher/review' })
  const dependent = bundle(root, 'dependent', { dependencies: [{ id: base.release.package.id, version: '1.0.0', digest: base.release.digest, optional: false, capabilities: ['inquiry'] }] })
  const adoption = policy(dependent.release)
  const settings = { workspaceRoot, adoption, sources: [dependent.directory, base.directory] }
  assert.match(capability.planCapabilityAdoption(settings).blockers.join(' '), /unsatisfied-dependency/)
  adoption.packages.push(policy(base.release, { alias: 'review-evidence' }).packages[0])
  const missingHost = structuredClone(adoption)
  missingHost.packages[1].bindings = missingHost.packages[1].bindings.filter(binding => binding.host === 'codex-repo-v1')
  assert.match(capability.planCapabilityAdoption({ ...settings, adoption: missingHost }).blockers.join(' '), /dependency-capability-not-bound.*claude-repo-v1/)
  adopt(settings)
  assert.equal(capability.inspectCapabilityAdoption({ workspaceRoot }).packages.length, 2)
  const collision = structuredClone(adoption)
  collision.packages[1].bindings[0].alias = 'research-inquire'
  assert.match(capability.planCapabilityAdoption({ ...settings, adoption: collision }).blockers.join(' '), /alias-collision|target-owned/)
})

test('reference mode preserves an existing skill; managed mode refuses ownership without consent', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  write(workspaceRoot, '.agents/skills/research-inquire/SKILL.md', 'External workflow')
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release, { mode: 'reference' }) }
  adopt(settings)
  assert.match(capability.planCapabilityAdoption({ ...settings, adoption: policy(pkg.release) }).blockers.join(' '), /unmanaged-collision/)
  assert.equal(fs.readFileSync(path.join(workspaceRoot, '.agents/skills/research-inquire/SKILL.md'), 'utf8'), 'External workflow')
})

test('plans bind repository, requirements, tool observations and source bytes', t => {
  const root = sandbox(t), workspaceRoot = repo(root), other = repo(root, 'other'), pkg = bundle(root, 'package', { requirements: { tools: ['research-tool'], effects: ['network'] } })
  const adoption = policy(pkg.release)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption }
  const blocked = capability.planCapabilityAdoption(settings)
  assert.match(blocked.blockers.join(' '), /tool-not-admitted/)
  assert.match(blocked.blockers.join(' '), /tool-not-observed/)
  assert.match(blocked.blockers.join(' '), /effect-not-admitted/)
  adoption.packages[0].allowedTools = ['research-tool']; adoption.packages[0].allowedEffects = ['network']
  settings.availableTools = ['research-tool']
  const plan = capability.planCapabilityAdoption(settings)
  assert.equal(plan.applyAllowed, true)
  assert.throws(() => capability.applyCapabilityAdoption({ ...settings, workspaceRoot: other, confirm: plan.planDigest }), /confirmation/)
  assert.throws(() => capability.applyCapabilityAdoption({ ...settings, availableTools: [], confirm: plan.planDigest }), /confirmation/)
  fs.appendFileSync(path.join(pkg.directory, 'evaluation.json'), ' ')
  assert.throws(() => capability.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest }), /integrity/)
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.agents')), false)
})

test('same publisher/version cannot be rebound to different bytes even after retirement', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  adopt(settings)
  adopt({ ...settings, sources: [], adoption: policy(pkg.release, { mode: 'retired' }) })
  const changed = bundle(root, 'different', { requirements: { tools: [], effects: [] } })
  assert.match(capability.planCapabilityAdoption({ ...settings, sources: [changed.directory], adoption: policy(changed.release) }).blockers.join(' '), /immutable-version-reused/)
  assert.match(capability.planCapabilityAdoption({ ...settings, adoption: { ...settings.adoption, packages: [] } }).blockers.join(' '), /explicit-retirement-required/)
})

test('retirement preserves previous bytes and refuses local drift', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  adopt(settings)
  const retired = adopt({ ...settings, sources: [], adoption: policy(pkg.release, { mode: 'retired' }) })
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.agents/skills/research-inquire')), false)
  assert.equal(fs.existsSync(path.join(workspaceRoot, retired.quarantine, '.agents/skills/research-inquire/SKILL.md')), true)
})

test('unsafe package links, resources and target ancestors are refused without touching external paths', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(workspaceRoot, '.agents'))
  assert.throws(() => capability.planCapabilityAdoption({ workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }), /redirected/)
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.symlinkSync(path.join(pkg.directory, 'evaluation.json'), path.join(pkg.directory, 'linked.json'))
  assert.throws(() => capability.verifyCapabilityRelease({ packageRoot: pkg.directory }), /symbolic link/)
  fs.unlinkSync(path.join(pkg.directory, 'linked.json'))
  write(pkg.directory, 'skills/research-inquire/references/output.md', '[Escaping dependency](../../../evaluation.json)')
  assert.throws(() => capability.prepareCapabilityRelease({ packageRoot: pkg.directory }), /escapes its bundle/)
})

test('existing steward lock and unignored private state block all adoption writes', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  const plan = capability.planCapabilityAdoption(settings)
  write(workspaceRoot, '.gitignore', '')
  assert.throws(() => capability.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest }), /ignored/)
  write(workspaceRoot, '.gitignore', '.atelier-local/\n')
  write(workspaceRoot, '.atelier-local/skill-steward/.operation.lock', 'legacy operation')
  assert.throws(() => capability.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest }), /EEXIST/)
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.agents')), false)
})

test('interruption leaves a blocking journal and recover restores the prior generation without deleting bundles', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  const initial = adopt(settings)
  const next = bundle(root, 'next', { version: '1.1.0' })
  fs.unlinkSync(path.join(next.directory, 'capability-release.json'))
  fs.appendFileSync(path.join(next.directory, 'skills/research-inquire/SKILL.md'), '\nChanged instructions.\n')
  next.release = capability.sealCapabilityRelease({ packageRoot: next.directory })
  const update = { ...settings, sources: [next.directory], adoption: policy(next.release) }
  const plan = capability.planCapabilityAdoption(update)
  const original = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(from).includes('/staged/.agents/skills/')) throw new Error('simulated installation interruption')
    return original(from, to)
  }
  try { assert.throws(() => capability.applyCapabilityAdoption({ ...update, confirm: plan.planDigest }), /interrupted/) }
  finally { fs.renameSync = original }
  assert.match(capability.planCapabilityAdoption(update).blockers.join(' '), /unfinished-transaction/)
  const recovery = capability.inspectCapabilityRecovery({ workspaceRoot })
  assert.equal(recovery.pending, true)
  assert.deepEqual(recovery.blockers, [])
  const result = capability.recoverCapabilityAdoption({ workspaceRoot, confirm: recovery.planDigest })
  assert.equal(result.recovered, true)
  assert.equal(result.state.generation, initial.state.generation)
  assert.equal(capability.inspectCapabilityRecovery({ workspaceRoot }).pending, false)
  assert.equal(capability.inspectCapabilityAdoption({ workspaceRoot }).packages[0].bindings[0].installed, 'current')
})

test('recovery refuses unexpected writer bytes and preserves them', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  const plan = capability.planCapabilityAdoption(settings), original = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(from).includes('/staged/.claude/skills/')) throw new Error('simulated interruption')
    return original(from, to)
  }
  try { assert.throws(() => capability.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest }), /interrupted/) }
  finally { fs.renameSync = original }
  const target = '.agents/skills/research-inquire/SKILL.md'
  fs.appendFileSync(path.join(workspaceRoot, target), '\nNew local work.\n')
  const recovery = capability.inspectCapabilityRecovery({ workspaceRoot })
  assert.match(recovery.blockers.join(' '), /ambiguous-binding/)
  assert.throws(() => capability.recoverCapabilityAdoption({ workspaceRoot, confirm: recovery.planDigest }), /unblocked recovery/)
  assert.match(fs.readFileSync(path.join(workspaceRoot, target), 'utf8'), /New local work/)
})

test('process termination preserves its journal and only its dead owned lock can be reclaimed', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  const plan = capability.planCapabilityAdoption(settings)
  const moduleUrl = new URL('../src/capabilities/index.mjs', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module'], {
    encoding: 'utf8', env: { ...process.env, CAPABILITY_TEST_SETTINGS: JSON.stringify({ ...settings, confirm: plan.planDigest }) },
    input: `import fs from 'node:fs'; import {applyCapabilityAdoption} from ${JSON.stringify(moduleUrl)};
const original = fs.renameSync;
fs.renameSync = (from, to) => { const result = original(from, to); if(String(from).includes('/staged/.agents/skills/')) process.exit(77); return result; };
applyCapabilityAdoption(JSON.parse(process.env.CAPABILITY_TEST_SETTINGS));`,
  })
  assert.equal(child.status, 77, child.stderr)
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.atelier-local/skill-steward/.operation.lock')), true)
  const recovery = capability.inspectCapabilityRecovery({ workspaceRoot })
  assert.deepEqual(recovery.blockers, [])
  assert.equal(capability.recoverCapabilityAdoption({ workspaceRoot, confirm: recovery.planDigest }).recovered, true)
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.atelier-local/skill-steward/.operation.lock')), false)
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.agents/skills/research-inquire')), false)
})

test('a repository edit after preview invalidates confirmation without replacing it', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  const plan = capability.planCapabilityAdoption(settings)
  write(workspaceRoot, '.agents/skills/research-inquire/SKILL.md', 'A new local skill')
  assert.throws(() => capability.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest }), /confirmation/)
  assert.equal(fs.readFileSync(path.join(workspaceRoot, '.agents/skills/research-inquire/SKILL.md'), 'utf8'), 'A new local skill')
})

test('content-free evidence stays version-bound, distinguishes cause and generates reviewable graph sources', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const result = adopt({ workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) })
  const ev = event(result.state)
  assert.throws(() => capability.recordCapabilityEvent({ workspaceRoot, event: { ...ev, prompt: 'must not be captured' } }), /invalid capability event/)
  capability.recordCapabilityEvent({ workspaceRoot, event: ev })
  assert.throws(() => capability.recordCapabilityEvent({ workspaceRoot, event: ev }), /already recorded/)
  for (const [id, session] of [['tool-one', 'session-one'], ['tool-two', 'session-two']]) capability.recordCapabilityEvent({ workspaceRoot, event: event(result.state, { id, session, outcome: 'failed', cause: 'tool' }) })
  const candidates = capability.capabilityImprovementCandidates({ workspaceRoot })
  assert.equal(candidates.candidates[0].proposal, 'review-tool')
  assert.equal(candidates.candidates[0].automaticEdit, false)
  assert.throws(() => capability.capabilityGraphSources({ workspaceRoot, namespace: 'invalid.namespace' }), /invalid graph namespace/)
  const graph = capability.capabilityGraphSources({ workspaceRoot, namespace: 'project' })
  assert.equal(graph.canonicalMutation, false)
  for (const file of graph.files) write(workspaceRoot, `governance/${file.path}`, file.content)
  const built = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: { schema: REPO_ACCESS_SCHEMA, defaultReadBoundary: 'private', repos: { project: { readBoundary: 'private' } } } })
  assert.equal(built.ok, true, built.errors.join('\n'))
  assert.ok(built.workspaceGraph.nodes.some(node => node.id.includes('capability-event')))
  assert.ok(built.workspaceGraph.edges.some(edge => edge.type === 'evidences' || edge.kind === 'evidences'))
})

test('inventory is read-only, explicitly scoped and never claims a host has loaded a duplicate', t => {
  const root = sandbox(t)
  for (const surface of ['personal', 'repository']) write(root, `${surface}/shared/SKILL.md`, '---\nname: shared\ndescription: Fixture.\n---\n\nBody\n')
  const inventory = capability.inventorySkillSurfaces({ surfaces: ['personal', 'repository'].map(scope => ({ id: scope, scope, root: path.join(root, scope) })) })
  assert.equal(inventory.entries.length, 2)
  assert.equal(inventory.findings.filter(item => item.code.includes('overlap')).length, 2)
  assert.equal(inventory.mutation, false)
  assert.ok(inventory.entries.every(entry => entry.hostLoaded === 'unknown'))
})

test('CLI exposes the complete local publisher-to-adopter flow with machine-readable refusals', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  write(root, 'adoption.json', policy(pkg.release))
  const args = ['--adoption', path.join(root, 'adoption.json'), '--source', pkg.directory]
  const run = (...argv) => spawnSync(process.execPath, [CLI, 'capability', ...argv], { cwd: workspaceRoot, encoding: 'utf8' })
  const preview = run('plan', ...args)
  assert.equal(preview.status, 0, preview.stderr + preview.stdout)
  const plan = JSON.parse(preview.stdout)
  const apply = run('apply', ...args, '--confirm', plan.planDigest)
  assert.equal(apply.status, 0, apply.stderr + apply.stdout)
  assert.equal(JSON.parse(run('status').stdout).packages[0].bindings[0].installed, 'current')
  assert.equal(run('apply', ...args, '--confirm', plan.planDigest).status, 1)
  assert.equal(run('plan', ...args, '--surprise').status, 2)
})

test('supplied withdrawal blocks further adoption without deleting installed files; retirement remains explicit', t => {
  const root = sandbox(t), workspaceRoot = repo(root), pkg = bundle(root)
  const settings = { workspaceRoot, sources: [pkg.directory], adoption: policy(pkg.release) }
  adopt(settings)
  const notices = [{ schema: 'mnstry.atelier-capability-notice@v1', id: pkg.release.package.id, digest: pkg.release.digest, status: 'withdrawn', evidenceDigest: digest('supplied-advisory') }]
  assert.match(capability.planCapabilityAdoption({ ...settings, notices }).blockers.join(' '), /release-withdrawn/)
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.agents/skills/research-inquire/SKILL.md')), true)
  const result = adopt({ ...settings, sources: [], notices, adoption: policy(pkg.release, { mode: 'retired' }) })
  assert.equal(result.state.packages[0].mode, 'retired')
})

test('shipped research and evidence-review examples install with complete self-contained resources', t => {
  const root = sandbox(t), workspaceRoot = repo(root)
  const sources = ['evidence-review', 'research'].map(name => new URL(`../fixtures/capability-packages/${name}`, import.meta.url).pathname)
  const adoption = JSON.parse(fs.readFileSync(new URL('../fixtures/capability-packages/adoption.example.json', import.meta.url)))
  adopt({ workspaceRoot, sources, adoption })
  assert.equal(capability.inspectCapabilityAdoption({ workspaceRoot }).packages.flatMap(item => item.bindings).length, 8)
  assert.match(fs.readFileSync(path.join(workspaceRoot, '.claude/skills/research-plan/references/inquiries.md'), 'utf8'), /Disconfirmation/)
})
