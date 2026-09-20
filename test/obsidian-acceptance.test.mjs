import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 0. The spawn guard, installed before anything else is imported: nothing in
// this file may start the installed app, its command-line tool, an
// operating-system opener or a service manager. An attempt throws here.
// ---------------------------------------------------------------------------

const BANNED_PROGRAMS = ['obsidian-cli', 'obsidian', 'open', 'xdg-open', 'launchctl', 'systemctl']
const WRAPPERS = ['sh', 'bash', 'zsh', 'dash', 'env', 'cmd', 'powershell', 'pwsh', 'nohup', 'sudo']
const programName = (command) => path.basename(String(command).replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|app|cmd|bat)$/, '')
const guardErrors = []
function guardSpawn(command, args) {
  const words = [command, ...(Array.isArray(args) ? args : [])].map(String)
  const wrapper = WRAPPERS.includes(programName(command))
  const banned = words.find((word, index) => ((index === 0 || wrapper) && BANNED_PROGRAMS.includes(programName(word))) || /obsidian:\/\//i.test(word))
  if (banned === undefined) return
  const error = new Error(`spawn guard: this test suite may never start "${programName(banned)}"`)
  guardErrors.push(error.message)
  throw error
}
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  childProcess[method] = function guarded(command, args, ...rest) {
    if (method === 'exec' || method === 'execSync') guardSpawn('sh', String(command).split(/\s+/)); else guardSpawn(command, args)
    return original.call(this, command, args, ...rest)
  }
}
syncBuiltinESMExports()

const { resolveProjectConfig, writeJson } = await import('../src/project/config.mjs')
const { CORPUS_ROOT } = await import('../src/contracts/corpus.mjs')
const { OBSIDIAN_EXT_KEY, ObsidianContractRefusal, identitySuffix, validateObsidianContract } = await import('../src/projection/obsidian/contracts.mjs')
const { openObjectStore } = await import('../src/projection/obsidian/edits/object-store.mjs')
const { editIdempotencyKey } = await import('../src/projection/obsidian/edits/observe.mjs')
const { applyPolicyDigest } = await import('../src/projection/obsidian/edits/policy.mjs')
const { isUserOwnedSettingsPath } = await import('../src/projection/obsidian/materialize/settings.mjs')
const {
  CONFLICT_VIEW_SCHEMA, FOCUS_QUERY_VERSION, OBJECT_VIEW_STATES, POLICY_SETUP_SCHEMA, RECEIPT_EXT_KEY, RECEIPT_GATES, RECEIPT_GATE_IDS, RECEIPT_RULES, RECEIPT_VALIDATION_LABEL,
  SELECTION_DIRECTORY, SELECTION_SCHEMA, SELECTION_STATE_SCHEMA, UI_OWNED_SETTINGS_FILES,
  assertWritableSelectionPath, buildApplyPolicy, buildFocusQuery, conflictView, createFocusQueryBuilderForOracleTests, createReceiptValidatorForOracleTests, createSelectionContribution,
  dispatchGate, focusBookmarkPayload, listSelectionStates, readConflictView, readSelectionState, receiptRequirementsFor, resolveSelection, runPolicySetup, scopeDocumentOf,
  validateAcceptanceReceipt, writeSelectionState,
} = await import('../src/projection/obsidian/selection-ui/index.mjs')
const { COMMAND_SCHEMA, EXIT, runObsidianCommandForOracleTests } = await import('../src/commands/obsidian.mjs')
const { ObsidianMaintenanceRefusal } = await import('../src/runtime/obsidian/errors.mjs')
const { authorizeAutomaticApply, defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, readInstalledApplyPolicy, readMachineSettings, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { dispatchAutomaticApply } = await import('../src/runtime/obsidian/pending-edits.mjs')

// AOP-4 phase 1: selection binding, focus queries, apply policy setup, the
// conflict view and acceptance receipt validation. Invented, synthetic
// content only. Nothing here opens the app, publishes a vault or writes a
// source file. The receipt tests prove the validator's shape checks and
// nothing about any gate: a schema-valid receipt closes no gate, and the
// last receipt test pins that.
//
// The literal expectations below are compared with the output of the real
// functions; the mutation controls prove each comparison can fail.

const TMP = fs.realpathSync(os.tmpdir())
const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const ORACLES = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/oracles/scope-cases.json'))
const PROFILE = readJson(path.join(CORPUS_ROOT, ORACLES.profileFixture))
const SNAPSHOT = { nodes: ORACLES.nodes, edges: ORACLES.edges }
const FIXTURES = path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'receipts')
const NOW = '2026-01-05T10:00:00.000Z'
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const fixedRandom = (size) => Buffer.alloc(size, 9)
const WORKSPACE_ID = `ws-${'09'.repeat(12)}`

function refusalCode(run) {
  try { run() } catch (error) {
    assert.ok(error instanceof ObsidianMaintenanceRefusal || error instanceof ObsidianContractRefusal, `expected a typed refusal, got ${error?.stack ?? error}`)
    return error.code
  }
  return null
}

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(TMP, `atelier-acceptance-${label}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}

// A private workspace root and one repository root it must stay outside of.
function tempWorkspace(t, label) {
  const dir = tempDir(t, label)
  const workspace = { workspaceRoot: path.join(dir, 'workspace'), workspaceId: WORKSPACE_ID }
  const repositoryRoots = [path.join(dir, 'repository')]
  fs.mkdirSync(workspace.workspaceRoot, { recursive: true, mode: 0o700 })
  fs.mkdirSync(repositoryRoots[0], { recursive: true })
  writeMachineSettings({ ...workspace, repositoryRoots, settings: defaultMachineSettings({ workspaceId: WORKSPACE_ID, updatedAt: NOW }) })
  return { dir, workspace, repositoryRoots }
}

const select = (scope, extra = {}) => resolveSelection({ canonicalSnapshot: SNAPSHOT, profile: PROFILE, scope, ...extra })

// ---------------------------------------------------------------------------
// 1. Selection: literal expected scopes
// ---------------------------------------------------------------------------

test('full selection is the whole authorized corpus, as an exact scope document', () => {
  const selection = select({ scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.equal(selection.schema, SELECTION_SCHEMA)
  assert.deepEqual(selection.scope, { schema: 'atelier-obsidian-scope/v1', scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.deepEqual(validateObsidianContract('scope', selection.scope), [])
  assert.deepEqual(selection.nodes, ['a', 'b', 'c', 'd'])
  assert.deepEqual(selection.edges, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'])
  assert.deepEqual(selection.outsideSelectionEdges, [])
  assert.deepEqual(selection.vaultNodes, ['a', 'b', 'c', 'd'])
  assert.equal(selection.truncated, false)
  assert.equal(selection.empty, false)
  assert.equal(selection.focus, null)
  // The withheld node x is in no list and no path.
  assert.deepEqual(Object.keys(selection.notePaths), ['a', 'b', 'c', 'd'])
  assert.deepEqual(selection.notePaths, {
    a: 'notes/Shared concept--82f6d012eaad.md', b: 'notes/Second concept--242ab15f42c6.md', c: 'notes/Third concept--f7e3c3e2b4b1.md'.replace('f7e3c3e2b4b1', selection.notePaths.c.slice(-15, -3)), d: selection.notePaths.d,
  })
  assert.match(selection.notePaths.c, /^notes\/Third concept--[0-9a-f]{12}\.md$/)
  assert.match(selection.notePaths.d, /^notes\/Shared concept--[0-9a-f]{12}\.md$/)
  assert.notEqual(selection.notePaths.a, selection.notePaths.d, 'duplicate titles stay distinct through the identity suffix')
})

test('scoped selection: repository, path prefix and a set expression give exactly the oracle sets', () => {
  const north = select({ scopeId: 'view-north', mode: 'scoped', selector: { repo: 'north' } })
  // Outside: every visible edge with exactly one end in {a, d}; e3 (c -> a) is one of them. e10 reaches the withheld x and is not visible at all.
  assert.deepEqual({ nodes: north.nodes, edges: north.edges, outside: north.outsideSelectionEdges, vault: north.vaultNodes }, { nodes: ['a', 'd'], edges: ['e4', 'e5'], outside: ['e1', 'e3', 'e6', 'e7', 'e8', 'e9'], vault: ['a', 'd'] })
  const plans = select({ scopeId: 'view-plans', mode: 'scoped', selector: { repo: 'north', pathPrefix: 'plans/' } })
  assert.deepEqual({ nodes: plans.nodes, edges: plans.edges }, { nodes: ['a'], edges: [] })
  const expression = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/scope/valid/scoped-set-expression.v1.json'))
  const scoped = select(expression)
  assert.deepEqual(scoped.scope, expression, 'the requested document comes back exactly')
  // (plans/ of north ∪ tag topic ∪ {b}) \ (html ∩ west) = {a, b}, then one outgoing hop within a budget of 3: c joins.
  assert.deepEqual({ nodes: scoped.nodes, edges: scoped.edges, truncated: scoped.truncated }, { nodes: ['a', 'b', 'c'], edges: ['e1', 'e2', 'e3', 'e6'], truncated: true })
  assert.deepEqual(scoped.diagnostics, ['expansion-truncated-at-node-budget'])
})

test('bounded expansion is exact and the two defaulted members are written into the document; budgets never are', () => {
  const expanded = select({ scopeId: 'view-expand', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 1, maxNodes: 3 } })
  assert.deepEqual(expanded.scope.expansion, { depth: 1, maxNodes: 3, direction: 'outgoing', order: 'canonical-id' })
  assert.deepEqual({ nodes: expanded.nodes, edges: expanded.edges, truncated: expanded.truncated }, { nodes: ['a', 'b', 'c'], edges: ['e1', 'e2', 'e3', 'e6'], truncated: true })
  const incoming = select({ scopeId: 'view-in', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 1, maxNodes: 10, direction: 'incoming' } })
  assert.deepEqual({ nodes: incoming.nodes, edges: incoming.edges, truncated: incoming.truncated }, { nodes: ['a', 'c', 'd'], edges: ['e3', 'e4', 'e5', 'e6', 'e8'], truncated: false })
  assert.equal(refusalCode(() => select({ scopeId: 'view-x', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 1 } })), 'missing-expansion-budget')
  assert.equal(refusalCode(() => select({ scopeId: 'view-x', mode: 'scoped', selector: { ids: ['a'] }, expansion: { maxNodes: 3 } })), 'missing-expansion-budget')
  assert.equal(refusalCode(() => select({ scopeId: 'view-x', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 9, maxNodes: 3 } })), 'invalid-expansion')
})

test('focus selection keeps the full vault and derives the graph query from the selected paths', () => {
  const focus = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] } })
  assert.deepEqual({ nodes: focus.nodes, edges: focus.edges, vault: focus.vaultNodes, vaultEdges: focus.vaultEdges }, { nodes: ['a', 'b'], edges: ['e1'], vault: ['a', 'b', 'c', 'd'], vaultEdges: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'] })
  assert.deepEqual(focus.focus, {
    version: FOCUS_QUERY_VERSION,
    query: 'path:"notes/Shared concept--82f6d012eaad.md" OR path:"notes/Second concept--242ab15f42c6.md"',
    queryDigest: sha('path:"notes/Shared concept--82f6d012eaad.md" OR path:"notes/Second concept--242ab15f42c6.md"'),
    paths: ['notes/Shared concept--82f6d012eaad.md', 'notes/Second concept--242ab15f42c6.md'],
    bookmark: { type: 'graph', title: 'Atelier focus view-focus', options: { search: 'path:"notes/Shared concept--82f6d012eaad.md" OR path:"notes/Second concept--242ab15f42c6.md"' } },
  })
  // The same identity has the same path in the full view.
  const full = select({ scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.equal(full.notePaths.a, focus.notePaths.a)
  assert.equal(full.notePaths.b, focus.notePaths.b)
  // Deterministic: the same request is the same answer.
  assert.deepEqual(select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] } }), focus)
})

test('a persisted path registry decides the paths a focus names', () => {
  // A registry may hold a longer suffix of the same identity (a lengthened one after a collision); an undeserved suffix is refused.
  const longer = identitySuffix('north', 'a', 16)
  assert.equal(longer.slice(0, 12), '82f6d012eaad')
  const registry = { schema: 'atelier-obsidian-path-registry/v1', workspaceId: PROFILE.workspaceId, entries: [{ repoId: 'north', nodeId: 'a', path: `notes/Shared concept--${longer}.md` }] }
  const focus = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] } }, { pathRegistry: registry })
  assert.equal(focus.focus.query, `path:"notes/Shared concept--${longer}.md"`)
  const forged = { ...registry, entries: [{ repoId: 'north', nodeId: 'a', path: 'notes/Shared concept--82f6d012eaad0000.md' }] }
  assert.equal(refusalCode(() => select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] } }, { pathRegistry: forged })), 'invalid-path-registry')
})

test('refusals: empty, withheld, unbounded expansion, focus of nothing, full mode with a subset', () => {
  assert.equal(refusalCode(() => select({ scopeId: 'view-e', mode: 'scoped', selector: { ids: [] } })), 'selection-empty')
  const honest = select({ scopeId: 'view-e', mode: 'scoped', selector: { ids: [] } }, { allowEmpty: true })
  assert.deepEqual({ nodes: honest.nodes, edges: honest.edges, vault: honest.vaultNodes, empty: honest.empty, reason: honest.emptyReason, paths: honest.notePaths }, { nodes: [], edges: [], vault: [], empty: true, reason: 'explicit-empty', paths: {} })
  // Withheld: absent and withheld are one answer, and no fallback to all.
  let error = null
  try { select({ scopeId: 'view-w', mode: 'scoped', selector: { ids: ['x', 'nobody'] } }) } catch (caught) { error = caught }
  assert.equal(error?.code, 'selection-empty')
  assert.deepEqual(error.detail, { reason: 'no-visible-members', unresolvedIds: ['nobody', 'x'] })
  const withheld = select({ scopeId: 'view-w', mode: 'scoped', selector: { ids: ['x'] } }, { allowEmpty: true })
  assert.deepEqual({ nodes: withheld.nodes, reason: withheld.emptyReason, diagnostics: withheld.diagnostics }, { nodes: [], reason: 'no-visible-members', diagnostics: ['selection-has-no-visible-members'] })
  assert.equal(refusalCode(() => select({ scopeId: 'view-f', mode: 'focus', selector: { ids: ['x'] } }, { allowEmpty: true })), 'focus-selection-empty', 'a focus is never widened, even when empty is allowed')
  assert.equal(refusalCode(() => select({ scopeId: 'view-f', mode: 'focus', selector: { ids: [] } }, { allowEmpty: true })), 'focus-selection-empty')
  assert.equal(refusalCode(() => select({ scopeId: 'view-full', mode: 'full', selector: { ids: ['a'] } })), 'invalid-scope')
  assert.equal(refusalCode(() => select({ scopeId: 'view-u', mode: 'scoped', selector: { repo: 'nowhere' } })), 'unknown-repo')
  assert.equal(refusalCode(() => select({ scopeId: 'view-u', mode: 'scoped', selector: { glob: '*' } })), 'invalid-scope')
  assert.equal(refusalCode(() => select({ scopeId: 'view-u', mode: 'everything', selector: { all: true } })), 'invalid-scope')
  assert.equal(refusalCode(() => scopeDocumentOf({ scopeId: '', mode: 'full', selector: { all: true } })), 'invalid-scope')
})

// ---------------------------------------------------------------------------
// 2. Focus query escaping, and its mutation control
// ---------------------------------------------------------------------------

const ESCAPING_CASES = [
  { name: 'spaces', paths: ['notes/Shared concept--82f6d012eaad.md'], query: 'path:"notes/Shared concept--82f6d012eaad.md"' },
  { name: 'double quotes', paths: ['notes/He said "go"--0123456789ab.md'], query: 'path:"notes/He said \\"go\\"--0123456789ab.md"' },
  { name: 'unicode, composed', paths: ['notes/Caf\u00e9 \u00fcnicode \u2014 \u5317--0123456789ab.md'], query: 'path:"notes/Caf\u00e9 \u00fcnicode \u2014 \u5317--0123456789ab.md"' },
  { name: 'unicode, decomposed input is composed on output', paths: ['notes/Cafe\u0301--0123456789ab.md'], query: 'path:"notes/Caf\u00e9--0123456789ab.md"' },
  { name: 'several, in the order given', paths: ['notes/B--0123456789ab.md', 'notes/A--0123456789ab.md'], query: 'path:"notes/B--0123456789ab.md" OR path:"notes/A--0123456789ab.md"' },
  { name: 'search operators inside a quoted term stay text', paths: ['notes/tag:#x OR -y (z)--0123456789ab.md'], query: 'path:"notes/tag:#x OR -y (z)--0123456789ab.md"' },
]

test('focus query escaping: spaces, quotes and unicode give the literal expected query', () => {
  for (const item of ESCAPING_CASES) {
    const built = buildFocusQuery(item.paths)
    assert.equal(built.query, item.query, item.name)
    assert.equal(built.queryDigest, sha(item.query), item.name)
    assert.equal(built.version, FOCUS_QUERY_VERSION)
  }
  assert.deepEqual(focusBookmarkPayload({ scopeId: 'view-focus', query: 'path:"a"' }), { type: 'graph', title: 'Atelier focus view-focus', options: { search: 'path:"a"' } })
  assert.deepEqual(UI_OWNED_SETTINGS_FILES, ['workspace.json', 'graph.json', 'bookmarks.json'])
  for (const name of UI_OWNED_SETTINGS_FILES) assert.ok(isUserOwnedSettingsPath(`.obsidian/${name}`), `${name} is a file the person owns`)
})

test('focus query refusals: nothing, a control character, a backslash path, an absolute path, a repeated path', () => {
  assert.equal(refusalCode(() => buildFocusQuery([])), 'focus-selection-empty')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\nb--0123456789ab.md'])), 'focus-path-unrepresentable')
  // The two Unicode line separators are written as escapes here and in the builder; neither file holds the literal character.
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\u2028b--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\u2029b--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\u0085b--0123456789ab.md'])), 'focus-path-unrepresentable')
  for (const file of ['src/projection/obsidian/selection-ui/focus.mjs', 'test/obsidian-acceptance.test.mjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8'), /[\u2028\u2029]/, `${file} carries no literal line separator`)
  }
  assert.equal(refusalCode(() => buildFocusQuery(['notes\\a--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['/notes/a--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/../a--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a--0123456789ab.md', 'notes/a--0123456789ab.md'])), 'duplicate-identity')
  assert.equal(refusalCode(() => focusBookmarkPayload({ scopeId: 'view-focus', query: '' })), 'focus-selection-empty')
})

test('mutation control: a builder that drops escaping fails the escaping oracle', () => {
  const unescaped = createFocusQueryBuilderForOracleTests({ escape: (value) => value })
  const failing = ESCAPING_CASES.filter((item) => unescaped(item.paths).query !== item.query).map((item) => item.name)
  assert.deepEqual(failing, ['double quotes'])
  const unquoted = createFocusQueryBuilderForOracleTests({ term: (value) => `path:${value}` })
  assert.equal(ESCAPING_CASES.filter((item) => unquoted(item.paths).query !== item.query).length, ESCAPING_CASES.length)
  const wrongJoin = createFocusQueryBuilderForOracleTests({ join: (terms) => terms.join(' ') })
  assert.deepEqual(ESCAPING_CASES.filter((item) => wrongJoin(item.paths).query !== item.query).map((item) => item.name), ['several, in the order given'])
})

// ---------------------------------------------------------------------------
// 3. The selector persists in Atelier state, never in a UI-owned file
// ---------------------------------------------------------------------------

test('a selection persists under state/selection, is read back exactly, and rewrites only when it changes', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'state')
  const focus = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] } })
  const written = writeSelectionState({ ...workspace, repositoryRoots, selection: focus, now: NOW })
  assert.equal(path.relative(workspace.workspaceRoot, written.file).split(path.sep).join('/'), 'state/selection/view-focus.json')
  assert.equal(written.changed, true)
  assert.deepEqual(written.document, {
    schema: SELECTION_STATE_SCHEMA, workspaceId: WORKSPACE_ID, scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] }, expansion: null,
    focus: { version: FOCUS_QUERY_VERSION, query: focus.focus.query, queryDigest: focus.focus.queryDigest, paths: focus.focus.paths, bookmark: focus.focus.bookmark }, updatedAt: NOW,
  })
  if (process.platform !== 'win32') assert.equal(fs.statSync(written.file).mode & 0o777, 0o600, 'owner-only')
  assert.deepEqual(readSelectionState({ ...workspace, scopeId: 'view-focus' }), written.document)
  // The same selection later: no rewrite, the earlier time stays.
  const again = writeSelectionState({ ...workspace, repositoryRoots, selection: focus, now: '2026-01-05T11:00:00.000Z' })
  assert.deepEqual({ changed: again.changed, updatedAt: again.document.updatedAt }, { changed: false, updatedAt: NOW })
  // A changed selection is a rewrite.
  const wider = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b', 'c'] } })
  assert.equal(writeSelectionState({ ...workspace, repositoryRoots, selection: wider, now: '2026-01-05T11:00:00.000Z' }).changed, true)
  assert.equal(readSelectionState({ ...workspace, scopeId: 'view-focus' }).focus.paths.length, 3)
  // Several scopes list in scope order; a scoped one carries no focus.
  writeSelectionState({ ...workspace, repositoryRoots, selection: select({ scopeId: 'view-a:north', mode: 'scoped', selector: { repo: 'north' }, expansion: { depth: 1, maxNodes: 4 } }), now: NOW })
  assert.deepEqual(listSelectionStates(workspace).map((item) => [item.scopeId, item.mode, item.focus === null, item.expansion]), [['view-a:north', 'scoped', true, { depth: 1, maxNodes: 4, direction: 'outgoing', order: 'canonical-id' }], ['view-focus', 'focus', false, null]])
  assert.equal(readSelectionState({ ...workspace, scopeId: 'view-none' }), null)
  // Nothing under any vault and nothing under .obsidian/ exists in the workspace.
  const files = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else files.push(path.relative(workspace.workspaceRoot, full).split(path.sep).join('/')) } }
  walk(workspace.workspaceRoot)
  assert.deepEqual(files.sort(), ['state/selection/view-a_north.json', 'state/selection/view-focus.json', 'state/settings/machine.json'])
  assert.ok(files.every((file) => !file.includes('.obsidian') && !file.startsWith('vaults/')))
})

test('the selection writer refuses a UI-owned target, a vault target, an outside target and an overlap with a repository', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'guard')
  const root = workspace.workspaceRoot
  for (const name of UI_OWNED_SETTINGS_FILES) assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, 'vaults', 'view-full', '.obsidian', name) })), 'ui-owned-file-refused')
  assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, 'vaults', 'view-full', 'notes', 'x.md') })), 'ui-owned-file-refused')
  assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, 'state', 'maintenance', 'x.json') })), 'selection-state-outside-workspace')
  assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(path.dirname(root), 'x.json') })), 'selection-state-outside-workspace')
  assert.equal(assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, SELECTION_DIRECTORY, 'view.json') }), path.join(root, SELECTION_DIRECTORY, 'view.json'))
  const selection = select({ scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.equal(refusalCode(() => writeSelectionState({ ...workspace, repositoryRoots: [root], selection, now: NOW })), 'managed-root-inside-repository')
  assert.equal(refusalCode(() => writeSelectionState({ ...workspace, repositoryRoots, selection: { schema: 'something-else' }, now: NOW })), 'invalid-selection')
  assert.equal(refusalCode(() => writeSelectionState({ ...workspace, repositoryRoots, selection, now: 'yesterday' })), 'invalid-selection-state')
  // A stored document of another workspace, or with a member the shape does not know, refuses on read.
  fs.mkdirSync(path.join(root, SELECTION_DIRECTORY), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, SELECTION_DIRECTORY, 'view-x.json'), JSON.stringify({ schema: SELECTION_STATE_SCHEMA, workspaceId: 'ws-other', scopeId: 'view-x', mode: 'full', selector: { all: true }, expansion: null, focus: null, updatedAt: NOW }))
  assert.equal(refusalCode(() => readSelectionState({ ...workspace, scopeId: 'view-x' })), 'invalid-selection-state')
  fs.writeFileSync(path.join(root, SELECTION_DIRECTORY, 'view-x.json'), JSON.stringify({ schema: SELECTION_STATE_SCHEMA, workspaceId: WORKSPACE_ID, scopeId: 'view-x', mode: 'full', selector: { all: true }, expansion: null, focus: null, updatedAt: NOW, graphSettings: {} }))
  assert.equal(refusalCode(() => readSelectionState({ ...workspace, scopeId: 'view-x' })), 'invalid-selection-state')
})

// ---------------------------------------------------------------------------
// 4. Apply policy setup: create, show, revoke; revocation wins
// ---------------------------------------------------------------------------

test('policy setup round trip: create manual, show, create automatic, revoke; the digest is the canonical one', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'policy')
  const actor = { kind: 'user', id: 'person-synthetic' }
  const manual = runPolicySetup({ action: 'create', input: { policyId: 'policy-house', mode: 'manual', actor, selector: { all: true } }, workspace, repositoryRoots, now: NOW })
  assert.equal(manual.schema, POLICY_SETUP_SCHEMA)
  assert.equal(manual.ok, true)
  assert.deepEqual(validateObsidianContract('apply-policy', manual.policy), [])
  assert.deepEqual({ ...manual.policy, digest: 'x' }, { schema: 'atelier-obsidian-apply-policy/v1', policyId: 'policy-house', workspaceId: WORKSPACE_ID, mode: 'manual', status: 'active', actor, version: 1, allowedEditClasses: [], selector: { all: true }, maxBatchSize: 10, retryBudget: 0, conflictDisposition: 'hold', digest: 'x' })
  assert.equal(manual.policy.digest, applyPolicyDigest(manual.policy))
  assert.deepEqual(manual.reference, { policyId: 'policy-house', version: 1, digest: manual.policy.digest, mode: 'manual', status: 'active' })
  assert.deepEqual(manual.automaticApply, { authorized: false, reason: 'maintenance-mode-manual' })
  assert.deepEqual(readInstalledApplyPolicy(workspace), manual.policy)
  assert.deepEqual(readMachineSettings(workspace).applyPolicy, { policyId: 'policy-house', version: 1, digest: manual.policy.digest })

  const shown = runPolicySetup({ action: 'show', workspace })
  assert.deepEqual({ ok: shown.ok, installed: shown.installed, policy: shown.policy, reference: shown.reference, maintenanceMode: shown.maintenanceMode, automaticApply: shown.automaticApply }, { ok: true, installed: true, policy: manual.policy, reference: readMachineSettings(workspace).applyPolicy, maintenanceMode: 'manual', automaticApply: { authorized: false, reason: 'maintenance-mode-manual' } })

  // The next revision of the same identity is one version up; only the implemented class can be allowed.
  const automatic = runPolicySetup({ action: 'create', input: { policyId: 'policy-house', mode: 'automatic', actor: { kind: 'agent', id: 'agent-synthetic' }, selector: { intersection: [{ repo: 'north' }, { type: 'md' }] }, maxBatchSize: 3, retryBudget: 1 }, workspace, repositoryRoots, now: NOW })
  assert.equal(automatic.ok, true)
  assert.deepEqual({ version: automatic.policy.version, classes: automatic.policy.allowedEditClasses, mode: automatic.policy.mode }, { version: 2, classes: ['body-replacement'], mode: 'automatic' })
  assert.equal(readMachineSettings(workspace).maintenanceMode, 'manual', 'installing a policy never switches the mode')
  assert.deepEqual(automatic.automaticApply, { authorized: false, reason: 'maintenance-mode-manual' })
  const stale = runPolicySetup({ action: 'create', input: { policyId: 'policy-house', version: 2, mode: 'automatic', actor, selector: { all: true } }, workspace, repositoryRoots, now: NOW })
  assert.deepEqual({ ok: stale.ok, code: stale.refusal.code }, { ok: false, code: 'policy-version-not-newer' })
  assert.equal(readInstalledApplyPolicy(workspace).digest, automatic.policy.digest, 'a refused create installs nothing')
  for (const [input, code] of [
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, allowedEditClasses: ['rename'] }, 'unimplemented-edit-class'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, allowedEditClasses: [] }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'agentic', actor, selector: { all: true } }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor: { kind: 'robot', id: 'r' }, selector: { all: true } }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { glob: '*' } }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, maxBatchSize: 0 }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, retryBudget: 99 }, 'invalid-apply-policy'],
  ]) {
    const result = runPolicySetup({ action: 'create', input, workspace, repositoryRoots, now: NOW })
    assert.deepEqual({ ok: result.ok, code: result.refusal.code }, { ok: false, code }, JSON.stringify(input))
  }
  assert.equal(runPolicySetup({ action: 'delete', workspace, repositoryRoots, now: NOW }).refusal.code, 'usage')
  assert.equal(refusalCode(() => buildApplyPolicy({ workspaceId: WORKSPACE_ID, policyId: 'p', mode: 'automatic', actor, selector: { all: true }, allowedEditClasses: ['body-replacement', 'rename'] })), 'unimplemented-edit-class')

  // Authorized once the person switches the mode; revoked durably afterwards.
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...readMachineSettings(workspace), maintenanceMode: 'automatic', updatedAt: NOW } })
  assert.deepEqual(dispatchGate(workspace), { authorized: true, reason: 'apply-policy-active', policyDigest: automatic.policy.digest })
  const revoked = runPolicySetup({ action: 'revoke', workspace, repositoryRoots, now: '2026-01-05T10:01:00.000Z' })
  assert.deepEqual({ ok: revoked.ok, revoked: revoked.revoked, reason: revoked.reason, status: revoked.policy.status, mode: revoked.maintenanceMode }, { ok: true, revoked: true, reason: 'revoked', status: 'revoked', mode: 'manual' })
  assert.equal(readInstalledApplyPolicy(workspace).status, 'revoked', 'the stored policy says revoked')
  assert.equal(readMachineSettings(workspace).maintenanceMode, 'manual')
  assert.deepEqual(dispatchGate(workspace), { authorized: false, reason: 'maintenance-mode-manual', policyDigest: null })
  assert.deepEqual(authorizeAutomaticApply({ ...workspace, assumeAutomatic: true }), { authorized: false, reason: 'apply-policy-revoked', policy: null }, 'even if the mode were automatic, a revoked policy denies')
  assert.deepEqual(runPolicySetup({ action: 'revoke', workspace, repositoryRoots, now: NOW }).reason, 'already-revoked')
  assert.equal(runPolicySetup({ action: 'show', workspace }).policy.status, 'revoked')
})

// The engine's dispatch (AOP-1) reads authorization from disk immediately
// before every edit. A revocation that lands between two edits of one batch
// stops the second: nothing queued behind a revocation is applied.
test('revocation wins over a queued apply: the dispatch that follows a revocation never reaches the operation', async (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'revoke')
  const actor = { kind: 'agent', id: 'agent-synthetic' }
  assert.equal(runPolicySetup({ action: 'create', input: { policyId: 'policy-auto', mode: 'automatic', actor, selector: { all: true }, maxBatchSize: 10, retryBudget: 2 }, workspace, repositoryRoots, now: NOW }).ok, true)
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...readMachineSettings(workspace), maintenanceMode: 'automatic', updatedAt: NOW } })
  const edit = (suffix, observedAt) => ({
    editId: `edit-${suffix.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: `n-${suffix}` }, scopeId: 'view-full', generationId: 'gen-1', path: `notes/${suffix}.md`,
    baseNoteDigest: sha(`base-${suffix}`), observedDigest: sha(`observed-${suffix}`), objectRef: `recovery/objects/${sha(`observed-${suffix}`).slice(7)}.bin`,
    observedAt, state: 'queued', attempts: 0, retryBudget: null, lastAttemptAt: null, lastResult: null, closedAt: null,
  })
  const edits = [edit('a', '2026-01-05T09:00:00.000Z'), edit('b', '2026-01-05T09:01:00.000Z')]
  const reached = []
  const applyOperation = {
    id: 'atelier.test-apply',
    async apply({ edit: dispatched, policyDigest }) {
      reached.push(dispatched.editId)
      // Somebody revokes while the first edit is being applied.
      runPolicySetup({ action: 'revoke', workspace, repositoryRoots, now: '2026-01-05T10:00:30.000Z' })
      return { status: 'applied', code: `applied-under-${policyDigest.slice(0, 15)}` }
    },
  }
  const outcome = await dispatchAutomaticApply({ edits, applyOperation, now: NOW, nowMs: Date.parse(NOW), retryIntervalMs: 0, authorize: () => authorizeAutomaticApply(workspace) })
  assert.deepEqual(reached, [`edit-${'a'.repeat(32)}`], 'the second edit is never dispatched')
  assert.equal(outcome.authorization, 'maintenance-mode-manual', 'the re-read before the second edit found the revocation')
  assert.deepEqual(outcome.edits.map((item) => item.state), ['applied', 'queued'])
  // And after a restart nothing is dispatched at all: the revocation is on disk.
  const later = await dispatchAutomaticApply({ edits: outcome.edits, applyOperation, now: NOW, nowMs: Date.parse(NOW), retryIntervalMs: 0, authorize: () => authorizeAutomaticApply(workspace) })
  assert.deepEqual({ reached: reached.length, dispatched: later.dispatched, authorization: later.authorization }, { reached: 1, dispatched: [], authorization: 'maintenance-mode-manual' })
  // Switching the mode back to automatic by hand does not resurrect a revoked policy.
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...readMachineSettings(workspace), maintenanceMode: 'automatic', updatedAt: NOW } })
  const resumed = await dispatchAutomaticApply({ edits: outcome.edits, applyOperation, now: NOW, nowMs: Date.parse(NOW), retryIntervalMs: 0, authorize: () => authorizeAutomaticApply(workspace) })
  assert.deepEqual({ reached: reached.length, authorization: resumed.authorization }, { reached: 1, authorization: 'apply-policy-revoked' })
})

// ---------------------------------------------------------------------------
// 5. Conflict view
// ---------------------------------------------------------------------------

test('conflict view is a typed, sorted function of the object entries and the open edits', () => {
  const objects = [
    { repoId: 'south', nodeId: 'b', state: 'pending', sequence: 2, sourceDigest: sha('b'), scopes: ['view-full'], operations: [{ idempotencyKey: `op-${'1'.repeat(64)}`, kind: 'body-replacement', state: 'pending', reason: null, by: null }], leaseHeld: false, intentOutcomeUnknown: false },
    { repoId: 'north', nodeId: 'a', state: 'conflicted', sequence: 4, sourceDigest: null, scopes: ['view-full', 'view-north'], operations: [
      { idempotencyKey: `op-${'2'.repeat(64)}`, kind: 'body-replacement', state: 'conflicted', reason: 'divergent-edits', by: null },
      { idempotencyKey: `op-${'3'.repeat(64)}`, kind: 'body-replacement', state: 'conflicted', reason: 'divergent-edits', by: null },
      { idempotencyKey: `op-${'4'.repeat(64)}`, kind: 'body-replacement', state: 'superseded', reason: 'resolved', by: `op-${'2'.repeat(64)}` },
    ], leaseHeld: true, intentOutcomeUnknown: false },
    { repoId: 'west', nodeId: 'c', state: 'settled', sequence: 9, sourceDigest: sha('c'), scopes: ['view-full'], operations: [{ idempotencyKey: `op-${'5'.repeat(64)}`, kind: 'body-replacement', state: 'applied', reason: null, by: null }], leaseHeld: false, intentOutcomeUnknown: true },
    { repoId: null, nodeId: null, state: 'unreadable', code: 'object-identity-unknown' },
    { repoId: 'west', nodeId: 'z', state: 'mystery' },
  ]
  const edits = [
    { editId: `edit-${'a'.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a' }, scopeId: 'view-north', state: 'apply-failed', lastResult: { status: 'conflict', code: 'object-conflicted' } },
    { editId: `edit-${'b'.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a' }, scopeId: 'view-full', state: 'queued', lastResult: null },
    { editId: `edit-${'c'.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a' }, scopeId: 'view-full', state: 'applied', lastResult: null },
  ]
  const view = conflictView({ objects, edits })
  assert.equal(view.schema, CONFLICT_VIEW_SCHEMA)
  assert.deepEqual(view.objects.map((item) => [item.repoId, item.nodeId, item.state, item.needsPerson]), [[null, null, 'unreadable', true], ['north', 'a', 'conflicted', true], ['south', 'b', 'pending', false], ['west', 'c', 'settled', true], ['west', 'z', 'unreadable', true]])
  const north = view.objects[1]
  assert.deepEqual(north.conflictedOperations, [`op-${'2'.repeat(64)}`, `op-${'3'.repeat(64)}`])
  assert.deepEqual(north.operations[2], { idempotencyKey: `op-${'4'.repeat(64)}`, kind: 'body-replacement', state: 'superseded', reason: 'resolved', by: `op-${'2'.repeat(64)}` })
  assert.deepEqual(north.pendingEdits, [{ editId: `edit-${'b'.repeat(32)}`, scopeId: 'view-full', state: 'queued', lastCode: null }, { editId: `edit-${'a'.repeat(32)}`, scopeId: 'view-north', state: 'apply-failed', lastCode: 'object-conflicted' }])
  assert.equal(north.leaseHeld, true)
  assert.match(north.next, /names every conflicted operation/)
  assert.match(view.objects[3].next, /outcome is not recorded/)
  assert.deepEqual(view.summary, { total: 5, byState: { conflicted: 1, pending: 1, settled: 1, empty: 0, inconsistent: 0, unreadable: 2 }, needsPerson: 4, openEdits: 2 })
  assert.equal(view.needsPerson, true)
  // Narrowed to one view: only that view's edits are attached.
  assert.deepEqual(conflictView({ objects, edits, scopeId: 'view-north' }).objects[1].pendingEdits.map((item) => item.editId), [`edit-${'a'.repeat(32)}`])
  assert.deepEqual(conflictView({ objects: [], edits: [] }), { schema: CONFLICT_VIEW_SCHEMA, scopeId: null, objects: [], summary: { total: 0, byState: Object.fromEntries(OBJECT_VIEW_STATES.map((state) => [state, 0])), needsPerson: 0, openEdits: 0 }, needsPerson: false })
  // No note text, title or path leaves the view.
  assert.ok(!JSON.stringify(view).includes('notes/'))
})

test('conflict view over the real arbitration record: two divergent edits of one object from two views are conflicted', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'arbitration')
  const clock = () => new Date(NOW)
  const store = openObjectStore({ stateRoot: workspace.workspaceRoot, workspaceId: WORKSPACE_ID, repositoryRoots, clock })
  const base = sha('source-as-generated')
  const operation = (editId, observed, next, scopeId) => ({
    schema: 'atelier-obsidian-edit-operation/v1', editId, workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a', origin: { scopeId, generationId: 'gen-0001' }, kind: 'body-replacement',
    baseSourceDigest: base, observed: { digest: sha(observed), byteLength: 40, recoveryRef: `recovery/objects/${sha(observed).slice(7)}.bin` },
    idempotencyKey: editIdempotencyKey({ workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a', baseSourceDigest: base, observedDigest: sha(observed) }),
    state: 'pending', observedAt: NOW, ext: { [OBSIDIAN_EXT_KEY]: { result: { newSourceDigest: sha(next), newByteLength: 41 } } },
  })
  assert.equal(store.observe(operation('edit-one', 'typed in the full view', 'source one', 'view-full')).object.state, 'pending')
  // The same bytes from another view coalesce: still one pending operation.
  assert.equal(store.observe(operation('edit-two', 'typed in the full view', 'source one', 'view-north')).object.state, 'pending')
  assert.equal(readConflictView({ ...workspace, repositoryRoots, clock }).objects[0].state, 'pending')
  assert.equal(store.observe(operation('edit-three', 'typed differently', 'source two', 'view-north')).object.state, 'conflicted')
  const sequenceBefore = store.stateOf({ repoId: 'north', nodeId: 'a' }).sequence
  const view = readConflictView({ ...workspace, repositoryRoots, clock })
  assert.deepEqual(view.objects.map((item) => [item.repoId, item.nodeId, item.state, item.needsPerson, item.operations.map((operation) => [operation.state, operation.reason])]), [['north', 'a', 'conflicted', true, [['conflicted', 'divergent-edits'], ['conflicted', 'divergent-edits']]]])
  assert.equal(view.objects[0].conflictedOperations.length, 2)
  assert.deepEqual({ needsPerson: view.needsPerson, foreign: view.foreign, byState: view.summary.byState.conflicted }, { needsPerson: true, foreign: 0, byState: 1 })
  assert.deepEqual(readConflictView({ ...workspace, repositoryRoots, clock, scopeId: 'view-elsewhere' }).objects, [], 'an object no such view edited is not listed for it')
  // The view read nothing into the source and wrote no event: the object log is as the observer left it.
  assert.equal(store.stateOf({ repoId: 'north', nodeId: 'a' }).sequence, sequenceBefore)
})

// ---------------------------------------------------------------------------
// 6. Receipt validation: schema validation only
// ---------------------------------------------------------------------------

const fixture = (gate) => readJson(path.join(FIXTURES, `${gate}.valid.v1.json`))
const withExt = (receipt, change) => { const copy = structuredClone(receipt); change(copy, copy.ext[RECEIPT_EXT_KEY]); return copy }

test('every owned gate has a valid synthetic receipt fixture, and validating it closes nothing', () => {
  assert.deepEqual(RECEIPT_GATE_IDS, ['G07', 'G13', 'G14', 'G15', 'G16', 'G17', 'G18'])
  assert.deepEqual(fs.readdirSync(FIXTURES).sort(), RECEIPT_GATE_IDS.map((gate) => `${gate}.valid.v1.json`))
  for (const gate of RECEIPT_GATE_IDS) {
    const receipt = fixture(gate)
    assert.deepEqual(validateObsidianContract('acceptance-receipt', receipt), [], gate)
    const result = validateAcceptanceReceipt(receipt, { gate })
    assert.deepEqual({ label: result.label, gate: result.gate, schemaValid: result.schemaValid, requirementsMet: result.requirementsMet, valid: result.valid, gateClosed: result.gateClosed, closes: result.closes, missing: result.missing, outcome: result.outcome, evidenceType: result.evidenceType },
      { label: RECEIPT_VALIDATION_LABEL, gate, schemaValid: true, requirementsMet: true, valid: true, gateClosed: false, closes: 'nothing', missing: [], outcome: 'passed', evidenceType: RECEIPT_GATES[gate].evidenceType }, gate)
    assert.match(result.note, /closes no gate/)
    // Without naming the gate, the receipt's own gate is checked.
    assert.equal(validateAcceptanceReceipt(receipt).valid, true)
    // The synthetic fixture names no real host, person or machine path. The extension key is the one registered name it must carry.
    assert.doesNotMatch(JSON.stringify(receipt).replaceAll(RECEIPT_EXT_KEY, ''), /mnstry|\.local|\/Users\/|C:\\/i, gate)
  }
})

test('the receipt field table is pinned per gate', () => {
  const table = Object.fromEntries(RECEIPT_GATE_IDS.map((gate) => [gate, receiptRequirementsFor(gate)]))
  const always = ['candidate.commit', 'candidate.treeDigest', 'environment.os.{name,version}', 'environment.app.{name,version}', 'environment.cli.version', 'evidence[].{name,digest,byteLength>0}', `ext.${RECEIPT_EXT_KEY}.host.id`, `ext.${RECEIPT_EXT_KEY}.operator.id`]
  assert.deepEqual(table, {
    G07: { gate: 'G07', procedure: 'AP-01', evidenceType: 'real-app', always, evidenceRoles: ['cli-link-inspection', 'app-observation'], acceptance: 'human', wallClock: false, dataset: false, tarballDigest: false },
    G13: { gate: 'G13', procedure: 'AP-02', evidenceType: 'real-app', always, evidenceRoles: ['on-disk-membership', 'app-index-membership', 'graph-filter-observation'], acceptance: 'human', wallClock: false, dataset: false, tarballDigest: false },
    G14: { gate: 'G14', procedure: 'AP-03', evidenceType: 'host', always, evidenceRoles: ['source-refresh-trace', 'dropped-event-recovery', 'sleep-wake-clock'], acceptance: null, wallClock: true, dataset: false, tarballDigest: false },
    G15: { gate: 'G15', procedure: 'AP-03', evidenceType: 'host', always, evidenceRoles: ['ownership-health', 'terminal-closure'], acceptance: null, wallClock: true, dataset: false, tarballDigest: false },
    G16: { gate: 'G16', procedure: 'AP-04', evidenceType: 'real-app', always, evidenceRoles: ['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies'], acceptance: null, wallClock: true, dataset: true, tarballDigest: false },
    G17: { gate: 'G17', procedure: 'AP-05', evidenceType: 'real-app', always, evidenceRoles: ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention'], acceptance: 'human', wallClock: false, dataset: false, tarballDigest: false },
    G18: { gate: 'G18', procedure: 'AP-06', evidenceType: 'human', always, evidenceRoles: ['tarball-audit', 'adopter-acceptance'], acceptance: 'adopter', wallClock: false, dataset: false, tarballDigest: true },
  })
  assert.equal(receiptRequirementsFor('G02'), null)
})

// Each negative names the one rule it is sensitive to. The mutation control
// below switches that rule off and proves the negative then passes.
const NEGATIVES = [
  { name: 'gate mismatch', gate: 'G07', rule: 'gate', code: 'gate-mismatch', change: (receipt) => { receipt.gate = 'G13' } },
  { name: 'procedure of another gate', gate: 'G13', rule: 'procedure', code: 'procedure-mismatch', change: (receipt) => { receipt.procedureId = 'AP-01' } },
  { name: 'procedure variant is fine, an unrelated id is not', gate: 'G13', rule: 'procedure', code: 'procedure-mismatch', change: (receipt) => { receipt.procedureId = 'AP-020' } },
  { name: 'node evidence for a real-app gate', gate: 'G07', rule: 'evidenceType', code: 'evidence-type-mismatch', change: (receipt) => { receipt.evidenceType = 'node' } },
  { name: 'real-app evidence for a host gate', gate: 'G14', rule: 'evidenceType', code: 'evidence-type-mismatch', change: (receipt) => { receipt.evidenceType = 'real-app' } },
  { name: 'app version placeholder', gate: 'G07', rule: 'versionPins', code: 'version-not-pinned', change: (receipt) => { receipt.environment.app.version = 'latest' } },
  { name: 'cli version unknown', gate: 'G13', rule: 'versionPins', code: 'version-not-pinned', change: (receipt) => { receipt.environment.cli.version = 'unknown' } },
  { name: 'os version blank', gate: 'G15', rule: 'versionPins', code: 'version-not-pinned', change: (receipt) => { receipt.environment.os.version = ' ' } },
  { name: 'candidate commit placeholder', gate: 'G17', rule: 'candidateIdentity', code: 'candidate-not-pinned', change: (receipt) => { receipt.candidate.commit = '0'.repeat(40) } },
  { name: 'tarball digest missing for the release gate', gate: 'G18', rule: 'candidateIdentity', code: 'candidate-not-pinned', change: (receipt) => { delete receipt.candidate.tarballDigest } },
  { name: 'host identity missing', gate: 'G14', rule: 'hostIdentity', code: 'host-identity-missing', change: (receipt, ext) => { delete ext.host } },
  { name: 'operator identity missing', gate: 'G16', rule: 'hostIdentity', code: 'operator-identity-missing', change: (receipt, ext) => { delete ext.operator } },
  { name: 'evidence role missing', gate: 'G07', rule: 'evidenceHashes', code: 'evidence-role-missing', change: (receipt, ext) => { delete ext.evidenceRoles['cli-link-inspection'] } },
  { name: 'evidence role names an entry that is not there', gate: 'G13', rule: 'evidenceHashes', code: 'evidence-role-missing', change: (receipt, ext) => { ext.evidenceRoles['app-index-membership'] = 'elsewhere.txt' } },
  { name: 'evidence role unknown to the gate', gate: 'G15', rule: 'evidenceHashes', code: 'evidence-role-unknown', change: (receipt, ext) => { ext.evidenceRoles['sleep-wake-clock'] = 'ownership-health.txt' } },
  { name: 'empty evidence file', gate: 'G17', rule: 'evidenceHashes', code: 'evidence-not-hashed', change: (receipt) => { receipt.evidence[0].byteLength = 0 } },
  { name: 'human acceptance missing', gate: 'G07', rule: 'acceptance', code: 'acceptance-missing', change: (receipt, ext) => { delete ext.acceptance } },
  { name: 'adopter acceptance missing', gate: 'G18', rule: 'acceptance', code: 'acceptance-missing', change: (receipt, ext) => { delete ext.acceptance } },
  { name: 'adopter acceptance given by the operator', gate: 'G18', rule: 'acceptance', code: 'acceptance-not-separate', change: (receipt, ext) => { ext.acceptance.actor = ext.operator.id } },
  { name: 'human acceptance where an adopter is needed', gate: 'G18', rule: 'acceptance', code: 'acceptance-kind-mismatch', change: (receipt, ext) => { ext.acceptance.kind = 'human' } },
  { name: 'acceptance names no evidence of its own', gate: 'G17', rule: 'acceptance', code: 'acceptance-missing', change: (receipt, ext) => { ext.acceptance.evidenceName = 'nowhere.txt' } },
  { name: 'acceptance where the gate records host evidence', gate: 'G14', rule: 'acceptance', code: 'acceptance-not-expected', change: (receipt, ext) => { ext.acceptance = { kind: 'human', actor: 'reviewer-synthetic', recordedAt: '2026-02-01T12:30:00Z', evidenceName: 'sleep-wake-clock.txt' } } },
  { name: 'wall clock missing', gate: 'G14', rule: 'wallClock', code: 'wall-clock-missing', change: (receipt, ext) => { delete ext.wallClock } },
  { name: 'wall clock runs backwards', gate: 'G15', rule: 'wallClock', code: 'wall-clock-missing', change: (receipt, ext) => { ext.wallClock.endedAt = '2026-02-01T10:00:00Z' } },
  { name: 'dataset missing', gate: 'G16', rule: 'dataset', code: 'dataset-missing', change: (receipt, ext) => { delete ext.dataset } },
  { name: 'dataset without a fixture digest', gate: 'G16', rule: 'dataset', code: 'dataset-missing', change: (receipt, ext) => { delete ext.dataset.fixtureDigest } },
]

test('receipt negatives per gate: each is rejected for exactly its reason, and never as gate closed', () => {
  for (const item of NEGATIVES) {
    const receipt = withExt(fixture(item.gate), item.change)
    const result = validateAcceptanceReceipt(receipt, { gate: item.gate })
    assert.deepEqual({ schemaValid: result.schemaValid, valid: result.valid, gateClosed: result.gateClosed, codes: [...new Set(result.missing.map((entry) => entry.code))] }, { schemaValid: true, valid: false, gateClosed: false, codes: [item.code] }, item.name)
    for (const entry of result.missing) assert.match(entry.pointer, /^\//, item.name)
  }
  // Procedure variants are accepted; a bare name of another procedure is not.
  assert.equal(validateAcceptanceReceipt(withExt(fixture('G13'), (receipt) => { receipt.procedureId = 'AP-02:run-3' }), { gate: 'G13' }).valid, true)
  // The extension is a closed shape.
  const extra = validateAcceptanceReceipt(withExt(fixture('G07'), (receipt, ext) => { ext.screenshots = 4 }), { gate: 'G07' })
  assert.deepEqual(extra.missing.map((entry) => entry.code), ['extension-key-unknown'])
  const none = validateAcceptanceReceipt(withExt(fixture('G07'), (receipt) => { delete receipt.ext }), { gate: 'G07' })
  assert.ok(none.missing.some((entry) => entry.code === 'extension-missing') && none.missing.some((entry) => entry.code === 'host-identity-missing') && none.missing.some((entry) => entry.code === 'acceptance-missing'))
  assert.equal(none.schemaValid, true, 'schema-valid and still not a receipt of this gate')
})

test('a schema-invalid receipt, an unowned gate and a non-object are refused before any rule runs', () => {
  const broken = fixture('G07')
  delete broken.environment
  const result = validateAcceptanceReceipt(broken, { gate: 'G07' })
  assert.deepEqual({ schemaValid: result.schemaValid, valid: result.valid, gateClosed: result.gateClosed, outcome: result.outcome }, { schemaValid: false, valid: false, gateClosed: false, outcome: null })
  assert.ok(result.missing.some((entry) => entry.code === 'schema-violation'))
  const g02 = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/acceptance-receipt/valid/node-gate.v1.json'))
  assert.deepEqual(validateObsidianContract('acceptance-receipt', g02), [])
  assert.deepEqual(validateAcceptanceReceipt(g02).missing.map((entry) => entry.code), ['gate-not-owned'])
  assert.deepEqual(validateAcceptanceReceipt(g02, { gate: 'G07' }).missing.map((entry) => entry.code), ['gate-mismatch'].concat(validateAcceptanceReceipt(g02, { gate: 'G07' }).missing.map((entry) => entry.code).slice(1)))
  assert.equal(validateAcceptanceReceipt(g02, { gate: 'G07' }).valid, false)
  for (const value of [null, 'receipt', 42, []]) assert.equal(validateAcceptanceReceipt(value, { gate: 'G07' }).valid, false)
  assert.equal(validateAcceptanceReceipt(null).missing[0].code, 'gate-not-owned')
})

test('a failed or blocked receipt is a valid receipt of its outcome; validity is not a pass', () => {
  for (const outcome of ['failed', 'blocked']) {
    const result = validateAcceptanceReceipt(withExt(fixture('G13'), (receipt) => { receipt.outcome = outcome }), { gate: 'G13' })
    assert.deepEqual({ valid: result.valid, outcome: result.outcome, gateClosed: result.gateClosed }, { valid: true, outcome, gateClosed: false })
  }
})

test('mutation control: a validator that ignores a required field accepts the receipt that lacks it', () => {
  for (const rule of Object.keys(RECEIPT_RULES)) {
    const blind = createReceiptValidatorForOracleTests({ [rule]: () => [] })
    const sensitive = NEGATIVES.filter((item) => item.rule === rule)
    assert.ok(sensitive.length > 0, `a negative case exercises ${rule}`)
    for (const item of sensitive) {
      const receipt = withExt(fixture(item.gate), item.change)
      assert.equal(validateAcceptanceReceipt(receipt, { gate: item.gate }).valid, false, `${item.name}: the real validator rejects`)
      assert.equal(blind(receipt, { gate: item.gate }).valid, true, `${item.name}: a validator blind to ${rule} accepts`)
      assert.equal(blind(receipt, { gate: item.gate }).gateClosed, false, 'and even that closes nothing')
    }
  }
})

// ---------------------------------------------------------------------------
// 7. Through the command: the contribution registered on AOP-1's operations
// ---------------------------------------------------------------------------

const EXT = OBSIDIAN_EXT_KEY
const note = ({ id, title, body }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`
const FILES = {
  'harbor/notes/quay.md': note({ id: 'harbor:quay', title: 'Quay ledger', body: 'Boats moor at dawn. See the [beacon](beacon.md).' }),
  'harbor/notes/beacon.md': note({ id: 'harbor:beacon', title: 'Beacon "north" side', body: 'The beacon blinks twice.' }),
  'orchard/rows/apple.md': note({ id: 'orchard:apple', title: 'Apple rows', body: 'Rows run east to west.' }),
}
const REPOSITORIES = ['harbor', 'orchard']
const SCOPES = [
  { scopeId: 'view-all', mode: 'full', selector: { all: true } },
  { scopeId: 'view-harbor', mode: 'scoped', selector: { repo: 'harbor' } },
  { scopeId: 'view-beacon', mode: 'focus', selector: { ids: ['harbor:quay', 'harbor:beacon'] } },
  { scopeId: 'view-nobody', mode: 'scoped', selector: { ids: ['harbor:nobody'] } },
  { scopeId: 'view-focus-nobody', mode: 'focus', selector: { ids: ['harbor:nobody'] } },
]
const UNREACHABLE = new Proxy({}, { get: (_target, name) => { throw new Error(`the seam ${String(name)} was reached`) } })
const UNREACHABLE_SEAMS = { appProbe: UNREACHABLE, launcher: UNREACHABLE, service: { entryPath: path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs') } }

function makeWorld(t) {
  const dir = tempDir(t, 'command')
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  for (const [relative, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  for (const name of REPOSITORIES) fs.mkdirSync(path.join(projectDir, name, '.git'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  writeJson(configPath, {
    schema: 'mnstry.atelier-project-config@v1', name: 'selection-fixture', roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: REPOSITORIES.map((name) => ({ name, path: name, readBoundary: 'team' })),
    ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: SCOPES, defaultScopeId: 'view-all' } },
  })
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(REPOSITORIES.map((name) => [name, { readBoundary: 'team' }])) })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  const project = loadProject()
  const pointer = ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
  const workspaceRoot = workspaceStateRoot(dataRoot, pointer.workspaceId)
  const workspace = { workspaceRoot, workspaceId: pointer.workspaceId }
  const repositoryRoots = protectedRoots(project)
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...defaultMachineSettings({ workspaceId: pointer.workspaceId, updatedAt: NOW }), audienceAllow: ['team'] } })
  const clock = () => new Date(NOW)
  return {
    dir, projectDir, dataRoot, configPath, workspace: { ...workspace, workspaceRoot: fs.realpathSync(workspaceRoot) }, repositoryRoots, clock,
    async run(argv) {
      const out = []
      const err = []
      const exit = await runObsidianCommandForOracleTests({
        argv: [...argv, '--json', `--project=${configPath}`, `--data-root=${dataRoot}`], seams: UNREACHABLE_SEAMS, env, cwd: projectDir, clock, contributions: [createSelectionContribution()], probeTimeoutMs: 500,
        stdout: (text) => out.push(text), stderr: (text) => err.push(text),
      }, {})
      const stdout = out.join('\n')
      return { exit, stdout, stderr: err.join('\n'), json: JSON.parse(stdout) }
    },
  }
}

test('selection through the command: resolve, persist, show and list bind the declared views to the canonical graph', async (t) => {
  const world = makeWorld(t)
  const status = await world.run(['status'])
  assert.equal(status.exit, EXIT.ok)
  assert.deepEqual(status.json.operations, [
    { name: 'apply-policy', summary: status.json.operations[0].summary }, { name: 'conflicts', summary: status.json.operations[1].summary }, { name: 'selection', summary: status.json.operations[2].summary },
  ])
  const full = await world.run(['selection', 'resolve', 'view-all'])
  assert.equal(full.exit, EXIT.ok, full.stdout)
  assert.deepEqual({ schema: full.json.schema, operation: full.json.operation, scopeId: full.json.scopeId, persisted: full.json.persisted }, { schema: COMMAND_SCHEMA, operation: 'selection', scopeId: 'view-all', persisted: false })
  assert.deepEqual(full.json.selection.nodes, ['harbor:beacon', 'harbor:quay', 'orchard:apple'])
  assert.deepEqual(full.json.selection.scope, { schema: 'atelier-obsidian-scope/v1', scopeId: 'view-all', mode: 'full', selector: { all: true } })
  assert.equal(full.json.selection.edges.length, 1, 'the derived link from the quay to the beacon')
  const harbor = await world.run(['selection', 'resolve', 'view-harbor'])
  assert.deepEqual({ nodes: harbor.json.selection.nodes, outside: harbor.json.selection.outsideSelectionEdges }, { nodes: ['harbor:beacon', 'harbor:quay'], outside: [] })

  const focus = await world.run(['selection', 'persist', 'view-beacon'])
  assert.equal(focus.exit, EXIT.ok, focus.stdout)
  assert.deepEqual({ persisted: focus.json.persisted, changed: focus.json.changed, file: focus.json.file }, { persisted: true, changed: true, file: 'state/selection/view-beacon.json' })
  const beaconPath = focus.json.selection.notePaths['harbor:beacon']
  assert.match(beaconPath, /^notes\/Beacon north side--[0-9a-f]{12}\.md$/, 'the readable title drops the quote characters the filesystem rules remove')
  assert.equal(focus.json.selection.focus.query, `path:"${beaconPath}" OR path:"${focus.json.selection.notePaths['harbor:quay']}"`)
  assert.deepEqual(focus.json.selection.vaultNodes, ['harbor:beacon', 'harbor:quay', 'orchard:apple'], 'a focus keeps the full vault')
  const shown = await world.run(['selection', 'show', 'view-beacon'])
  assert.deepEqual({ exit: shown.exit, persisted: shown.json.persisted, query: shown.json.selection.focus.query, mode: shown.json.selection.mode }, { exit: EXIT.ok, persisted: true, query: focus.json.selection.focus.query, mode: 'focus' })
  assert.deepEqual(readSelectionState({ ...world.workspace, scopeId: 'view-beacon' }), shown.json.selection)
  const unchanged = await world.run(['selection', 'persist', 'view-beacon'])
  assert.equal(unchanged.json.changed, false)
  const listed = await world.run(['selection', 'list'])
  assert.deepEqual(listed.json.selections.map((item) => [item.scopeId, item.mode]), [['view-beacon', 'focus']])
  const missing = await world.run(['selection', 'show', 'view-harbor'])
  assert.deepEqual({ exit: missing.exit, persisted: missing.json.persisted, selection: missing.json.selection }, { exit: EXIT.notSuccess, persisted: false, selection: null })
  // Nothing was written to any vault and no .obsidian/ file exists anywhere under the workspace.
  const found = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else found.push(path.relative(world.workspace.workspaceRoot, full).split(path.sep).join('/')) } }
  walk(world.workspace.workspaceRoot)
  assert.deepEqual(found.sort(), ['state/selection/view-beacon.json', 'state/settings/machine.json'])
})

test('selection refusals through the command are typed: unknown view, withheld members, empty focus, usage', async (t) => {
  const world = makeWorld(t)
  const unknown = await world.run(['selection', 'resolve', 'view-elsewhere'])
  assert.deepEqual({ exit: unknown.exit, code: unknown.json.error.code }, { exit: EXIT.refused, code: 'unknown-scope' })
  // An unresolved identity is reported without saying whether it is withheld or absent.
  const nobody = await world.run(['selection', 'resolve', 'view-nobody'])
  assert.deepEqual({ exit: nobody.exit, nodes: nobody.json.selection.nodes, empty: nobody.json.selection.empty, reason: nobody.json.selection.emptyReason, unresolved: nobody.json.selection.unresolvedIds }, { exit: EXIT.ok, nodes: [], empty: true, reason: 'no-visible-members', unresolved: ['harbor:nobody'] })
  const persistEmpty = await world.run(['selection', 'persist', 'view-nobody'])
  assert.deepEqual({ exit: persistEmpty.exit, code: persistEmpty.json.error.code }, { exit: EXIT.refused, code: 'selection-empty' })
  const persistNamed = await world.run(['selection', 'persist', 'view-nobody', 'allow-empty'])
  assert.deepEqual({ exit: persistNamed.exit, nodes: persistNamed.json.selection.nodes }, { exit: EXIT.ok, nodes: [] })
  const focusEmpty = await world.run(['selection', 'resolve', 'view-focus-nobody'])
  assert.deepEqual({ exit: focusEmpty.exit, code: focusEmpty.json.error.code }, { exit: EXIT.refused, code: 'focus-selection-empty' })
  const usage = await world.run(['selection', 'forget', 'view-all'])
  assert.deepEqual({ exit: usage.exit, code: usage.json.error.code }, { exit: EXIT.refused, code: 'usage' })
  assert.deepEqual((await world.run(['selection', 'resolve', 'view-all', 'allow-empty'])).json.error.code, 'usage')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('apply-policy and conflicts through the command: create, show, revoke and the empty conflict view', async (t) => {
  const world = makeWorld(t)
  const request = path.join(world.dir, 'policy-request.json')
  fs.writeFileSync(request, JSON.stringify({ policyId: 'policy-harbor', mode: 'automatic', actor: { kind: 'agent', id: 'agent-synthetic' }, selector: { repo: 'harbor' }, maxBatchSize: 2, retryBudget: 1 }))
  const created = await world.run(['apply-policy', 'create', request])
  assert.equal(created.exit, EXIT.ok, created.stdout)
  assert.deepEqual({ ok: created.json.ok, action: created.json.action, installed: created.json.installed, version: created.json.policy.version, mode: created.json.maintenanceMode, automatic: created.json.automaticApply }, { ok: true, action: 'create', installed: true, version: 1, mode: 'manual', automatic: { authorized: false, reason: 'maintenance-mode-manual' } })
  assert.deepEqual(readInstalledApplyPolicy(world.workspace), created.json.policy)
  // The built-in policy operation sees the same installed policy; the built-in mode switch can now go automatic.
  const builtIn = await world.run(['policy', 'show'])
  assert.deepEqual(builtIn.json.policy, created.json.policy)
  const mode = await world.run(['mode', 'set', 'automatic'])
  assert.equal(mode.exit, EXIT.ok, mode.stdout)
  const shown = await world.run(['apply-policy', 'show'])
  assert.deepEqual(shown.json.automaticApply, { authorized: true, reason: 'apply-policy-active' })
  const bad = path.join(world.dir, 'bad-request.json')
  fs.writeFileSync(bad, JSON.stringify({ policyId: 'policy-harbor', mode: 'automatic', actor: { kind: 'agent', id: 'agent-synthetic' }, selector: { repo: 'harbor' }, allowedEditClasses: ['rename'] }))
  const refused = await world.run(['apply-policy', 'create', bad])
  assert.deepEqual({ exit: refused.exit, ok: refused.json.ok, code: refused.json.refusal.code }, { exit: EXIT.notSuccess, ok: false, code: 'unimplemented-edit-class' })
  assert.equal(readInstalledApplyPolicy(world.workspace).version, 1)
  const revoked = await world.run(['apply-policy', 'revoke'])
  assert.deepEqual({ exit: revoked.exit, revoked: revoked.json.revoked, status: revoked.json.policy.status, mode: revoked.json.maintenanceMode, automatic: revoked.json.automaticApply }, { exit: EXIT.ok, revoked: true, status: 'revoked', mode: 'manual', automatic: { authorized: false, reason: 'maintenance-mode-manual' } })
  assert.equal(readMachineSettings(world.workspace).maintenanceMode, 'manual')
  assert.deepEqual((await world.run(['apply-policy', 'create'])).json.error.code, 'usage')
  assert.deepEqual((await world.run(['apply-policy', 'create', path.join(world.dir, 'absent.json')])).json.error.code, 'invalid-apply-policy')
  const conflicts = await world.run(['conflicts'])
  assert.deepEqual({ exit: conflicts.exit, schema: conflicts.json.schema, objects: conflicts.json.objects, needsPerson: conflicts.json.needsPerson }, { exit: EXIT.ok, schema: CONFLICT_VIEW_SCHEMA, objects: [], needsPerson: false })
  const narrowed = await world.run(['conflicts', 'view-harbor'])
  assert.deepEqual({ scopeId: narrowed.json.scopeId, objects: narrowed.json.objects }, { scopeId: 'view-harbor', objects: [] })
  assert.equal((await world.run(['conflicts', 'view-elsewhere'])).json.error.code, 'unknown-scope')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})
