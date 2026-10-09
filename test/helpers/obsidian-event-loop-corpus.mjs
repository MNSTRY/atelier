import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { resolveProjectConfig, writeJson } from '../../src/project/config.mjs'
import {
  defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots,
  workspaceStateRoot, writeMachineSettings,
} from '../../src/runtime/obsidian/index.mjs'
import { readLocalPointer } from '../../src/runtime/obsidian/machine-settings.mjs'
import { createMaintenanceStateStore } from '../../src/runtime/obsidian/state-store.mjs'
import { observeVaultEdits, trustedNoteBases } from '../../src/runtime/obsidian/pending-edits.mjs'
import { createProductionSeams } from '../../src/runtime/obsidian/pipeline.mjs'
import { createSourceApply, openObjectStore } from '../../src/projection/obsidian/edits/index.mjs'
import { createProposalAdapter } from '../../src/projection/obsidian/proposals/index.mjs'
import { createProposalStore } from '../../src/collaboration/proposals.mjs'
import { createMaintenanceExtensions } from '../../src/runtime/obsidian/extension-points.mjs'

// Invented, classified notes only. This helper cannot nominate or open a real
// corpus. Both the sources and every service/vault file live in its own temp
// directory; cleanup only removes the directory this invocation created.
export function createEventLoopCorpus({ notes = 32, scopes = 1 } = {}) {
  if (!Number.isInteger(notes) || notes < 1 || notes > 10000) throw new TypeError('notes must be between 1 and 10000')
  if (!Number.isInteger(scopes) || scopes < 1 || scopes > 6) throw new TypeError('scopes must be between 1 and 6')
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-event-loop-'))
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  try {
    const projectDir = path.join(directory, 'project')
    const dataRoot = path.join(directory, 'data')
    const repositories = ['east-wing', 'west-wing']
    const definitions = Array.from({ length: scopes }, (_, i) => ({ scopeId: `scope-${i + 1}`, mode: 'full', selector: { all: true } }))
    const inventory = []
    for (const repo of repositories) fs.mkdirSync(path.join(projectDir, repo, 'notes'), { recursive: true })
    for (let i = 0; i < notes; i += 1) {
      const repo = repositories[i % repositories.length]
      const ordinal = String(i).padStart(5, '0')
      const next = i + 2 < notes ? `[Next invented note](note-${String(i + 2).padStart(5, '0')}.md).\n` : ''
      const bytes = Buffer.from(`---\ntitle: "Invented note ${ordinal}"\nkg:\n  id: "${repo}:note-${ordinal}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# Invented note ${ordinal}\n\nThis is disposable scheduling evidence. No person or client supplied these words.\n${next}`)
      const relative = `notes/note-${ordinal}.md`
      fs.writeFileSync(path.join(projectDir, repo, relative), bytes)
      inventory.push({ repoId: repo, path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    const configPath = path.join(projectDir, 'atelier.project.json')
    writeJson(configPath, {
      schema: 'mnstry.atelier-project-config@v1', name: 'event-loop-fixture',
      roots: { workspace: '.', repoOps: '.' },
      graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
      projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
      repos: repositories.map(name => ({ name, path: name, readBoundary: 'team' })),
      ext: { 'mnstry.atelier.obsidian': { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: definitions } },
    })
    writeJson(path.join(projectDir, 'repo-access.v1.json'), {
      schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team',
      repos: Object.fromEntries(repositories.map(name => [name, { readBoundary: 'team' }])),
    })
    const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
    const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
    const project = loadProject()
    const pointer = ensureWorkspaceIdentity({ project, randomBytes: size => Buffer.alloc(size, 7) })
    const workspaceRoot = workspaceStateRoot(dataRoot, pointer.workspaceId)
    const at = '2026-01-05T10:00:00.000Z'
    writeMachineSettings({
      workspaceRoot, workspaceId: pointer.workspaceId, repositoryRoots: protectedRoots(project),
      settings: { ...defaultMachineSettings({ workspaceId: pointer.workspaceId, updatedAt: at }), maintenanceMode: 'manual', audienceAllow: ['team'] },
    })
    // A fixture digest, not another graph/profile/snapshot authority. Production
    // builds those existing contracts from these exact authored bytes.
    const manifest = { kind: 'invented-event-loop-fixture', notes, scopes: definitions, inventory }
    return { directory, projectDir, configPath, dataRoot, workspaceRoot, workspaceId: pointer.workspaceId, env, loadProject, manifest, digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), cleanup }
  } catch (error) { cleanup(); throw error }
}

export const TRANSITION_SCENARIOS = Object.freeze(['apply-prepare', 'apply-pointer', 'observe-16'])
const epochMs = () => performance.timeOrigin + performance.now()
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

// Enable the real source-ignore and proposal-routing checks in owned fixture
// repositories. No Git identity, commit, remote, hook or user template is used.
export function initializeTransitionRepositories(corpus) {
  for (const repo of ['east-wing', 'west-wing']) {
    const directory = path.join(corpus.projectDir, repo)
    fs.writeFileSync(path.join(directory, '.gitignore'), '.atelier-proposals/\n', { flag: 'wx' })
    childProcess.execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', directory], {
      env: { ...corpus.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }, timeout: 10000, stdio: 'pipe',
    })
  }
}

// Byte inventories use no stat-hint equivalence: a same-byte rename changes
// file identity but must preserve every authored byte. Proposal stores are a
// separate permitted effect, rather than excluded from all verification.
function treeBytes(directory, excluded = new Set()) {
  const inventory = {}
  const walk = (here, prefix = '') => {
    if (!fs.existsSync(here)) return
    for (const name of fs.readdirSync(here).sort()) {
      if (excluded.has(name)) continue
      const file = path.join(here, name), relative = prefix ? `${prefix}/${name}` : name
      const stat = fs.lstatSync(file)
      assert.ok(!stat.isSymbolicLink(), 'fixture oracle refuses links')
      if (stat.isDirectory()) walk(file, relative)
      else inventory[relative] = digest(fs.readFileSync(file))
    }
  }
  walk(directory)
  return inventory
}

export function createTransitionDriver({ loadProject, dataRoot, fixtureRoot, scenario, onPhase = () => {} }) {
  assert.ok(TRANSITION_SCENARIOS.includes(scenario))
  const root = fs.realpathSync(fixtureRoot), project = loadProject()
  const inside = file => {
    const relative = path.relative(root, path.resolve(file))
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'transition effects stay inside the owned fixture')
    return file
  }
  for (const repo of project.repos) inside(repo.path)
  const pointer = readLocalPointer(project)
  assert.ok(pointer)
  const workspaceRoot = inside(workspaceStateRoot(dataRoot, pointer.workspaceId)), workspaceId = pointer.workspaceId
  const repositoryRoots = protectedRoots(project), production = createProductionSeams()
  const stateStore = createMaintenanceStateStore({ workspaceRoot, workspaceId })
  let nowMs = Date.now(), preparing = false, race = null
  const clock = () => new Date(nowMs)
  const attempts = [], pointerReads = [], replacements = []
  const timedPrepare = input => {
    const startedMs = epochMs(), ordinal = attempts.length + 1
    preparing = true
    let code = null
    try { return production.prepareView(input) } catch (error) { code = error.code ?? error.name; throw error }
    finally { preparing = false; const event = { ordinal, startedMs, endedMs: epochMs(), code }; attempts.push(event); try { onPhase({ phase: 'transition-prepare-attempt', ...event }) } catch { /* telemetry cannot replace the operation result */ } }
  }
  const recoveryStore = input => {
    const store = production.createRecoveryStore(input)
    return { ...store, readCurrentManifest(...args) {
      const startedMs = epochMs()
      let code = null
      try { return store.readCurrentManifest(...args) } catch (error) { code = error.code ?? error.name; throw error }
      finally { const event = { ordinal: pointerReads.length + 1, startedMs, endedMs: epochMs(), code }; pointerReads.push(event); try { onPhase({ phase: 'transition-pointer-read', ...event }) } catch { /* read-only telemetry */ } }
    } }
  }
  const extensions = createMaintenanceExtensions()
  if (scenario === 'observe-16') extensions.register('proposal-adapter', createProposalAdapter({ env: process.env, clock, seams: { prepareView: timedPrepare } }))
  const stores = () => project.repos.map(repo => {
    const directory = path.join(repo.path, '.atelier-proposals')
    if (!fs.existsSync(directory)) return { repoId: repo.name, count: 0, bytes: {} }
    const listed = createProposalStore({ workspaceRoot: repo.path, workspaceId }).listProposals()
    assert.equal(listed.ok, true)
    return { repoId: repo.name, count: listed.proposals.length, bytes: treeBytes(directory) }
  })
  const storeOf = scopeId => production.createRecoveryStore({ workspaceRoot, workspaceId, scopeId, repositoryRoots })
  const oracles = store => ({
    sources: Object.fromEntries(project.repos.map(repo => [repo.name, treeBytes(repo.path, new Set(['.git', '.atelier-proposals']))])),
    vault: treeBytes(store.vaultRoot), proposals: stores(),
    pending: stateStore.readPendingEdits(), objects: treeBytes(path.join(workspaceRoot, 'state', 'objects')),
    candidates: Object.keys(treeBytes(workspaceRoot)).filter(name => name.endsWith('.candidate')),
  })
  const seed = count => {
    const scopeId = project.config.ext['mnstry.atelier.obsidian'].scopes[0].scopeId, store = storeOf(scopeId)
    const { manifest, bases } = trustedNoteBases(store)
    assert.ok(manifest.notes.length >= count)
    const chosen = manifest.notes.slice(0, count), inputs = []
    for (const [index, note] of chosen.entries()) {
      const file = inside(path.join(store.vaultRoot, note.path)), bytes = fs.readFileSync(file)
      const semantic = scenario === 'observe-16' && index === count - 1
      const text = bytes.toString('utf8')
      const editedText = semantic ? text.replace(/^title:.*$/m, 'title: "Invented transition proposal"') : text.replace('This is disposable scheduling evidence.', `Disposable transition edit ${index}.`)
      assert.notEqual(editedText, text, 'fixture mutation must change the authored lens input')
      fs.writeFileSync(file, editedText)
      // Force the production fallback to reprepare, while preserving the edited
      // object through observeVaultEdits below. This removes only invented base
      // objects from this newly created fixture, never a real retained object.
      const baseObject = inside(path.join(workspaceRoot, 'recovery', 'objects', `${note.noteDigest.slice(7)}.bin`))
      fs.rmSync(baseObject, { force: true })
      const source = note.ext['mnstry.atelier.obsidian'].source
      const repo = project.repos.find(repo => repo.name === note.repoId)
      inputs.push({ nodeId: note.nodeId, sourceFile: inside(path.join(repo.path, source.path)), sourceBytes: fs.readFileSync(path.join(repo.path, source.path)), editedDigest: digest(Buffer.from(editedText)), semantic })
    }
    const pending = stateStore.readPendingEdits()
    const observed = observeVaultEdits({ store, workspaceId, scopeId, manifest, bases, edits: pending.edits, now: clock().toISOString(), digestOf: relative => digest(fs.readFileSync(path.join(store.vaultRoot, relative))) })
    stateStore.writePendingEdits({ ...pending, edits: observed.edits })
    assert.equal(observed.events.filter(event => event.kind === 'queued').length, count)
    return { store, inputs, edits: stateStore.readPendingEdits().edits.filter(edit => edit.closedAt === null) }
  }
  const withRace = async (file, kind, operation) => {
    inside(file)
    const bytes = fs.readFileSync(file), originalOpen = fs.openSync
    race = { file, kind, lastAttempt: -1 }
    fs.openSync = function fixtureOpen(target, flags, ...rest) {
      if (typeof target === 'string' && path.resolve(target) === path.resolve(file)
          && (kind === 'pointer' || (preparing && race.lastAttempt !== attempts.length))) {
        const saving = inside(`${file}.transition-saving`)
        fs.writeFileSync(saving, bytes)
        fs.renameSync(saving, file)
        race.lastAttempt = attempts.length
        replacements.push({ ordinal: replacements.length + 1, kind, atMs: epochMs(), bytesDigest: digest(bytes) })
      }
      return originalOpen.call(this, target, flags, ...rest)
    }
    try { return await operation() } finally { fs.openSync = originalOpen; race = null }
  }
  const assertPreserved = (before, after) => {
    assert.deepEqual(after.sources, before.sources, 'all source bytes preserved')
    assert.deepEqual(after.vault, before.vault, 'all edited/unrelated vault bytes preserved')
    assert.deepEqual(after.pending, before.pending, 'pending edit identities/retained digests preserved')
    assert.deepEqual(after.candidates, before.candidates, 'no unfinished source candidate')
  }
  return {
    clock, extensions,
    async run(engine) {
      const startedMs = epochMs(), seeded = seed(scenario === 'observe-16' ? 17 : 1), before = oracles(seeded.store)
      let outcomes, afterRefusal, afterRecovery
      const firstInput = seeded.inputs[0], firstEdit = seeded.edits.find(edit => edit.identity.nodeId === firstInput.nodeId)
      if (scenario === 'observe-16') {
        nowMs += 1000
        const refused = await withRace(firstInput.sourceFile, 'prepare', () => engine.tick())
        assert.equal(refused.state, 'ticked')
        assert.equal(refused.observed.observed.length, 16)
        assert.ok(refused.observed.observed.every(item => item.status === 'refused' && item.code === 'published-note-unavailable'), JSON.stringify({ observed: refused.observed, attempts, replacements }))
        assert.equal(attempts.length, 16)
        assert.equal(replacements.length, 16)
        assert.ok(attempts.every(item => item.code === 'ELEAFCHANGED'))
        afterRefusal = oracles(seeded.store); assertPreserved(before, afterRefusal)
        assert.deepEqual(afterRefusal.proposals, before.proposals)
        nowMs += 1000
        const tail = await engine.tick()
        assert.equal(tail.observed.observed.length, 1, 'seventeenth edit proceeds on the next ordinary tick')
        assert.equal(tail.observed.observed[0].status, 'observed')
        const settled = oracles(seeded.store)
        nowMs += 1000
        const quiet = await engine.tick()
        assert.deepEqual(quiet.observed.observed, [])
        assert.deepEqual(oracles(seeded.store).objects, settled.objects)
        nowMs += 6 * 60 * 1000
        const recovered = await engine.tick()
        assert.equal(recovered.full, true)
        assert.equal(recovered.observed.observed.length, 16)
        assert.ok(recovered.observed.observed.every(item => item.status === 'observed'))
        afterRecovery = oracles(seeded.store); assertPreserved(before, afterRecovery)
        const objects = openObjectStore({ stateRoot: workspaceRoot, workspaceId, repositoryRoots, clock })
        const operations = seeded.edits.flatMap(edit => objects.stateOf(edit.identity).operations)
        assert.equal(operations.length, 17)
        assert.equal(operations.filter(item => item.kind === 'semantic-proposal').length, 1)
        assert.equal(afterRecovery.proposals.reduce((count, item) => count + item.count, 0), 1)
        nowMs += 1000
        const final = await engine.tick()
        assert.deepEqual(final.observed.observed, [])
        assert.deepEqual(oracles(seeded.store).objects, afterRecovery.objects)
        assert.deepEqual(oracles(seeded.store).proposals, afterRecovery.proposals)
        outcomes = { refused: refused.observed, tail: tail.observed, quiet: quiet.observed, recovered: recovered.observed, final: final.observed, operations: operations.map(({ kind, state, idempotencyKey }) => ({ kind, state, idempotencyKey })) }
      } else {
        const apply = seams => createSourceApply({ loadProject, dataRoot, env: process.env, clock, quietPeriodMs: 0, seams }).apply({ editId: firstEdit.editId, mode: 'manual', actor: 'synthetic-transition' })
        const file = scenario === 'apply-prepare' ? firstInput.sourceFile : inside(path.join(workspaceRoot, 'state', 'manifests', firstEdit.scopeId, 'current.json'))
        const refused = await withRace(file, scenario === 'apply-prepare' ? 'prepare' : 'pointer', () => apply({ prepareView: timedPrepare, createRecoveryStore: recoveryStore }))
        if (scenario === 'apply-prepare') {
          assert.equal(attempts.length, 3); assert.equal(replacements.length, 3)
          assert.ok(attempts.every(item => item.code === 'ELEAFCHANGED'))
          assert.deepEqual([refused.status, refused.code], ['refused', 'published-note-unavailable'])
        } else {
          assert.equal(pointerReads.length, 5); assert.equal(replacements.length, 5)
          assert.ok(pointerReads.every(item => item.code === 'ELEAFCHANGED'))
          assert.deepEqual([refused.status, refused.code, refused.detail.cause], ['refused', 'manifest-unavailable', 'changed-while-reading'])
        }
        afterRefusal = oracles(seeded.store); assertPreserved(before, afterRefusal)
        assert.deepEqual(afterRefusal.proposals, before.proposals)
        const recovered = await apply({})
        assert.equal(recovered.status, 'applied')
        const expected = Buffer.from(firstInput.sourceBytes.toString('utf8').replace('This is disposable scheduling evidence.', 'Disposable transition edit 0.'))
        assert.deepEqual(fs.readFileSync(firstInput.sourceFile), expected, 'recovery applies exactly the admitted invented body edit')
        afterRecovery = oracles(seeded.store)
        const relative = path.relative(project.repos.find(repo => repo.name === firstEdit.identity.repoId).path, firstInput.sourceFile).split(path.sep).join('/')
        const expectedSources = structuredClone(before.sources)
        expectedSources[firstEdit.identity.repoId][relative] = digest(expected)
        assert.deepEqual(afterRecovery.sources, expectedSources, 'only the intended source body changes')
        assert.deepEqual(afterRecovery.vault, before.vault)
        assert.deepEqual(afterRecovery.proposals, before.proposals)
        assert.equal(afterRecovery.candidates.length, 0)
        const objects = openObjectStore({ stateRoot: workspaceRoot, workspaceId, repositoryRoots, clock })
        const object = objects.stateOf(firstEdit.identity)
        assert.equal(object.operations.length, 1, 'same edit has one operation across refusal/recovery')
        outcomes = { refused, recovered, operation: object.operations.map(({ kind, state, idempotencyKey }) => ({ kind, state, idempotencyKey })) }
      }
      return { scenario, startedMs, endedMs: epochMs(), attempts, pointerReads, replacements, outcomes, oracles: { before, afterRefusal, afterRecovery }, typedAndByteOraclesPassed: true, fsOpenRestored: race === null }
    },
  }
}
