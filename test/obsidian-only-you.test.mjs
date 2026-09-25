import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// A vault that is only yours shows the notes that carry no classification;
// a vault of any other audience never does. The rule is the eligibility the
// machine settings decide (src/runtime/obsidian/pipeline.mjs `eligibilityFor`),
// and every path that builds the canonical graph asks it: the engine, source
// apply, the proposal adapter, the selection operation. Temporary directories
// and invented notes only.
//
// Nothing here may start the installed app, its command-line tool, an operating-system opener or a service manager,
// directly or through a shell, nor anything that loads the production app seams: an attempt throws before it runs.
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
    return original.call(this, command, args, ...rest)
  }
}
syncBuiltinESMExports()

const { resolveProjectConfig, writeJson } = await import('../src/project/config.mjs')
const { prepareView } = await import('../src/projection/obsidian/materialize/index.mjs')
const { resolveExchange } = await import('../src/projection/obsidian/publication/index.mjs')
const { createSelectionContribution } = await import('../src/projection/obsidian/selection-ui/contribution.mjs')
const { EXIT, runObsidianCommand } = await import('../src/commands/obsidian.mjs')
const { ONLY_YOU_AUDIENCES, defaultMachineSettings, withDecision } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { DEFAULT_ELIGIBILITY, buildGraph, captureSnapshot, eligibilityFor, onlyYouEligibility, profileFor } = await import('../src/runtime/obsidian/pipeline.mjs')
const { createProposalAdapter } = await import('../src/projection/obsidian/proposals/index.mjs')
const { protectedRoots } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { APPLY_WORKSPACE_ID, EXT, makeApplyWorld, noteText } = await import('./support/obsidian-edits/apply-world.mjs')

const TMP = fs.realpathSync(os.tmpdir())
const NOW = '2026-01-05T10:00:00.000Z'
const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which the recovery suite asserts' }
const WHOLE = { scopeId: 'scope-whole', mode: 'full', selector: { all: true } }

// Notes without a classification: three the emitter reads as notes, and four whose bytes it refuses.
const UNCLASSIFIED = {
  'drafts/plain.md': '# Plain\n\nNo front matter at all. The tide turns at noon.\n',
  'drafts/own-front-matter.md': '---\ntitle: "Own"\nstatus: draft\n---\n\n# Own\n\nFront matter of its own, and no kg block.\n',
  'drafts/malformed.md': '---\ntitle: [never closed\n---\n\n# Malformed\n',
  'drafts/rule.md': '---\n\nA thematic break first, and nothing closes it.\n',
  'drafts/empty.md': '---\n---\n\n# Empty front matter\n',
  'drafts/spaced.md': '--- \ntitle: "Spaced"\n---\n\n# A delimiter with a trailing space\n',
  'drafts/latin1.md': Buffer.from('# Caf\u00e9\n', 'latin1'),
}
const READ_AS_NOTES = ['drafts/malformed.md', 'drafts/own-front-matter.md', 'drafts/plain.md']

// A project of one repository, `harbor`, in a temporary directory, with a data root beside it: `files` are relative to
// the repository.
function makeProject(t, files) {
  const top = fs.mkdtempSync(path.join(TMP, 'atelier-only-you-'))
  t.after(() => fs.rmSync(top, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const dir = path.join(top, 'project')
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'harbor', relative)), { recursive: true })
    fs.writeFileSync(path.join(dir, 'harbor', relative), content)
  }
  fs.mkdirSync(path.join(dir, 'harbor', '.git'), { recursive: true })
  writeJson(path.join(dir, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1', name: 'only-you-fixture', roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'harbor', path: 'harbor', readBoundary: 'team' }],
  })
  writeJson(path.join(dir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: { harbor: { readBoundary: 'team' } } })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  return { dir, dataRoot: path.join(top, 'data'), env, project: resolveProjectConfig({ argv: [`--project=${path.join(dir, 'atelier.project.json')}`], cwd: dir, env, writeLocalState: false }) }
}

// Machine settings with an audience decision, as `audience set` leaves them.
function decided(choice, unclassified, audienceAllow = [...ONLY_YOU_AUDIENCES]) {
  const base = { ...defaultMachineSettings({ workspaceId: `ws-${'0c'.repeat(12)}`, updatedAt: NOW }), audienceAllow }
  return withDecision(base, 'audience', { choice, unclassified }, { decidedAt: NOW, via: 'command' })
}
const byPath = (graph) => Object.fromEntries(graph.nodes.map((node) => [node.path, node]))
// The audience decision of an apply world's workspace, with every audience "only you" stands for.
const decide = (world, choice, unclassified) => world.configureMachine({
  audienceAllow: [...ONLY_YOU_AUDIENCES],
  decisions: { audience: { choice, unclassified, decidedAt: NOW, decidedBy: null, via: 'command' }, location: null, loginItem: null, adapter: null },
})

test('only "only you" with unclassified notes shown admits them; every other decision, and none, withholds them', (t) => {
  const { project } = makeProject(t, { 'notes/lantern.md': noteText({ id: 'harbor:lantern', title: 'Lantern room', body: 'Classified.' }), ...UNCLASSIFIED })
  for (const [label, machine] of [
    ['no settings', null],
    ['nothing decided', defaultMachineSettings({ workspaceId: `ws-${'0c'.repeat(12)}`, updatedAt: NOW })],
    ['a list of audiences', decided('custom', 'withheld', ['team'])],
    ['a list with every audience "only you" stands for', decided('custom', 'withheld')],
    ['"only you" withholding them', decided('only-you', 'withheld')],
  ]) assert.equal(eligibilityFor({ machine, project }), DEFAULT_ELIGIBILITY, label)
  const shown = eligibilityFor({ machine: decided('only-you', 'shown'), project })
  assert.notEqual(shown, DEFAULT_ELIGIBILITY)
  assert.notEqual(shown.revision(), DEFAULT_ELIGIBILITY.revision(), 'the revision changes with the rule, so every view is rebuilt when the decision changes')
  assert.equal(shown.revision(), onlyYouEligibility({ project }).revision())
  assert.throws(() => decided('custom', 'shown', ['team']), (error) => error.code === 'invalid-machine-settings', 'a list of audiences cannot show them')
})

test('an "only you" vault admits a note without a classification only when its bytes read as a note', (t) => {
  const { project } = makeProject(t, { 'notes/lantern.md': noteText({ id: 'harbor:lantern', title: 'Lantern room', body: 'Classified.' }), ...UNCLASSIFIED })
  const withheld = byPath(buildGraph({ project, eligibility: DEFAULT_ELIGIBILITY }))
  const admitted = byPath(buildGraph({ project, eligibility: onlyYouEligibility({ project }) }))
  for (const relative of Object.keys(UNCLASSIFIED)) {
    assert.equal(withheld[relative]?.classification, 'unclassified', `${relative} carries no classification`)
    assert.equal(withheld[relative].eligible, false, `${relative}: withheld by default`)
    assert.equal(admitted[relative].eligible, READ_AS_NOTES.includes(relative), `${relative}: ${READ_AS_NOTES.includes(relative) ? 'admitted' : 'withheld, since the emitter would refuse its bytes and stop the vault'}`)
  }
  assert.equal(admitted['notes/lantern.md'].eligible, true, 'a classified note is eligible, as always')
  assert.equal(withheld['notes/lantern.md'].eligible, true)
  // A note that cannot be read any more is withheld, not a failure.
  const reader = onlyYouEligibility({ project })
  fs.rmSync(path.join(project.repos[0].path, 'drafts', 'plain.md'))
  assert.equal(reader.isEligible(admitted['drafts/plain.md']), false)
  assert.equal(reader.isEligible({ ...admitted['drafts/own-front-matter.md'], repo: 'elsewhere' }), false, 'a repository the project does not enrol')
})

// A classified note whose title names the unclassified note by its repository-qualified source path, an unambiguous
// identifier, so the relations region generated for the note it supports carries it: the redaction guard's free-text rule.
function guardProject(t) {
  const plain = { ...UNCLASSIFIED }['drafts/plain.md']
  return makeProject(t, {
    'notes/plan.md': noteText({ id: 'harbor:plan', title: 'Harbor plan', body: 'The plan. See the [draft](../drafts/plain.md).' }),
    'notes/naming.md': `---\ntitle: "Names harbor/drafts/plain.md"\nkg:\n  id: "harbor:naming"\n  type: "document"\n  status: "active"\n  audience: "team"\n  relations:\n    supports:\n      - "harbor:plan"\n---\n\n# Names it\n`,
    'drafts/plain.md': plain,
  })
}

function prepared({ project, eligibility }) {
  const graph = buildGraph({ project, eligibility })
  const snapshot = captureSnapshot({ project, graph, workspaceId: `ws-${'0c'.repeat(12)}`, index: new Map(), configDigest: `sha256:${'0'.repeat(64)}`, capturedAt: NOW })
  const profile = profileFor({ project, workspaceId: `ws-${'0c'.repeat(12)}`, audienceAllow: [...ONLY_YOU_AUDIENCES] })
  return { graph, run: () => prepareView({ snapshot, profile, scope: { schema: 'atelier-obsidian-scope/v1', ...WHOLE }, clock: () => NOW }) }
}

test('the redaction guard: an admitted note without a classification is part of an "only you" view, and stays withheld from a view of a list of audiences', (t) => {
  const { project } = guardProject(t)
  // "Only you": the note is in the view, the link to it is rewritten to its vault path, and generated text may name it.
  const mine = prepared({ project, eligibility: onlyYouEligibility({ project }) })
  const draft = mine.graph.nodes.find((node) => node.path === 'drafts/plain.md')
  const view = mine.run()
  const entry = view.manifest.notes.find((note) => note.nodeId === draft.id)
  assert.ok(entry, 'the note is in the view')
  assert.equal(entry.path, 'harbor/drafts/plain.md', 'at its readable path, as every note of the view')
  const link = view.manifest.links.find((item) => item.sourceNodeId === 'harbor:plan' && item.targetNodeId === draft.id)
  assert.equal(link?.targetState, 'in-scope', 'the plan\'s link to it is a link inside the view')
  // Any other audience decision, with the very same audiences: the note is withheld, and the generated text that
  // names it is refused.
  const theirs = prepared({ project, eligibility: DEFAULT_ELIGIBILITY })
  assert.throws(() => theirs.run(), (error) => error.code === 'redaction-failure' && error.detail?.rule === 'deny-list', 'refused by the free-text rule')
})

test('the selection operation resolves the view the engine publishes: with the note under "only you", without it under a list', async (t) => {
  const { dir, dataRoot, env } = makeProject(t, { 'notes/lantern.md': noteText({ id: 'harbor:lantern', title: 'Lantern room', body: 'Classified.' }), 'drafts/plain.md': UNCLASSIFIED['drafts/plain.md'] })
  const configPath = path.join(dir, 'atelier.project.json')
  const document = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  writeJson(configPath, { ...document, ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [WHOLE] } } })
  const run = async (argv) => {
    const out = []
    const exit = await runObsidianCommand({ argv: [...argv, '--json', `--project=${configPath}`, `--data-root=${dataRoot}`], seams: {}, env, cwd: dir, clock: () => new Date(NOW), contributions: [createSelectionContribution()], stdout: (text) => out.push(text), stderr: () => {}, account: () => 'harbor-keeper' })
    return { exit, json: JSON.parse(out.join('\n')) }
  }
  const resolved = async () => (await run(['selection', 'resolve', WHOLE.scopeId])).json.selection.nodes
  assert.equal((await run(['audience', 'set', 'me'])).json.unclassified, 'shown')
  const mine = await resolved()
  assert.equal(mine.length, 2)
  assert.ok(mine.includes('harbor:lantern'))
  const list = await run(['audience', 'set', ONLY_YOU_AUDIENCES.join(',')])
  assert.deepEqual([list.exit, list.json.choice, list.json.unclassified, list.json.changed], [EXIT.ok, 'custom', 'withheld', true], 'the same audiences, named: a list, which withholds them')
  assert.deepEqual(await resolved(), ['harbor:lantern'])
})

test('an "only you" vault publishes the notes without a classification that read as notes, and an edit to one reaches its source; a list withholds them again', needsExchange, async (t) => {
  const files = {
    'east-wing/notes/lantern.md': noteText({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute.' }),
    'east-wing/drafts/scratch.md': '# Scratch\n\nNo front matter, so no classification. The tide turns at noon.\n',
    'east-wing/drafts/rule.md': '---\n\nA thematic break first, and nothing closes it.\n',
  }
  const world = makeApplyWorld(t, { repositories: ['east-wing'], files, scopes: [WHOLE], audienceAllow: [...ONLY_YOU_AUDIENCES] })
  const sourcePaths = () => world.manifest().notes.map((note) => note.ext[EXT].source.path).sort()
  decide(world, 'only-you', 'shown')
  const engine = world.engine()
  assert.equal((await engine.tick()).scopes[0].state, 'current')
  assert.deepEqual(sourcePaths(), ['drafts/scratch.md', 'notes/lantern.md'], 'the note that reads as a note is published; the one the emitter would refuse is withheld, and the vault is complete')
  const scratch = world.manifest().notes.find((note) => note.ext[EXT].source.path === 'drafts/scratch.md')

  world.editNote(scratch.nodeId, 'turns at noon', 'turns at one')
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'held-for-your-edit')
  const edit = world.editOf(scratch.nodeId)
  const result = await world.sourceApply().apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
  assert.deepEqual([result.status, result.code], ['applied', 'applied'], JSON.stringify(result))
  assert.equal(fs.readFileSync(world.source('east-wing/drafts/scratch.md'), 'utf8'), '# Scratch\n\nNo front matter, so no classification. The tide turns at one.\n')
  world.advance(1000)
  await engine.tick()
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'current', 'the hold is lifted once the source holds the edit')

  // The same audiences as a list: every view is rebuilt without them.
  decide(world, 'custom', 'withheld')
  world.advance(1000)
  const rebuilt = await engine.tick()
  assert.ok(rebuilt.changes.some((change) => change.changeClass === 'eligibility'), JSON.stringify(rebuilt.changes))
  assert.equal(rebuilt.scopes[0].state, 'current')
  assert.deepEqual(sourcePaths(), ['notes/lantern.md'])
  assert.equal(fs.existsSync(path.join(world.vault(), scratch.path)), false, 'its note left the vault')
})

test('the proposal adapter sees what the vault shows: a structural edit of a note without a classification is proposed under "only you", and withheld once a list decides', needsExchange, async (t) => {
  const files = {
    'east-wing/notes/lantern.md': noteText({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute.' }),
    'east-wing/drafts/first.md': '# First draft\n\nNo classification.\n\nClosing words.\n',
    'east-wing/drafts/second.md': '# Second draft\n\nNo classification either.\n\nClosing words.\n',
  }
  const world = makeApplyWorld(t, { repositories: ['east-wing'], files, scopes: [WHOLE], audienceAllow: [...ONLY_YOU_AUDIENCES], gitignore: { 'east-wing': '.atelier-proposals/\n' } })
  decide(world, 'only-you', 'shown')
  assert.equal((await world.engine().tick()).scopes[0].state, 'current')
  const idOf = (relative) => world.manifest().notes.find((note) => note.ext[EXT].source.path === relative).nodeId
  const [first, second] = [idOf('drafts/first.md'), idOf('drafts/second.md')]
  const lantern = path.basename(world.manifest().notes.find((note) => note.nodeId === 'east-wing:lantern').path, '.md')
  // A link typed into the note is a structural edit: source apply records it as proposed, for the adapter to hand over.
  const linkTyped = async (nodeId) => {
    world.editNote(nodeId, 'Closing words.', `Closing words and [[${lantern}]].`)
    world.queueDirectly()
    const recorded = await world.sourceApply().apply({ editId: world.editOf(nodeId).editId, mode: 'manual' })
    assert.equal(recorded.detail?.cause, 'unsupported-structural-edit', JSON.stringify(recorded))
  }
  const adapter = createProposalAdapter({ clock: world.clock, env: world.env })
  const propose = async () => (await adapter.propose({ project: world.loadProject(), workspaceRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID, repositoryRoots: protectedRoots(world.loadProject()), edits: world.pendingEdits(), clock: world.clock }))
    .outcomes.map((item) => [item.nodeId, item.status, item.code ?? null])
  await linkTyped(first)
  assert.deepEqual(await propose(), [[first, 'acknowledged', null]], 'under "only you" the note is visible, and its proposal is made')
  await linkTyped(second)
  decide(world, 'custom', 'withheld')
  assert.deepEqual(await propose(), [[second, 'refused', 'route-withheld']], 'once a list decides, the same kind of note is withheld from the adapter too')
})
