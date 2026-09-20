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
// AOP-4 phase 2 proof tooling (scripts/obsidian, unshipped). Imported after
// the guard: none of it may start the app, and its drivers never run on import.
const { OutputRefusal, assertExternalOutput, repositoryContaining } = await import('../scripts/obsidian/lib/common.mjs')
const { PROPOSED_TARGETS, createResourceSampler, createWarmChangeSummaryForOracleTests, percentile, waitUntil, warmChangeSummary } = await import('../scripts/obsidian/lib/measure.mjs')
const { absentAdapter, deriveWorkspace, materializeFixtureWorkspace } = await import('../scripts/obsidian/lib/derive.mjs')
const { bindLayoutToVault, createCommandRunner, createServiceRuntime, fileDigest, initialiseRepositories, noteFile, prepareWorkspace, stripProjectEnv } = await import('../scripts/obsidian/lib/service-world.mjs')
const { runAp03 } = await import('../scripts/obsidian/lib/ap03.mjs')
const { AP05_EDITS, AP05_SCOPES, createAp05RunnerForOracleTests, prepareAp05Workspace, runAp05 } = await import('../scripts/obsidian/lib/ap05.mjs')
const { createMaintenanceEngine } = await import('../src/runtime/obsidian/engine.mjs')
const { createObsidianRegistry } = await import('../src/runtime/obsidian/extension-points.mjs')
const { createNullWatcherFactory } = await import('../src/runtime/obsidian/watchers.mjs')
const { createSourceApplyContribution } = await import('../src/projection/obsidian/edits/contribution.mjs')
const { createProposalAdapterContribution } = await import('../src/projection/obsidian/proposals/contribution.mjs')
const { DESKTOP_EXT_KEY, ReceiptRefusal, buildReceipt, evidenceFileName, writeGateReceipt } = await import('../scripts/obsidian/lib/receipts.mjs')
const { DEFAULT_SEED, PROFILES, generateScaleDataset, planDataset } = await import('../scripts/obsidian/generate-scale.mjs')
const {
  DESKTOP_PROCEDURES, IsolationRefusal, PROCEDURE_IDS, assertIsolatedInstance, compareMembership, compareResolvedLinks, discoverCapabilities, expectedLinkPairs, parseHelpOutput, parseVersionOutput,
  planProcedure, recordProcedureReceipts, runAp01, runAp02Membership, runAp04App,
} = await import('../scripts/obsidian/desktop-receipts.mjs')
const { SIGNED_NOTE, UNSIGNED_NOTE, createReceiptVerifierForOracleTests, formatTable, verifyReceiptSet } = await import('../scripts/obsidian/verify-receipts.mjs')
const { signReceipt } = await import('../scripts/obsidian/sign-receipt.mjs')

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

// ---------------------------------------------------------------------------
// 7. AOP-4 phase 2 proof tooling: scale generator, measurement helpers,
// desktop planner and runners against a fake instance, receipt writer,
// signer and verifier. Nothing here starts the app; the fake instance answers
// scripted text and the spawn guard stays silent.
// ---------------------------------------------------------------------------

const TINY_FIXTURE_DIGEST = 'sha256:f29cd4f5f97f7e01958125af2d94fc75775b8d4880b94c91b2614abf60a804a3'
const CANDIDATE = { commit: '1'.repeat(40), treeDigest: `sha256:${'2'.repeat(64)}`, ext: { dirty: false } }
const CAPABILITIES = { discoveredAt: NOW, qualified: true, app: { name: 'Obsidian', version: '1.13.7', installerVersion: '1.12.7', raw: 'Obsidian 1.13.7 (installer 1.12.7)' }, cli: { version: 'Obsidian 1.13.7 (installer 1.12.7)', commands: { vaults: true, eval: true, links: true, backlinks: true, unresolved: true } }, lastSavedData: { present: true }, errors: [] }
const WALL = { startedAt: '2026-01-05T10:00:00.000Z', endedAt: '2026-01-05T10:20:00.000Z' }
const HOST = { id: 'host-synthetic-desk-02' }

// A scripted instance: `answers` maps a substring of the CLI arguments to the
// text the CLI would print. `eval` scripts are matched by their probe text.
function fakeInstance(t, { vaults, home, answers = {} } = {}) {
  const root = tempDir(t, 'instance')
  const layout = { root, home: home ?? path.join(root, 'home'), profile: path.join(root, 'profile'), vault: path.join(root, 'vault') }
  fs.mkdirSync(layout.vault, { recursive: true })
  const calls = []
  return {
    layout,
    env: { HOME: layout.home },
    calls,
    async cli(...args) {
      calls.push(args)
      const joined = args.join(' ')
      if (args[0] === 'vaults') return (vaults ?? [`atelierg00synthetic\t${layout.vault}`]).join('\n')
      for (const [needle, answer] of Object.entries(answers)) if (joined.includes(needle)) return typeof answer === 'function' ? answer(args) : answer
      throw new Error(`fake instance has no answer for ${joined.slice(0, 80)}`)
    },
  }
}

test('scale generator: same seed, same fixture digest; another seed differs; writes only outside repositories and fixtures', (t) => {
  const dir = tempDir(t, 'scale')
  const first = generateScaleDataset({ outDir: path.join(dir, 'a'), profile: 'tiny' })
  const second = generateScaleDataset({ outDir: path.join(dir, 'b'), profile: 'tiny', seed: DEFAULT_SEED })
  assert.equal(first.manifest.fixtureDigest, TINY_FIXTURE_DIGEST, 'the tiny profile digest is pinned')
  assert.equal(second.manifest.fixtureDigest, first.manifest.fixtureDigest)
  assert.deepEqual(first.manifest.counts, { nodes: 50, edges: 100, repositories: 2, files: 50, bytes: first.manifest.counts.bytes })
  assert.deepEqual({ schema: first.manifest.schema, generatorVersion: first.manifest.generatorVersion, seed: first.manifest.seed, profile: first.manifest.profile, derivation: first.manifest.derivation }, { schema: 'atelier-obsidian-scale-dataset/v1', generatorVersion: '1.0.0', seed: DEFAULT_SEED, profile: 'tiny', derivation: null })
  assert.notEqual(generateScaleDataset({ outDir: path.join(dir, 'c'), profile: 'tiny', seed: 7 }).manifest.fixtureDigest, TINY_FIXTURE_DIGEST)
  // Edge planning is exact: 100 declared relations over 50 nodes, none to self, none repeated.
  const plan = planDataset({ nodes: 50, edges: 100, repositories: 2 })
  const declared = plan.records.flatMap((record) => Object.values(record.relations).flat())
  assert.equal(declared.length, 100)
  assert.ok(plan.records.every((record) => new Set(Object.values(record.relations).flat()).size === Object.values(record.relations).flat().length && !Object.values(record.relations).flat().includes(record.nodeId)))
  assert.deepEqual(PROFILES.standard, { nodes: 10000, edges: 50000, repositories: 4 })
  assert.deepEqual(PROFILES.stress, { nodes: 100000, edges: 500000, repositories: 8 })
  // Refusals: inside this repository, under any fixtures path, inside another repository, a relative path, a non-empty target.
  const refusal = (options, code) => { try { generateScaleDataset(options) } catch (error) { assert.ok(error instanceof OutputRefusal, error.stack); return error.code } return null }
  assert.equal(refusal({ outDir: path.join(REPOSITORY_ROOT, '.artifacts', 'scale'), profile: 'tiny' }, 'output-inside-repository'), 'output-inside-repository')
  assert.equal(refusal({ outDir: path.join(dir, 'fixtures', 'scale'), profile: 'tiny' }, 'output-inside-fixtures'), 'output-inside-fixtures')
  fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true })
  assert.equal(repositoryContaining(path.join(dir, 'repo', 'deep', 'er')), path.join(dir, 'repo'))
  assert.equal(refusal({ outDir: path.join(dir, 'repo', 'deep'), profile: 'tiny' }, 'output-inside-repository'), 'output-inside-repository')
  assert.equal(refusal({ outDir: 'relative/scale', profile: 'tiny' }, 'output-not-absolute'), 'output-not-absolute')
  assert.equal(refusal({ outDir: path.join(dir, 'a'), profile: 'tiny' }, 'output-not-empty'), 'output-not-empty')
  assert.equal(refusal({ outDir: path.join(dir, 'd'), profile: 'huge' }, 'unknown-profile'), 'unknown-profile')
  assert.ok(!fs.existsSync(path.join(REPOSITORY_ROOT, '.artifacts', 'scale')), 'nothing was written inside the repository')
  assert.equal(assertExternalOutput(path.join(dir, 'ok')), path.join(dir, 'ok'))
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('cold derivation of the tiny dataset: the real pipeline publishes every note into a temporary vault with no app', async (t) => {
  const dir = tempDir(t, 'derive')
  const { manifest } = generateScaleDataset({ outDir: path.join(dir, 'data'), profile: 'tiny' })
  const vaultRoot = path.join(dir, 'vault')
  const result = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot: path.join(dir, 'state'), vaultRoot })
  assert.deepEqual({ state: result.state, mode: result.mode, graph: result.graph, notes: result.manifest.notes.length }, { state: 'committed', mode: 'direct', graph: { nodes: 50, edges: 100 }, notes: 50 })
  assert.equal(result.manifest.links.length, 100, 'every declared relation is a manifest link')
  for (const key of ['loadProjectMs', 'buildGraphMs', 'captureSnapshotMs', 'prepareViewMs', 'publishViewMs', 'totalMs']) assert.ok(typeof result.timings[key] === 'number' && result.timings[key] >= 0, key)
  assert.ok(result.written.files >= 50 && result.written.bytes > 0)
  // Warm path: one source change, the same store, a replace of exactly that note.
  const source = fs.readdirSync(path.join(manifest.workspaceDir, 'scale-1', 'notes', '000')).sort()[0]
  fs.appendFileSync(path.join(manifest.workspaceDir, 'scale-1', 'notes', '000', source), '\nWarm change 1.\n')
  const warm = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot: path.join(dir, 'state'), vaultRoot })
  assert.deepEqual({ state: warm.state, expected: warm.expectedGeneration }, { state: 'committed', expected: result.generationId })
  const changed = warm.files.filter((file) => file.kind === 'note' && fs.readFileSync(path.join(vaultRoot, file.path), 'utf8').includes('Warm change 1.'))
  assert.equal(changed.length, 1)
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-04 measurement helpers: p95 pinned on a literal sample, file and app series independent, no app target substituted', () => {
  const sample = [120, 340, 90, 5000, 410, 260, 275, 310, 4900, 150]
  assert.equal(percentile(sample, 95), 5000, 'nearest rank: ceil(0.95 * 10) = 10th value')
  assert.equal(percentile(sample, 50), 275)
  assert.equal(percentile(sample, 0), 90)
  assert.equal(percentile([], 95), null)
  assert.equal(percentile(Array.from({ length: 30 }, (_, index) => index + 1), 95), 29, 'ceil(0.95 * 30) = 29th value')
  const changes = Array.from({ length: 30 }, (_, index) => ({ change: index + 1, sourceToFileMs: 100 + index * 10, sourceToAppMs: null }))
  const summary = warmChangeSummary(changes)
  assert.deepEqual({ count: summary.count, complete: summary.complete, file: summary.sourceToFile, app: summary.sourceToApp }, {
    count: 30, complete: true,
    file: { samples: 30, p50Ms: 240, p95Ms: 380, maxMs: 390, targetP95Ms: 5000, withinTarget: true, status: 'measured' },
    app: { samples: 0, p50Ms: null, p95Ms: null, maxMs: null, targetP95Ms: null, withinTarget: null, status: 'not-measured' },
  })
  const withApp = warmChangeSummary(changes.map((change) => ({ ...change, sourceToAppMs: 9000 })))
  assert.deepEqual({ fileP95: withApp.sourceToFile.p95Ms, appP95: withApp.sourceToApp.p95Ms, appWithin: withApp.sourceToApp.withinTarget }, { fileP95: 380, appP95: 9000, appWithin: null }, 'a slow app never fails the file target and has no substituted target')
  assert.deepEqual({ file: PROPOSED_TARGETS.fileUpdate.p95Ms, recovery: PROPOSED_TARGETS.droppedEventRecovery.maxMs, app: PROPOSED_TARGETS.appUsableOpen.budgetMs }, { file: 5000, recovery: 60000, app: null })
  assert.equal(warmChangeSummary(changes.slice(0, 12)).complete, false)
  // Resource sampler with an injected reader and clock.
  let tick = 0
  const timers = []
  const sampler = createResourceSampler({ intervalMs: 100, now: () => tick, read: () => ({ rssBytes: 1000 + tick, heapUsedBytes: 1, cpuUserMicros: tick * 2, cpuSystemMicros: tick }), setInterval: (callback) => { timers.push(callback); return 1 }, clearInterval: () => {} }).start()
  tick = 100; timers[0]()
  tick = 250; sampler.sample('phase')
  tick = 400
  const samples = sampler.stop()
  assert.deepEqual(samples.map(({ atMs, label, rssBytes }) => [atMs, label, rssBytes]), [[0, 'start', 1000], [100, null, 1100], [250, 'phase', 1250], [400, 'stop', 1400]])
  assert.deepEqual(sampler.summary(), { samples: 4, intervalMs: 100, rssPeakBytes: 1400, rssEndBytes: 1400, cpuUserMicros: 800, cpuSystemMicros: 400, wallMs: 400 })
})

test('waitUntil records a met condition and a timeout without throwing', async () => {
  let clock = 0
  let answers = 0
  const met = await waitUntil(async () => { answers += 1; return answers === 3 }, { timeoutMs: 1000, intervalMs: 10, now: () => clock, sleep: async () => { clock += 10 } })
  assert.deepEqual(met, { met: true, elapsedMs: 20, attempts: 3, error: null })
  const late = await waitUntil(async () => { throw new Error('not yet') }, { timeoutMs: 30, intervalMs: 10, now: () => clock, sleep: async () => { clock += 10 } })
  assert.deepEqual(late, { met: false, elapsedMs: 30, attempts: 4, error: 'not yet' })
})

test('desktop planner: every gate role is automated or an exact manual step; the plan closes nothing', () => {
  assert.deepEqual(PROCEDURE_IDS, ['AP-01', 'AP-02', 'AP-03', 'AP-04', 'AP-05'])
  const manual = {}
  for (const id of PROCEDURE_IDS) {
    const plan = planProcedure(id, { receiptDir: '/tmp/receipts', operator: 'op-synthetic', isolatedHome: '/tmp/iso/home', workspaceDir: '/tmp/ws' })
    assert.deepEqual({ gates: plan.gates, closes: plan.closes }, { gates: [...DESKTOP_PROCEDURES[id].gates], closes: false })
    manual[id] = plan.manualStepsRequired.map((step) => `${step.gate}:${step.role}`)
    for (const step of plan.manualStepsRequired) assert.ok(step.instructions.length > 0 && step.instructions.every((line) => !line.includes('<ISOLATED_HOME>') && !line.includes('<SYNTHETIC_WORKSPACE>') && !line.includes('<OPERATOR>')), 'placeholders are filled')
  }
  assert.deepEqual(manual, {
    'AP-01': ['G07:app-observation'],
    'AP-02': ['G13:graph-filter-observation'],
    'AP-03': ['G14:sleep-wake-clock'],
    'AP-04': [],
    'AP-05': [],
  })
  assert.deepEqual({ ap03: planProcedure('AP-03', {}).automatedRoles, ap05: planProcedure('AP-05', {}).automatedRoles }, {
    ap03: { G14: ['source-refresh-trace', 'dropped-event-recovery'], G15: ['ownership-health', 'terminal-closure'] },
    ap05: { G17: ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention'] },
  })
  assert.deepEqual(planProcedure('AP-04', {}).receipts.map((item) => [item.gate, item.status]), [['G16', 'complete']])
  assert.deepEqual(planProcedure('AP-03', {}).receipts.map((item) => [item.gate, item.status]), [['G14', 'incomplete'], ['G15', 'complete']])
  assert.deepEqual(planProcedure('AP-05', {}).receipts.map((item) => [item.gate, item.status]), [['G17', 'complete']])
  const sleep = planProcedure('AP-03', { isolatedHome: '/tmp/iso/home', isolatedProfile: '/tmp/iso/profile', workspaceDir: '/tmp/ws', dataRoot: '/tmp/data', operator: 'op-x' }).manualStepsRequired.find((step) => step.role === 'sleep-wake-clock')
  assert.ok(sleep.instructions[0].includes('HOME=/tmp/iso/home /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=/tmp/iso/profile'), sleep.instructions[0])
  assert.ok(sleep.instructions[2].includes('HOME=/tmp/iso/home node bin/atelier.mjs obsidian service status --project /tmp/ws/atelier.project.json --data-root /tmp/data --json'), sleep.instructions[2])
  assert.ok(sleep.instructions.every((line) => !line.includes('<DATA_ROOT>') && !line.includes('<ISOLATED_PROFILE>')))
  assert.throws(() => planProcedure('AP-09'), (error) => error instanceof OutputRefusal && error.code === 'unknown-procedure')
})

test('desktop runner refuses anything but the isolated instance: two vaults, a foreign vault, a shared HOME', async (t) => {
  const refusal = async (instance, options) => { try { await assertIsolatedInstance(instance, options) } catch (error) { assert.ok(error instanceof IsolationRefusal, error.stack); return error.code } return null }
  const two = fakeInstance(t)
  two.cli = async () => `atelierg00synthetic\t${two.layout.vault}\nreal-vault\t${path.join(os.homedir(), 'Documents', 'Notes')}`
  assert.equal(await refusal(two), 'unexpected-vaults-visible')
  const foreign = fakeInstance(t, { vaults: ['other\t/somewhere/else/vault'] })
  assert.equal(await refusal(foreign), 'unexpected-vaults-visible')
  const shared = fakeInstance(t, { home: os.homedir() })
  assert.equal(await refusal(shared), 'instance-home-not-private')
  const elsewhere = fakeInstance(t)
  elsewhere.env = { HOME: elsewhere.layout.home }
  elsewhere.layout = { ...elsewhere.layout, home: path.join(tempDir(t, 'other'), 'home') }
  assert.equal(await refusal(elsewhere), 'instance-home-not-private')
  assert.equal(await refusal({}), 'instance-not-isolated')
  const good = fakeInstance(t)
  assert.deepEqual(await assertIsolatedInstance(good), { vaultRoot: good.layout.vault, vaultsOutput: `atelierg00synthetic\t${good.layout.vault}` })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('capability discovery records versions, CLI commands and lastSavedData from raw output; an unsupported CLI fails qualification', async (t) => {
  assert.deepEqual(parseVersionOutput('Obsidian 1.13.7 (installer 1.12.7)'), { appVersion: '1.13.7', installerVersion: '1.12.7' })
  assert.deepEqual(parseVersionOutput('garbage'), { appVersion: null, installerVersion: null })
  const help = 'Commands:\n  vaults [verbose]\n  eval code=...\n  links file=...\n  backlinks file=...\n  unresolved\n  dev:cdp method=...\n  version\n  help\n'
  assert.deepEqual(parseHelpOutput(help), { version: true, help: true, vaults: true, eval: true, links: true, backlinks: true, unresolved: true, file: true, 'dev:cdp': true })
  const qualified = fakeInstance(t, { answers: { version: 'Obsidian 1.13.7 (installer 1.12.7)', help, 'openFile': '=> ok', 'lastSavedData': '=> {"views":[{"path":"notes/a.md","hasLastSavedData":true}]}', 'detach': '=> ok' } })
  const record = await discoverCapabilities(qualified, { now: () => NOW })
  assert.deepEqual({ qualified: record.qualified, app: record.app.version, installer: record.app.installerVersion, cli: record.cli.version, last: record.lastSavedData.present, errors: record.errors }, { qualified: true, app: '1.13.7', installer: '1.12.7', cli: 'Obsidian 1.13.7 (installer 1.12.7)', last: true, errors: [] })
  const unsupported = fakeInstance(t, { answers: { version: 'Obsidian 1.13.7 (installer 1.12.7)', help: 'Commands:\n  vaults\n  eval\n', 'openFile': '=> ok', 'lastSavedData': '=> {"views":[{"path":"notes/a.md","hasLastSavedData":false}]}', 'detach': '=> ok' } })
  const failed = await discoverCapabilities(unsupported, { now: () => NOW })
  assert.deepEqual({ qualified: failed.qualified, links: failed.cli.commands.links, last: failed.lastSavedData.present }, { qualified: false, links: false, last: false })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-01 and AP-02 runners record raw app output and compare it with the generation manifest through a fake instance', async (t) => {
  const dir = tempDir(t, 'ap01')
  const { materializeFixtureWorkspace } = await import('../scripts/obsidian/lib/derive.mjs')
  const fixture = materializeFixtureWorkspace(path.join(dir, 'workspace'))
  const vaultRoot = path.join(dir, 'vault')
  const derived = await deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(dir, 'state'), vaultRoot })
  assert.equal(derived.state, 'committed')
  const expected = expectedLinkPairs(derived.manifest)
  assert.ok(expected.length > 0)
  const resolved = {}
  for (const pair of expected) { const [source, target] = pair.split(' -> '); (resolved[source] ??= {})[target] = 1 }
  const instance = fakeInstance(t, { answers: {
    'metadataCache.initialized': '=> true',
    'resolvedLinks': `=> ${JSON.stringify({ resolved, unresolved: {} })}`,
    'getMarkdownFiles().map': `=> ${JSON.stringify(derived.manifest.notes.map((note) => note.path).sort())}`,
    unresolved: 'no unresolved links',
    links: (args) => `links of ${args[1]}`,
    backlinks: (args) => `backlinks of ${args[1]}`,
  } })
  const run = await runAp01({ instance, manifest: derived.manifest })
  assert.deepEqual({ passed: run.passed, roles: run.evidence.map((item) => item.role), matches: run.comparison.matches, missing: run.comparison.missing, unexpected: run.comparison.unexpected }, { passed: true, roles: ['cli-link-inspection'], matches: true, missing: [], unexpected: [] })
  const raw = run.evidence[0].bytes.toString('utf8')
  assert.ok(raw.includes('indexReady: true') && raw.includes('## obsidian-cli unresolved\nno unresolved links') && raw.includes('## obsidian-cli backlinks file=') && raw.includes('links of file='))
  // A destination the app did not resolve is a recorded mismatch, never averaged away.
  const short = compareResolvedLinks({ resolved: {}, expected })
  assert.deepEqual({ matches: short.matches, missing: short.missing.length, resolved: short.resolved }, { matches: false, missing: expected.length, resolved: 0 })
  const membership = await runAp02Membership({ instance, label: 'full', vaultRoot, manifest: derived.manifest })
  assert.deepEqual({ passed: membership.passed, disk: membership.disk.matches, app: membership.app.matches, expected: membership.expected.length }, { passed: true, disk: true, app: true, expected: derived.manifest.notes.length })
  assert.deepEqual(compareMembership(['a.md', 'b.md'], ['b.md', 'c.md']), { actual: 2, expected: 2, missing: ['c.md'], unexpected: ['a.md'], matches: false })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-04 app runner measures usable-open, indexing and source-to-file/source-to-app independently through a fake instance', async (t) => {
  const dir = tempDir(t, 'ap04')
  const workspaceDir = path.join(dir, 'workspace')
  const vaultRoot = path.join(dir, 'vault')
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(vaultRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'note.md'), '# Note\n')
  let appSees = true
  const instance = fakeInstance(t, { answers: { 'layoutReady': '=> true', 'metadataCache.initialized': '=> true', 'adapter.read': () => (appSees ? '=> true' : '=> false') } })
  // The fake derivation copies the edited source into the vault, as the pipeline would.
  const derive = async () => { fs.writeFileSync(path.join(vaultRoot, 'note.md'), fs.readFileSync(path.join(workspaceDir, 'note.md'))); return { state: 'committed', mode: 'in-app', files: [{ kind: 'note', path: 'note.md' }], store: { vaultRoot } } }
  const run = await runAp04App({ instance, launchedAtMs: Date.now() - 50, scaleManifest: { workspaceDir }, derive, warm: 3, sampleAppRss: async () => 4096, random: () => 0 })
  assert.deepEqual({ passed: run.passed, count: run.summary.count, complete: run.summary.complete, fileStatus: run.summary.sourceToFile.status, appStatus: run.summary.sourceToApp.status, budget: run.timings.budget.budgetMs }, { passed: true, count: 3, complete: true, fileStatus: 'measured', appStatus: 'measured', budget: null })
  assert.ok(run.timings.usableOpen.met && run.timings.appIndexing.met && run.timings.usableOpen.sinceLaunchMs >= 50)
  assert.ok(run.samples.every((sample) => sample.sourceToFileMs !== null && sample.sourceToAppMs !== null && sample.sourceToAppMs >= sample.sourceToFileMs))
  assert.deepEqual(run.appSamples.map((sample) => sample.label), ['after-index', 'end'])
  appSees = false
  const unseen = await runAp04App({ instance, launchedAtMs: Date.now(), scaleManifest: { workspaceDir }, derive, warm: 1, appTimeoutMs: 250, random: () => 0 })
  assert.deepEqual({ passed: unseen.passed, file: unseen.samples[0].sourceToFileMs !== null, app: unseen.samples[0].sourceToAppMs }, { passed: false, file: true, app: null }, 'an app that never shows the change fails the run; the file measurement stands on its own')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

// Writes an AP-01 receipt set (G07) and an AP-04 receipt (G16) into `dir`.
function writeDesktopSet(t, dir, { candidate = CANDIDATE } = {}) {
  const g07 = recordProcedureReceipts({ plan: planProcedure('AP-01', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G07: [{ role: 'cli-link-inspection', name: evidenceFileName('G07', 'cli-link-inspection'), bytes: Buffer.from('indexReady: true\nlinks\n') }] }, passedByGate: { G07: true }, wallClock: WALL, recordedAt: NOW })
  const g16 = recordProcedureReceipts({ plan: planProcedure('AP-04', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G16: ['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies'].map((role) => ({ role, name: evidenceFileName('G16', role, 'json'), bytes: Buffer.from(`{"role":"${role}"}\n`) })) }, passedByGate: { G16: true }, wallClock: WALL, dataset: { nodes: 10000, edges: 50000, fixtureDigest: TINY_FIXTURE_DIGEST }, recordedAt: NOW })
  return { g07: g07[0], g16: g16[0] }
}

test('receipt writer: schema-valid, closes false, human acceptance null; manual roles leave the receipt incomplete and blocked', (t) => {
  const dir = tempDir(t, 'write')
  const { g07, g16 } = writeDesktopSet(t, dir)
  for (const written of [g07, g16]) {
    assert.deepEqual(validateObsidianContract('acceptance-receipt', written.receipt), [])
    assert.deepEqual({ schemaValid: written.validation.schemaValid, label: written.validation.label, gateClosed: written.validation.gateClosed }, { schemaValid: true, label: RECEIPT_VALIDATION_LABEL, gateClosed: false })
    const desktop = written.receipt.ext[DESKTOP_EXT_KEY]
    assert.deepEqual({ closes: desktop.closes, human: desktop.humanAcceptance, signature: desktop.signature }, { closes: false, human: null, signature: null })
    assert.ok(fs.existsSync(written.receiptPath))
    for (const item of written.receipt.evidence) assert.equal(sha(fs.readFileSync(path.join(dir, item.name))), item.digest, `${item.name} is hashed as written`)
  }
  assert.deepEqual({ status: g07.receipt.ext[DESKTOP_EXT_KEY].status, outcome: g07.receipt.outcome, pending: g07.receipt.ext[DESKTOP_EXT_KEY].pendingRoles, missing: g07.validation.missing.map((item) => item.code) }, { status: 'incomplete', outcome: 'blocked', pending: ['app-observation'], missing: ['evidence-role-missing', 'acceptance-missing'] })
  assert.deepEqual({ status: g16.receipt.ext[DESKTOP_EXT_KEY].status, outcome: g16.receipt.outcome, met: g16.validation.requirementsMet, dataset: g16.receipt.ext[RECEIPT_EXT_KEY].dataset }, { status: 'complete', outcome: 'passed', met: true, dataset: { nodes: 10000, edges: 50000, fixtureDigest: TINY_FIXTURE_DIGEST } })
  assert.equal(g07.receipt.environment.app.ext.installerVersion, '1.12.7')
  // A failed automated check or an unqualified CLI is a failed receipt, never a skipped pass.
  const failed = recordProcedureReceipts({ plan: planProcedure('AP-04', { receiptDir: dir }), receiptDir: path.join(dir, 'failed'), candidate: CANDIDATE, capabilities: { ...CAPABILITIES, qualified: false }, operator: 'op-synthetic', host: HOST, evidenceByGate: { G16: ['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies'].map((role) => ({ role, name: evidenceFileName('G16', role, 'json'), bytes: Buffer.from('{}\n') })) }, passedByGate: { G16: true }, wallClock: WALL, dataset: { nodes: 10, edges: 5, fixtureDigest: TINY_FIXTURE_DIGEST }, recordedAt: NOW })
  assert.equal(failed[0].receipt.outcome, 'failed')
  // The writer refuses what a receipt cannot carry.
  const refusal = (input, code) => { try { buildReceipt(input) } catch (error) { assert.ok(error instanceof ReceiptRefusal, error.stack); return error.code } return null }
  const base = { gate: 'G16', candidate: CANDIDATE, environment: g16.receipt.environment, host: HOST, operator: 'op-synthetic', evidence: [{ role: null, name: 'x.txt', bytes: Buffer.from('x') }], recordedAt: NOW, outcome: 'passed', wallClock: WALL, dataset: { nodes: 1, edges: 0, fixtureDigest: TINY_FIXTURE_DIGEST } }
  assert.equal(refusal({ ...base, evidence: [{ role: null, name: 'x.txt', bytes: Buffer.alloc(0) }] }), 'evidence-empty')
  assert.equal(refusal({ ...base, evidence: [{ role: 'app-observation', name: 'x.txt', bytes: Buffer.from('x') }] }), 'evidence-role-unknown')
  assert.equal(refusal({ ...base, evidence: [{ role: null, name: '../x.txt', bytes: Buffer.from('x') }] }), 'evidence-name-invalid')
  assert.equal(refusal({ ...base, candidate: { commit: '0'.repeat(40) } }), 'candidate-missing')
  assert.equal(refusal({ ...base, wallClock: null }), 'wall-clock-missing')
  assert.equal(refusal({ ...base, dataset: null }), 'dataset-missing')
  assert.equal(refusal({ ...base, gate: 'G18' }), 'gate-not-owned', 'the adopter gate is never written by the desktop tooling')
  assert.throws(() => writeGateReceipt({ ...base, receiptDir: 'relative' }), (error) => error.code === 'receipt-dir-not-absolute')
})

test('verifier: a complete signed set passes; missing, hash mismatch, incomplete, unsigned and wrong candidate each fail; a hash-blind verifier accepts tampering', (t) => {
  const dir = tempDir(t, 'verify')
  writeDesktopSet(t, dir)
  const statuses = (result) => Object.fromEntries(result.rows.map((row) => [row.gate, row.status]))
  // Fresh from the writer: G07 incomplete (a manual role outstanding), G16 complete but unsigned.
  const fresh = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G16'] })
  assert.deepEqual({ ok: fresh.ok, closes: fresh.closes, statuses: statuses(fresh), note16: fresh.rows[1].note }, { ok: false, closes: false, statuses: { G07: 'incomplete', G16: 'unsigned' }, note16: UNSIGNED_NOTE })
  // Signing refuses while manual steps are outstanding, then attaches the human evidence and signs.
  const signRefusal = (input) => { try { signReceipt(input) } catch (error) { assert.ok(error instanceof ReceiptRefusal, error.stack); return error.code } return null }
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'looked' }), 'manual-steps-outstanding')
  fs.writeFileSync(path.join(dir, 'observation.txt'), 'graph readable; both Shared concept notes distinct; links opened\n')
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'looked', attach: [{ role: 'app-observation', file: path.join(dir, 'observation.txt') }] }), 'outcome-required')
  const signed07 = signReceipt({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'inspected the graph and the CLI inspection', attach: [{ role: 'app-observation', file: path.join(dir, 'observation.txt') }], outcome: 'passed', signedAt: NOW })
  assert.deepEqual({ met: signed07.validation.requirementsMet, closes: signed07.closes, acceptance: signed07.receipt.ext[RECEIPT_EXT_KEY].acceptance, human: signed07.receipt.ext[DESKTOP_EXT_KEY].humanAcceptance.actor, outcome: signed07.receipt.outcome }, { met: true, closes: false, acceptance: { kind: 'human', actor: 'owner-synthetic', recordedAt: NOW, evidenceName: 'G07-acceptance-record.txt' }, human: 'owner-synthetic', outcome: 'passed' })
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'again' }), 'already-signed')
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G16', actor: 'owner-synthetic', note: 'x', outcome: 'failed' }), 'outcome-fixed')
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G18', actor: 'owner-synthetic', note: 'x' }), 'adopter-acceptance-separate')
  const signed16 = signReceipt({ receiptDir: dir, gate: 'G16', actor: 'owner-synthetic', note: 'inspected the dataset manifest, samples and latencies', signedAt: NOW })
  assert.deepEqual({ met: signed16.validation.requirementsMet, human: signed16.receipt.ext[DESKTOP_EXT_KEY].humanAcceptance, signature: signed16.receipt.ext[DESKTOP_EXT_KEY].signature.actor }, { met: true, human: null, signature: 'owner-synthetic' })
  // Complete, hashed, signed: exit-zero territory, and still not a closed gate.
  const complete = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G16'] })
  assert.deepEqual({ ok: complete.ok, closes: complete.closes, statuses: statuses(complete), notes: complete.rows.map((row) => row.note), signed: complete.rows.map((row) => row.signedBy) }, { ok: true, closes: false, statuses: { G07: 'ok', G16: 'ok' }, notes: [SIGNED_NOTE, SIGNED_NOTE], signed: ['owner-synthetic', 'owner-synthetic'] })
  const table = formatTable(complete)
  assert.ok(table.includes('G07   ok') && table.includes(SIGNED_NOTE) && !/\bclosed\b/.test(table))
  // Missing gate.
  const missing = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G13', 'G16'] })
  assert.deepEqual({ ok: missing.ok, G13: statuses(missing).G13 }, { ok: false, G13: 'missing' })
  // Wrong candidate: against an explicit commit, and a set whose receipts disagree.
  const wrong = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G16'], candidateCommit: '3'.repeat(40) })
  assert.deepEqual({ ok: wrong.ok, statuses: statuses(wrong) }, { ok: false, statuses: { G07: 'wrong-candidate', G16: 'wrong-candidate' } })
  const mixed = tempDir(t, 'verify-mixed')
  writeDesktopSet(t, mixed)
  signReceipt({ receiptDir: mixed, gate: 'G16', actor: 'owner-synthetic', note: 'ok', signedAt: NOW })
  const other = path.join(mixed, 'G07.json')
  const otherCandidate = JSON.parse(fs.readFileSync(path.join(dir, 'G07.json'), 'utf8'))
  otherCandidate.candidate.commit = '4'.repeat(40)
  fs.writeFileSync(other, JSON.stringify(otherCandidate))
  for (const name of otherCandidate.evidence.map((item) => item.name)) fs.copyFileSync(path.join(dir, name), path.join(mixed, name))
  assert.deepEqual(statuses(verifyReceiptSet({ receiptDir: mixed, required: ['G16', 'G07'] })), { G16: 'ok', G07: 'wrong-candidate' })
  // Hash mismatch: tampered evidence beside a signed receipt; the hash-blind mutation control accepts it.
  fs.appendFileSync(path.join(dir, 'G16-warm-update-latencies.json'), 'tampered\n')
  const tampered = verifyReceiptSet({ receiptDir: dir, required: ['G16'] })
  assert.deepEqual({ ok: tampered.ok, status: tampered.rows[0].status, detail: tampered.rows[0].detail }, { ok: false, status: 'hash-mismatch', detail: ['evidence-length-mismatch: G16-warm-update-latencies.json', 'evidence-digest-mismatch: G16-warm-update-latencies.json'] })
  const blind = createReceiptVerifierForOracleTests({ checkHashes: false })({ receiptDir: dir, required: ['G16'] })
  assert.deepEqual({ ok: blind.ok, status: blind.rows[0].status }, { ok: true, status: 'ok' }, 'mutation control: without the hash check the tampered receipt passes, so the check is load-bearing')
  fs.rmSync(path.join(dir, 'G16-dataset-manifest.json'))
  assert.equal(verifyReceiptSet({ receiptDir: dir, required: ['G16'] }).rows[0].detail[0], 'evidence-file-missing: G16-dataset-manifest.json')
  // Schema-invalid and unparseable receipts.
  fs.writeFileSync(path.join(dir, 'G13.json'), JSON.stringify({ schema: 'atelier-obsidian-acceptance-receipt/v1', gate: 'G13' }))
  fs.writeFileSync(path.join(dir, 'G14.json'), '{not json')
  assert.deepEqual(statuses(verifyReceiptSet({ receiptDir: dir, required: ['G13', 'G14'] })), { G13: 'schema-invalid', G14: 'schema-invalid' })
  assert.throws(() => verifyReceiptSet({ receiptDir: dir, required: ['G99'] }), (error) => error instanceof OutputRefusal && error.code === 'usage')
  assert.throws(() => verifyReceiptSet({ receiptDir: 'relative', required: ['G07'] }), (error) => error.code === 'usage')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('verify-receipts and generate-scale command lines: exit codes on a complete set, an incomplete set and a refused output', async (t) => {
  const dir = tempDir(t, 'cli')
  writeDesktopSet(t, dir)
  signReceipt({ receiptDir: dir, gate: 'G16', actor: 'owner-synthetic', note: 'ok', signedAt: NOW })
  const run = (script, args) => new Promise((resolve) => childProcess.execFile(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts', 'obsidian', script), ...args], { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })))
  const ok = await run('verify-receipts.mjs', ['--required', 'G16', '--receipt-dir', dir])
  assert.deepEqual({ code: ok.code, signed: ok.stdout.includes(SIGNED_NOTE), closed: /\bclosed\b/.test(ok.stdout) }, { code: 0, signed: true, closed: false }, ok.stdout + ok.stderr)
  const incomplete = await run('verify-receipts.mjs', ['--required', 'G07,G16', '--receipt-dir', dir])
  assert.deepEqual({ code: incomplete.code, status: incomplete.stdout.includes('G07   incomplete') }, { code: 1, status: true }, incomplete.stdout + incomplete.stderr)
  const usage = await run('verify-receipts.mjs', ['--receipt-dir', dir])
  assert.equal(usage.code, 2)
  const refused = await run('generate-scale.mjs', ['--out', path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'scale'), '--profile', 'tiny'])
  assert.deepEqual({ code: refused.code, message: refused.stderr.includes('output-inside-fixtures') }, { code: 2, message: true })
  assert.ok(!fs.existsSync(path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'scale')))
  const planOnly = await run('desktop-receipts.mjs', ['--procedure', 'AP-03', '--receipt-dir', path.join(dir, 'receipts')])
  assert.deepEqual({ code: planOnly.code, plan: planOnly.stdout.includes('plan only'), sleep: planOnly.stdout.includes('sleep-wake-clock'), nothingWritten: !fs.existsSync(path.join(dir, 'receipts')) }, { code: 0, plan: true, sleep: true, nothingWritten: true })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('the desktop derivation applies the fixture\'s withheld list and refuses a vault that carries a sentinel', async (t) => {
  const { deriveWorkspace, materializeFixtureWorkspace } = await import('../scripts/obsidian/lib/derive.mjs')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-derive-withheld-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const fixture = materializeFixtureWorkspace(path.join(temp, 'workspace'))
  assert.ok(fixture.withheldByEligibility.length > 0 && fixture.sentinels.length > 0)
  const vault = path.join(temp, 'vault')
  const derived = await deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(temp, 'state'), vaultRoot: vault, withheld: fixture.withheldByEligibility, sentinels: fixture.sentinels })
  assert.equal(derived.state, 'committed')
  const names = fs.readdirSync(path.join(vault, 'notes'))
  for (const sentinel of fixture.sentinels) assert.ok(!names.some((name) => name.includes(sentinel)), `${sentinel} must not name a note`)
  // Control: without the withheld list the sentinel reaches the vault and the derivation refuses to be evidence.
  await assert.rejects(() => deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(temp, 'state-2'), vaultRoot: path.join(temp, 'vault-2'), sentinels: fixture.sentinels }), /withheld sentinel/)
})

// ---------------------------------------------------------------------------
// 8. AOP-4 phase 2, AP-03 and AP-05: the lifecycle and editing procedures run
// against the real runtime (a service process of the test entry for AP-03,
// an in-process engine with the real apply and proposal contributions for
// AP-05), a fake app that reads the vault from disk, and the shipped command.
// The spawn guard stays silent: the test entry's adapter reports no app.
// ---------------------------------------------------------------------------

const TEST_SERVICE_ENTRY = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs')
const FULL_ONLY = [{ scopeId: 'scope-full', mode: 'full', selector: { all: true } }]
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// A synthetic workspace with real (empty) git repositories, its private state under a data root of its own.
function serviceWorld(t, label, { scoped = false } = {}) {
  const dir = tempDir(t, label)
  const workspaceDir = path.join(dir, 'workspace')
  const fixture = scoped ? prepareAp05Workspace(workspaceDir) : materializeFixtureWorkspace(workspaceDir, { scopes: FULL_ONLY })
  if (!scoped) initialiseRepositories(fixture.repositories.map((repoId) => path.join(workspaceDir, repoId)))
  const env = stripProjectEnv(process.env)
  const world = prepareWorkspace({ projectFile: fixture.projectFile, dataRoot: path.join(dir, 'data'), env, randomBytes: fixedRandom })
  return { dir, fixture, env, world }
}

// The app of AP-03, faked: it "opens" any note and reads the vault file from disk, as the real probe reads app.vault.
const diskApp = (vaultRoot) => ({ openNote: async (notePath) => `opened ${notePath}`, readIncludes: ({ path: notePath, needle }) => { try { return fs.readFileSync(noteFile(vaultRoot, notePath), 'utf8').includes(needle) } catch { return false } } })

test('AP-03 runner: source refresh, dropped event with the null watcher, kills at owned points and a start from an exiting launcher, against a real service process', async (t) => {
  const { world, env } = serviceWorld(t, 'ap03')
  const runtime = createServiceRuntime({ loadProject: world.loadProject, dataRoot: world.dataRoot, env, consent: { actor: 'op-synthetic', coverage: 'service' }, intervalMs: 3_600_000, entryPath: TEST_SERVICE_ENTRY, entryArgs: [], launchThroughShell: false, probeTimeoutMs: 2000 })
  // Registered after tempDir's removal hook, so by the time it runs the workspace may be gone: every step tolerates that.
  t.after(async () => { try { await runtime.stop({ stopTimeoutMs: 5000 }) } catch { /* ended below */ } try { const record = runtime.record(); if (record && isAlive(record.pid)) process.kill(record.pid, 'SIGKILL') } catch { /* gone, or the workspace already removed */ } })
  const run = await runAp03({ world, runtime, app: diskApp(world.vaultRootFor('scope-full')), adapterFactory: () => absentAdapter(), recoveryIntervalMs: 400, settleMs: 300, midTickDelayMs: 5 })
  assert.deepEqual({ passed: run.passed, failures: run.failures, roles: run.evidence.map((item) => [item.role, item.name]) }, { passed: true, failures: [], roles: [['source-refresh-trace', 'G14-source-refresh-trace.json'], ['dropped-event-recovery', 'G14-dropped-event-recovery.json'], ['ownership-health', 'G15-ownership-health.json'], ['terminal-closure', 'G15-terminal-closure.json']] })
  const { steps } = run
  assert.ok(steps['source-refresh'].fileUpdate.met && steps['source-refresh'].appReadback.met && steps['source-refresh'].after.sourceDigest !== steps['source-refresh'].before.sourceDigest)
  assert.ok(typeof run.timings.sourceToFileMs === 'number' && typeof run.timings.sourceToAppMs === 'number', 'both latencies are recorded, separately')
  assert.deepEqual(steps['dropped-event'].trials.map((trial) => [trial.label, trial.caught, trial.tick.full, trial.tick.changes.some((change) => change.changeClass === 'source-body')]), [['stat-and-digest', true, false, true], ['full-hash-pass', true, true, true]])
  assert.deepEqual(steps.interruption.points.map((point) => [point.point, point.afterKill.state, point.restart.state, point.restart.pid !== point.before.pid, point.retained.pendingEditsUnchanged, point.retained.journalsRetained, point.retained.objectsPresent]), [['idle-between-ticks', 'stale-record', 'healthy', true, true, true, true], ['during-a-tick', 'stale-record', 'healthy', true, true, true, true]])
  assert.ok(steps.interruption.reference.pendingEdits.length >= 1 && steps.interruption.reference.retainedObjects.every((item) => item.present))
  const launcher = steps['launcher-exit']
  assert.deepEqual({ exit: launcher.launcher.exit, alive: launcher.launcher.alive, reported: launcher.reported.state, sameRuntime: launcher.statusLater.runtimeId === launcher.reported.runtimeId && launcher.statusLater.pid === launcher.reported.pid, health: launcher.healthAfterExit.answer.kind }, { exit: { code: 0, signal: null }, alive: false, reported: 'healthy', sameRuntime: true, health: 'health' })
  assert.equal(launcher.finalStop.stopped, true)
  // The evidence is what the receipt hashes: every role carries the wall clock of its step and the source digests.
  const refresh = JSON.parse(run.evidence[0].bytes.toString('utf8'))
  assert.ok(refresh.step.startedAt && refresh.step.endedAt && refresh.host.sourceDigests['north-desk/plans/harbor-plan.md'].startsWith('sha256:'))
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

// The AP-05 runtime for tests: the real engine with the real apply operation and proposal adapter, in this process.
// `start` creates a fresh engine (what a restarted service does: everything it knows comes from disk).
function engineRuntime(world, env, { onTick = () => {} } = {}) {
  const context = { loadProject: world.loadProject, dataRoot: world.dataRoot, env, platform: process.platform }
  const contributions = [createSourceApplyContribution({ context }), createProposalAdapterContribution(), createSelectionContribution()]
  let engine = null
  let generation = 0
  let ticks = 0
  return {
    contributions,
    async start() { generation += 1; engine = createMaintenanceEngine({ ...context, adapterFactory: () => absentAdapter(), clock: () => new Date(), extensions: createObsidianRegistry({ contributions }).extensions, watcherFactory: createNullWatcherFactory(), quietPeriodMs: 0 }); return { state: 'healthy', started: true, record: { runtimeId: `rt-engine-${generation}`, pid: process.pid } } },
    async tick() { ticks += 1; onTick(ticks); const report = await engine.tick(); return { requested: true, state: 'healthy', reason: 'tick-ran', tick: { ok: report.state !== 'refused', state: report.state, reason: report.reason ?? report.refusal?.code ?? null, scopes: (report.scopes ?? []).map(({ scopeId, state, reason }) => ({ scopeId, state, reason })), dispatched: report.dispatched ?? [] } } },
    async stop() { engine?.stop(); engine = null; return { stopped: true } },
    async status() { return { state: engine ? 'healthy' : 'stopped' } },
  }
}

// The editor of a fake instance: the same bytes real typing leaves on disk after the app saved.
const fileEditor = (world, scopeId) => ({ async typeAt({ notePath, anchor, text }) { const file = noteFile(world.vaultRootFor(scopeId), notePath); const held = fs.readFileSync(file, 'utf8'); const at = held.indexOf(anchor); if (at < 0) throw new Error(`no anchor "${anchor}" in ${notePath}`); fs.writeFileSync(file, held.slice(0, at + anchor.length) + text + held.slice(at + anchor.length)); return { notePath, anchor, text, typedAt: new Date().toISOString(), noteDigest: fileDigest(file) } } })

async function ap05World(t, label, { onTick } = {}) {
  const { world, env, fixture } = serviceWorld(t, label, { scoped: true })
  const runtime = engineRuntime(world, env, { onTick })
  const command = await createCommandRunner({ projectFile: fixture.projectFile, dataRoot: world.dataRoot, env, contributions: runtime.contributions })
  const views = { full: { scopeId: AP05_SCOPES.full, editor: fileEditor(world, AP05_SCOPES.full) }, scoped: { scopeId: AP05_SCOPES.scoped, editor: fileEditor(world, AP05_SCOPES.scoped) } }
  return { world, runtime, command, views, fixture }
}

test('AP-05 runner: coalesced and conflicted edits across two vaults, manual and automatic apply, pending kinds, idempotent restart, proposal store and retention', async (t) => {
  const { world, runtime, command, views, fixture } = await ap05World(t, 'ap05')
  assert.deepEqual(fixture.extraNotes, ['north-desk/plans/quay-notes.md', 'north-desk/plans/lantern-log.md'])
  const run = await runAp05({ world, views, runtime, command, operator: 'op-synthetic' })
  assert.deepEqual({ passed: run.passed, failures: run.failures, roles: run.evidence.map((item) => item.role) }, { passed: true, failures: [], roles: ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention', null] })
  const { steps } = run
  assert.deepEqual({ identical: [steps['multi-vault'].identical.object.state, steps['multi-vault'].identical.object.operations.length, steps['multi-vault'].identical.object.pendingEdits.length], divergent: [steps['multi-vault'].divergent.object.state, steps['multi-vault'].divergent.object.conflictedOperations.length] }, { identical: ['pending', 1, 2], divergent: ['conflicted', 2] })
  assert.deepEqual({ ticks: steps.manual.ticks.map((item) => item.sourceChanges.length), applied: steps.manual.apply.answer.result.status, exact: steps.manual.after.exactlyAsTyped, others: steps.manual.after.otherSourceChanges }, { ticks: [0, 0, 0], applied: 'applied', exact: true, others: [] })
  assert.ok(fs.readFileSync(path.join(world.workspaceDir, 'south-desk', 'tables', 'tide-table.md'), 'utf8').includes(AP05_EDITS.identical.text), 'the explicit apply wrote exactly the typed text into the source')
  // The dispatch of that tick also offered the two conflicted harbor-plan edits; each was refused as a conflict, and only the eligible one was applied.
  assert.deepEqual({ eligible: [steps.automatic.eligible.after.exactlyAsTyped, steps.automatic.eligible.after.dispatched.map((item) => item.status).sort()], pending: Object.fromEntries(Object.entries(steps.automatic.pendingSummary).map(([kind, list]) => [kind, list.map((edit) => [edit.state, edit.lastCode, edit.objectState])])) }, {
    eligible: [true, ['applied', 'conflict', 'conflict']],
    pending: {
      outOfScope: [['retry-exhausted', 'outside-policy-selection', 'pending']],
      stale: [['retry-exhausted', 'stale-source', 'conflicted']],
      unsupported: [['retry-exhausted', 'edit-not-applicable', 'settled']],
      conflicting: [['retry-exhausted', 'object-conflicted', 'conflicted'], ['retry-exhausted', 'object-conflicted', 'conflicted']],
      revoked: [['queued', null, 'pending']],
    },
  })
  assert.deepEqual({ same: steps.automatic.restart.idempotent.sameOpenEdits, sourceChanges: steps.automatic.restart.idempotent.sourceChanges, journals: steps.automatic.restart.idempotent.journalsRetained }, { same: true, sourceChanges: [], journals: true })
  assert.ok(steps.retention.ledger.exists && steps.retention.ledger.lines >= 1 && steps.retention.structuralSource.unchangedSinceTyped, 'the structural edit reached the copy-only store and the source stayed')
  assert.ok(steps.retention.retained.vaultHolds.length >= 8 && steps.retention.retained.vaultHolds.every((item) => item.present) && steps.retention.retained.recoveryObjects.every((item) => item.present))
  assert.deepEqual(run.timings.sourceChangesSinceBaseline, ['north-desk/plans/quay-notes.md', 'north-desk/plans/shared-b.md', 'south-desk/tables/tide-table.md'], 'exactly the moved stale source, the automatic apply and the manual apply changed a source')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('mutation control: a recorder blind to source digests accepts a manual-mode tick that wrote a source; the real recorder refuses it', async (t) => {
  // A runtime whose fourth tick (the first manual-mode tick after the two multi-vault ticks) writes a source, as a broken engine would.
  const sabotage = (world) => (count) => { if (count === 4) fs.appendFileSync(path.join(world.workspaceDir, 'north-desk', 'plans', 'lantern-log.md'), '\nWritten by a tick.\n') }
  const honest = await ap05World(t, 'ap05-honest')
  honest.runtime = engineRuntime(honest.world, honest.world.env, { onTick: sabotage(honest.world) })
  const real = await runAp05({ ...honest, operator: 'op-synthetic', manualTicks: 1 })
  assert.ok(real.failures.includes('manual: a tick in manual mode changed a source'), real.failures.join('\n'))
  const blind = await ap05World(t, 'ap05-blind')
  blind.runtime = engineRuntime(blind.world, blind.world.env, { onTick: sabotage(blind.world) })
  const blindRun = await createAp05RunnerForOracleTests({ sourceDigests: () => ({}) })({ ...blind, operator: 'op-synthetic', manualTicks: 1 })
  assert.ok(!blindRun.failures.includes('manual: a tick in manual mode changed a source'), 'the blind recorder cannot see the written source')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('mutation control: a warm summary that reads the app series from the file member fails the pinned p95', () => {
  const changes = Array.from({ length: 30 }, (_, index) => ({ change: index + 1, sourceToFileMs: 100 + index * 10, sourceToAppMs: 9000 }))
  const real = warmChangeSummary(changes)
  assert.deepEqual({ file: real.sourceToFile.p95Ms, app: real.sourceToApp.p95Ms, met: real.targetsMet, claimed: real.usability.claimed }, { file: 380, app: 9000, met: { fileUpdateP95: true, sourceToAppP95: null }, claimed: false })
  const wrongSeries = createWarmChangeSummaryForOracleTests({ appOf: (sample) => sample.sourceToFileMs })(changes)
  assert.notEqual(wrongSeries.sourceToApp.p95Ms, 9000, 'the app p95 computed over the file series is not the app p95')
  assert.throws(() => assert.deepEqual({ file: wrongSeries.sourceToFile.p95Ms, app: wrongSeries.sourceToApp.p95Ms }, { file: 380, app: 9000 }), assert.AssertionError)
})

test('service world seams: the profile is bound to the engine vault, repositories ignore the proposal store, the audience is set, the launcher is spawned without a shell in tests', (t) => {
  const dir = tempDir(t, 'seams')
  const layout = { root: dir, home: path.join(dir, 'home'), profile: path.join(dir, 'profile'), vault: path.join(dir, 'vault') }
  fs.mkdirSync(layout.profile, { recursive: true })
  fs.writeFileSync(path.join(layout.profile, 'obsidian.json'), JSON.stringify({ vaults: { atelierg00synthetic: { path: layout.vault, ts: 1, open: true } }, cli: true, updateDisabled: true }))
  const bound = bindLayoutToVault(layout, path.join(dir, 'engine-vault'))
  const profile = JSON.parse(fs.readFileSync(path.join(layout.profile, 'obsidian.json'), 'utf8'))
  assert.deepEqual({ vault: bound.vault, registered: Object.values(profile.vaults).map((item) => item.path), cli: profile.cli, exists: fs.existsSync(bound.vault) }, { vault: path.join(dir, 'engine-vault'), registered: [path.join(dir, 'engine-vault')], cli: true, exists: true })
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  const ran = []
  initialiseRepositories([repo], { run: (command, args, options) => { ran.push([command, ...args, options.cwd]); fs.mkdirSync(path.join(options.cwd, '.git'), { recursive: true }) } })
  assert.deepEqual({ ran, ignore: fs.readFileSync(path.join(repo, '.gitignore'), 'utf8') }, { ran: [['git', 'init', '-q', repo]], ignore: '.atelier-proposals/\n' })
  const { world } = serviceWorld(t, 'seams-world')
  assert.deepEqual({ audience: readMachineSettings({ workspaceRoot: world.workspaceRoot, workspaceId: world.workspaceId }).audienceAllow, workspaceId: world.workspaceId, vault: path.relative(world.workspaceRoot, world.vaultRootFor('scope-full')).split(path.sep) }, { audience: ['team'], workspaceId: WORKSPACE_ID, vault: ['vaults', 'scope-full'] })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-03 and AP-05 receipts: G14 stays incomplete for the host sleep/wake, G15 and G17 are complete from automated roles alone; a failed run is a failed receipt', (t) => {
  const dir = tempDir(t, 'lifecycle-receipts')
  const roles = (gate, names) => names.map((role) => ({ role, name: evidenceFileName(gate, role, 'json'), bytes: Buffer.from(`{"role":"${role}"}\n`) }))
  const ap03 = recordProcedureReceipts({ plan: planProcedure('AP-03', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate: CANDIDATE, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G14: roles('G14', ['source-refresh-trace', 'dropped-event-recovery']), G15: roles('G15', ['ownership-health', 'terminal-closure']) }, passedByGate: { G14: true, G15: true }, wallClock: WALL, recordedAt: NOW })
  assert.deepEqual(ap03.map(({ receipt, validation }) => [receipt.gate, receipt.outcome, receipt.ext[DESKTOP_EXT_KEY].status, receipt.ext[DESKTOP_EXT_KEY].pendingRoles, validation.schemaValid, validation.missing.map((item) => item.code)]), [
    ['G14', 'blocked', 'incomplete', ['sleep-wake-clock'], true, ['evidence-role-missing']],
    ['G15', 'passed', 'complete', [], true, []],
  ])
  const ap05 = recordProcedureReceipts({ plan: planProcedure('AP-05', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate: CANDIDATE, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G17: roles('G17', ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention']) }, passedByGate: { G17: true }, wallClock: WALL, recordedAt: NOW })
  assert.deepEqual(ap05.map(({ receipt, validation }) => [receipt.gate, receipt.outcome, receipt.ext[DESKTOP_EXT_KEY].status, receipt.ext[DESKTOP_EXT_KEY].closes, receipt.ext[DESKTOP_EXT_KEY].humanAcceptance, validation.schemaValid, validation.missing.map((item) => item.code)]), [['G17', 'passed', 'complete', false, null, true, ['acceptance-missing']]], 'complete from automation; the human acceptance is recorded separately by the closing owner')
  const failed = recordProcedureReceipts({ plan: planProcedure('AP-05', { receiptDir: path.join(dir, 'failed'), operator: 'op-synthetic' }), receiptDir: path.join(dir, 'failed'), candidate: CANDIDATE, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G17: roles('G17', ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention']) }, passedByGate: { G17: false }, wallClock: WALL, recordedAt: NOW })
  assert.equal(failed[0].receipt.outcome, 'failed')
})
