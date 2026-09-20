#!/usr/bin/env node
// AP-01..AP-05 orchestration against an isolated Obsidian instance, writing
// one receipt per gate. Developer proof tooling: not shipped.
//
// The instance is always the disposable one experiments/obsidian-publication/
// lib/instance.mjs creates (private HOME, private profile, synthetic vault,
// mock keychain), and every run first asks it `vaults verbose` and refuses
// unless exactly that synthetic vault is visible. Capability discovery (app
// and installer version, CLI command availability, `lastSavedData`) is
// recorded before any procedure. Each receipt carries raw app output, wall
// clock timings and host identity, validates against the acceptance receipt
// schema, and says `closes: false` with `humanAcceptance: null`: the closing
// owner inspects and signs afterwards (sign-receipt.mjs).
//
// AP-03 and AP-05 run the owned maintenance service for real (a detached
// process started through the runtime's own lifecycle API, with the isolated
// HOME so its editor adapter reaches only the isolated app) and read every
// decision through the shipped command. What no script can do is listed per
// gate as `manualStepsRequired` with the exact commands, and that gate's
// receipt stays `incomplete`: the host's actual sleep/wake of AP-03 (G14).
//
// Usage:
//   node scripts/obsidian/desktop-receipts.mjs --procedure AP-01|AP-02|AP-03|AP-04|AP-05|all
//       [--receipt-dir DIR] [--operator ID] [--scale-dir DIR] [--warm N] [--keep] [--json]
//       [--run-isolated-app]
// Without --run-isolated-app the plan and manual steps are printed and no
// application starts. --keep leaves the synthetic workspace, the data root and
// the isolated instance roots in place, which the manual sleep/wake step needs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildFocusQuery, focusBookmarkPayload } from '../../src/projection/obsidian/selection-ui/focus.mjs'
import { RECEIPT_GATES } from '../../src/projection/obsidian/selection-ui/receipt.mjs'
import { OutputRefusal, REPOSITORY_ROOT, assertExternalOutput, candidateIdentity, hardwareProfile, hostIdentity, isoNow, osEnvironment, parseArgs, sha256Digest, toIdentifier, walkFiles } from './lib/common.mjs'
import { runAp03 } from './lib/ap03.mjs'
import { AP05_SCOPES, AP05_SCOPE_DOCUMENTS, prepareAp05Workspace, runAp05 } from './lib/ap05.mjs'
import { FULL_SCOPE, absentAdapter, deriveWorkspace, materializeFixtureWorkspace } from './lib/derive.mjs'
import { PROPOSED_TARGETS, waitUntil, warmChangeSummary } from './lib/measure.mjs'
import { evidenceFileName, writeGateReceipt } from './lib/receipts.mjs'
import { bindLayoutToVault, createAppEditor, createCommandRunner, createInProcessServiceRuntime, createPerVaultAdapterFactory, createServiceRuntime, initialiseRepositories, prepareWorkspace, stripProjectEnv } from './lib/service-world.mjs'

export const DEFAULT_RECEIPT_DIR = path.join(REPOSITORY_ROOT, '.artifacts', 'obsidian', 'desktop')
// The sentinels the production eligibility rule keeps out of a view the real service maintains (see the fixture's description).
export const SERVICE_SENTINELS = path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'service-sentinels.json')
export const INDEX_TIMEOUT_MS = 10 * 60 * 1000
export const WARM_CHANGES = 30
export const SCOPED_IDS = Object.freeze(['north-desk:harbor-plan', 'south-desk:tide-table'])
export const SCOPED_SCOPE = Object.freeze({ schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-harbor', mode: 'scoped', selector: Object.freeze({ ids: SCOPED_IDS }) })

const HOME_PLACEHOLDER = '<ISOLATED_HOME>'
const PROFILE_PLACEHOLDER = '<ISOLATED_PROFILE>'
const WORKSPACE_PLACEHOLDER = '<SYNTHETIC_WORKSPACE>'
const DATA_ROOT_PLACEHOLDER = '<DATA_ROOT>'
const cli = (operation) => `HOME=${HOME_PLACEHOLDER} node bin/atelier.mjs obsidian ${operation} --project ${WORKSPACE_PLACEHOLDER}/atelier.project.json --data-root ${DATA_ROOT_PLACEHOLDER} --json`
// The service interval of the AP-03 and AP-05 runs: every tick is requested explicitly and recorded, so the loop never ticks between two recorded steps.
export const PROCEDURE_TICK_INTERVAL_MS = 60 * 60 * 1000

// Every step a person performs, with the exact command where one exists.
// The receipts of these gates stay incomplete until the closing owner records
// each role's evidence with sign-receipt.mjs --attach ROLE=FILE.
export const MANUAL_STEPS = Object.freeze({
  G07: [
    { role: 'app-observation', instructions: [
      'In the isolated instance (same HOME as the run), open the graph view and confirm every note of the small fixture appears with a readable basename.',
      'Open the two "Shared concept" notes and confirm the identity suffix disambiguates them in the file explorer and in tab titles.',
      'Click a cross-repository link (Harbor plan -> Tide table), a heading link (Tide table#Spring) and the embedded attachment; confirm each opens.',
      'Open outgoing links and backlinks panes for Harbor plan; compare with G07-cli-link-inspection.txt.',
      'Record what you saw, with screenshots or a recording, in one text file; attach it as app-observation.',
    ] },
  ],
  G13: [
    { role: 'graph-filter-observation', instructions: [
      'Open the full-vault isolated instance. In the graph view, paste the query from G13-focus-query.json into "Search files" and confirm only the selected notes remain.',
      'Save the filtered graph through core Bookmarks and reopen it from the bookmark; confirm the filter is applied again.',
      'Confirm the scoped vault (second instance) shows exactly the scoped membership recorded in G13-app-index-membership.txt.',
      'Record the observations, with screenshots, in one text file; attach it as graph-filter-observation.',
    ] },
  ],
  G14: [
    { role: 'sleep-wake-clock', instructions: [
      `Run AP-03 with --keep, then start the isolated app on the kept profile: HOME=${HOME_PLACEHOLDER} /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=${PROFILE_PLACEHOLDER} --use-mock-keychain --password-store=basic`,
      `Start the service against the kept workspace: ${cli('service start --consent-actor <OPERATOR> --adapter=obsidian-cli')}`,
      `Record ${cli('service status')} and the wall clock (date -u); put the host to sleep for at least two minutes; wake it.`,
      `Record the wall clock and ${cli('service status')} again: the same runtime ID and PID must answer healthy.`,
      `Append a line to ${WORKSPACE_PLACEHOLDER}/north-desk/plans/harbor-plan.md, wait one service interval or run ${cli('status')} until the view reports current, and confirm the note in the app shows the line.`,
      'Attach both clock readings, both status documents and the post-wake confirmation as sleep-wake-clock. A mocked resume event is not this evidence.',
    ] },
  ],
})

export const DESKTOP_PROCEDURES = Object.freeze({
  'AP-01': Object.freeze({ title: 'Readable notes and navigation', gates: ['G07'], automated: { G07: ['cli-link-inspection'] }, app: 'small-fixture' }),
  'AP-02': Object.freeze({ title: 'Scope and focus', gates: ['G13'], automated: { G13: ['on-disk-membership', 'app-index-membership'] }, app: 'small-fixture-full-and-scoped' }),
  'AP-03': Object.freeze({ title: 'Maintenance and host lifecycle', gates: ['G14', 'G15'], automated: { G14: ['source-refresh-trace', 'dropped-event-recovery'], G15: ['ownership-health', 'terminal-closure'] }, app: 'service-full' }),
  'AP-04': Object.freeze({ title: 'Scale', gates: ['G16'], automated: { G16: ['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies'] }, app: 'scale-vault' }),
  'AP-05': Object.freeze({ title: 'Editing and agentic application', gates: ['G17'], automated: { G17: ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention'] }, app: 'service-full-and-scoped' }),
})
export const PROCEDURE_IDS = Object.freeze(Object.keys(DESKTOP_PROCEDURES))

export class IsolationRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'IsolationRefusal'
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

function fill(text, { isolatedHome, isolatedProfile, workspaceDir, dataRoot, operator }) {
  return text.replaceAll(HOME_PLACEHOLDER, isolatedHome ?? HOME_PLACEHOLDER).replaceAll(PROFILE_PLACEHOLDER, isolatedProfile ?? PROFILE_PLACEHOLDER).replaceAll(WORKSPACE_PLACEHOLDER, workspaceDir ?? WORKSPACE_PLACEHOLDER).replaceAll(DATA_ROOT_PLACEHOLDER, dataRoot ?? DATA_ROOT_PLACEHOLDER).replaceAll('<OPERATOR>', operator ?? '<OPERATOR>')
}

export function planProcedure(procedureId, { receiptDir = DEFAULT_RECEIPT_DIR, operator = null, isolatedHome = null, isolatedProfile = null, workspaceDir = null, dataRoot = null, scaleDir = null } = {}) {
  const procedure = DESKTOP_PROCEDURES[procedureId]
  if (!procedure) throw new OutputRefusal('unknown-procedure', `procedures: ${PROCEDURE_IDS.join(', ')}`)
  const manualStepsRequired = []
  for (const gate of procedure.gates) {
    for (const step of MANUAL_STEPS[gate] ?? []) manualStepsRequired.push({ gate, role: step.role, instructions: step.instructions.map((line) => fill(line, { isolatedHome, isolatedProfile, workspaceDir, dataRoot, operator })) })
  }
  const automatedRoles = Object.fromEntries(procedure.gates.map((gate) => [gate, [...(procedure.automated[gate] ?? [])]]))
  const uncovered = procedure.gates.flatMap((gate) => RECEIPT_GATES[gate].roles.filter((role) => !automatedRoles[gate].includes(role) && !manualStepsRequired.some((step) => step.gate === gate && step.role === role)).map((role) => `${gate}:${role}`))
  if (uncovered.length > 0) throw new OutputRefusal('plan-incomplete', `no automated or manual step covers ${uncovered.join(', ')}`)
  return {
    procedureId,
    title: procedure.title,
    gates: [...procedure.gates],
    app: procedure.app,
    receiptDir,
    receipts: procedure.gates.map((gate) => ({ gate, file: path.join(receiptDir, `${gate}.json`), status: manualStepsRequired.some((step) => step.gate === gate) ? 'incomplete' : 'complete' })),
    automatedRoles,
    manualStepsRequired,
    requiresScaleDir: procedure.app === 'scale-vault',
    scaleDir,
    closes: false,
  }
}

// ---------------------------------------------------------------------------
// Isolation and capability discovery
// ---------------------------------------------------------------------------

const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }

// Refuses anything that is not the disposable instance: the instance's HOME
// must be a private directory under its layout root and not this user's
// home, and the app must list exactly the synthetic vault of that layout.
export async function assertIsolatedInstance(instance, { userHome = os.homedir() } = {}) {
  const layout = instance?.layout
  if (!layout || typeof layout.root !== 'string' || typeof layout.vault !== 'string' || typeof layout.home !== 'string') throw new IsolationRefusal('instance-not-isolated', 'the instance carries no isolated layout (root, home, vault)')
  const home = instance.env?.HOME
  if (typeof home !== 'string' || home !== layout.home || !inside(layout.root, home) || path.resolve(home) === path.resolve(userHome)) throw new IsolationRefusal('instance-home-not-private', 'the instance must run with a private HOME under its own layout root', { home })
  if (typeof instance.cli !== 'function') throw new IsolationRefusal('instance-not-isolated', 'the instance exposes no CLI call')
  const output = String(await instance.cli('vaults', 'verbose'))
  const vaults = output.split('\n').map((line) => line.trim()).filter(Boolean)
  if (vaults.length !== 1 || !vaults[0].endsWith(layout.vault)) throw new IsolationRefusal('unexpected-vaults-visible', `refusing: the app lists ${vaults.length} vault(s), not exactly the synthetic one`, { vaults })
  return { vaultRoot: layout.vault, vaultsOutput: output }
}

// Eval probes are fixed scripts; the only variable input travels as a JSON
// payload in base64, never spliced into code.
const evalCode = (script, payload = {}) => {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return `code=(()=>{const P=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${data}'),c=>c.charCodeAt(0))));return ${script}})()`
}
export const PROBES = Object.freeze({
  indexReady: 'String(app.metadataCache.initialized===true)',
  layoutReady: 'String(app.workspace.layoutReady===true)',
  basePath: 'JSON.stringify({basePath:app.vault.adapter.basePath})',
  markdownFiles: 'JSON.stringify(app.vault.getMarkdownFiles().map(f=>f.path).sort())',
  resolvedLinks: 'JSON.stringify({resolved:app.metadataCache.resolvedLinks,unresolved:app.metadataCache.unresolvedLinks})',
  openFirst: 'app.workspace.getLeaf(true).openFile(app.vault.getMarkdownFiles()[0]).then(()=>"ok")',
  lastSavedData: 'JSON.stringify({views:app.workspace.getLeavesOfType("markdown").map(l=>({path:l.view.file&&l.view.file.path,hasLastSavedData:"lastSavedData" in l.view}))})',
  closeAll: '(app.workspace.getLeavesOfType("markdown").forEach(l=>l.detach()),"ok")',
  readIncludes: 'app.vault.adapter.read(P.path).then(t=>String(t.includes(P.needle)))',
})

export async function evalValue(instance, script, payload) {
  const out = String(await instance.cli('eval', evalCode(script, payload)))
  const start = out.indexOf('=> ')
  if (start < 0) throw new Error(`eval returned no value: ${JSON.stringify(out.slice(0, 300))}`)
  return out.slice(start + 3).trim()
}

const evalJson = async (instance, script, payload) => {
  const text = await evalValue(instance, script, payload)
  const value = JSON.parse(text)
  return typeof value === 'string' && /^[[{]/.test(value) ? JSON.parse(value) : value
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/g
const CLI_COMMANDS = ['version', 'help', 'vaults', 'eval', 'links', 'backlinks', 'unresolved', 'file', 'dev:cdp']

export function parseVersionOutput(text) {
  const found = String(text ?? '').match(VERSION_PATTERN) ?? []
  const installer = String(text ?? '').match(/installer[^0-9]*(\d+\.\d+\.\d+)/i)
  return { appVersion: found[0] ?? null, installerVersion: installer?.[1] ?? found[1] ?? null }
}

export function parseHelpOutput(text) {
  const help = String(text ?? '')
  return Object.fromEntries(CLI_COMMANDS.map((command) => [command, new RegExp(`(^|[^A-Za-z0-9:_-])${command.replace(':', '\\:')}(?![A-Za-z0-9_-])`, 'm').test(help)]))
}

// Records what the installed app and CLI can do. A probe that fails is
// recorded as failed; unsupported capability is a failed qualification.
export async function discoverCapabilities(instance, { now = isoNow } = {}) {
  const record = { discoveredAt: now(), app: { name: 'Obsidian', version: null, installerVersion: null, raw: null }, cli: { version: null, commands: null, helpRaw: null }, lastSavedData: { present: null, views: null, error: null }, errors: [] }
  try {
    const raw = String(await instance.cli('version')).trim()
    const parsed = parseVersionOutput(raw)
    record.app.raw = raw
    record.app.version = parsed.appVersion
    record.app.installerVersion = parsed.installerVersion
    record.cli.version = parsed.appVersion === null ? null : raw
  } catch (error) { record.errors.push(`version: ${error.message}`) }
  try {
    const help = String(await instance.cli('help'))
    record.cli.helpRaw = help
    record.cli.commands = parseHelpOutput(help)
  } catch (error) { record.errors.push(`help: ${error.message}`) }
  try {
    await evalValue(instance, PROBES.openFirst)
    const views = await evalJson(instance, PROBES.lastSavedData)
    record.lastSavedData.views = views.views
    record.lastSavedData.present = views.views.length > 0 ? views.views.every((view) => view.hasLastSavedData === true) : null
    await evalValue(instance, PROBES.closeAll)
  } catch (error) { record.lastSavedData.error = error.message; record.errors.push(`lastSavedData: ${error.message}`) }
  record.qualified = record.errors.length === 0 && record.app.version !== null && record.lastSavedData.present === true && ['vaults', 'eval', 'links', 'backlinks', 'unresolved'].every((command) => record.cli.commands?.[command] === true)
  return record
}

export const environmentOf = (capabilities) => ({
  os: osEnvironment(),
  app: { name: 'Obsidian', version: capabilities.app.version ?? 'unknown', ...(capabilities.app.installerVersion ? { ext: { installerVersion: capabilities.app.installerVersion } } : {}) },
  cli: { version: capabilities.cli.version ?? 'unknown' },
})

// ---------------------------------------------------------------------------
// Procedure runners: each takes an instance and answers evidence buffers,
// timings and the automated verdict. None writes a receipt.
// ---------------------------------------------------------------------------

const text = (value) => Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8')

export async function waitForIndex(instance, { timeoutMs = INDEX_TIMEOUT_MS, ...options } = {}) {
  return waitUntil(async () => (await evalValue(instance, PROBES.indexReady)) === 'true', { timeoutMs, ...options })
}

// The set of (source path, target path) pairs the generated view expects the
// app to resolve: every manifest link whose target is in scope.
export function expectedLinkPairs(manifest) {
  const pathOf = new Map(manifest.notes.map((note) => [note.nodeId, note.path]))
  const pairs = new Set()
  for (const link of manifest.links) {
    if (link.targetState !== 'in-scope') continue
    const source = pathOf.get(link.sourceNodeId)
    const target = pathOf.get(link.targetNodeId)
    if (source && target && source !== target) pairs.add(`${source} -> ${target}`)
  }
  return [...pairs].sort()
}

export function compareResolvedLinks({ resolved, expected }) {
  const app = new Set()
  for (const [source, targets] of Object.entries(resolved ?? {})) for (const target of Object.keys(targets ?? {})) if (target.endsWith('.md')) app.add(`${source} -> ${target}`)
  const expectedSet = new Set(expected)
  const missing = expected.filter((pair) => !app.has(pair))
  const unexpected = [...app].filter((pair) => !expectedSet.has(pair)).sort()
  return { expected: expected.length, resolved: app.size, missing, unexpected, matches: missing.length === 0 && unexpected.length === 0 }
}

export async function runAp01({ instance, manifest, timeoutMs = INDEX_TIMEOUT_MS, maxNotes = 200 }) {
  const timings = {}
  const index = await waitForIndex(instance, { timeoutMs })
  timings.indexWaitMs = index.elapsedMs
  const lines = [`# AP-01 CLI link inspection`, `indexReady: ${index.met} after ${index.elapsedMs} ms (${index.attempts} probes)${index.error ? `; last error ${index.error}` : ''}`, '']
  let comparison = null
  try {
    const links = await evalJson(instance, PROBES.resolvedLinks)
    comparison = compareResolvedLinks({ resolved: links.resolved, expected: expectedLinkPairs(manifest) })
    lines.push('## metadataCache.resolvedLinks compared with the generation manifest', JSON.stringify({ ...comparison, unresolved: links.unresolved }, null, 2), '')
  } catch (error) { lines.push(`!! resolvedLinks probe failed: ${error.message}`, '') }
  for (const command of ['unresolved']) {
    try { lines.push(`## obsidian-cli ${command}`, String(await instance.cli(command)).trimEnd(), '') } catch (error) { lines.push(`## obsidian-cli ${command}`, `!! error: ${error.message}`, '') }
  }
  for (const note of manifest.notes.slice(0, maxNotes)) {
    for (const command of ['links', 'backlinks']) {
      try { lines.push(`## obsidian-cli ${command} file=${note.path}`, String(await instance.cli(command, `file=${note.path}`)).trimEnd(), '') } catch (error) { lines.push(`## obsidian-cli ${command} file=${note.path}`, `!! error: ${error.message}`, '') }
    }
  }
  const passed = index.met && comparison?.matches === true
  return { evidence: [{ role: 'cli-link-inspection', name: evidenceFileName('G07', 'cli-link-inspection'), bytes: text(lines.join('\n')) }], timings, comparison, passed }
}

export function diskMembership(vaultRoot) {
  return walkFiles(vaultRoot).map((file) => path.relative(vaultRoot, file).split(path.sep).join('/')).filter((relative) => relative.endsWith('.md') && !relative.startsWith('.obsidian/') && !relative.startsWith('.atelier-publication/')).sort()
}

export function compareMembership(actual, expected) {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  return { actual: actual.length, expected: expected.length, missing: expected.filter((item) => !actualSet.has(item)), unexpected: actual.filter((item) => !expectedSet.has(item)), matches: actual.length === expected.length && expected.every((item) => actualSet.has(item)) }
}

// One vault: on-disk membership against the manifest, then the app's index.
export async function runAp02Membership({ instance, label, vaultRoot, manifest, timeoutMs = INDEX_TIMEOUT_MS }) {
  const expected = manifest.notes.map((note) => note.path).sort()
  const disk = compareMembership(diskMembership(vaultRoot), expected)
  const index = await waitForIndex(instance, { timeoutMs })
  let app = { error: null, matches: false }
  try { app = { ...compareMembership(await evalJson(instance, PROBES.markdownFiles), expected), error: null } } catch (error) { app = { error: error.message, matches: false } }
  return { label, scopeId: manifest.scopeId, expected, disk, index: { met: index.met, elapsedMs: index.elapsedMs }, app, passed: disk.matches && index.met && app.matches }
}

export function ap02Evidence(memberships, focus) {
  const diskLines = ['# AP-02 on-disk membership', ...memberships.map((item) => `## ${item.label} (${item.scopeId})\n${JSON.stringify({ expected: item.expected, ...item.disk }, null, 2)}`)]
  const appLines = ['# AP-02 app index membership (app.vault.getMarkdownFiles)', ...memberships.map((item) => `## ${item.label} (${item.scopeId})\nindexReady: ${item.index.met} after ${item.index.elapsedMs} ms\n${JSON.stringify(item.app, null, 2)}`)]
  return [
    { role: 'on-disk-membership', name: evidenceFileName('G13', 'on-disk-membership'), bytes: text(diskLines.join('\n\n')) },
    { role: 'app-index-membership', name: evidenceFileName('G13', 'app-index-membership'), bytes: text(appLines.join('\n\n')) },
    { role: null, name: 'G13-focus-query.json', bytes: text(focus) },
  ]
}

export function focusRecord({ fullManifest, ids = SCOPED_IDS }) {
  const paths = fullManifest.notes.filter((note) => ids.includes(note.nodeId)).map((note) => note.path)
  const query = buildFocusQuery(paths)
  return { scopeId: 'view-focus-harbor', ids: [...ids], ...query, bookmark: focusBookmarkPayload({ scopeId: 'view-focus-harbor', query: query.query }) }
}

// AP-04 against the scale vault: usable-open and index timings from launch,
// then warm single-note changes published through the running instance with
// source-to-file and source-to-app measured independently from the same edit.
export async function runAp04App({ instance, launchedAtMs, scaleManifest, derive, warm = WARM_CHANGES, timeoutMs = INDEX_TIMEOUT_MS, appTimeoutMs = 60000, sampleAppRss = null, now = () => Date.now(), random = Math.random }) {
  const timings = { launchedAt: new Date(launchedAtMs).toISOString() }
  const layout = await waitUntil(async () => (await evalValue(instance, PROBES.layoutReady)) === 'true', { timeoutMs })
  timings.usableOpen = { met: layout.met, sinceLaunchMs: now() - launchedAtMs, waitMs: layout.elapsedMs, probe: 'app.workspace.layoutReady' }
  const index = await waitForIndex(instance, { timeoutMs })
  timings.appIndexing = { met: index.met, sinceLaunchMs: now() - launchedAtMs, waitMs: index.elapsedMs, probe: 'app.metadataCache.initialized' }
  timings.budget = PROPOSED_TARGETS.appUsableOpen
  timings.usability = { claimed: false, reason: 'usable-open and indexing are recorded against a budget that is set from G00 before G16 closes; nothing here claims the app is usable at this scale' }
  const appSamples = []
  const sampleApp = async (label) => { if (sampleAppRss) { try { appSamples.push({ label, atMs: now() - launchedAtMs, rssBytes: await sampleAppRss() }) } catch (error) { appSamples.push({ label, error: error.message }) } } }
  await sampleApp('after-index')
  const samples = []
  const notes = walkFiles(scaleManifest.workspaceDir).filter((file) => file.endsWith('.md'))
  for (let change = 0; change < warm; change += 1) {
    const source = notes[Math.floor(random() * notes.length)]
    const editedAt = new Date(now()).toISOString()
    const needle = `Warm app change ${change + 1} at ${editedAt}.`
    const started = now()
    fs.appendFileSync(source, `\n${needle}\n`)
    let sample = { change: change + 1, source: path.relative(scaleManifest.workspaceDir, source), editedAt, sourceToFileMs: null, sourceToAppMs: null, state: null, error: null }
    try {
      const result = await derive()
      const file = result.files.find((item) => item.kind === 'note' && fs.existsSync(path.join(result.store.vaultRoot, item.path)) && fs.readFileSync(path.join(result.store.vaultRoot, item.path), 'utf8').includes(needle))
      sample.state = result.state
      sample.mode = result.mode
      if (file) {
        sample.path = file.path
        sample.sourceToFileMs = now() - started
        const app = await waitUntil(async () => (await evalValue(instance, PROBES.readIncludes, { path: file.path, needle })) === 'true', { timeoutMs: appTimeoutMs, intervalMs: 100 })
        sample.sourceToAppMs = app.met ? now() - started : null
        sample.appProbe = { met: app.met, attempts: app.attempts, error: app.error }
      }
    } catch (error) { sample.error = error.message }
    samples.push(sample)
    if ((change + 1) % 10 === 0) await sampleApp(`after-change-${change + 1}`)
  }
  await sampleApp('end')
  const summary = warmChangeSummary(samples, { expectedSamples: warm })
  return { timings, samples, summary, appSamples, passed: layout.met && index.met && summary.complete && samples.every((sample) => sample.sourceToFileMs !== null && sample.sourceToAppMs !== null) }
}

export function ap04Evidence({ scaleManifest, run, derivationSamples }) {
  return [
    { role: 'dataset-manifest', name: evidenceFileName('G16', 'dataset-manifest', 'json'), bytes: text(scaleManifest) },
    { role: 'resource-samples', name: evidenceFileName('G16', 'resource-samples', 'json'), bytes: text({ hardware: hardwareProfile(), derivation: derivationSamples, app: run.appSamples }) },
    { role: 'app-indexing-timings', name: evidenceFileName('G16', 'app-indexing-timings', 'json'), bytes: text(run.timings) },
    { role: 'warm-update-latencies', name: evidenceFileName('G16', 'warm-update-latencies', 'json'), bytes: text({ summary: run.summary, samples: run.samples, coldDerivation: scaleManifest.derivation?.cold ?? null, warmWithoutApp: scaleManifest.derivation?.warm?.summary ?? null }) },
  ]
}

// ---------------------------------------------------------------------------
// Receipt assembly (pure apart from writing into receiptDir)
// ---------------------------------------------------------------------------

export function recordProcedureReceipts({ plan, receiptDir, candidate, capabilities, operator, host, evidenceByGate = {}, passedByGate = {}, timingsByGate = {}, wallClock, dataset = null, recordedAt = isoNow() }) {
  const written = []
  for (const gate of plan.gates) {
    const capabilityEvidence = { role: null, name: `${gate}-capabilities.json`, bytes: text(capabilities) }
    const evidence = [capabilityEvidence, ...(evidenceByGate[gate] ?? [])]
    const pending = plan.manualStepsRequired.filter((step) => step.gate === gate)
    const automatedPassed = passedByGate[gate]
    const outcome = automatedPassed === false || capabilities.qualified === false ? 'failed' : pending.length > 0 ? 'blocked' : 'passed'
    const notes = [capabilities.qualified === false ? 'Capability discovery did not qualify the installed app or CLI; unsupported capability is a failed qualification.' : 'Capability discovery qualified the installed app and CLI for this run.']
    if (pending.length > 0) notes.push(`${pending.length} manual step(s) remain; the receipt is incomplete until each role is attached and signed.`)
    written.push(writeGateReceipt({ receiptDir, gate, candidate, environment: environmentOf(capabilities), host, operator, evidence, recordedAt, outcome, wallClock, dataset, manualStepsRequired: plan.manualStepsRequired, capabilities, timings: timingsByGate[gate] ?? null, notes }))
  }
  return written
}

// ---------------------------------------------------------------------------
// Driver: the only code that starts the isolated app. Never runs on import.
// ---------------------------------------------------------------------------

function printPlan(plan) {
  console.log(`[desktop-receipts] ${plan.procedureId} ${plan.title}: gates ${plan.gates.join(', ')}; receipts under ${plan.receiptDir}; closes: false`)
  for (const [gate, roles] of Object.entries(plan.automatedRoles)) console.log(`  ${gate} automated roles: ${roles.length ? roles.join(', ') : '(none)'}`)
  for (const step of plan.manualStepsRequired) {
    console.log(`  ${step.gate} manual role ${step.role}:`)
    step.instructions.forEach((line, index) => console.log(`    ${index + 1}. ${line}`))
  }
}

async function runIsolated({ plan, args, candidate, operator, host, receiptDir }) {
  const { createLayout, Instance } = await import('../../experiments/obsidian-publication/lib/instance.mjs')
  // The CLI socket lives at <layout>/home/.obsidian-cli.sock and a Unix socket
  // path is limited to 104 bytes on macOS, so every instance gets its own short
  // root directly under the system temp directory, never a nested one.
  const shortLayout = (make) => {
    const layout = make()
    const socket = path.join(layout.home, '.obsidian-cli.sock')
    if (Buffer.byteLength(socket) > 100) throw new OutputRefusal(`isolated instance socket path is too long (${Buffer.byteLength(socket)} bytes): ${socket}`)
    return layout
  }
  const { createObsidianCliAdapter } = await import('../../src/projection/obsidian/publication/transport.mjs')
  const { execFile } = await import('node:child_process')
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-desktop-'))
  const startedAt = isoNow()
  const instances = []
  const launch = async (layout) => {
    const app = new Instance(layout)
    const launchedAtMs = Date.now()
    await app.launch()
    await assertIsolatedInstance(app)
    instances.push(app)
    return { app, launchedAtMs }
  }
  const appRss = (app) => () => new Promise((resolve, reject) => execFile('/bin/ps', ['-o', 'rss=', '-p', String(app.child.pid)], { encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(Number.parseInt(stdout.trim(), 10) * 1024))))
  try {
    const evidenceByGate = {}
    const passedByGate = {}
    const timingsByGate = {}
    let capabilities = null
    let dataset = null
    if (plan.app === 'small-fixture' || plan.app === 'small-fixture-full-and-scoped') {
      const workspaceDir = path.join(temp, 'workspace')
      const fixture = materializeFixtureWorkspace(workspaceDir, { scopes: plan.app === 'small-fixture' ? undefined : [{ scopeId: 'scope-full', mode: 'full', selector: { all: true } }, SCOPED_SCOPE] })
      const full = shortLayout(createLayout)
      const derived = await deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(temp, 'state-full'), vaultRoot: full.vault , withheld: fixture.withheldByEligibility, sentinels: fixture.sentinels })
      const { app, launchedAtMs } = await launch(full)
      capabilities = await discoverCapabilities(app)
      timingsByGate[plan.gates[0]] = { launchedAt: new Date(launchedAtMs).toISOString(), derivation: derived.timings }
      if (plan.app === 'small-fixture') {
        const run = await runAp01({ instance: app, manifest: derived.manifest })
        evidenceByGate.G07 = run.evidence
        passedByGate.G07 = run.passed
        timingsByGate.G07 = { ...timingsByGate.G07, ...run.timings, comparison: run.comparison }
      } else {
        const memberships = [await runAp02Membership({ instance: app, label: 'full', vaultRoot: full.vault, manifest: derived.manifest })]
        await app.quit()
        const scopedLayout = shortLayout(createLayout)
        const scoped = await deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(temp, 'state-scoped'), vaultRoot: scopedLayout.vault, scope: SCOPED_SCOPE , withheld: fixture.withheldByEligibility, sentinels: fixture.sentinels })
        const second = await launch(scopedLayout)
        memberships.push(await runAp02Membership({ instance: second.app, label: 'scoped', vaultRoot: scopedLayout.vault, manifest: scoped.manifest }))
        evidenceByGate.G13 = ap02Evidence(memberships, focusRecord({ fullManifest: derived.manifest }))
        passedByGate.G13 = memberships.every((item) => item.passed)
        timingsByGate.G13 = { ...timingsByGate.G13, memberships: memberships.map(({ label, index, disk, app: appIndex }) => ({ label, index, diskMatches: disk.matches, appMatches: appIndex.matches })) }
      }
      plan = planProcedure(plan.procedureId, { receiptDir, operator, isolatedHome: full.home, workspaceDir })
    } else if (plan.app === 'service-full' || plan.app === 'service-full-and-scoped') {
      // The owned service maintains the vault(s) the isolated app(s) open: every instance's private profile is bound to
      // the vault directory the engine publishes into, and the service runs with the isolated HOME so its editor
      // adapter can reach nothing but the isolated app. Each view is derived once before launch (no app yet), so the
      // app opens a populated vault and capability discovery has a note to open.
      const workspaceDir = path.join(temp, 'workspace')
      const dataRoot = path.join(temp, 'data')
      const scoped = plan.app === 'service-full-and-scoped'
      const fixture = scoped ? prepareAp05Workspace(workspaceDir) : materializeFixtureWorkspace(workspaceDir, { scopes: [FULL_SCOPE] })
      if (!scoped) initialiseRepositories(fixture.repositories.map((repoId) => path.join(workspaceDir, repoId)))
      const layouts = { full: shortLayout(createLayout), ...(scoped ? { scoped: shortLayout(createLayout) } : {}) }
      const env = { ...stripProjectEnv(process.env), HOME: layouts.full.home }
      const world = prepareWorkspace({ projectFile: fixture.projectFile, dataRoot, env })
      const scopeDocuments = scoped ? AP05_SCOPE_DOCUMENTS : [FULL_SCOPE]
      const derivations = {}
      const serviceSentinels = JSON.parse(fs.readFileSync(SERVICE_SENTINELS, 'utf8')).sentinels
      for (const scope of scopeDocuments) derivations[scope.scopeId] = (await deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: world.workspaceRoot, workspaceId: world.workspaceId, vaultRoot: world.vaultRootFor(scope.scopeId), scope, sentinels: serviceSentinels })).timings
      const bound = { full: bindLayoutToVault(layouts.full, world.vaultRootFor(AP05_SCOPES.full)), ...(scoped ? { scoped: bindLayoutToVault(layouts.scoped, world.vaultRootFor(AP05_SCOPES.scoped)) } : {}) }
      const full = await launch(bound.full)
      capabilities = await discoverCapabilities(full.app)
      const [{ createQualifiedAdapterFactory }, { createProductionAppProbe }, { createObsidianRegistry }, { createSourceApplyContribution }, { createProposalAdapterContribution }] = await Promise.all([
        import('../../src/runtime/obsidian/app-capability.mjs'), import('../../src/runtime/obsidian/app-production-seams.mjs'), import('../../src/runtime/obsidian/extension-points.mjs'),
        import('../../src/projection/obsidian/edits/contribution.mjs'), import('../../src/projection/obsidian/proposals/contribution.mjs'),
      ])
      const consent = { actor: operator, coverage: 'service' }
      // AP-03 runs the production service entry as a detached process (its kills and its exiting launcher need one).
      // AP-05 hosts the same service body in this process, because one service maintains two vaults held by two
      // isolated apps, each reached through its own private HOME: the vault selects the app.
      const runtime = scoped
        ? createInProcessServiceRuntime({
          loadProject: world.loadProject, dataRoot, env, consent, intervalMs: PROCEDURE_TICK_INTERVAL_MS, probeTimeoutMs: 5000,
          adapterFactory: createPerVaultAdapterFactory([{ vaultRoot: bound.full.vault, env }, { vaultRoot: bound.scoped.vault, env: { ...env, HOME: layouts.scoped.home } }], { createQualifiedAdapterFactory, createProductionAppProbe, createObsidianCliAdapter }),
          extensions: createObsidianRegistry({ contributions: [createSourceApplyContribution({ context: { loadProject: world.loadProject, dataRoot, env, platform: process.platform } }), createProposalAdapterContribution()] }).extensions,
        })
        : createServiceRuntime({ loadProject: world.loadProject, dataRoot, env, consent, intervalMs: PROCEDURE_TICK_INTERVAL_MS, probeTimeoutMs: 5000 })
      try {
        if (!scoped) {
          const appSeam = { openNote: (notePath) => full.app.stimulus('open', notePath), readIncludes: async ({ path: notePath, needle }) => (await evalValue(full.app, PROBES.readIncludes, { path: notePath, needle })) === 'true' }
          const adapterFactory = createQualifiedAdapterFactory({ appProbe: createProductionAppProbe({ env }), createAdapter: () => createObsidianCliAdapter({ env }) })
          const run = await runAp03({ world, runtime, app: appSeam, adapterFactory })
          evidenceByGate.G14 = run.evidence.filter((item) => item.name.startsWith('G14'))
          evidenceByGate.G15 = run.evidence.filter((item) => item.name.startsWith('G15'))
          passedByGate.G14 = run.passed
          passedByGate.G15 = run.passed
          timingsByGate.G14 = { launchedAt: new Date(full.launchedAtMs).toISOString(), derivation: derivations, ...run.timings, failures: run.failures }
          timingsByGate.G15 = { launchedAt: new Date(full.launchedAtMs).toISOString(), ...run.timings, failures: run.failures }
        } else {
          const second = await launch(bound.scoped)
          const command = await createCommandRunner({ projectFile: fixture.projectFile, dataRoot, env })
          const views = {
            full: { scopeId: AP05_SCOPES.full, editor: createAppEditor(full.app, { vaultRoot: bound.full.vault }) },
            scoped: { scopeId: AP05_SCOPES.scoped, editor: createAppEditor(second.app, { vaultRoot: bound.scoped.vault }) },
          }
          const run = await runAp05({ world, views, runtime, command, operator })
          evidenceByGate.G17 = run.evidence
          passedByGate.G17 = run.passed
          timingsByGate.G17 = { launchedAt: new Date(full.launchedAtMs).toISOString(), derivation: derivations, ...run.timings, failures: run.failures }
        }
      } finally {
        // The service is the disposable one this run started; its record names it, and only it is stopped.
        try { const status = await runtime.status(); if (status.state === 'healthy') await runtime.stop({ stopTimeoutMs: 20000 }) } catch { /* recorded in the service log */ }
        if (runtime.logLines) for (const gate of plan.gates) (evidenceByGate[gate] ??= []).push({ role: null, name: `${gate}-service-in-process.log`, bytes: Buffer.from(`${runtime.logLines.map((entry) => JSON.stringify(entry)).join('\n')}\n`) })
      }
      plan = planProcedure(plan.procedureId, { receiptDir, operator, isolatedHome: layouts.full.home, isolatedProfile: layouts.full.profile, workspaceDir, dataRoot })
    } else if (plan.app === 'scale-vault') {
      const manifestPath = path.join(args['scale-dir'], 'atelier-scale-dataset.json')
      if (!fs.existsSync(manifestPath)) throw new OutputRefusal('scale-dataset-missing', `no dataset manifest at ${manifestPath}; run generate-scale.mjs --out DIR --derive --warm 30 first`)
      const scaleManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (!scaleManifest.derivation) throw new OutputRefusal('scale-not-derived', 'the dataset has no cold derivation; run generate-scale.mjs with --derive first')
      const layout = createLayout(path.join(temp, 'instance-scale'), path.dirname(scaleManifest.derivation.vaultRoot))
      const { app, launchedAtMs } = await launch(layout)
      capabilities = await discoverCapabilities(app)
      const adapter = createObsidianCliAdapter({ env: app.env })
      const derive = () => deriveWorkspace({ projectFile: scaleManifest.projectFile, stateRoot: scaleManifest.derivation.stateRoot, vaultRoot: scaleManifest.derivation.vaultRoot, adapter })
      const run = await runAp04App({ instance: app, launchedAtMs, scaleManifest, derive, warm: Number.parseInt(args.warm ?? String(WARM_CHANGES), 10), sampleAppRss: appRss(app) })
      evidenceByGate.G16 = ap04Evidence({ scaleManifest, run, derivationSamples: scaleManifest.derivation.cold.samples })
      passedByGate.G16 = run.passed
      timingsByGate.G16 = { ...run.timings, warm: run.summary }
      dataset = { nodes: scaleManifest.counts.nodes, edges: scaleManifest.counts.edges, fixtureDigest: scaleManifest.fixtureDigest }
    }
    for (const app of instances) await app.quit()
    for (const app of instances) { const log = path.join(app.layout.root, 'app.log'); if (fs.existsSync(log)) for (const gate of plan.gates) (evidenceByGate[gate] ??= []).push({ role: null, name: `${gate}-app-${toIdentifier(path.basename(app.layout.root))}.log`, bytes: Buffer.concat([Buffer.from(`# app.log of ${app.layout.root}\n`), fs.readFileSync(log)]) }) }
    const wallClock = { startedAt, endedAt: isoNow() }
    return { written: recordProcedureReceipts({ plan, receiptDir, candidate, capabilities, operator, host, evidenceByGate, passedByGate, timingsByGate, wallClock, dataset }), plan }
  } finally {
    for (const app of instances) await app.quit().catch(() => {})
    if (!args.keep) {
      fs.rmSync(temp, { recursive: true, force: true })
      for (const app of instances) fs.rmSync(app.layout.root, { recursive: true, force: true })
    } else console.log(`[desktop-receipts] kept ${temp}${instances.map((app) => ` ${app.layout.root}`).join('')}`)
  }
}

async function main(argv) {
  const args = parseArgs(argv, { flags: ['run-isolated-app', 'keep', 'json', 'help'], values: ['procedure', 'receipt-dir', 'operator', 'scale-dir', 'warm'] })
  if (args.help || !args.procedure) {
    console.log('Usage: node scripts/obsidian/desktop-receipts.mjs --procedure AP-01|AP-02|AP-03|AP-04|AP-05|all [--receipt-dir DIR] [--operator ID] [--scale-dir DIR] [--warm N] [--keep] [--run-isolated-app]')
    return args.help ? 0 : 2
  }
  const procedures = args.procedure === 'all' ? PROCEDURE_IDS : [args.procedure]
  const receiptDir = assertExternalOutput(path.resolve(args['receipt-dir'] ?? DEFAULT_RECEIPT_DIR), { allowInsideRepository: [path.join(REPOSITORY_ROOT, '.artifacts')] })
  const operator = args.operator ? toIdentifier(args.operator) : null
  if (!args['run-isolated-app']) {
    for (const id of procedures) printPlan(planProcedure(id, { receiptDir, operator, scaleDir: args['scale-dir'] ?? null }))
    console.log('[desktop-receipts] plan only; add --run-isolated-app to start the disposable instance and record receipts')
    return 0
  }
  if (!operator) throw new OutputRefusal('usage', '--operator ID is required to record receipts')
  const candidate = candidateIdentity()
  const host = { ...hostIdentity(), hardware: hardwareProfile() }
  for (const id of procedures) {
    const plan = planProcedure(id, { receiptDir, operator, scaleDir: args['scale-dir'] ?? null })
    if (plan.requiresScaleDir && !args['scale-dir']) throw new OutputRefusal('usage', 'AP-04 needs --scale-dir DIR (a generate-scale.mjs output with --derive)')
    const { written, plan: filled } = await runIsolated({ plan, args, candidate, operator, host, receiptDir })
    for (const { receiptPath, receipt, validation } of written) {
      const desktop = receipt.ext['mnstry.atelier.obsidian.desktop-receipts']
      console.log(`[desktop-receipts] ${receipt.gate} ${receiptPath}: outcome ${receipt.outcome}, status ${desktop.status}, closes false, schemaValid ${validation.schemaValid}, missing ${validation.missing.map((item) => item.code).join(',') || 'none'}`)
      if (args.json) console.log(JSON.stringify(receipt, null, 2))
    }
    // With --keep the manual steps name the kept workspace, data root and instance; without it they keep their placeholders.
    printPlan(args.keep ? filled : planProcedure(id, { receiptDir, operator }))
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => { console.error(`[desktop-receipts] ${error?.message ?? error}`); process.exitCode = error instanceof OutputRefusal || error instanceof IsolationRefusal ? 2 : 1 })
}
