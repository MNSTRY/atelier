import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Inert state-method regression. No onload, sockets, app, plugin files or timers.
// An optional source path allows the same assertions to demonstrate the defect.
const sourcePath = process.argv[2] || fileURLToPath(new URL('../plugins/obsidian/main.js', import.meta.url))
const source = fs.readFileSync(sourcePath, 'utf8')
const checkedAt = '2026-01-01T00:00:00.000Z' // Explicit invented observation, never an execution timestamp.
const channelData = (changes = {}) => ({
  schema: 'atelier-obsidian-plugin-data/v1', scopeId: 'scope-invented-a',
  bearer: Buffer.alloc(32, 1).toString('base64url'), channel: { host: '127.0.0.1', port: 12345 }, ...changes,
})
function world() {
  const module = { exports: {} }
  const calls = { writes: 0, modules: [], notices: [] }
  class ClockNotAdmitted { constructor() { throw new Error('No invented wall clock') } static now() { throw new Error('No invented wall clock') } }
  const context = vm.createContext({ module, Date: ClockNotAdmitted, require(name) {
    calls.modules.push(name)
    assert.equal(name, 'obsidian', 'VM cannot load file, socket, timer or native modules')
    return { Plugin: class {}, Modal: class {}, Notice: class { constructor(text) { calls.notices.push(text) } } }
  } })
  vm.runInContext(source, context, { filename: sourcePath, timeout: 1000 })
  const plugin = new module.exports()
  plugin.statusBarEl = { setText() {}, setAttr() {} }
  plugin.shownState = null
  plugin.manifest = { version: 'synthetic' }
  plugin.appVersion = 'synthetic'
  const data = channelData()
  plugin.channel = { ...data.channel, scopeId: data.scopeId, bearer: data.bearer }
  plugin.view = { state: 'connecting', reason: 'not-yet-asked', report: null }
  plugin.saveData = () => { calls.writes += 1; throw new Error('Plugin writes forbidden') }
  return { plugin, calls, context }
}
function observed(plugin, { state = 'stale', reason = 'canonical-graph-invalid', generation = 'gen-invented-a', time = checkedAt, scopeId = plugin.channel.scopeId } = {}) {
  const report = { schema: 'atelier-obsidian-plugin-status/v1', scopeId, service: { status: 'healthy' }, pendingEdits: { open: 3 }, view: {
    state, reason, verified: state === 'current', generationId: generation, preparedGenerationId: generation, checkedAt: time, heldNoteCount: 2, retainedEdits: 1,
  } }
  const shown = state === 'held-for-your-edit' ? 'held' : state === 'disabled' ? 'stale' : state
  plugin.setView({ state: shown, reason, report })
  return report
}
const rows = (plugin) => Object.fromEntries(plugin.statusRows())
const disconnect = (plugin, code = 'refused') => plugin.showRound(plugin.unreachable({ kind: 'unreachable', code }))
const noHistory = (plugin) => {
  const shown = rows(plugin)
  assert.equal(shown['Last observed generation'], undefined)
  assert.equal(shown['Last observed reason'], undefined)
  assert.equal(shown.Generation, 'none yet')
  assert.equal(plugin.view.report, null)
}

test('stale disconnect retains only explicitly historical scope-bound cause, generation and check', () => {
  const { plugin } = world(); observed(plugin); disconnect(plugin)
  const shown = rows(plugin)
  assert.equal(shown.State, 'service unreachable'); assert.equal(shown.Reason, 'refused')
  assert.equal(plugin.view.report, null)
  assert.equal(shown.Generation, 'none yet'); assert.equal(shown['Checked at'], 'not yet')
  assert.equal(shown['Last observed state'], 'stale'); assert.equal(shown['Last observed reason'], 'canonical graph invalid')
  assert.equal(shown['Last observed generation'], 'gen-invented-a'); assert.equal(shown['Last observed check'], checkedAt)
  assert.equal(shown['Held edits'], 'unknown'); assert.equal(shown['Pending edits'], 'unknown')
  assert.equal(shown.Service, '127.0.0.1:12345, no answer')
})
test('a previously current report is historical on disconnect and never grants current validity', () => {
  const { plugin } = world(); observed(plugin, { state: 'current', reason: 'published-and-verified' }); disconnect(plugin)
  assert.equal(rows(plugin).State, 'service unreachable'); assert.equal(rows(plugin)['Last observed state'], 'current')
  assert.equal(plugin.view.report, null); assert.equal(rows(plugin).Generation, 'none yet')
})
test('repeated transport interruptions do not invent a newer check or replace the stale cause', () => {
  const { plugin } = world(); observed(plugin); disconnect(plugin); disconnect(plugin, 'timeout')
  assert.equal(rows(plugin).Reason, 'timeout'); assert.equal(rows(plugin)['Last observed check'], checkedAt)
  assert.equal(rows(plugin)['Last observed reason'], 'canonical graph invalid')
})
test('a fresh report restores normal rows and replaces earlier history on the next disconnect', () => {
  const { plugin } = world(); observed(plugin); disconnect(plugin)
  observed(plugin, { state: 'current', reason: 'published-and-verified', generation: 'gen-invented-b', time: '2026-01-01T01:00:00.000Z' })
  assert.equal(rows(plugin).State, 'current'); assert.equal(rows(plugin).Generation, 'gen-invented-b')
  assert.equal(rows(plugin)['Last observed generation'], undefined)
  disconnect(plugin); assert.equal(rows(plugin)['Last observed generation'], 'gen-invented-b')
  assert.equal(rows(plugin)['Last observed reason'], 'published and verified')
})
test('cold instance or no observed report leaves history unavailable', () => {
  const { plugin } = world(); disconnect(plugin); noHistory(plugin)
  assert.equal(rows(plugin)['Last observed status'], 'not available')
  const cold = world().plugin; disconnect(cold); noHistory(cold)
})
test('unchanged channel data re-read keeps the exact history binding without a socket', async () => {
  const { plugin } = world(); observed(plugin); disconnect(plugin)
  plugin.loadData = async () => channelData(); await plugin.readChannel()
  assert.equal(rows(plugin)['Last observed generation'], 'gen-invented-a')
})
for (const [name, changes] of [
  ['scope', { scopeId: 'scope-invented-b' }],
  ['key', { bearer: Buffer.alloc(32, 2).toString('base64url') }],
  ['port', { channel: { host: '127.0.0.1', port: 12346 } }],
  ['host', { channel: { host: '::1', port: 12345 } }],
]) test(`${name} change clears both old current display and history before another round`, async () => {
  const { plugin } = world(); observed(plugin); plugin.loadData = async () => channelData(changes); await plugin.readChannel()
  assert.equal(rows(plugin).State, 'connecting'); assert.equal(rows(plugin).Generation, 'none yet')
  disconnect(plugin); noHistory(plugin)
})
test('missing channel/setup clears history and remains not set up', async () => {
  const { plugin } = world(); observed(plugin); plugin.loadData = async () => null; await plugin.readChannel()
  assert.equal(rows(plugin).State, 'not set up'); assert.equal(plugin.lastObservedStatus, null)
})
test('an authenticated report with no view replaces history with unknown', () => {
  const { plugin } = world(); observed(plugin)
  plugin.setView({ state: 'stale', reason: 'no-freshness-recorded', report: { schema: 'atelier-obsidian-plugin-status/v1', scopeId: plugin.channel.scopeId, view: null } })
  disconnect(plugin); noHistory(plugin)
})
test('mismatched report scope cannot become historical evidence for this channel', () => {
  const { plugin } = world(); observed(plugin); observed(plugin, { scopeId: 'scope-invented-b' }); disconnect(plugin); noHistory(plugin)
})
test('unknown authenticated historical fields stay unknown rather than using local time', () => {
  const { plugin } = world(); observed(plugin, { generation: null, time: null }); disconnect(plugin)
  assert.equal(rows(plugin)['Last observed generation'], 'none yet'); assert.equal(rows(plugin)['Last observed check'], 'not yet')
})
for (const code of ['answer-not-authenticated', 'answer-too-large', 'listener-not-proven', 'request-failed', 'answer-failed']) test(`${code} is not a transport outage and cannot reuse history`, () => {
  const { plugin } = world(); observed(plugin); plugin.showRound(plugin.unreachable({ kind: 'unreachable', code })); noHistory(plugin)
})
for (const statusCode of [401, 403, 409, 503]) test(`unsealed HTTP ${statusCode} refusal cannot reuse history`, () => {
  const { plugin } = world(); observed(plugin)
  const answer = plugin.opened({ kind: 'response', statusCode, body: { error: 'synthetic-refusal' } }, 'status', {}, 1)
  plugin.showRound(plugin.unreachable(answer)); noHistory(plugin)
})
test('malformed status answer becomes authentication-unknown and clears history', () => {
  const { plugin } = world(); observed(plugin)
  const answer = plugin.opened({ kind: 'response', statusCode: 200, body: {} }, 'status', { id: 'synthetic-session' }, 1)
  assert.equal(answer.code, 'answer-not-authenticated'); plugin.showRound(plugin.unreachable(answer)); noHistory(plugin)
})
for (const reason of ['key-not-known-to-the-service', 'not-the-vault-atelier-maintains']) test(`${reason} clears history before setup-label hysteresis resolves`, () => {
  const { plugin } = world(); observed(plugin); disconnect(plugin)
  plugin.showRound({ state: 'not-set-up', reason, report: null })
  assert.equal(rows(plugin).State, 'service unreachable'); noHistory(plugin)
  plugin.showRound({ state: 'not-set-up', reason, report: null }); assert.equal(rows(plugin).State, 'not set up')
})
test('sealed disabled-in-settings is a known disablement and cannot become retained history', () => {
  const { plugin } = world(); observed(plugin); observed(plugin, { state: 'disabled', reason: 'disabled-in-settings' }); disconnect(plugin); noHistory(plugin)
})
test('unsupported setup and unload remove the transient history', () => {
  const { plugin } = world(); observed(plugin); plugin.setView({ state: 'unsupported', reason: 'app-below-minimum-version', report: null })
  assert.equal(plugin.lastObservedStatus, null)
  observed(plugin); plugin.onunload(); assert.equal(plugin.lastObservedStatus, null)
})
test('stored fields are a snapshot; no old service health, counts, content or serialized key is retained', () => {
  const { plugin, calls } = world(); const report = observed(plugin); report.view.generationId = 'gen-mutated'; report.view.checkedAt = 'not-a-time'; disconnect(plugin)
  assert.equal(rows(plugin)['Last observed generation'], 'gen-invented-a'); assert.equal(rows(plugin)['Last observed check'], checkedAt)
  assert.deepEqual(Object.keys(plugin.lastObservedStatus).sort(), ['channel', 'checkedAt', 'generationId', 'reason', 'state'])
  assert.equal(plugin.lastObservedStatus.channel, plugin.channel, 'only an existing private in-memory channel reference; never serialized')
  assert.equal(calls.writes, 0); assert.deepEqual(calls.modules, ['obsidian'])
})
