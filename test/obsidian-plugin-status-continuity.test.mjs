import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { pluginClientProof, pluginKeyHint, pluginRequestMac, pluginResponseMac, pluginServerProof, pluginSessionKey, pluginVaultProof } from '../src/projection/obsidian/plugin-bridge/channel.mjs'

// Inert state, startup and request-flow regression. No real app, sockets, plugin writes or timers.
// ATELIER_PLUGIN_SOURCE_UNDER_TEST may name another plugin source, so the same assertions can
// demonstrate the defect. The runner's arguments never choose the source.
const sourcePath = process.env.ATELIER_PLUGIN_SOURCE_UNDER_TEST || fileURLToPath(new URL('../plugins/obsidian/main.js', import.meta.url))
const source = fs.readFileSync(sourcePath, 'utf8')
const checkedAt = '2026-01-01T00:00:00.000Z' // Explicit invented observation, never an execution timestamp.
const channelData = (changes = {}) => ({
  schema: 'atelier-obsidian-plugin-data/v1', scopeId: 'scope-invented-a',
  bearer: Buffer.alloc(32, 1).toString('base64url'), channel: { host: '127.0.0.1', port: 12345 }, ...changes,
})
function world({ requestFlow = false, apiVersion = '1.13.7', unavailableModules = false } = {}) {
  const module = { exports: {} }
  const calls = { writes: 0, modules: [], notices: [], requests: [], intervals: 0, dataReads: 0 }
  class ClockNotAdmitted { constructor() { throw new Error('No invented wall clock') } static now() { throw new Error('No invented wall clock') } }
  class InventedClock { static now() { return 1_000_000 } }
  const statusBarEl = { setText() {}, setAttr() {}, addClass() {} }
  class PluginStandIn {
    addStatusBarItem() { return statusBarEl }
    registerDomEvent() {}
    addCommand() {}
    registerInterval() { throw new Error('No interval admitted') }
  }
  const context = vm.createContext({ module, TextEncoder, Date: requestFlow ? InventedClock : ClockNotAdmitted,
    setInterval() { calls.intervals += 1; throw new Error('No timer admitted') }, require(name) {
    calls.modules.push(name)
    if (unavailableModules && name !== 'obsidian') throw new Error('No Node module available in this invented host')
    assert.equal(name, 'obsidian', 'VM cannot load file, socket, timer or native modules')
    return { apiVersion, Plugin: PluginStandIn, Modal: class {}, Notice: class { constructor(text) { calls.notices.push(text) } } }
  } })
  vm.runInContext(source, context, { filename: sourcePath, timeout: 1000 })
  const plugin = new module.exports()
  plugin.statusBarEl = { setText() {}, setAttr() {} }
  plugin.shownState = null
  plugin.noticeState = null
  plugin.session = null
  plugin.cycling = null
  plugin.unloaded = false
  plugin.channelAdmitted = true // State/request fixtures represent an already admitted launch.
  plugin.lastObservedStatus = null
  plugin.manifest = { version: 'synthetic' }
  plugin.appVersion = '1.13.7'
  const data = channelData()
  plugin.channel = { ...data.channel, scopeId: data.scopeId, bearer: data.bearer }
  plugin.view = { state: 'connecting', reason: 'not-yet-asked', report: null }
  plugin.saveData = () => { calls.writes += 1; throw new Error('Plugin writes forbidden') }
  // A request made where no request flow is admitted is recorded and refused.
  plugin.http = { request() { calls.requests.push('forbidden'); throw new Error('No socket admitted') } }
  return { plugin, calls, context }
}
function reportOf(plugin, { state = 'stale', reason = 'canonical-graph-invalid', generation = 'gen-invented-a', time = checkedAt, scopeId = plugin.channel.scopeId } = {}) {
  return { schema: 'atelier-obsidian-plugin-status/v1', scopeId, service: { status: 'healthy' }, pendingEdits: { open: 3 }, view: {
    state, reason, verified: state === 'current', generationId: generation, preparedGenerationId: generation, checkedAt: time, heldNoteCount: 2, retainedEdits: 1,
  } }
}
function observed(plugin, options = {}) {
  const report = reportOf(plugin, options)
  const { state, reason } = report.view
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
  assert.equal(shown.Generation, plugin.view.state === 'unreachable' ? 'unknown' : 'none yet')
  assert.equal(plugin.view.report, null)
}

// The production post(), handshake(), opened(), request() and runCycle() use
// this finite stand-in for http.request. Every response is queued explicitly;
// canonical channel computations seal it. No listener, clock, file or timer
// is opened. The only clock value and cryptographic bytes here are invented.
function requestWorld(steps) {
  const state = world({ requestFlow: true })
  const { plugin, calls } = state
  const remaining = [...steps]
  const pending = []
  calls.requests = []
  calls.destroyed = 0
  let nonce = 0
  let bound = null
  let sessionKey = null
  let sessionId = null
  const vaultPath = ['', 'invented', 'vault'].join('/')
  plugin.app = { vault: { adapter: { getBasePath: () => vaultPath } } }
  plugin.fs = { realpathSync: (value) => { assert.equal(value, vaultPath); return value } }
  plugin.crypto = { createHmac, randomBytes: (size) => Buffer.alloc(size, ++nonce) }
  plugin.instanceId = `pi-${'1'.repeat(32)}`
  plugin.setView(plugin.view)
  plugin.http = { request(options, callback) {
    const request = new EventEmitter()
    request.destroy = () => { calls.destroyed += 1 }
    request.end = (text) => {
      const step = remaining.shift()
      assert.ok(step, 'every request must have an explicitly admitted response')
      assert.equal(options.path, `/plugin/${step.command}`)
      assert.equal(options.method, 'POST')
      assert.equal(options.agent, false)
      assert.ok(['127.0.0.1', '::1'].includes(options.host))
      const body = JSON.parse(text)
      calls.requests.push({ command: step.command, body })
      let responseBody = step.body
      if (step.command === 'challenge') {
        bound = { bearer: plugin.channel.bearer, scopeId: plugin.channel.scopeId, authority: options.headers.Host,
          clientNonce: body.clientNonce, serverNonce: '2'.repeat(64), handshakeId: `ph-${'3'.repeat(32)}` }
        assert.equal(body.keyHint, pluginKeyHint({ ...bound, issuedAt: body.issuedAt }))
        assert.equal(body.issuedAt, 1_000_000)
        sessionKey = pluginSessionKey(bound)
        sessionId = `ps-${'4'.repeat(32)}`
        responseBody ??= { protocol: plugin.constructor.channel.protocol, handshakeId: bound.handshakeId,
          serverNonce: bound.serverNonce, serverProof: step.badProof ? '0'.repeat(64) : pluginServerProof(bound) }
      } else if (step.command === 'hello') {
        assert.equal(body.vaultProof, pluginVaultProof({ sessionKey, vaultPath }))
        assert.equal(body.clientProof, pluginClientProof({ ...bound, ...body }))
      } else {
        assert.equal(body.mac, pluginRequestMac({ sessionKey, command: step.command, sessionId, counter: body.counter }))
      }
      if (step.command !== 'challenge' && !step.transport && !step.httpStatus && responseBody === undefined) {
        const document = step.command === 'hello' ? { sessionId } : step.command === 'status' ? (step.report || reportOf(plugin)) : { ok: true }
        const payload = JSON.stringify(document)
        responseBody = { payload, mac: step.badMac ? '0'.repeat(64) : pluginResponseMac({ sessionKey, command: step.command, sessionId,
          counter: step.command === 'hello' ? 0 : body.counter, payload }) }
      }
      const deliver = () => {
        if (step.transport === 'timeout') { request.emit('timeout'); return }
        if (step.transport) { request.emit('error', { code: step.transport === 'refused' ? 'ECONNREFUSED' : 'ECONNRESET' }); return }
        const response = new EventEmitter()
        response.statusCode = step.httpStatus || 200
        response.setEncoding = () => {}
        callback(response)
        response.emit('data', JSON.stringify(responseBody ?? { error: step.error || 'invented-refusal' }))
        response.emit('end')
      }
      if (step.hold) pending.push(deliver)
      else queueMicrotask(deliver)
    }
    return request
  } }
  return { ...state, respond() { assert.ok(pending.length); pending.shift()() }, done() {
    assert.equal(remaining.length, 0); assert.equal(pending.length, 0)
    assert.equal(calls.writes, 0); assert.deepEqual(calls.modules, ['obsidian'])
  } }
}
const firstRound = (status = {}) => [{ command: 'challenge' }, { command: 'hello' }, { command: 'status', ...status }]
async function flushUntil(check) {
  for (let count = 0; count < 50 && !check(); count += 1) await Promise.resolve()
  assert.ok(check(), 'the explicitly queued callback must complete within a finite microtask budget')
}

for (const [name, options, expectedState, expectedReason, expectedModules] of [
  ['below-floor app', { apiVersion: '1.13.6' }, 'unsupported', 'app-below-minimum-version', ['obsidian']],
  ['unreadable app version', { apiVersion: null }, 'unsupported', 'app-below-minimum-version', ['obsidian']],
  ['unavailable Node modules', { unavailableModules: true }, 'not-set-up', 'node-modules-unavailable', ['obsidian', 'http']],
]) test(`production startup with ${name} keeps its label and channel closed after republish`, async () => {
  const { plugin, calls } = world(options)
  plugin.loadData = async () => { calls.dataReads += 1; return channelData() }
  await plugin.onload()
  assert.equal(plugin.view.state, expectedState); assert.equal(plugin.view.reason, expectedReason)
  const notices = calls.notices.length
  await assert.doesNotReject(() => plugin.onExternalSettingsChange())
  await plugin.readChannel(); await plugin.cycle()
  assert.equal(plugin.view.state, expectedState); assert.equal(plugin.view.reason, expectedReason)
  assert.equal(plugin.channel, null); assert.equal(plugin.session, null)
  assert.equal(calls.dataReads, 0); assert.equal(calls.intervals, 0); assert.equal(calls.requests.length, 0)
  assert.equal(calls.writes, 0); assert.equal(calls.notices.length, notices)
  assert.deepEqual(calls.modules, expectedModules)
})

test('production settings callback and direct cycle stay closed after unload', async () => {
  const { plugin, calls } = world(); observed(plugin)
  plugin.loadData = async () => { calls.dataReads += 1; return channelData() }
  plugin.onunload()
  const shown = plugin.view
  await plugin.onExternalSettingsChange(); await plugin.readChannel(); await plugin.cycle()
  assert.equal(plugin.view, shown); assert.equal(plugin.lastObservedStatus, null)
  assert.equal(calls.dataReads, 0); assert.equal(calls.intervals, 0); assert.equal(calls.requests.length, 0)
  assert.deepEqual(calls.modules, ['obsidian'])
})

test('production channel data read completing after unload cannot replace the channel or history', async () => {
  const { plugin, calls } = world(); observed(plugin)
  const channel = plugin.channel; const shown = plugin.view; const notices = calls.notices.length
  let complete
  plugin.loadData = () => new Promise((resolve) => { complete = resolve })
  const callback = plugin.onExternalSettingsChange()
  assert.equal(typeof complete, 'function')
  plugin.onunload(); complete(channelData({ scopeId: 'scope-invented-b' })); await callback
  assert.equal(plugin.channel, channel); assert.equal(plugin.view, shown); assert.equal(plugin.lastObservedStatus, null)
  assert.equal(calls.notices.length, notices); assert.equal(calls.intervals, 0); assert.equal(calls.requests.length, 0)
  assert.deepEqual(calls.modules, ['obsidian'])
})

test('stale disconnect retains only explicitly historical scope-bound cause, generation and check', () => {
  const { plugin } = world(); observed(plugin); disconnect(plugin)
  const shown = rows(plugin)
  assert.equal(shown.State, 'service unreachable'); assert.equal(shown.Reason, 'refused')
  assert.equal(plugin.view.report, null)
  assert.equal(shown.Generation, 'unknown'); assert.equal(shown['Prepared generation'], 'unknown'); assert.equal(shown['Checked at'], 'unknown')
  assert.equal(shown['Last observed state'], 'stale'); assert.equal(shown['Last observed reason'], 'canonical graph invalid')
  assert.equal(shown['Last observed generation'], 'gen-invented-a'); assert.equal(shown['Last observed check'], checkedAt)
  assert.equal(shown['Held edits'], 'unknown'); assert.equal(shown['Pending edits'], 'unknown')
  assert.equal(shown.Service, '127.0.0.1:12345, no answer')
})
test('a previously current report is historical on disconnect and never grants current validity', () => {
  const { plugin } = world(); observed(plugin, { state: 'current', reason: 'published-and-verified' }); disconnect(plugin)
  assert.equal(rows(plugin).State, 'service unreachable'); assert.equal(rows(plugin)['Last observed state'], 'current')
  assert.equal(plugin.view.report, null); assert.equal(rows(plugin).Generation, 'unknown')
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

for (const transport of ['refused', 'timeout']) test(`production round retains authenticated history after a ${transport} lease interruption`, async () => {
  const state = requestWorld([...firstRound(), { command: 'lease', transport }])
  await state.plugin.cycle(); await state.plugin.cycle()
  const shown = rows(state.plugin)
  assert.equal(shown.State, 'service unreachable'); assert.equal(shown.Reason, transport)
  assert.equal(shown['Last observed reason'], 'canonical graph invalid')
  assert.equal(shown['Last observed generation'], 'gen-invented-a'); assert.equal(shown['Last observed check'], checkedAt)
  for (const label of ['Generation', 'Prepared generation', 'Checked at', 'Held edits', 'Retained edits', 'Pending edits']) assert.equal(shown[label], 'unknown')
  assert.equal(state.plugin.session, null); state.done()
})
for (const transport of ['refused', 'timeout']) test(`production status ${transport} interruption retains the last authenticated report`, async () => {
  const state = requestWorld([...firstRound(), { command: 'lease' }, { command: 'status', transport }])
  await state.plugin.cycle(); await state.plugin.cycle()
  assert.equal(rows(state.plugin)['Last observed generation'], 'gen-invented-a')
  assert.equal(rows(state.plugin).Reason, transport); state.done()
})
for (const refusal of [{ httpStatus: 401, error: 'invented-refusal' }, { httpStatus: 409, error: 'session-unknown' }]) {
  for (const command of ['challenge', 'hello']) for (const transport of ['refused', 'timeout']) {
    test(`production lease ${refusal.httpStatus} ${refusal.error} clears history before ${command} ${transport}`, async () => {
      const retry = command === 'challenge' ? [{ command, transport }] : [{ command: 'challenge' }, { command, transport }]
      const state = requestWorld([...firstRound(), { command: 'lease', ...refusal }, ...retry])
      await state.plugin.cycle(); await state.plugin.cycle()
      assert.equal(rows(state.plugin).Reason, transport); noHistory(state.plugin)
      assert.equal(rows(state.plugin)['Last observed status'], 'not available'); state.done()
    })
  }
}
test('production failed listener proof clears history without sending a hello', async () => {
  const state = requestWorld([...firstRound(), { command: 'lease', transport: 'refused' }, { command: 'challenge', badProof: true }])
  await state.plugin.cycle(); await state.plugin.cycle(); await state.plugin.cycle()
  assert.equal(rows(state.plugin).Reason, 'listener not proven'); noHistory(state.plugin)
  assert.deepEqual(state.calls.requests.map(({ command }) => command), ['challenge', 'hello', 'status', 'lease', 'challenge']); state.done()
})
for (const response of [{ badMac: true }, { body: {} }, { httpStatus: 403 }, { transport: 'reset' }]) test(`production untrusted status ${JSON.stringify(response)} clears history`, async () => {
  const state = requestWorld([...firstRound(), { command: 'lease' }, { command: 'status', ...response }])
  await state.plugin.cycle(); await state.plugin.cycle(); noHistory(state.plugin); state.done()
})
for (const reportChange of [{ view: null }, { scopeId: 'scope-invented-b' }, { view: { state: 'disabled', reason: 'disabled-in-settings' } }]) {
  test(`production sealed status ${JSON.stringify(reportChange)} cannot supply retained history`, async () => {
    const steps = [...firstRound(), { command: 'lease' }, { command: 'status' }, { command: 'lease', transport: 'refused' }]
    const state = requestWorld(steps)
    steps[4].report = { ...reportOf(state.plugin), ...reportChange }
    await state.plugin.cycle(); await state.plugin.cycle(); await state.plugin.cycle()
    noHistory(state.plugin); state.done()
  })
}
test('production held status maps the service state and reports recovery through notices', async () => {
  const steps = [...firstRound(), { command: 'lease' }, { command: 'status' }]
  const state = requestWorld(steps)
  steps[2].report = reportOf(state.plugin, { state: 'held-for-your-edit', reason: 'edits-held' })
  steps[4].report = reportOf(state.plugin, { state: 'current', reason: 'published-and-verified' })
  await state.plugin.cycle()
  assert.equal(rows(state.plugin).State, 'held (2)'); assert.equal(state.calls.notices.length, 1)
  await state.plugin.cycle()
  assert.equal(rows(state.plugin).State, 'current'); assert.equal(state.calls.notices.at(-1), 'Atelier: this view is current again.')
  state.done()
})
for (const stateName of ['held-for-your-edit', 'stale', 'unreachable']) test(`production channel republish does not repeat a ${stateName} notice`, async () => {
  const initial = stateName === 'unreachable' ? { transport: 'refused' } : {}
  const retry = stateName === 'unreachable' ? [{ command: 'challenge', transport: 'refused' }] : firstRound()
  const steps = [...firstRound(initial), ...retry]
  const state = requestWorld(steps)
  if (stateName !== 'unreachable') {
    steps[2].report = reportOf(state.plugin, { state: stateName })
    steps[5].report = steps[2].report
  }
  await state.plugin.cycle()
  assert.equal(state.calls.notices.length, 1)
  state.plugin.loadData = async () => channelData({ bearer: Buffer.alloc(32, 2).toString('base64url') })
  await state.plugin.onExternalSettingsChange()
  assert.equal(state.calls.notices.length, 1); state.done()
})
test('production channel republish preserves the current-again notice after an attention state', async () => {
  const steps = [...firstRound(), ...firstRound()]
  const state = requestWorld(steps)
  steps[5].report = reportOf(state.plugin, { state: 'current', reason: 'published-and-verified', generation: 'gen-invented-b' })
  await state.plugin.cycle()
  state.plugin.loadData = async () => channelData({ channel: { host: '127.0.0.1', port: 12346 } })
  await state.plugin.onExternalSettingsChange()
  assert.equal(rows(state.plugin).Generation, 'gen-invented-b')
  assert.equal(state.calls.notices.at(-1), 'Atelier: this view is current again.'); state.done()
})
test('production unchanged data callback preserves history through a transport interruption', async () => {
  const state = requestWorld([...firstRound(), { command: 'lease', transport: 'timeout' }])
  await state.plugin.cycle()
  state.plugin.loadData = async () => channelData()
  await state.plugin.onExternalSettingsChange()
  assert.equal(rows(state.plugin)['Last observed generation'], 'gen-invented-a'); state.done()
})
test('production late old-channel status cannot restore history after the settings callback', async () => {
  const steps = [...firstRound(), { command: 'lease' }, { command: 'status', hold: true }, { command: 'challenge', transport: 'timeout' }]
  const state = requestWorld(steps)
  await state.plugin.cycle()
  const oldRound = state.plugin.cycle()
  await flushUntil(() => state.calls.requests.length === 5)
  state.plugin.loadData = async () => channelData({ scopeId: 'scope-invented-b' })
  const changed = state.plugin.onExternalSettingsChange()
  await flushUntil(() => state.plugin.channel.scopeId === 'scope-invented-b')
  assert.equal(state.plugin.channel.scopeId, 'scope-invented-b')
  assert.equal(rows(state.plugin).State, 'connecting'); assert.equal(state.plugin.lastObservedStatus, null)
  state.respond(); await oldRound; await changed
  noHistory(state.plugin); state.done()
})
test('production late old hello releases its session after a channel reset without restoring history', async () => {
  const steps = [{ command: 'challenge' }, { command: 'hello', hold: true }, { command: 'release' }]
  const state = requestWorld(steps)
  const round = state.plugin.cycle()
  await flushUntil(() => state.calls.requests.length === 2)
  state.plugin.loadData = async () => channelData({ scopeId: 'scope-invented-b' })
  await state.plugin.readChannel(); state.respond(); await round; await Promise.resolve()
  assert.equal(state.plugin.session, null); assert.equal(state.plugin.lastObservedStatus, null)
  assert.equal(rows(state.plugin).State, 'connecting'); state.done()
})
test('production late status after unload cannot create new history or notices', async () => {
  const state = requestWorld([...firstRound(), { command: 'lease' }, { command: 'status', hold: true }, { command: 'release' }])
  await state.plugin.cycle()
  assert.equal(state.plugin.lastObservedStatus.generationId, 'gen-invented-a')
  const notices = state.calls.notices.length
  const round = state.plugin.cycle()
  await flushUntil(() => state.calls.requests.length === 5)
  state.plugin.onunload(); assert.equal(state.plugin.lastObservedStatus, null)
  state.respond(); await round; await Promise.resolve()
  assert.equal(state.plugin.lastObservedStatus, null); assert.equal(state.calls.notices.length, notices); state.done()
})

// The sole ledger stays RELEASED_PLUGIN_CODE in test/obsidian-plugin.test.mjs. It is
// read as text and parsed as strict literal data; that module is never imported or run.
const LEDGER_SOURCE = fileURLToPath(new URL('./obsidian-plugin.test.mjs', import.meta.url))
const PLUGIN_DIRECTORY = fileURLToPath(new URL('../plugins/obsidian/', import.meta.url))
const LEDGER_OPEN = 'const RELEASED_PLUGIN_CODE = Object.freeze({'
const LEDGER_ENTRY = /^ {2}'(\d+\.\d+\.\d+)': 'sha256:([0-9a-f]{64})',$/u

function releasedPluginCode() {
  // The ledger file is not byte-pinned, so a checkout may give it CRLF line endings.
  const source = fs.readFileSync(LEDGER_SOURCE, 'utf8').replace(/\r\n/gu, '\n')
  assert.equal(source.includes('\r'), false, 'the plugin ledger must not contain a bare carriage return')
  const lines = source.split('\n')
  assert.equal((source.match(/RELEASED_PLUGIN_CODE\s*=/gu) || []).length, 1, 'exactly one RELEASED_PLUGIN_CODE table')
  const declarations = lines.filter((line) => /RELEASED_PLUGIN_CODE\s*=/u.test(line))
  assert.deepEqual(declarations, [LEDGER_OPEN], 'exactly one RELEASED_PLUGIN_CODE table')
  const open = lines.indexOf(LEDGER_OPEN)
  const close = lines.indexOf('})', open + 1)
  assert.ok(close > open + 1, 'RELEASED_PLUGIN_CODE has entries and a closing line')
  const table = new Map()
  for (const line of lines.slice(open + 1, close)) {
    const entry = line.match(LEDGER_ENTRY)
    assert.ok(entry, `malformed RELEASED_PLUGIN_CODE entry: ${JSON.stringify(line)}`)
    assert.equal(table.has(entry[1]), false, `duplicate RELEASED_PLUGIN_CODE version ${entry[1]}`)
    table.set(entry[1], `sha256:${entry[2]}`)
  }
  return table
}

test('the shipped plugin code matches its released digest', () => {
  const hash = createHash('sha256')
  for (const name of ['main.js', 'styles.css']) {
    hash.update(`${name}\u0000`)
    hash.update(fs.readFileSync(`${PLUGIN_DIRECTORY}${name}`))
    hash.update('\u0000')
  }
  const { version } = JSON.parse(fs.readFileSync(`${PLUGIN_DIRECTORY}manifest.json`, 'utf8'))
  const table = releasedPluginCode()
  assert.ok(table.has(version), `plugin version ${version} is not recorded in RELEASED_PLUGIN_CODE`)
  assert.equal(`sha256:${hash.digest('hex')}`, table.get(version))
})
