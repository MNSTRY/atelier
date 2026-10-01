import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nodeTest, { after } from 'node:test'

// The personal-workspace route of the Obsidian projection: one composed graph for every caller, typed refusals,
// projection fidelity for two people, views from the overlay, and preferences that never reach a vault's settings.
// Two invented people, Ari (repositories a and b, and an overlay) and Bea (repository a, and an overlay), with private
// homes made through the personal-workspace module's own API, outside every Git worktree, owned by this user, mode
// 0700. Scratch Git repositories, a scratch HOME and a data root per person. No app: the editor adapter is absent.
//
// Nothing here may start the installed app, its command-line tool, an operating-system opener or a service manager,
// directly or through a shell: an attempt throws before it runs.
const BANNED_PROGRAMS = ['obsidian-cli', 'obsidian', 'open', 'xdg-open', 'launchctl', 'systemctl']
const WRAPPERS = ['sh', 'bash', 'zsh', 'dash', 'env', 'cmd', 'powershell', 'pwsh', 'nohup', 'sudo']
const programName = (command) => path.basename(String(command).replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|app|cmd|bat)$/, '')
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  childProcess[method] = function guarded(command, args, ...rest) {
    const words = (method === 'exec' || method === 'execSync' ? ['sh', ...String(command).split(/\s+/)] : [command, ...(Array.isArray(args) ? args : [])]).map(String)
    const wrapper = WRAPPERS.includes(programName(words[0]))
    const banned = words.find((word, index) => ((index === 0 || wrapper) && BANNED_PROGRAMS.includes(programName(word))) || /obsidian:\/\//i.test(word) || /--adapter=obsidian-cli|app-production-seams/.test(word))
    if (banned !== undefined) throw new Error(`spawn guard: this suite may never start "${programName(banned)}"`)
    // The personal-workspace composition asks Git for core.fsmonitor once per enrolled repository: counted here, on the
    // main thread only (a worker has its own modules), it shows whether a composition ran on the event loop.
    if (words.includes('core.fsmonitor') && words.includes('--get-all')) globalThis.mainThreadCompositionProbes = (globalThis.mainThreadCompositionProbes ?? 0) + 1
    return original.call(this, command, args, ...rest)
  }
}
syncBuiltinESMExports()

// The personal-workspace module refuses ambient Git variables and configured helpers, and the projection must never
// reach a real data directory: the whole file runs under a sanitized environment and a scratch HOME.
const AMBIENT = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^GIT_/i.test(name) || /^MNSTRY_ATELIER_/.test(name) || ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].includes(name)))
for (const name of Object.keys(AMBIENT)) delete process.env[name]
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-pw-obsidian-')))
fs.chmodSync(SCRATCH, 0o700)
process.env.HOME = path.join(SCRATCH, 'home')
process.env.XDG_CONFIG_HOME = path.join(SCRATCH, 'home', '.config')
fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 })
after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name) || ['HOME', 'XDG_CONFIG_HOME'].includes(name)) delete process.env[name]
  Object.assign(process.env, AMBIENT)
})

const {
  MANIFEST_SCHEMA, OVERLAY_SCHEMA, PersonalWorkspaceRefusal, composePersonalWorkspace, materializePersonalGeneration, planPersonalGeneration, resolvePersonalWorkspace,
} = await import('@mnstry/atelier/personal-workspace')
const { resolveProjectConfig } = await import('../src/project/config.mjs')
const { buildCanonicalGraph } = await import('../src/graph/graph.mjs')
const { OBSIDIAN_EXT_KEY, selectScope } = await import('../src/projection/obsidian/contracts.mjs')
const { withEligibility } = await import('../src/projection/obsidian/materialize/index.mjs')
const { createEditorAdapter, resolveExchange } = await import('../src/projection/obsidian/publication/index.mjs')
const { SOURCE_APPLY_PRIMITIVES, createSourceApplyForOracleTests } = await import('../src/projection/obsidian/edits/index.mjs')
const { createProposalAdapter } = await import('../src/projection/obsidian/proposals/index.mjs')
const { createSelectionContribution } = await import('../src/projection/obsidian/selection-ui/contribution.mjs')
const { EXIT, runObsidianCommandForOracleTests } = await import('../src/commands/obsidian.mjs')
const { createMaintenanceEngine } = await import('../src/runtime/obsidian/engine.mjs')
const { createMaintenanceExtensions } = await import('../src/runtime/obsidian/extension-points.mjs')
const { readObsidianEnablement } = await import('../src/runtime/obsidian/enablement.mjs')
const { ONLY_YOU_AUDIENCES, defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, withDecision, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { DEFAULT_ELIGIBILITY, assetEligibilityFor, captureSnapshot, createProductionSeams, profileFor } = await import('../src/runtime/obsidian/pipeline.mjs')
const { createMaintenanceStateStore } = await import('../src/runtime/obsidian/state-store.mjs')
const { viewCounts } = await import('../src/runtime/obsidian/view-counts.mjs')
const { EVERYTHING_SCOPE_ID, PERSONAL_MEMBER_KEY, validatePersonalWorkspace, bindPersonalWorkspace, createPersonalWorkspaceBinderForOracleTests, loadBoundProject, loadBoundProjectOffThread, personalWorkspaceBindingOf, personalWorkspaceScopes } = await import('../src/projection/obsidian/personal-workspace.mjs')

const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const test = (name, fn) => nodeTest(name, {
  skip: process.platform === 'win32' ? 'private-root qualification is POSIX-only in the personal-workspace module'
    : !EXCHANGE_HERE ? 'no atomic exchange on this platform: the publisher refuses, which the recovery suite asserts' : false,
}, fn)

const NOW = '2026-01-05T10:00:00.000Z'
const clock = () => new Date(NOW)
const ROOT = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)))

// Canaries: bytes that may appear only where their owner's graph reaches.
const CANARY = Object.freeze({ bOnly: 'B_ONLY_', ari: 'ARI_', bea: 'BEA_' })
const noteText = ({ id, title, body, audience = 'team' }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "${audience}"\n---\n\n# ${title}\n\n${body}\n`
// A shared note whose wikilink names a private note by its file name: the canonical builder resolves it in a plain
// build of the generation's configuration, and composition does not, since private nodes are never link targets.
const SHARED_A = {
  'notes/harbor.md': noteText({ id: 'a:harbor', title: 'Harbor', body: 'Shared harbor note. The private side is in [[workspace]].' }),
  'notes/tide.md': noteText({ id: 'a:tide', title: 'Tide', body: 'Tide tables follow the [[Harbor]].\n\n![[assets/chart.png]]' }),
  'assets/chart.png': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
}
const SHARED_B = {
  'notes/ledger.md': noteText({ id: 'b:ledger', title: 'Ledger', body: `${CANARY.bOnly}LEDGER_7f3a ledger entries.` }),
  'notes/cargo.md': noteText({ id: 'b:cargo', title: 'Cargo', body: `${CANARY.bOnly}CARGO_2b81 cargo list, see [[Ledger]].` }),
}

const GIT_ENV = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME })
const git = (cwd, args) => childProcess.execFileSync('git', ['-c', 'user.name=Synthetic Author', '-c', 'user.email=author@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const isoNoJournal = (text) => text.replace(/journal-\d{17}-[0-9a-f]{8}/g, 'journal-X')

// Every file under `directory` by digest, links by target, directories by name. `normalize` rewrites relative paths
// and contents first (random journal identities); lstat throughout, so a symlinked root is seen as a link.
function treeListing(directory, { skip = () => false, normalize = (value) => value } = {}) {
  const found = {}
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) return found
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(current, entry.name)
      const relative = normalize(path.relative(directory, absolute).split(path.sep).join('/'))
      if (skip(relative)) continue
      if (entry.isSymbolicLink()) found[relative] = `link:${fs.readlinkSync(absolute)}`
      else if (entry.isDirectory()) { found[`${relative}/`] = 'directory'; walk(absolute) } else found[relative] = digestOf(normalize(fs.readFileSync(absolute, 'latin1')))
    }
  }
  walk(directory)
  return found
}
// The files under `directory` whose path or bytes hold any of `needles`.
function canariesIn(directory, needles) {
  const hits = []
  if (!fs.existsSync(directory)) return hits
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(directory, absolute)
      for (const needle of needles) if (relative.includes(needle)) hits.push(`${relative} (path: ${needle})`)
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(absolute)
      else if (entry.isFile()) { const bytes = fs.readFileSync(absolute); for (const needle of needles) if (bytes.includes(needle)) hits.push(`${relative} (${needle})`) }
    }
  }
  walk(directory)
  return hits
}
const unbound = (project) => Object.fromEntries(Object.entries(project)) // the same project, without the symbol-keyed binding
// The same project as an ordinary one: no binding, and a settings member that does not name a personal workspace. What a
// caller that routed around the binding would build from.
const routedAround = (project) => {
  const { ext: _personal, ...member } = project.config.ext[OBSIDIAN_EXT_KEY]
  return { ...unbound(project), config: { ...project.config, ext: { ...project.config.ext, [OBSIDIAN_EXT_KEY]: member } } }
}
const graphFacts = (graph) => ({ nodes: graph.nodes, edges: graph.edges, embeds: graph.embeds ?? [], assets: graph.assets ?? [] })
const eligible = (graph) => withEligibility(graph, DEFAULT_ELIGIBILITY.isEligible, assetEligibilityFor({ graph, eligibility: DEFAULT_ELIGIBILITY }))
const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })

function makeRepository(base, name, files) {
  const root = path.join(base, 'shared', name)
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'synthetic fixture'])
  return root
}

// One person: a private home made through the module's own API, a generation materialized from it, the binding, and
// machine settings deciding "only you" (notes without a classification withheld).
function makePerson(world, { name, repos, overlay, fill }) {
  const home = path.join(world.base, 'homes', name)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  const person = {
    name, home, dataRoot: path.join(world.base, 'data', name),
    manifest: { schema: MANIFEST_SCHEMA, workspaceId: name, revision: 1, bindings: [repos[0].root], repos: repos.map(({ repoId, root }) => ({ repoId, root, remote: null, enrolled: true })) },
    overlay: { schema: OVERLAY_SCHEMA, workspaceId: name, annotations: [], connections: [], collections: [], views: [], preferences: {}, ...overlay },
    randomBytes: (size) => Buffer.alloc(size, fill),
  }
  person.save = () => {
    fs.writeFileSync(path.join(home, 'atelier.personal.json'), JSON.stringify(person.manifest))
    fs.writeFileSync(path.join(home, 'atelier.overlay.json'), JSON.stringify(person.overlay))
  }
  person.materialize = () => {
    person.save()
    const plan = planPersonalGeneration(resolvePersonalWorkspace({ folder: repos[0].root, personalHome: home }))
    person.generationId = materializePersonalGeneration(plan, { personalHome: home }).generationId
    return person.generationId
  }
  person.bind = (binder = bindPersonalWorkspace) => { person.bound = binder({ personalHome: home, generationId: person.generationId }); return person.bound }
  person.loadProject = () => person.bound.project
  person.compose = () => composePersonalWorkspace({ personalHome: home, generationId: person.generationId })
  person.expected = () => eligible(person.compose().graph)
  person.workspaceRoot = () => fs.realpathSync(workspaceStateRoot(person.dataRoot, person.workspaceId))
  person.vault = (scopeId) => path.join(person.workspaceRoot(), 'vaults', scopeId)
  person.stateStore = () => createMaintenanceStateStore({ workspaceRoot: person.workspaceRoot(), workspaceId: person.workspaceId })
  person.manifestOf = (scopeId) => {
    const directory = path.join(person.workspaceRoot(), 'state', 'manifests', scopeId)
    return JSON.parse(fs.readFileSync(path.join(directory, JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8')).manifestFile), 'utf8'))
  }
  person.scopes = () => readObsidianEnablement(person.bound.project).scopes
  person.engine = ({ seams = {}, extensions = createMaintenanceExtensions(), loadProject = person.loadProject, ...options } = {}) => createMaintenanceEngine({
    loadProject, dataRoot: person.dataRoot, adapterFactory: absentAdapter, clock, randomBytes: person.randomBytes, quietPeriodMs: 0, extensions, env: process.env, seams, ...options,
  })
  person.command = async (argv, { contributions = [], loadProject = person.loadProject } = {}) => {
    const out = []
    const exit = await runObsidianCommandForOracleTests({ argv: [...argv, '--json'], seams: {}, loadProject, dataRoot: person.dataRoot, env: process.env, cwd: home, clock, contributions, stdout: (text) => out.push(text), stderr: (text) => out.push(text), account: () => 'person-synthetic' })
    return { exit, json: JSON.parse(out.join('\n')) }
  }
  person.materialize()
  person.bind()
  const pointer = ensureWorkspaceIdentity({ project: person.bound.project, randomBytes: person.randomBytes })
  person.workspaceId = pointer.workspaceId
  // "Only you", notes without a classification withheld: what `audience set` would record, written as a fixture since a
  // personal binding refuses that command (test 6).
  person.decideAudience = () => {
    const settings = withDecision({ ...defaultMachineSettings({ workspaceId: pointer.workspaceId, updatedAt: NOW }), audienceAllow: [...ONLY_YOU_AUDIENCES] }, 'audience', { choice: 'only-you', unclassified: 'withheld' }, { decidedAt: NOW, via: 'command' })
    writeMachineSettings({ workspaceRoot: workspaceStateRoot(person.dataRoot, pointer.workspaceId), workspaceId: pointer.workspaceId, repositoryRoots: protectedRoots(person.bound.project), settings })
  }
  person.decideAudience()
  return person
}

function makeWorld(t, { people = ['ari', 'bea'] } = {}) {
  const base = path.join(SCRATCH, `world-${Math.random().toString(16).slice(2, 10)}`)
  fs.mkdirSync(base, { mode: 0o700 })
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const world = { base }
  world.a = makeRepository(base, 'a', SHARED_A)
  world.b = makeRepository(base, 'b', SHARED_B)
  world.sharedBefore = [treeListing(world.a), treeListing(world.b)]
  if (people.includes('ari')) {
    world.ari = makePerson(world, {
      name: 'ari', fill: 0x0a, repos: [{ repoId: 'a', root: world.a }, { repoId: 'b', root: world.b }],
      overlay: {
        annotations: [{ id: 'harbor-thought', target: { repoId: 'a', nodeId: 'a:harbor' }, note: `${CANARY.ari}HARBOR_51c2 the harbor matters most.`, displayAlias: 'Ari on the harbor', tags: ['reading'] }],
        connections: [{ id: 'harbor-ledger', from: { repoId: 'a', nodeId: 'a:harbor' }, to: { repoId: 'b', nodeId: 'b:ledger' }, label: 'Harbor pays into the ledger' }],
        collections: [{ id: 'shelf', name: 'Shelf', members: [{ repoId: 'a', nodeId: 'a:tide' }] }],
        views: [{ id: 'harbor-only', name: 'Harbor only', repoIds: ['a'] }, { id: 'both', name: 'Both', repoIds: ['a', 'b'] }],
        preferences: { theme: 'dark', defaultView: 'harbor-only' },
      },
    })
  }
  if (people.includes('bea')) {
    world.bea = makePerson(world, {
      name: 'bea', fill: 0x0b, repos: [{ repoId: 'a', root: world.a }],
      overlay: {
        annotations: [{ id: 'tide-thought', target: { repoId: 'a', nodeId: 'a:tide' }, note: `${CANARY.bea}TIDE_9d04 tides are early this year.` }],
        views: [{ id: 'mine', name: 'Mine', repoIds: ['a'] }],
        preferences: { theme: 'light' },
      },
    })
  }
  return world
}

// Records the graph each caller builds through the production seam, under the caller's name.
function recorder() {
  const production = createProductionSeams()
  const graphs = new Map()
  return {
    graphs,
    seamsFor: (caller) => ({ ...production, buildGraph: (args) => { const graph = production.buildGraph(args); graphs.set(caller, graph); return graph } }),
  }
}

// What viewCounts reports, computed from a given graph with the contract's own selection.
function countsOver(graph, { project, scope, audienceAllow, workspaceId }) {
  const known = new Set(graph.nodes.map((node) => node.id))
  const profile = profileFor({ project, workspaceId, audienceAllow })
  const selection = selectScope({ canonicalSnapshot: { nodes: graph.nodes, edges: graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target)) }, profile, selector: scope.selector, expansion: scope.expansion, mode: scope.mode })
  const named = selectScope({ canonicalSnapshot: { nodes: graph.nodes.map((node) => ({ ...node, eligible: true, audience: undefined })), edges: [] }, profile, selector: scope.selector, mode: scope.mode === 'focus' ? 'scoped' : scope.mode }).nodes
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const withheld = { unclassified: 0, audience: 0 }
  for (const id of named) {
    if (byId.get(id).eligible !== true) withheld.unclassified += 1
    else if (byId.get(id).audience !== undefined && !audienceAllow.includes(byId.get(id).audience)) withheld.audience += 1
  }
  return { corpus: graph.nodes.length, named: named.length, shown: selection.nodes.length, withheld, truncated: selection.truncated }
}
// A view of repository a that follows outgoing links one step: it shows the private note a plain build links to.
const PROBE_SCOPE = Object.freeze({ scopeId: 'probe', mode: 'scoped', selector: { repo: 'a' }, expansion: { depth: 1, maxNodes: 100, direction: 'outgoing' } })

// Edits the first note of `scopeId` from repository a in the vault, and lets the engine preserve and queue it.
async function queueVaultEdit(person, engine, scopeId) {
  const note = person.manifestOf(scopeId).notes.find((item) => item.repoId === 'a' && item.nodeId === 'a:harbor')
  const file = path.join(person.vault(scopeId), note.path)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Shared harbor note.', 'Shared harbor note, edited in the vault.'))
  const ticked = await engine.tick()
  const edit = ticked.pendingEdits.find((item) => item.scopeId === scopeId)
  assert.ok(edit, `the edit is queued: ${JSON.stringify(ticked.pendingEdits)}`)
  return edit
}

// The five callers' graphs for one person, and the view counts, each through its own production path.
async function fiveCallers(person, { routeAround = null } = {}) {
  const rec = recorder()
  const loadFor = (caller) => (routeAround === caller ? () => routedAround(person.bound.project) : person.loadProject)
  const engine = person.engine({ seams: rec.seamsFor('engine'), loadProject: loadFor('engine') })
  const started = Date.now()
  const first = await engine.tick()
  const firstTickMs = Date.now() - started
  assert.equal(first.state, 'ticked', JSON.stringify(first.refusal ?? first))
  const edit = await queueVaultEdit(person, engine, 'harbor-only')
  // Proposals: the adapter observes the queued edit, which builds its corpus.
  const project = loadFor('proposals')()
  const adapter = createProposalAdapter({ clock, env: process.env, seams: rec.seamsFor('proposals') })
  await adapter.observe({ project, workspaceRoot: person.workspaceRoot(), workspaceId: person.workspaceId, repositoryRoots: protectedRoots(project), edits: person.stateStore().readPendingEdits().edits, clock, env: process.env }, { retryRefused: true })
  // Source apply: its corpus is built first, then the decision is made to refuse, so no source is written.
  const stopAfterCorpus = { ...SOURCE_APPLY_PRIMITIVES, decide: () => ({ allowed: false, code: 'object-not-visible' }) }
  const applied = await createSourceApplyForOracleTests(stopAfterCorpus)({ loadProject: loadFor('apply'), dataRoot: person.dataRoot, env: process.env, clock, quietPeriodMs: 0, seams: rec.seamsFor('apply') }).apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
  assert.equal(applied.code, 'object-not-visible', JSON.stringify(applied))
  // The selection snapshot, through the command and the shipped selection contribution.
  const selection = await person.command(['selection', 'resolve', EVERYTHING_SCOPE_ID], { contributions: [createSelectionContribution({ seams: rec.seamsFor('selection') })], loadProject: loadFor('selection') })
  assert.equal(selection.exit, EXIT.ok, JSON.stringify(selection.json))
  // View counts: built through the pipeline's buildGraph, which it imports directly.
  const countsProject = loadFor('view-counts')()
  const counts = [...person.scopes(), PROBE_SCOPE].map((scope) => ({ scopeId: scope.scopeId, counts: viewCounts({ project: countsProject, audienceAllow: [...ONLY_YOU_AUDIENCES], scope, eligibility: DEFAULT_ELIGIBILITY, workspaceId: person.workspaceId }) }))
  engine.stop()
  return { graphs: rec.graphs, counts, selection: selection.json.selection, firstTickMs }
}

function assertOneGraph(person, { graphs, counts }) {
  const expected = person.expected()
  for (const caller of ['engine', 'proposals', 'apply', 'selection']) {
    assert.ok(graphs.has(caller), `${caller} built a graph`)
    assert.deepEqual(graphFacts(graphs.get(caller)), graphFacts(expected), `${caller}: the composed graph, with eligibility applied`)
  }
  for (const { scopeId, counts: actual } of counts) {
    const scope = scopeId === PROBE_SCOPE.scopeId ? PROBE_SCOPE : person.scopes().find((item) => item.scopeId === scopeId)
    assert.deepEqual(actual, countsOver(expected, { project: person.bound.project, scope, audienceAllow: [...ONLY_YOU_AUDIENCES], workspaceId: person.workspaceId }), `view counts of ${scopeId}: those of the composed graph`)
  }
}

test('1. five callers, one graph: engine, view counts, apply, proposals and selection read the composed graph; one caller routed around the binding fails', async (t) => {
  const { ari } = makeWorld(t, { people: ['ari'] })
  const run = await fiveCallers(ari)
  assertOneGraph(ari, run)
  // Composition is asked on every build. The tick time is reported, not asserted.
  const composeStarted = Date.now()
  ari.compose()
  t.diagnostic(`composition on every build: first engine tick ${run.firstTickMs} ms (three views published); one compose ${Date.now() - composeStarted} ms`)
  // Mutation controls: the selection operation, and view counts, each given the same project without its binding.
  for (const caller of ['selection', 'view-counts']) {
    const other = makeWorld(t, { people: ['ari'] }).ari
    const around = await fiveCallers(other, { routeAround: caller })
    assert.throws(() => assertOneGraph(other, around), assert.AssertionError, `${caller} routed around the binding must be caught`)
  }
})

test('2. divergence control: a plain build of the generation configuration differs from composition on a shared note that links to a private note', (t) => {
  const { ari } = makeWorld(t, { people: ['ari'] })
  const generation = path.join(ari.home, 'generations', ari.generationId)
  const plainProject = resolveProjectConfig({ argv: [`--project-config=${path.join(generation, 'atelier.project.json')}`], cwd: generation, env: { PATH: process.env.PATH }, writeLocalState: false })
  const plain = eligible(buildCanonicalGraph(plainProject))
  const composed = ari.expected()
  const shortcut = (graph) => graph.edges.filter((edge) => edge.source === 'a:harbor' && edge.target === 'personal-ari:workspace')
  assert.equal(shortcut(composed).length, 0, 'composition never makes a private note the target of a shared note\'s link')
  assert.equal(shortcut(plain).length, 1, 'the plain build now agrees with composition on this link: the divergence the route exists for is gone; revisit the route before trusting either')
  assert.notDeepEqual(graphFacts(plain), graphFacts(composed))
  // The pipeline's build of the bound project is the composed one, and of the same project without the binding the plain one.
  const { buildGraph } = createProductionSeams()
  assert.deepEqual(graphFacts(buildGraph({ project: ari.bound.project, eligibility: DEFAULT_ELIGIBILITY })), graphFacts(composed))
  assert.deepEqual(graphFacts(buildGraph({ project: routedAround(ari.bound.project), eligibility: DEFAULT_ELIGIBILITY })).edges, plain.edges)
})

test('3. coverage is never permission: no Obsidian source reads it, and a permissive coverage changes no output byte', async (t) => {
  // Structural: every Obsidian source, the command included.
  const sources = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (file.endsWith('.mjs')) sources.push(file) } }
  walk(path.join(ROOT, 'src', 'projection', 'obsidian'))
  walk(path.join(ROOT, 'src', 'runtime', 'obsidian'))
  sources.push(path.join(ROOT, 'src', 'commands', 'obsidian.mjs'))
  const code = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n')
  for (const file of sources) {
    const text = code(file)
    assert.doesNotMatch(text, /\benforcement\b|manifest-only|\buncovered\b/, `${path.relative(ROOT, file)} reads what coverage says`)
    assert.doesNotMatch(text, /coverage\s*(\?\.|\.)\s*(profile|enforcement|uncovered)|coverage\s*\[|\{[^}]*\bprofile\b[^}]*\}\s*=\s*[^;\n]*coverage/, `${path.relative(ROOT, file)} reads a member of coverage`)
  }
  const route = code(path.join(ROOT, 'src', 'projection', 'obsidian', 'personal-workspace.mjs'))
  const passThrough = route.match(/coverage: composed\.coverage/g) ?? []
  assert.ok(passThrough.length > 0)
  assert.equal(route.match(/coverage/g).length, passThrough.length * 2, 'every mention of coverage in the route passes it through')

  // Behavioural: the same person bound twice, once with the module's coverage and once with a permissive one, into
  // two data roots. Every output byte is the same, apart from journal identities and lock records, which are random
  // per acquisition and carry no byte of the graph.
  const { ari } = makeWorld(t, { people: ['ari'] })
  let calls = 0
  const permissive = createPersonalWorkspaceBinderForOracleTests({ compose: (input) => { calls += 1; return { ...composePersonalWorkspace(input), coverage: { profile: 'full', enforcement: 'enforced', uncovered: [], permission: 'granted' } } } })
  const runs = []
  for (const binder of [bindPersonalWorkspace, permissive]) {
    ari.bind(binder)
    ari.decideAudience()
    const engine = ari.engine()
    const ticked = await engine.tick()
    engine.stop()
    assert.deepEqual(ticked.scopes.map((scope) => scope.state), ['current', 'current', 'current'], JSON.stringify(ticked.scopes))
    const selection = await ari.command(['selection', 'resolve', 'both'], { contributions: [createSelectionContribution()] })
    const counts = ari.scopes().map((scope) => viewCounts({ project: ari.bound.project, audienceAllow: [...ONLY_YOU_AUDIENCES], scope, eligibility: DEFAULT_ELIGIBILITY, workspaceId: ari.workspaceId }))
    runs.push({ tree: treeListing(ari.dataRoot, { normalize: isoNoJournal, skip: (relative) => relative.includes('/engine-lock') || relative.includes('.lock.owners') }), selection: selection.json, counts })
    fs.renameSync(ari.dataRoot, `${ari.dataRoot}-${runs.length}`)
  }
  assert.ok(calls > 0, 'the permissive composition admitted the second binding')
  // Both runs were built through the route: the graph of the permissive binding is the composition's.
  assert.deepEqual(graphFacts(createProductionSeams().buildGraph({ project: ari.bound.project, eligibility: DEFAULT_ELIGIBILITY })), graphFacts(ari.expected()), 'the second run read the composed graph')
  assert.equal(ari.bound.coverage.permission, 'granted', 'the coverage was passed through untouched')
  assert.deepEqual(runs[1], runs[0])
})

// The personal-workspace refusal codes a binding can reach, how each is brought about at a home that was valid, and how it is undone.
function refusalCases(world, person) {
  const generation = path.join(person.home, 'generations', person.generationId)
  const overlayFile = path.join(person.home, 'atelier.overlay.json')
  const manifestFile = path.join(person.home, 'atelier.personal.json')
  const original = { overlay: fs.readFileSync(overlayFile), manifest: fs.readFileSync(manifestFile), workspace: fs.readFileSync(path.join(generation, 'overlay', 'workspace.md')) }
  const restoreInputs = () => { fs.writeFileSync(overlayFile, original.overlay); fs.writeFileSync(manifestFile, original.manifest) }
  const edited = (file, change) => { const document = JSON.parse(fs.readFileSync(file, 'utf8')); change(document); fs.writeFileSync(file, JSON.stringify(document)) }
  const aside = `${person.home}-real`
  return {
    'stale-generation': { induce: () => edited(overlayFile, (overlay) => { overlay.annotations[0].note += ' Revised.' }), restore: restoreInputs },
    'generation-missing': { induce: () => fs.renameSync(path.join(person.home, 'generations'), path.join(person.home, 'generations-aside')), restore: () => fs.renameSync(path.join(person.home, 'generations-aside'), path.join(person.home, 'generations')) },
    'generation-corrupt': { induce: () => fs.appendFileSync(path.join(generation, 'overlay', 'workspace.md'), '\nAppended.\n'), restore: () => fs.writeFileSync(path.join(generation, 'overlay', 'workspace.md'), original.workspace) },
    'retained-removed-reference': { induce: () => edited(manifestFile, (manifest) => { manifest.repos.find((repo) => repo.repoId === 'b').enrolled = false }), restore: restoreInputs },
    'not-private-location': { induce: () => fs.chmodSync(person.home, 0o770), restore: () => fs.chmodSync(person.home, 0o700) },
    'root-symlinked': { induce: () => { fs.renameSync(person.home, aside); fs.symlinkSync(aside, person.home) }, restore: () => { fs.unlinkSync(person.home); fs.renameSync(aside, person.home) } },
    'ambient-git-environment': { induce: () => { process.env.GIT_DIR = path.join(world.b, '.git') }, restore: () => { delete process.env.GIT_DIR } },
    'future-schema': { induce: () => edited(overlayFile, (overlay) => { overlay.schema = 'atelier-personal-workspace-overlay@v2' }), restore: restoreInputs },
    'ambiguous-binding': { induce: () => edited(manifestFile, (manifest) => { manifest.bindings = [world.a, path.join(world.a, 'notes')] }), restore: restoreInputs },
  }
}

test('4. typed refusals: every personal-workspace refusal a binding reaches is surfaced, nothing is written, and no view is current', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  const cases = refusalCases(world, ari)
  const everything = () => ({ homes: treeListing(path.join(world.base, 'homes')), data: treeListing(ari.dataRoot), a: treeListing(world.a), b: treeListing(world.b) })

  // At bind time: the module's own refusal, before anything is read or written.
  for (const [code, { induce, restore }] of Object.entries(cases)) {
    induce()
    try {
      const before = everything()
      assert.throws(() => bindPersonalWorkspace({ personalHome: ari.home, generationId: ari.generationId }), (error) => error instanceof PersonalWorkspaceRefusal && error.code === code && !error.message.includes(ari.home), `bind refuses ${code}`)
      assert.deepEqual(everything(), before, `${code} at bind: nothing written`)
    } finally { restore() }
  }
  // A moved home: its generation recorded the old place.
  const moved = path.join(world.base, 'homes', 'ari-moved')
  fs.cpSync(ari.home, moved, { recursive: true, preserveTimestamps: true })
  fs.chmodSync(moved, 0o700)
  const beforeMoved = everything()
  assert.throws(() => bindPersonalWorkspace({ personalHome: moved, generationId: ari.generationId }), (error) => error instanceof PersonalWorkspaceRefusal && error.code === 'generation-relocated')
  assert.deepEqual(everything(), beforeMoved, 'generation-relocated at bind: nothing written')
  fs.rmSync(moved, { recursive: true })

  // At build time: a bound engine whose views are current, then each condition, and a preparation asked of every view.
  const engine = ari.engine()
  t.after(() => engine.stop())
  const first = await engine.tick()
  assert.deepEqual(first.scopes.map((scope) => scope.state), ['current', 'current', 'current'], JSON.stringify(first.scopes))
  const kept = (relative) => relative.endsWith('state/maintenance/freshness.json') || relative.includes('state/maintenance/engine-lock')
  const reached = []
  for (const [code, { induce, restore }] of Object.entries(cases)) {
    induce()
    try {
      const before = { homes: treeListing(path.join(world.base, 'homes')), data: treeListing(ari.dataRoot, { skip: kept }), a: treeListing(world.a), b: treeListing(world.b) }
      for (const scope of ari.scopes()) engine.requestPreparation(scope.scopeId)
      const ticked = await engine.tick()
      const states = ticked.state === 'ticked' ? ticked.scopes.map((scope) => [scope.scopeId, scope.state, scope.reason]) : [['*', ticked.state, ticked.refusal?.code]]
      for (const [, state, reason] of states) {
        assert.notEqual(state, 'current', `${code}: no view is current`)
        assert.equal(reason, code, `${code}: the code is surfaced (${JSON.stringify(states)})`)
      }
      const freshness = ari.stateStore().readFreshness()
      assert.ok(freshness.scopes.every((scope) => scope.state !== 'current' && scope.reason === code), `${code}: the freshness document says so`)
      assert.deepEqual({ homes: treeListing(path.join(world.base, 'homes')), data: treeListing(ari.dataRoot, { skip: kept }), a: treeListing(world.a), b: treeListing(world.b) }, before, `${code}: no vault, manifest, journal, registry, edit, recovery or private-home byte is written`)
      reached.push(code)
    } finally { restore() }
  }
  assert.deepEqual(reached, Object.keys(cases))
  // Undone, the same generation is current again, and the vaults are the ones published first.
  for (const scope of ari.scopes()) engine.requestPreparation(scope.scopeId)
  const again = await engine.tick()
  assert.deepEqual(again.scopes.map((scope) => [scope.state, scope.reason]), again.scopes.map(() => ['current', 'verified-by-read-back']))
})

test('5. projection fidelity for both people: each vault is that person\'s eligible composed graph, and no canary crosses', async (t) => {
  const world = makeWorld(t)
  const published = {}
  for (const person of [world.ari, world.bea]) {
    const engine = person.engine()
    const ticked = await engine.tick()
    engine.stop()
    assert.ok(ticked.scopes.every((scope) => scope.state === 'current'), JSON.stringify(ticked.scopes))
    const expected = person.expected()
    const registry = person.stateStore().readPathRegistry()
    for (const scope of person.scopes()) {
      const manifest = person.manifestOf(scope.scopeId)
      const vault = person.vault(scope.scopeId)
      const notesOnDisk = Object.keys(treeListing(vault, { skip: (relative) => relative.startsWith('.obsidian') || relative.startsWith('.atelier-publication') })).filter((relative) => relative.endsWith('.md')).sort()
      assert.deepEqual(notesOnDisk, manifest.notes.map((note) => note.path).sort(), `${person.name}/${scope.scopeId}: the vault holds exactly the manifest's notes`)
      const snapshot = captureSnapshot({ project: person.bound.project, graph: expected, workspaceId: person.workspaceId, index: new Map(), configDigest: `sha256:${'0'.repeat(64)}`, capturedAt: NOW })
      const prepared = createProductionSeams().prepareView({ snapshot, profile: profileFor({ project: person.bound.project, workspaceId: person.workspaceId, audienceAllow: [...ONLY_YOU_AUDIENCES] }), scope, persistentPathRegistry: registry, priorManifest: null, existingSettings: null, clock, vaultRootBytes: Buffer.byteLength(vault, 'utf8'), viewScopeIds: person.scopes().map((item) => item.scopeId) })
      const preparedNotes = Object.fromEntries(prepared.files.filter((file) => file.path.endsWith('.md')).map((file) => [file.path, digestOf(file.bytes)]))
      assert.deepEqual(Object.fromEntries(notesOnDisk.map((relative) => [relative, digestOf(fs.readFileSync(path.join(vault, relative)))])), preparedNotes, `${person.name}/${scope.scopeId}: the bytes of prepareView over the eligible composed graph`)
      published[`${person.name}/${scope.scopeId}`] = { vault, manifest }
    }
  }
  // The snapshot pins every repository the graph names, the private overlay of the generation included.
  const snapshot = captureSnapshot({ project: world.ari.bound.project, graph: world.ari.expected(), workspaceId: world.ari.workspaceId, index: new Map(), configDigest: `sha256:${'0'.repeat(64)}`, capturedAt: NOW })
  const overlay = snapshot.document.repositories.find((repo) => repo.repoId === 'personal-ari')
  assert.deepEqual(overlay.files.map((file) => file.path).sort(), world.ari.expected().nodes.filter((node) => node.repo === 'personal-ari').map((node) => node.path).sort())
  assert.ok(snapshot.readSource('personal-ari', 'workspace.md').equals(fs.readFileSync(path.join(world.ari.home, 'generations', world.ari.generationId, 'overlay', 'workspace.md'))))

  // Canaries: Bea's vaults, manifests, freshness, diagnostics, plugin data and whole data root, and her home, hold
  // nothing of B or of Ari; Ari's hold nothing of Bea.
  assert.deepEqual(canariesIn(world.bea.dataRoot, [CANARY.bOnly, CANARY.ari]), [])
  assert.deepEqual(canariesIn(world.bea.home, [CANARY.bOnly, CANARY.ari]), [])
  assert.deepEqual(canariesIn(world.ari.dataRoot, [CANARY.bea]), [])
  assert.deepEqual(canariesIn(world.ari.home, [CANARY.bea]), [])
  assert.ok(canariesIn(world.ari.dataRoot, [CANARY.bOnly]).length > 0 && canariesIn(world.ari.dataRoot, [CANARY.ari]).length > 0, 'the scan sees canaries where they belong')
  // A shared note in a view of shared repository a carries no row of a private note: a count at most.
  for (const key of ['ari/harbor-only', 'bea/mine']) {
    const { vault, manifest } = published[key]
    const harbor = fs.readFileSync(path.join(vault, manifest.notes.find((note) => note.nodeId === 'a:harbor').path), 'utf8')
    const generated = harbor.slice(harbor.indexOf('## Relations (generated)'))
    assert.doesNotMatch(generated, /^- /m, `${key}: no relation row on the shared note`)
    assert.doesNotMatch(harbor, /ARI_|BEA_|personal-|Ari on the harbor/, `${key}: nothing private named on the shared note`)
  }
  // No shared source was written.
  assert.deepEqual([treeListing(world.a), treeListing(world.b)], world.sharedBefore)
})

test('6. views come from the overlay; view add, audience and location refuse typed and write nothing', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  const enablement = readObsidianEnablement(ari.bound.project)
  assert.deepEqual(enablement.scopes.map(({ scopeId, mode, selector }) => ({ scopeId, mode, selector })), [
    { scopeId: 'harbor-only', mode: 'scoped', selector: { repo: 'a' } },
    { scopeId: 'both', mode: 'scoped', selector: { union: [{ repo: 'a' }, { repo: 'b' }] } },
    { scopeId: EVERYTHING_SCOPE_ID, mode: 'full', selector: { all: true } },
  ])
  assert.equal(enablement.defaultScopeId, 'harbor-only', 'the preferred view is the default')
  assert.deepEqual(personalWorkspaceBindingOf(ari.bound.project), { personalHome: ari.home, generationId: ari.generationId, overlayRepoId: 'personal-ari' })
  assert.ok(Object.isFrozen(ari.bound.binding))
  assert.equal(Object.getOwnPropertySymbols(ari.bound.project).length, 1, 'one symbol key')
  assert.doesNotMatch(JSON.stringify(ari.bound.project), /overlayRepoId/, 'the binding is never serialized with the project')
  const engine = ari.engine()
  const ticked = await engine.tick()
  engine.stop()
  assert.deepEqual(ticked.scopes.map((scope) => scope.scopeId), ['both', EVERYTHING_SCOPE_ID, 'harbor-only'])
  const sourcesOf = (scopeId) => new Set(ari.manifestOf(scopeId).notes.map((note) => note.repoId))
  assert.deepEqual([...sourcesOf('harbor-only')], ['a'])
  assert.deepEqual([...sourcesOf('both')].sort(), ['a', 'b'])
  assert.deepEqual([...sourcesOf(EVERYTHING_SCOPE_ID)].sort(), ['a', 'b', 'personal-ari'])

  const before = { homes: treeListing(path.join(world.base, 'homes')), data: treeListing(ari.dataRoot), a: treeListing(world.a), b: treeListing(world.b) }
  for (const [argv, code] of [
    [['view', 'add', 'extra', '--all', '--yes'], 'views-from-personal-overlay'],
    [['view', 'add', 'extra', '--repo', 'a', '--folder', 'notes', '--default', '--allow-empty', '--yes'], 'views-from-personal-overlay'],
    [['audience', 'set', 'me'], 'personal-binding-decision-unavailable'],
    [['audience', 'clear'], 'personal-binding-decision-unavailable'],
    [['location', 'set', path.join(world.base, 'elsewhere')], 'personal-binding-decision-unavailable'],
  ]) {
    const result = await ari.command(argv)
    assert.deepEqual([result.exit, result.json.error?.code], [EXIT.refused, code], `${argv.join(' ')}: ${JSON.stringify(result.json)}`)
  }
  assert.deepEqual({ homes: treeListing(path.join(world.base, 'homes')), data: treeListing(ari.dataRoot), a: treeListing(world.a), b: treeListing(world.b) }, before, 'the generation files, the private home and the data root are byte-identical')
  assert.equal(fs.existsSync(path.join(world.base, 'elsewhere')), false)
  // Reading stays available.
  const listed = await ari.command(['view', 'list'])
  assert.deepEqual(listed.json.scopes.map((scope) => scope.scopeId), ['harbor-only', 'both', EVERYTHING_SCOPE_ID])

  // A vault edit to a private note is never applied into the generation.
  const generationBefore = treeListing(path.join(ari.home, 'generations'))
  const annotation = ari.manifestOf(EVERYTHING_SCOPE_ID).notes.find((note) => note.nodeId === 'personal-ari:annotation-harbor-thought')
  const file = path.join(ari.vault(EVERYTHING_SCOPE_ID), annotation.path)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('matters most', 'matters less'))
  const queued = await ari.engine().tick()
  const edit = queued.pendingEdits.find((item) => item.path === annotation.path)
  assert.ok(edit, JSON.stringify(queued.pendingEdits))
  const applied = await createSourceApplyForOracleTests()({ loadProject: ari.loadProject, dataRoot: ari.dataRoot, env: process.env, clock, quietPeriodMs: 0 }).apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
  assert.deepEqual([applied.status, applied.code], ['refused', 'personal-overlay-proposals-only'], JSON.stringify(applied))
  // Nor is it proposed: the proposal adapter answers it by name, records nothing, and hands nothing over.
  const adapter = createProposalAdapter({ clock, env: process.env })
  const context = () => ({ project: ari.bound.project, workspaceRoot: ari.workspaceRoot(), workspaceId: ari.workspaceId, repositoryRoots: protectedRoots(ari.bound.project), edits: ari.stateStore().readPendingEdits().edits, clock, env: process.env })
  const observed = await adapter.observe(context(), { retryRefused: true })
  assert.deepEqual(observed.observed.filter((item) => item.editId === edit.editId).map(({ status, code }) => [status, code]), [['refused', 'personal-overlay-not-proposed']])
  const proposed = await adapter.propose(context())
  assert.equal(proposed.outcomes.some((item) => item.editId === edit.editId), false, JSON.stringify(proposed.outcomes))
  assert.deepEqual(treeListing(path.join(ari.home, 'generations')), generationBefore, 'the generation is byte-identical')
  assert.equal(ari.compose().generation.generationId, ari.generationId, 'and still composes')
})

test('7. preferences: a theme is reported, never written; no .obsidian path outside Atelier\'s own changes', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  assert.equal(ari.bound.preferences.theme, 'dark', 'read, and reported')
  assert.ok(Object.isFrozen(ari.bound.preferences))
  assert.doesNotMatch(JSON.stringify(ari.bound.project.config.ext), /theme|dark/)
  const engine = ari.engine()
  t.after(() => engine.stop())
  assert.ok((await engine.tick()).scopes.every((scope) => scope.state === 'current'))
  const settingsOf = (scopeId) => path.join(ari.vault(scopeId), '.obsidian')
  for (const scope of ari.scopes()) {
    assert.equal(fs.existsSync(path.join(settingsOf(scope.scopeId), 'appearance.json')), false, `${scope.scopeId}: no appearance.json is written`)
    assert.doesNotMatch(JSON.stringify(treeListing(settingsOf(scope.scopeId))), /appearance/)
  }
  // The person's own settings, then a republication after a shared source changed: only Atelier's paths may move.
  const OWNED = (relative) => relative === 'core-plugins.json' || relative === 'community-plugins.json' || relative.startsWith('plugins/atelier-projection')
  for (const scope of ari.scopes()) {
    fs.writeFileSync(path.join(settingsOf(scope.scopeId), 'appearance.json'), '{"theme":"moonstone","cssTheme":"Person"}\n')
    fs.writeFileSync(path.join(settingsOf(scope.scopeId), 'app.json'), '{"spellcheck":false}\n')
  }
  const before = Object.fromEntries(ari.scopes().map((scope) => [scope.scopeId, treeListing(settingsOf(scope.scopeId), { skip: OWNED })]))
  fs.writeFileSync(path.join(world.a, 'notes', 'tide.md'), SHARED_A['notes/tide.md'].replace('Tide tables', 'Revised tide tables'))
  const republished = await engine.tick()
  assert.ok(republished.scopes.every((scope) => scope.state === 'current' && scope.reason === 'published-and-verified'), JSON.stringify(republished.scopes))
  for (const scope of ari.scopes()) assert.deepEqual(treeListing(settingsOf(scope.scopeId), { skip: OWNED }), before[scope.scopeId], `${scope.scopeId}: the person's settings are byte-identical`)
  // The oracle can fail: a theme written into the person's settings is seen.
  fs.writeFileSync(path.join(settingsOf('harbor-only'), 'appearance.json'), '{"theme":"obsidian"}\n')
  assert.notDeepEqual(treeListing(settingsOf('harbor-only'), { skip: OWNED }), before['harbor-only'])
})

test('withdrawal: a repository withdrawn between two ticks: the next tick, unasked, leaves no view current and writes no byte of it; the rebound generation prepares nothing from it', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  // The engine's loader follows the person's current binding, as a binding entry point would.
  const engine = ari.engine({ loadProject: () => ari.bound.project })
  t.after(() => engine.stop())
  const first = await engine.tick()
  assert.ok(first.scopes.every((scope) => scope.state === 'current'))
  assert.ok(ari.manifestOf('both').notes.some((note) => note.repoId === 'b'), 'b is published before the withdrawal')
  const knownDigests = new Set([...Object.values(treeListing(ari.dataRoot)), ...Object.values(treeListing(ari.home))])
  const fresh = (directory) => Object.entries(treeListing(directory)).filter(([relative, digest]) => !relative.endsWith('/') && !knownDigests.has(digest)).map(([relative]) => path.join(directory, relative))
  const bBytesWritten = () => [...fresh(ari.dataRoot), ...fresh(ari.home)].filter((file) => fs.readFileSync(file).includes(CANARY.bOnly)).map((file) => path.relative(world.base, file))

  // Withdrawn: b is no longer enrolled, and the overlay no longer refers to it.
  ari.manifest.repos.find((repo) => repo.repoId === 'b').enrolled = false
  ari.overlay.connections = []
  ari.overlay.views = ari.overlay.views.map((view) => ({ ...view, repoIds: view.repoIds.filter((id) => id !== 'b') }))
  const withdrawnFrom = ari.generationId
  ari.materialize()
  assert.notEqual(ari.generationId, withdrawnFrom)
  // The next tick, with nothing requested and no full reconciliation due: the authored change is observed, every view
  // asks the composition again, and the old generation is refused. No view is current.
  const refused = await engine.tick()
  assert.equal(refused.full, false)
  assert.ok(refused.scopes.every((scope) => scope.state === 'stale' && scope.reason === 'stale-generation'), JSON.stringify(refused.scopes))
  assert.ok(ari.stateStore().readFreshness().scopes.every((scope) => scope.state !== 'current'))
  assert.deepEqual(bBytesWritten(), [])

  // Rebound, the same engine follows the next generation: every view is prepared from it, and no b note is published.
  ari.bind()
  const rebound = await engine.tick()
  assert.ok(rebound.scopes.every((scope) => scope.state === 'current'), JSON.stringify(rebound.scopes))
  for (const scope of ari.scopes()) assert.equal(ari.manifestOf(scope.scopeId).notes.some((note) => note.repoId === 'b'), false, `${scope.scopeId}: no b note is published`)
  engine.stop()

  // Graph, counts and the selection snapshot hold no b node, and nor do apply and proposals.
  const run = await fiveCallers(ari)
  assertOneGraph(ari, run)
  for (const [caller, graph] of run.graphs) assert.equal(graph.nodes.filter((node) => node.repo === 'b').length, 0, `${caller}: no b node`)
  assert.ok(run.counts.every(({ counts }) => counts.corpus === ari.expected().nodes.length))
  assert.equal(run.selection.nodes.some((id) => id.startsWith('b:')), false, 'the selection snapshot holds no b node')
  // No b canary in any byte written since the withdrawal. Bytes that were already there (a note moved to recovery
  // keeps them, which retention governs) are not new bytes.
  assert.ok([...fresh(ari.dataRoot), ...fresh(ari.home)].length > 0)
  assert.deepEqual(bBytesWritten(), [])
})

test('a rebound generation with the same enrolment invalidates every view of a running engine', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  const engine = ari.engine({ loadProject: () => ari.bound.project })
  t.after(() => engine.stop())
  assert.ok((await engine.tick()).scopes.every((scope) => scope.state === 'current'))
  const configBytes = () => fs.readFileSync(ari.bound.project.configPath)
  const before = configBytes()
  // An overlay change only: the next generation's configuration file is byte-identical to this one.
  ari.overlay.annotations[0].note += ' Revised.'
  ari.materialize()
  ari.bind()
  assert.ok(configBytes().equals(before), 'the generation configuration is the same bytes')
  // One tick: the authored change is observed, the loader is asked again, and every view is prepared from the rebound
  // generation, the configuration and the settings member both changed.
  const rebound = await engine.tick()
  assert.ok(rebound.scopes.every((scope) => scope.state === 'current' && scope.changeClasses.includes('config') && scope.changeClasses.includes('ext-settings')), JSON.stringify(rebound.scopes))
  const annotation = ari.manifestOf(EVERYTHING_SCOPE_ID).notes.find((note) => note.nodeId === 'personal-ari:annotation-harbor-thought')
  assert.match(fs.readFileSync(path.join(ari.vault(EVERYTHING_SCOPE_ID), annotation.path), 'utf8'), /Revised\./, 'the vault holds the rebound generation')
})

test('a full reconciliation composes a bound workspace again: an enrolled repository whose identity changed leaves no view current', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  const engine = ari.engine({ fullReconciliationIntervalMs: 0 })
  t.after(() => engine.stop())
  assert.ok((await engine.tick()).scopes.every((scope) => scope.state === 'current'))
  // A remote recorded as none is now there: no file the engine observes changes.
  git(world.b, ['remote', 'add', 'origin', 'https://example.invalid/b.git'])
  const ticked = await engine.tick()
  assert.equal(ticked.full, true)
  assert.ok(ticked.scopes.every((scope) => scope.state === 'stale' && scope.reason === 'repo-identity-replaced'), JSON.stringify(ticked.scopes))
})

test('a refusal at load time is typed: the engine reports the code, no view stays current, and status answers typed', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  // The engine loads off the event loop; a command loads in its own thread.
  const loadProject = () => loadBoundProject({ personalHome: ari.home, generationId: ari.generationId })
  const engine = ari.engine({ loadProject: () => loadBoundProjectOffThread({ personalHome: ari.home, generationId: ari.generationId }) })
  t.after(() => engine.stop())
  assert.ok((await engine.tick()).scopes.every((scope) => scope.state === 'current'))
  ari.overlay.annotations[0].note += ' Revised.'
  ari.save()
  const ticked = await engine.tick()
  assert.deepEqual([ticked.state, ticked.refusal?.code], ['refused', 'stale-generation'], JSON.stringify(ticked))
  const freshness = ari.stateStore().readFreshness()
  assert.ok(freshness.scopes.length === 3 && freshness.scopes.every((scope) => scope.state === 'stale' && scope.reason === 'stale-generation'), JSON.stringify(freshness.scopes))
  for (const argv of [['status'], ['view', 'list']]) {
    const answered = await ari.command(argv, { loadProject })
    assert.deepEqual([answered.exit, answered.json.error?.code], [EXIT.refused, 'stale-generation'], `${argv.join(' ')}: ${JSON.stringify(answered.json)}`)
  }
  // The binding itself still throws the module's own refusal.
  assert.throws(() => bindPersonalWorkspace({ personalHome: ari.home, generationId: ari.generationId }), (error) => error instanceof PersonalWorkspaceRefusal && error.code === 'stale-generation')
})

test('a copy of a bound project that lost its binding is refused, never built as an ordinary project', (t) => {
  const { ari } = makeWorld(t, { people: ['ari'] })
  const { buildGraph } = createProductionSeams()
  assert.deepEqual(graphFacts(buildGraph({ project: { ...ari.bound.project }, eligibility: DEFAULT_ELIGIBILITY })), graphFacts(ari.expected()), 'a spread keeps the binding')
  for (const [label, copy] of [['structured clone', structuredClone(ari.bound.project)], ['JSON round trip', JSON.parse(JSON.stringify(ari.bound.project))], ['symbol dropped', unbound(ari.bound.project)]]) {
    assert.equal(personalWorkspaceBindingOf(copy), null, label)
    assert.throws(() => buildGraph({ project: copy, eligibility: DEFAULT_ELIGIBILITY }), (error) => error.code === 'personal-binding-lost', label)
    assert.throws(() => viewCounts({ project: copy, audienceAllow: [...ONLY_YOU_AUDIENCES], scope: PROBE_SCOPE }), (error) => error.code === 'personal-binding-lost', `${label}: view counts`)
  }
  // An ordinary project whose own settings use the reserved key is refused too, and the message names the key without
  // presuming a copy.
  const ordinary = routedAround(ari.bound.project)
  const declared = { ...ordinary, config: { ...ordinary.config, ext: { [OBSIDIAN_EXT_KEY]: { ...ordinary.config.ext[OBSIDIAN_EXT_KEY], ext: { [PERSONAL_MEMBER_KEY]: {} } } } } }
  assert.throws(() => buildGraph({ project: declared, eligibility: DEFAULT_ELIGIBILITY }), (error) => error.code === 'personal-binding-lost' && error.message.includes(`ext["${PERSONAL_MEMBER_KEY}"]`) && !/\bcopy\b/.test(error.message))
})

test('the cached route: one load, a composition only when the validity key changes, and identity with the composition', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  let composed = 0
  const counting = createPersonalWorkspaceBinderForOracleTests({ compose: (input) => { composed += 1; return composePersonalWorkspace(input) } })
  let loads = 0
  // The engine never composes on its own thread: a build whose key is unconfirmed refuses pending, and is built again
  // once the composition (off the event loop) confirmed it.
  const production = createProductionSeams()
  const builds = []
  const seams = { buildGraph: (args) => { try { const graph = production.buildGraph(args); builds.push('built'); return graph } catch (error) { builds.push(error.code); throw error } } }
  const engine = ari.engine({ seams, loadProject: () => { loads += 1; return ari.bind(counting).project } })
  t.after(() => engine.stop())
  assert.ok((await engine.tick()).scopes.every((scope) => scope.state === 'current'))
  assert.equal(loads, 1, 'a bound project is loaded once')
  assert.equal(composed, 2, 'the load composed, and the first (full) reconciliation asked again; the first build was served under the confirmed key')
  // An idle tick composes nothing.
  await engine.tick()
  assert.equal(composed, 2)
  // A shared note whose title changes changes the graph: the next build composes once, and the views follow it.
  fs.writeFileSync(path.join(world.a, 'notes', 'tide.md'), SHARED_A['notes/tide.md'].replaceAll('Tide', 'Tides'))
  const changed = await engine.tick()
  assert.ok(changed.scopes.every((scope) => scope.state === 'current' && scope.reason === 'published-and-verified'), JSON.stringify(changed.scopes))
  assert.equal(composed, 3)
  assert.deepEqual(builds, ['built', 'personal-validation-pending', 'built'])
  engine.stop()
  // Every other caller reads that same composed graph, and composes nothing.
  const run = await fiveCallers(ari)
  assertOneGraph(ari, run)
  assert.equal(composed, 4, 'only the new engine\'s first full reconciliation asked; no caller composed')
})

test('mutation control: a cached build without the composition\'s link-target rule is caught', async (t) => {
  const { ari } = makeWorld(t, { people: ['ari'] })
  ari.bind(createPersonalWorkspaceBinderForOracleTests({ build: (project, options) => buildCanonicalGraph(project, options) }))
  // The engine publishes nothing from it, and every caller refuses it.
  const engine = ari.engine()
  t.after(() => engine.stop())
  const ticked = await engine.tick()
  assert.ok(ticked.scopes.every((scope) => scope.state === 'stale' && scope.reason === 'personal-graph-unconfirmed'), JSON.stringify(ticked.scopes))
  assert.throws(() => viewCounts({ project: ari.bound.project, audienceAllow: [...ONLY_YOU_AUDIENCES], scope: PROBE_SCOPE }), (error) => error.code === 'personal-graph-unconfirmed')
  const selection = await ari.command(['selection', 'resolve', EVERYTHING_SCOPE_ID], { contributions: [createSelectionContribution()] })
  assert.equal(selection.json.error?.code, 'personal-graph-unconfirmed')
  // So the five-caller identity test cannot pass on it.
  await assert.rejects(async () => assertOneGraph(ari, await fiveCallers(ari)))
})

test('a full reconciliation of an unchanged bound workspace prepares, publishes and locks nothing; an ordinary project is unchanged', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  let composed = 0
  ari.bind(createPersonalWorkspaceBinderForOracleTests({ compose: (input) => { composed += 1; return composePersonalWorkspace(input) } }))
  const lockOwners = () => { const locks = path.join(ari.workspaceRoot(), 'state', 'locks'); return fs.readdirSync(locks).filter((name) => name.endsWith('.lock.owners')).map((name) => fs.readdirSync(path.join(locks, name)).length).reduce((sum, count) => sum + count, 0) }
  for (const [label, loadProject] of [['bound', () => ari.bound.project], ['ordinary', () => routedAround(ari.bound.project)]]) {
    const counts = { build: 0, publish: 0 }
    const production = createProductionSeams()
    const seams = { buildGraph: (args) => { counts.build += 1; return production.buildGraph(args) }, publishView: (args) => { counts.publish += 1; return production.publishView(args) } }
    const engine = ari.engine({ loadProject, seams, fullReconciliationIntervalMs: 0 })
    const first = await engine.tick()
    assert.ok(first.scopes.every((scope) => scope.state === 'current'), `${label}: ${JSON.stringify(first.scopes)}`)
    const settled = { ...counts, locks: lockOwners(), composed }
    for (let tick = 0; tick < 4; tick += 1) {
      const ticked = await engine.tick()
      assert.equal(ticked.full, true)
      assert.deepEqual(ticked.scopes, first.scopes, `${label}: every view keeps its settled entry`)
    }
    engine.stop()
    assert.deepEqual({ build: counts.build, publish: counts.publish, locks: lockOwners() }, { build: settled.build, publish: settled.publish, locks: settled.locks }, `${label}: nothing is built, published or locked again`)
    if (label === 'bound') assert.equal(composed, settled.composed + 4, 'the composition is asked at every full reconciliation')
  }
})

test('saved views beyond the Obsidian settings limits are refused at bind, typed, and write nothing', (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  const views = (count) => Array.from({ length: count }, (_, index) => ({ id: `view-${index}`, name: `View ${index}`, repoIds: ['a'] }))
  // 255 saved views and `everything` are what the settings contract allows.
  const allowed = personalWorkspaceScopes({ views: views(255), preferences: {} }, ari.generationId)
  assert.equal(readObsidianEnablement({ config: { ext: { [OBSIDIAN_EXT_KEY]: allowed } } }).scopes.length, 256)
  assert.throws(() => personalWorkspaceScopes({ views: [{ id: 'wide', name: 'Wide', repoIds: Array.from({ length: 257 }, (_, index) => `r${index}`) }], preferences: {} }, ari.generationId), (error) => error.code === 'personal-views-exceed-settings-limit' && error.detail.kind === 'repositories')
  ari.overlay.views = views(256)
  ari.overlay.preferences = {}
  ari.materialize()
  const before = { homes: treeListing(path.join(world.base, 'homes')), data: treeListing(ari.dataRoot) }
  assert.throws(() => bindPersonalWorkspace({ personalHome: ari.home, generationId: ari.generationId }), (error) => error.code === 'personal-views-exceed-settings-limit' && error.detail.kind === 'views')
  assert.throws(() => loadBoundProject({ personalHome: ari.home, generationId: ari.generationId }), (error) => error.code === 'personal-views-exceed-settings-limit')
  assert.deepEqual({ homes: treeListing(path.join(world.base, 'homes')), data: treeListing(ari.dataRoot) }, before)
})

test('inputs that change while the composition runs are never confirmed: the next build refuses', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  let withdrawn = false
  // The edit lands after the composition read the inputs, and before it returns.
  const racing = createPersonalWorkspaceBinderForOracleTests({ compose: (input) => {
    const composed = composePersonalWorkspace(input)
    if (!withdrawn) { withdrawn = true; ari.manifest.repos.find((repo) => repo.repoId === 'b').enrolled = false; ari.save() }
    return composed
  } })
  ari.bind(racing)
  const { buildGraph } = createProductionSeams()
  assert.throws(() => buildGraph({ project: ari.bound.project, eligibility: DEFAULT_ELIGIBILITY }), (error) => ['stale-generation', 'retained-removed-reference'].includes(error.code), 'the withdrawn repository is not served')
  const engine = ari.engine()
  t.after(() => engine.stop())
  const ticked = await engine.tick()
  assert.ok(ticked.scopes.every((scope) => scope.state !== 'current'), JSON.stringify(ticked.scopes))
})

test('with the proposal adapter registered, the engine never composes on its event loop', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  const extensions = createMaintenanceExtensions()
  extensions.register('proposal-adapter', createProposalAdapter({ clock, env: process.env }))
  const production = createProductionSeams()
  const builds = []
  const seams = { buildGraph: (args) => { try { const graph = production.buildGraph(args); builds.push('built'); return graph } catch (error) { builds.push(error.code); throw error } } }
  const engine = ari.engine({ extensions, seams, loadProject: () => loadBoundProjectOffThread({ personalHome: ari.home, generationId: ari.generationId }) })
  t.after(() => engine.stop())
  globalThis.mainThreadCompositionProbes = 0
  assert.ok((await engine.tick()).scopes.every((scope) => scope.state === 'current'))
  // A vault edit (so the adapter builds) and a graph change, seen in the same tick.
  const note = ari.manifestOf('harbor-only').notes.find((item) => item.nodeId === 'a:harbor')
  const file = path.join(ari.vault('harbor-only'), note.path)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Shared harbor note.', 'Shared harbor note, edited.'))
  fs.writeFileSync(path.join(world.a, 'notes', 'tide.md'), SHARED_A['notes/tide.md'].replaceAll('Tide', 'Tides'))
  builds.length = 0
  const ticked = await engine.tick()
  assert.equal(ticked.observed?.deferred, 'personal-validation-pending', JSON.stringify(ticked.observed))
  assert.deepEqual(builds, ['personal-validation-pending', 'built'])
  assert.equal(globalThis.mainThreadCompositionProbes, 0, 'no composition ran on the main thread')
  // The next tick observes the edit against the confirmed graph, still without composing here.
  const next = await engine.tick()
  assert.ok(next.observed?.observed.some((item) => item.status === 'observed'), JSON.stringify(next.observed))
  assert.equal(globalThis.mainThreadCompositionProbes, 0)
})

test('every full reconciliation asks the composition, even when every view is being prepared', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  let refusing = false
  ari.bind(createPersonalWorkspaceBinderForOracleTests({ compose: (input) => { if (refusing) throw new PersonalWorkspaceRefusal('repo-identity-replaced'); return composePersonalWorkspace(input) } }))
  const engine = ari.engine({ fullReconciliationIntervalMs: 0 })
  t.after(() => engine.stop())
  assert.ok((await engine.tick()).scopes.every((scope) => scope.state === 'current'))
  // A cause no key sees, and every view asked to be prepared again.
  refusing = true
  for (const scope of ari.scopes()) engine.requestPreparation(scope.scopeId)
  const ticked = await engine.tick()
  assert.ok(ticked.scopes.every((scope) => scope.state === 'stale' && scope.reason === 'repo-identity-replaced'), JSON.stringify(ticked.scopes))
})

test('the validity key reads only regular files, never waits on one, and sees the causes it can cheaply see', async (t) => {
  const world = makeWorld(t, { people: ['ari'] })
  const { ari } = world
  const { buildGraph } = createProductionSeams()
  const build = () => buildGraph({ project: ari.bound.project, eligibility: DEFAULT_ELIGIBILITY })
  const refusesWith = (code, label) => assert.throws(build, (error) => error.code === code, label)
  const generation = path.join(ari.home, 'generations', ari.generationId)
  // A FIFO in the generation, and a FIFO in place of the manifest: refused at once, as the composition would.
  childProcess.execFileSync('mkfifo', [path.join(generation, 'overlay', 'pipe')])
  refusesWith('generation-corrupt', 'a FIFO in the generation')
  fs.rmSync(path.join(generation, 'overlay', 'pipe'))
  const manifest = path.join(ari.home, 'atelier.personal.json')
  const manifestBytes = fs.readFileSync(manifest)
  fs.renameSync(manifest, `${manifest}.aside`)
  childProcess.execFileSync('mkfifo', [manifest])
  refusesWith('malformed-input', 'a FIFO in place of the manifest')
  assert.throws(() => bindPersonalWorkspace({ personalHome: ari.home, generationId: ari.generationId }), (error) => error.code === 'malformed-input')
  // The manifest replaced by a link to the same bytes.
  fs.rmSync(manifest)
  fs.symlinkSync(`${manifest}.aside`, manifest)
  refusesWith('malformed-input', 'a linked manifest')
  fs.rmSync(manifest)
  fs.renameSync(`${manifest}.aside`, manifest)
  assert.ok(fs.readFileSync(manifest).equals(manifestBytes))
  assert.ok(build().nodes.length > 0, 'undone, the graph is served again')
  // A Git work tree above the home.
  fs.mkdirSync(path.join(world.base, 'homes', '.git'))
  refusesWith('generation-inside-work-tree', 'a .git above the home')
  fs.rmSync(path.join(world.base, 'homes', '.git'), { recursive: true })
  build()
  // A shared root replaced by a link to itself.
  fs.renameSync(world.b, `${world.b}-real`)
  fs.symlinkSync(`${world.b}-real`, world.b)
  refusesWith('root-symlinked', 'a linked shared root')
  fs.rmSync(world.b)
  fs.renameSync(`${world.b}-real`, world.b)
  build()
  // A Git helper in the user's configuration.
  fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[core]\n\tfsmonitor = true\n')
  try { refusesWith('git-helper-configured', 'a user core.fsmonitor') } finally { fs.rmSync(path.join(process.env.HOME, '.gitconfig')) }
  build()
})

test('a composition worker that never answers is terminated at its deadline, and refuses typed', async (t) => {
  const { ari } = makeWorld(t, { people: ['ari'] })
  ari.bind(createPersonalWorkspaceBinderForOracleTests({ worker: { deadlineMs: 500, stallMs: 60 * 1000 } }))
  const started = Date.now()
  assert.deepEqual(await validatePersonalWorkspace(ari.bound.project), { ok: false, code: 'personal-composition-unavailable' })
  assert.ok(Date.now() - started < 10 * 1000, 'settled at the deadline, not when the worker would have answered')
})

test('a graph whose resolved links differ from the composition is not served', (t) => {
  const { ari } = makeWorld(t, { people: ['ari'] })
  ari.bind(createPersonalWorkspaceBinderForOracleTests({ build: (project, options) => ({ ...buildCanonicalGraph(project, { ...options, isLinkTargetEligible: (node) => node.repo !== 'personal-ari' }), links: [] }) }))
  const { buildGraph } = createProductionSeams()
  assert.throws(() => buildGraph({ project: ari.bound.project, eligibility: DEFAULT_ELIGIBILITY }), (error) => error.code === 'personal-graph-unconfirmed')
})
