import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveProjectConfig, writeJson } from '../../../src/project/config.mjs'
import { OBJECT_STORE_PRIMITIVES, createObjectStoreForOracleTests, createSourceApplyForOracleTests, SOURCE_APPLY_PRIMITIVES, withApplyPolicyDigest } from '../../../src/projection/obsidian/edits/index.mjs'
import { createEditorAdapter } from '../../../src/projection/obsidian/publication/index.mjs'
import { createRecoveryStore } from '../../../src/projection/obsidian/recovery/index.mjs'
import { createMaintenanceEngine } from '../../../src/runtime/obsidian/engine.mjs'
import { createMaintenanceExtensions } from '../../../src/runtime/obsidian/extension-points.mjs'
import { ensureWorkspaceIdentity, installApplyPolicy, protectedRoots, readMachineSettings, workspaceStateRoot, writeMachineSettings } from '../../../src/runtime/obsidian/machine-settings.mjs'
import { observeVaultEdits, trustedNoteBases } from '../../../src/runtime/obsidian/pending-edits.mjs'
import { createProductionSeams } from '../../../src/runtime/obsidian/pipeline.mjs'
import { createAbandonmentProof, isProcessAlive } from '../../../src/runtime/obsidian/private-lock.mjs'
import { createMaintenanceStateStore } from '../../../src/runtime/obsidian/state-store.mjs'

// An invented project of real git repositories in a temporary directory, a
// temporary data root, and either the real maintenance engine or, where no
// atomic exchange exists and the publisher refuses, a view written directly.
// Every source file an apply can reach lives under that temporary directory.

export const EXT = 'mnstry.atelier.obsidian'

// A holder that is gone, deterministically. The PID of a child that exited can be handed to another process at once
// (quickly on Windows), and a lease held under it is then, correctly, not taken over. A test that needs an abandoned
// lease holds it under this PID instead, and opens the object store with a proof whose ONLY injected part is that
// this PID is not alive; every other PID is asked of the operating system, and the production rule decides.
export const GONE_HOLDER_PID = 2 ** 31 - 2
export const goneHolderProof = (options = {}) => createAbandonmentProof({ ...options, alive: (pid) => pid !== GONE_HOLDER_PID && isProcessAlive(pid) })
export const objectStoreWhereTheHolderIsGone = createObjectStoreForOracleTests({ ...OBJECT_STORE_PRIMITIVES, proveAbandoned: goneHolderProof() })
export const APPLY_WORKSPACE_ID = `ws-${'0b'.repeat(12)}`
const fixedRandom = (size) => Buffer.alloc(size, 0x0b)
const START = Date.parse('2026-01-05T10:00:00.000Z')
export const digestOf = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
export const noteText = ({ id, title, body, audience = 'team' }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "${audience}"\n---\n\n# ${title}\n\n${body}\n`

const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
export function git(cwd, args) {
  return childProcess.execFileSync('git', ['-c', 'user.name=Synthetic Author', '-c', 'user.email=author@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Every file under `directory` by digest, links by target, directories by name: the byte oracle.
export function treeListing(directory, { skip = () => false } = {}) {
  const found = {}
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(directory, absolute).split(path.sep).join('/')
      if (skip(relative)) continue
      if (entry.isSymbolicLink()) found[relative] = `link:${fs.readlinkSync(absolute)}`
      else if (entry.isDirectory()) { found[`${relative}/`] = 'directory'; walk(absolute) } else found[relative] = digestOf(fs.readFileSync(absolute))
    }
  }
  walk(directory)
  return found
}

export function makeApplyWorld(t, { files, repositories, scopes = [{ scopeId: 'scope-whole', mode: 'full', selector: { all: true } }], audienceAllow = ['team'], gitignore = null }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'atelier-apply-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  for (const name of repositories) {
    if (gitignore?.[name]) fs.writeFileSync(path.join(projectDir, name, '.gitignore'), gitignore[name])
    git(path.join(projectDir, name), ['init', '-q'])
    git(path.join(projectDir, name), ['add', '-A'])
    git(path.join(projectDir, name), ['commit', '-q', '-m', 'synthetic fixture'])
  }
  const configPath = path.join(projectDir, 'atelier.project.json')
  const projectDocument = (ext) => ({
    schema: 'mnstry.atelier-project-config@v1', name: 'apply-fixture', roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: repositories.map((name) => ({ name, path: name, readBoundary: 'team' })),
    ext: { [EXT]: ext },
  })
  const settings = (extra = {}) => ({ schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes, ...extra })
  writeJson(configPath, projectDocument(settings()))
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(repositories.map((name) => [name, { readBoundary: 'team' }])) })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  let nowMs = START
  const clock = () => new Date(nowMs)
  const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })

  const world = {
    dir, projectDir, dataRoot, configPath, loadProject, env, clock,
    advance: (ms) => { nowMs += ms },
    setEnabled: (enabled) => writeJson(configPath, projectDocument(settings({ enabled }))),
    source: (relative) => path.join(projectDir, relative),
    repo: (name) => path.join(projectDir, name),
    workspaceRoot: () => fs.realpathSync(workspaceStateRoot(dataRoot, APPLY_WORKSPACE_ID)),
    recovery: () => path.join(world.workspaceRoot(), 'recovery'),
    vault: (scopeId = scopes[0].scopeId) => path.join(world.workspaceRoot(), 'vaults', scopeId),
    manifest(scopeId = scopes[0].scopeId) {
      const directory = path.join(world.workspaceRoot(), 'state', 'manifests', scopeId)
      const pointer = JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8'))
      return JSON.parse(fs.readFileSync(path.join(directory, pointer.manifestFile), 'utf8'))
    },
    noteFile: (nodeId, scopeId = scopes[0].scopeId) => path.join(world.vault(scopeId), world.manifest(scopeId).notes.find((item) => item.nodeId === nodeId).path),
    stateStore: () => createMaintenanceStateStore({ workspaceRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID }),
    pendingEdits: () => world.stateStore().readPendingEdits().edits,
    editOf: (nodeId, scopeId = scopes[0].scopeId) => world.pendingEdits().find((edit) => edit.identity.nodeId === nodeId && edit.scopeId === scopeId && edit.closedAt === null),
    configureMachine(machine) {
      const project = loadProject()
      const pointer = ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
      const root = workspaceStateRoot(dataRoot, pointer.workspaceId)
      const current = fs.existsSync(root) ? readMachineSettings({ workspaceRoot: root, workspaceId: pointer.workspaceId }) : null
      return writeMachineSettings({ workspaceRoot: root, workspaceId: pointer.workspaceId, repositoryRoots: protectedRoots(project), settings: { schema: 'atelier-obsidian-machine-settings/v1', workspaceId: pointer.workspaceId, applyPolicy: null, ...(current ?? {}), ...machine, updatedAt: clock().toISOString() } })
    },
    // Installs a policy whose digest is the digest of its content, unless `digest` is given.
    installPolicy(overrides = {}) {
      const content = {
        schema: 'atelier-obsidian-apply-policy/v1', policyId: 'policy-synthetic', workspaceId: APPLY_WORKSPACE_ID, mode: 'automatic', status: 'active', actor: { kind: 'agent', id: 'agent-synthetic' },
        version: 1, digest: `sha256:${'0'.repeat(64)}`, allowedEditClasses: ['body-replacement'], selector: { all: true }, maxBatchSize: 10, retryBudget: 2, conflictDisposition: 'hold', ...overrides,
      }
      const policy = overrides.digest === undefined ? withApplyPolicyDigest(content) : content
      installApplyPolicy({ workspaceRoot: workspaceStateRoot(dataRoot, APPLY_WORKSPACE_ID), workspaceId: APPLY_WORKSPACE_ID, policy, repositoryRoots: protectedRoots(loadProject()), updatedAt: clock().toISOString() })
      return policy
    },
    sourceApply: (options = {}, primitives = SOURCE_APPLY_PRIMITIVES) => createSourceApplyForOracleTests(primitives)({ loadProject, dataRoot, env, clock, quietPeriodMs: 0, objectStore: objectStoreWhereTheHolderIsGone, ...options }),
    engine({ applyOperation = null, ...options } = {}) {
      const extensions = createMaintenanceExtensions()
      if (applyOperation) extensions.register('apply-operation', applyOperation)
      const engine = createMaintenanceEngine({ loadProject, dataRoot, adapterFactory: absentAdapter, clock, randomBytes: fixedRandom, quietPeriodMs: 0, extensions, env, ...options })
      t.after(() => engine.stop())
      return engine
    },
    // A person edits a note: the bytes of the note with `from` replaced by `to`, written over the note.
    editNote(nodeId, from, to, scopeId) {
      const file = world.noteFile(nodeId, scopeId)
      const before = fs.readFileSync(file)
      const at = before.indexOf(from)
      if (at === -1) throw new Error('the fixture note does not hold the text to edit')
      const after = Buffer.concat([before.subarray(0, at), Buffer.from(to), before.subarray(at + Buffer.byteLength(from))])
      fs.writeFileSync(file, after)
      return after
    },
    // Without a publisher (no atomic exchange on this platform): the prepared view written as files, the manifest
    // committed, and edits queued by the real observation. Nothing else differs from what the engine leaves behind.
    publishDirectly(scopeId = scopes[0].scopeId) {
      world.configureMachine({ maintenanceMode: 'manual', audienceAllow })
      const project = loadProject()
      const seams = createProductionSeams()
      const graph = seams.buildGraph({ project, eligibility: { revision: () => 'test', isEligible: (node) => node.classification === 'classified' } })
      const scope = { schema: 'atelier-obsidian-scope/v1', ...scopes.find((item) => item.scopeId === scopeId) }
      const snapshot = seams.captureSnapshot({ project, graph, workspaceId: APPLY_WORKSPACE_ID, index: new Map(), configDigest: digestOf('config'), capturedAt: clock().toISOString() })
      const prepared = seams.prepareView({ snapshot, profile: seams.profileFor({ project, workspaceId: APPLY_WORKSPACE_ID, audienceAllow }), scope, clock })
      const store = createRecoveryStore({ workspaceRoot: workspaceStateRoot(dataRoot, APPLY_WORKSPACE_ID), workspaceId: APPLY_WORKSPACE_ID, scopeId, repositoryRoots: protectedRoots(project) })
      for (const file of prepared.files.filter((item) => item.kind !== 'settings')) {
        fs.mkdirSync(path.dirname(path.join(store.vaultRoot, file.path)), { recursive: true })
        fs.writeFileSync(path.join(store.vaultRoot, file.path), file.bytes)
      }
      store.commitManifest({ manifestBytes: Buffer.from(`${JSON.stringify(prepared.manifest, null, 2)}\n`), generationId: prepared.manifest.generationId, journalId: 'journal-direct', committedAt: clock().toISOString() })
      world.stateStore().writePathRegistry(prepared.persistentPathRegistry)
      return store
    },
    queueDirectly(scopeId = scopes[0].scopeId) {
      const store = createRecoveryStore({ workspaceRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID, scopeId, repositoryRoots: protectedRoots(loadProject()) })
      const { manifest, bases } = trustedNoteBases(store)
      const stateStore = world.stateStore()
      const pending = stateStore.readPendingEdits()
      const digestNow = (notePath) => { try { return digestOf(fs.readFileSync(path.join(store.vaultRoot, notePath))) } catch { return null } }
      const observed = observeVaultEdits({ store, workspaceId: APPLY_WORKSPACE_ID, scopeId, manifest, bases, digestOf: digestNow, edits: pending.edits, now: clock().toISOString() })
      stateStore.writePendingEdits({ ...pending, edits: observed.edits })
    },
  }
  world.configureMachine({ maintenanceMode: 'manual', audienceAllow })
  return world
}
