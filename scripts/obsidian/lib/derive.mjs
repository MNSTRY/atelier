import fs from 'node:fs'
import path from 'node:path'
import { resolveProjectConfig } from '../../../src/project/config.mjs'
import { createEditorAdapter } from '../../../src/projection/obsidian/publication/transport.mjs'
import { PROTOCOL_ID } from '../../../src/projection/obsidian/publication/bridge-script.mjs'
import { createRecoveryStore } from '../../../src/projection/obsidian/recovery/index.mjs'
import { DEFAULT_ELIGIBILITY, createProductionSeams } from '../../../src/runtime/obsidian/pipeline.mjs'
import { listSourceFiles, reconcile } from '../../../src/runtime/obsidian/observation.mjs'
import { REPOSITORY_ROOT, bytesUnder, readJson, sha256Digest, writeJson } from './common.mjs'
import { timed } from './measure.mjs'

// Derivation without an app: the production pipeline (canonical graph ->
// source snapshot -> prepareView -> publishView) run over a synthetic
// workspace into a vault that no application has open. The default adapter
// reports the editor absent, so publication takes the direct path; that is
// only correct for a vault nothing else has open, which is what every caller
// here provides (a fresh temporary directory). With a running isolated
// instance, pass its CLI adapter instead and publication coordinates with it.

export const FULL_SCOPE = Object.freeze({ schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-full', mode: 'full', selector: Object.freeze({ all: true }) })
export const DEFAULT_WORKSPACE_ID = 'ws-proof-0001'

export const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })

export function projectDocument({ name, repositories, scopes = [FULL_SCOPE] }) {
  return {
    schema: 'mnstry.atelier-project-config@v1',
    name,
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: repositories.map((repoId) => ({ name: repoId, path: repoId, readBoundary: 'team' })),
    ext: { 'mnstry.atelier.obsidian': { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: scopes.map(({ scopeId, mode, selector, expansion }) => ({ scopeId, mode, selector, ...(expansion ? { expansion } : {}) })) } },
  }
}

// Writes the project and repository-access documents a workspace needs so
// both this derivation and the shipped `atelier obsidian` command can read it.
export function writeWorkspaceConfig(workspaceDir, { name, repositories, scopes }) {
  for (const repoId of repositories) fs.mkdirSync(path.join(workspaceDir, repoId, '.git'), { recursive: true })
  writeJson(path.join(workspaceDir, 'atelier.project.json'), projectDocument({ name, repositories, scopes }))
  writeJson(path.join(workspaceDir, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: Object.fromEntries(repositories.map((repoId) => [repoId, { readBoundary: 'team' }])),
  })
  return path.join(workspaceDir, 'atelier.project.json')
}

// The small synthetic workspace of the materialization fixture, written as
// files: the AP-01 and AP-02 corpus.
export function materializeFixtureWorkspace(workspaceDir, { fixture = path.join(REPOSITORY_ROOT, 'fixtures/obsidian/materialization/workspace.json'), scopes } = {}) {
  const workspace = readJson(fixture)
  for (const [relative, file] of Object.entries(workspace.files)) {
    const absolute = path.join(workspaceDir, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, file.hex ? Buffer.from(file.hex, 'hex') : Buffer.from(file.text, 'utf8'))
  }
  const projectFile = writeWorkspaceConfig(workspaceDir, { name: 'obsidian-acceptance-fixture', repositories: workspace.repositories, scopes })
  return { projectFile, repositories: workspace.repositories, withheldByEligibility: workspace.withheldByEligibility ?? [], sentinels: workspace.sentinels ?? [] }
}

export function loadProject(projectFile) {
  return resolveProjectConfig({ argv: [`--project=${projectFile}`], cwd: path.dirname(projectFile) })
}

// The seams the maintenance engine drives between ticks: one graph file
// cache, one preparation cache and one observation index that `observe`
// reconciles the way the engine does (every file hashed on a full pass, by
// stat hint otherwise). A derivation through these seams is the warm path a
// running service takes; `createProductionSeams()` alone is the path from
// nothing. The result bytes are the same either way.
export function createEngineSeams(base = createProductionSeams()) {
  const graphCache = base.createGraphCache()
  const preparationCache = base.createPreparationCache()
  const index = new Map()
  const seams = {
    ...base,
    buildGraph: (options) => base.buildGraph({ ...options, cache: graphCache, index }),
    captureSnapshot: (options) => base.captureSnapshot({ ...options, index }),
    prepareView: (options) => base.prepareView({ ...options, cache: preparationCache }),
  }
  const observe = (project, { full }) => reconcile({ index, files: listSourceFiles(project), prefix: 'source\u0000', full })
  return { seams, index, observe }
}

// One derivation into `vaultRoot`. Returns per-phase timings, the committed
// generation and what was written. Repeated calls continue the same recovery
// store, so a second call is the warm path: prior manifest, expected
// generation, replace units only where bytes changed.
// `withheld` lists node identities the fixture withholds by eligibility, on
// top of the production rule; `sentinels` are strings that must not appear in
// any vault byte afterwards, so a derivation that leaked a withheld node can
// never become evidence.
export async function deriveWorkspace({ projectFile, stateRoot, vaultRoot, scope = FULL_SCOPE, workspaceId = DEFAULT_WORKSPACE_ID, audienceAllow = ['team'], adapter = absentAdapter(), quietPeriodMs = 0, clock = () => new Date(), seams = createProductionSeams(), sampler = null, withheld = [], sentinels = [] } = {}) {
  const timings = {}
  sampler?.sample('derive-start')
  const project = await timed(timings, 'loadProjectMs', () => loadProject(projectFile))
  const withheldIds = new Set(withheld)
  const eligibility = { ...DEFAULT_ELIGIBILITY, isEligible: (node) => !withheldIds.has(node?.id) && DEFAULT_ELIGIBILITY.isEligible(node) === true }
  const graph = await timed(timings, 'buildGraphMs', () => seams.buildGraph({ project, eligibility }))
  sampler?.sample('graph-built')
  const configDigest = sha256Digest(fs.readFileSync(projectFile))
  // A seam set from createEngineSeams carries its own observation index; a bare production seam set observes nothing between calls.
  const snapshot = await timed(timings, 'captureSnapshotMs', () => seams.captureSnapshot({ project, graph, workspaceId, index: new Map(), configDigest, capturedAt: clock().toISOString() }))
  const repositoryRoots = project.repos.filter((repo) => !repo.external).map((repo) => repo.path)
  const store = seams.createRecoveryStore({ workspaceRoot: stateRoot, workspaceId, scopeId: scope.scopeId, vaultRoot, repositoryRoots })
  const priorManifest = store.readCurrentManifest() ?? null
  const profile = seams.profileFor({ project, workspaceId, audienceAllow })
  const prepared = await timed(timings, 'prepareViewMs', () => seams.prepareView({ snapshot, profile, scope, priorManifest, clock: () => clock().toISOString() }))
  sampler?.sample('view-prepared')
  const expectedGeneration = store.readCurrent()?.generationId ?? null
  const result = await timed(timings, 'publishViewMs', () => seams.publishView({ preparedView: prepared, protocolId: PROTOCOL_ID, expectedGeneration, recoveryStore: store, adapter, clock, quietPeriodMs }))
  sampler?.sample('view-published')
  timings.totalMs = Math.round(Object.values(timings).reduce((sum, value) => sum + value, 0) * 1000) / 1000
  const written = bytesUnder(vaultRoot)
  // A derivation that carries any withheld sentinel into the vault is not
  // evidence of anything and is refused here, before a receipt can name it.
  if (sentinels.length > 0) {
    for (const file of walkVault(vaultRoot)) {
      const text = fs.readFileSync(file).toString('latin1')
      for (const sentinel of sentinels) if (text.includes(sentinel)) throw new Error(`withheld sentinel reached the vault: ${path.relative(vaultRoot, file)}`)
      if (sentinels.some((sentinel) => path.relative(vaultRoot, file).includes(sentinel))) throw new Error(`withheld sentinel names a vault path: ${path.relative(vaultRoot, file)}`)
    }
  }
  return {
    timings,
    quietPeriodMs,
    state: result.state,
    mode: result.mode ?? null,
    generationId: result.generationId ?? prepared.manifest.generationId,
    expectedGeneration,
    graph: { nodes: graph.nodes.length, edges: graph.edges.length },
    manifest: prepared.manifest,
    files: prepared.files.map((file) => ({ path: file.path, kind: file.kind, digest: file.digest, byteLength: file.bytes.length })),
    written,
    store,
  }
}

export { PROTOCOL_ID, createRecoveryStore }

function walkVault(root) {
  const found = []
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.isFile()) found.push(full) } }
  walk(root)
  return found
}
