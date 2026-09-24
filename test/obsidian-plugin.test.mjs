import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { forbiddenEgressFindingsForText } from '../src/egress/forbidden-egress.mjs'
import { OBSIDIAN_EXT_KEY, validateObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import { COMMUNITY_PLUGINS_PATH, POLICY_SETTINGS_PATH, isUserOwnedSettingsPath, prepareSettings } from '../src/projection/obsidian/materialize/index.mjs'
import {
  PLUGIN_CHANNEL_PROTOCOL, PLUGIN_DATA_MODE, PLUGIN_DATA_PATH, PLUGIN_DATA_SCHEMA, PLUGIN_DIRECTORY, PLUGIN_ID, PLUGIN_LEASE_TTL_MS, PLUGIN_MAX_REQUEST_BYTES, PLUGIN_MINIMUM_APP_VERSION,
  PLUGIN_RENEW_INTERVAL_MS, PLUGIN_ROUTES, PLUGIN_SOURCE_FILES, PLUGIN_STATUS_SCHEMA, preparePluginFiles, readPluginSource, validatePluginData, validatePluginRequest,
} from '../src/projection/obsidian/plugin-bridge/index.mjs'
import { PROTOCOL_ID, createEditorAdapter, createInProcessHost, createObsidianCliAdapter, publishView, resolveExchange, runInProcess } from '../src/projection/obsidian/publication/index.mjs'
import { createRecoveryStore } from '../src/projection/obsidian/recovery/index.mjs'
import { resolveProjectConfig, writeJson } from '../src/project/config.mjs'
import { runObsidianCommandForOracleTests } from '../src/commands/obsidian.mjs'
import { MINIMUM_APP_VERSION, createQualifiedAdapterFactory, inspectApp, parseAppVersion, qualifyApp, readVersionAnswer } from '../src/runtime/obsidian/app-capability.mjs'
import { ensureWorkspaceIdentity, protectedRoots, workspaceStateRoot, writeMachineSettings } from '../src/runtime/obsidian/machine-settings.mjs'
import { readPluginChoice } from '../src/runtime/obsidian/plugin-choice.mjs'
import { pluginPresenceOf, turnPluginOnNext, withPluginReportedVersion } from '../src/runtime/obsidian/plugin-presence.mjs'
import { readServiceRecord, writeServiceSettings } from '../src/runtime/obsidian/service-record.mjs'
import { runMaintenanceService } from '../src/runtime/obsidian/service.mjs'
import { createMaintenanceStateStore } from '../src/runtime/obsidian/state-store.mjs'
import { createPluginChannel, createPluginSessions, ensurePluginBearer, pluginBearerDirectory, readPluginBearers } from '../src/runtime/obsidian/plugin-channel.mjs'
import { authorityOf, requestLoopback } from '../src/runtime/obsidian/service-client.mjs'
import { MAX_REQUEST_BYTES, SERVER_PRIMITIVES, createServiceServerForOracleTests } from '../src/runtime/obsidian/service-server.mjs'

// Atelier's own Obsidian plugin (plugins/obsidian/), its channel to the
// maintenance service, and the files that put it into every vault Atelier
// manages. Invented, synthetic content only, in temporary directories.
//
// The plugin is loaded the way the app loads a plugin: its main.js text is
// wrapped as `function anonymous(require, module, exports)` and evaluated,
// with a minimal stand-in for the app's `obsidian` module. It reaches a real
// service listener on 127.0.0.1 and an ephemeral port through Node's `http`,
// the module it gets inside the app. The stand-in app refuses every write.

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLUGIN_SOURCE = path.join(REPOSITORY_ROOT, 'plugins', 'obsidian')
const TMP = fs.realpathSync(os.tmpdir())
const WORKSPACE_ID = `ws-${'0a'.repeat(12)}`
const SCOPE = 'scope-plugin'
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function waitFor(check, { timeoutMs = 10000, everyMs = 20, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await sleep(everyMs)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

function raw({ port, method = 'POST', route, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: route, setHost: false, agent: false, headers: { Connection: 'close', ...(body === null ? {} : { 'Content-Length': Buffer.byteLength(body) }), ...headers } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let parsed = null; try { parsed = JSON.parse(text) } catch { parsed = null } resolve({ statusCode: response.statusCode, text, body: parsed }) })
    })
    request.on('error', reject)
    request.end(body ?? undefined)
  })
}

// ---------------------------------------------------------------------------
// A stand-in for the app: the `obsidian` module, DOM elements and a vault
// ---------------------------------------------------------------------------

function fakeElement(tag = 'div') {
  const element = {
    tag, text: '', attributes: {}, classes: new Set(), children: [], listeners: {}, detached: false,
    setText(value) { element.text = String(value) },
    setAttr(name, value) { element.attributes[name] = String(value) },
    addClass(...names) { for (const name of names) element.classes.add(name) },
    createEl(childTag, options = {}) {
      const child = fakeElement(childTag)
      if (options.text !== undefined) child.setText(options.text)
      if (options.cls !== undefined) child.addClass(...[].concat(options.cls))
      element.children.push(child)
      return child
    },
    createDiv(options = {}) { return element.createEl('div', options) },
    empty() { element.children.length = 0; element.text = '' },
    detach() { element.detached = true },
    addEventListener(type, handler) { (element.listeners[type] ??= []).push(handler) },
    removeEventListener(type, handler) { element.listeners[type] = (element.listeners[type] ?? []).filter((item) => item !== handler) },
  }
  return element
}

// Every property of the vault but the adapter's base path is a write or a
// read the plugin has no business with: touching one is recorded and throws.
function fakeApp(vaultRoot, record) {
  const forbidden = (where) => new Proxy({}, { get: (_target, key) => { record.forbidden.push(`${where}.${String(key)}`); return () => { throw new Error(`the plugin used ${where}.${String(key)}`) } } })
  const adapter = new Proxy({}, { get: (_target, key) => (key === 'getBasePath' ? () => vaultRoot : forbidden('vault.adapter')[key]) })
  const vault = new Proxy({}, { get: (_target, key) => (key === 'adapter' ? adapter : forbidden('vault')[key]) })
  return { vault, workspace: forbidden('workspace'), metadataCache: forbidden('metadataCache') }
}

function fakeObsidian({ apiVersion = '1.13.7' } = {}) {
  const record = { notices: [], modals: [], commands: [], statusBars: [], intervals: [], forbidden: [], saved: 0 }
  class Component {
    constructor() { this.cleanups = [] }
    register(cleanup) { this.cleanups.push(cleanup) }
    // The stand-in app drives each round through cycle(), so a test never races the plugin's own timer: the interval
    // it registers is recorded and stopped at once.
    registerInterval(id) { record.intervals.push(id); clearInterval(id); return id }
    registerDomEvent(element, type, handler) { element.addEventListener(type, handler); this.register(() => element.removeEventListener(type, handler)) }
  }
  class Plugin extends Component {
    constructor(app, manifest) { super(); this.app = app; this.manifest = manifest }
    addStatusBarItem() { const element = fakeElement(); record.statusBars.push(element); this.register(() => element.detach()); return element }
    addCommand(command) { const registered = { ...command, id: `${this.manifest.id}:${command.id}`, name: `${this.manifest.name}: ${command.name}` }; record.commands.push(registered); return registered }
    // As the app does: the data file in this plugin's folder of the vault the app has open.
    async loadData() {
      try { return JSON.parse(fs.readFileSync(path.join(this.app.vault.adapter.getBasePath(), PLUGIN_DIRECTORY, 'data.json'), 'utf8')) } catch { return null }
    }
    async saveData() { record.saved += 1; throw new Error('the plugin wrote its data file') }
    async load() { await this.onload() }
    unload() { this.onunload(); for (const cleanup of this.cleanups.splice(0).reverse()) cleanup() }
    onload() {}
    onunload() {}
  }
  class Modal {
    constructor(app) { this.app = app; this.titleEl = fakeElement(); this.contentEl = fakeElement() }
    setTitle(title) { this.titleEl.setText(title); return this }
    open() { record.modals.push(this); this.onOpen() }
    close() { this.onClose() }
    onOpen() {}
    onClose() {}
  }
  class Notice { constructor(message) { record.notices.push(message) } }
  return { module: { Plugin, Modal, Notice, apiVersion }, record }
}

// The plugin exactly as the app evaluates main.js. `requests` receives every
// request the plugin makes through `http`, as it was asked for.
function loadPluginClass(fake, { requires = [], requests = [], source = fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8') } = {}) {
  const recordingHttp = { request(options, onResponse) { requests.push({ host: options.host, port: options.port, method: options.method, path: options.path, headers: { ...options.headers } }); return http.request(options, onResponse) } }
  const factory = (0, eval)(`(function anonymous(require,module,exports){${source}\n})\n//# sourceURL=plugin:${PLUGIN_ID}\n`)
  const module = { exports: {} }
  factory((name) => {
    requires.push(name)
    if (name === 'obsidian') return fake.module
    if (name === 'http') return recordingHttp
    if (name === 'fs') return fs
    throw new Error(`the plugin required ${name}`)
  }, module, module.exports)
  return module.exports.default || module.exports
}

const shippedManifest = () => JSON.parse(fs.readFileSync(path.join(PLUGIN_SOURCE, 'manifest.json'), 'utf8'))

// ---------------------------------------------------------------------------
// 1. The shipped plugin and the channel contract
// ---------------------------------------------------------------------------

test('the shipped plugin: three files, a desktop-only manifest at the protocol floor, and nothing else under plugins/obsidian', () => {
  assert.deepEqual(fs.readdirSync(PLUGIN_SOURCE).sort(), [...PLUGIN_SOURCE_FILES].sort())
  const manifest = shippedManifest()
  assert.deepEqual(Object.keys(manifest).sort(), ['author', 'description', 'id', 'isDesktopOnly', 'minAppVersion', 'name', 'version'])
  assert.deepEqual([manifest.id, manifest.minAppVersion, manifest.isDesktopOnly], [PLUGIN_ID, MINIMUM_APP_VERSION, true])
  assert.equal(PLUGIN_MINIMUM_APP_VERSION, MINIMUM_APP_VERSION, 'the plugin needs exactly the floor the publication protocol was proven on')
  assert.doesNotMatch(manifest.id, /obsidian/i, 'a plugin id never names the app')
  const source = readPluginSource()
  assert.equal(source.version, manifest.version)
  assert.deepEqual(source.files.map((file) => file.name), [...PLUGIN_SOURCE_FILES])
  for (const file of source.files) assert.ok(file.bytes.equals(fs.readFileSync(path.join(PLUGIN_SOURCE, file.name))), `${file.name} is shipped byte for byte`)
  const pkg = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  for (const name of PLUGIN_SOURCE_FILES) assert.ok(pkg.files.includes(`plugins/obsidian/${name}`), `package.json files ships ${name}`)
})

// Every released plugin version and the code it shipped. A vault keeps running an older main.js until the app
// reloads the plugin, so a change to the code without a new version would leave two plugins under one version.
const RELEASED_PLUGIN_CODE = Object.freeze({
  '1.0.0': 'sha256:57f6cf1613c45f677438e86cc470094b73fda37bd9f3a62fb4aba42decc98294',
})

test('the plugin\'s version changes whenever its code does', () => {
  const hash = createHash('sha256')
  for (const name of ['main.js', 'styles.css']) { hash.update(`${name}\u0000`); hash.update(fs.readFileSync(path.join(PLUGIN_SOURCE, name))); hash.update('\u0000') }
  const code = `sha256:${hash.digest('hex')}`
  const { version } = shippedManifest()
  assert.ok(Object.hasOwn(RELEASED_PLUGIN_CODE, version), `plugin version ${version} is not recorded here; record it with its code digest ${code}`)
  assert.equal(code, RELEASED_PLUGIN_CODE[version], `the code of plugin ${version} changed: raise the version in plugins/obsidian/manifest.json and record ${code} under it`)
})

test('parity: the constants the plugin carries are the channel contract\'s', () => {
  const fake = fakeObsidian()
  const Plugin = loadPluginClass(fake)
  assert.deepEqual(Plugin.channel, {
    pluginId: PLUGIN_ID, protocol: PLUGIN_CHANNEL_PROTOCOL, dataSchema: PLUGIN_DATA_SCHEMA, statusSchema: PLUGIN_STATUS_SCHEMA, routes: { ...PLUGIN_ROUTES },
    renewEveryMs: PLUGIN_RENEW_INTERVAL_MS, requestTimeoutMs: Plugin.channel.requestTimeoutMs, maxResponseBytes: 64 * 1024, minimumAppVersion: PLUGIN_MINIMUM_APP_VERSION,
  })
  assert.ok(Plugin.channel.requestTimeoutMs < PLUGIN_RENEW_INTERVAL_MS, 'one round trip gives up before the next renewal is due')
  assert.ok(PLUGIN_LEASE_TTL_MS >= 3 * PLUGIN_RENEW_INTERVAL_MS, 'three renewals can be missed before a vault stops counting as open')
})

test('mutation control: a plugin that carries another route fails the parity oracle', () => {
  const source = fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8').replace("lease: '/plugin/lease'", "lease: '/plugin/renew'")
  const Plugin = loadPluginClass(fakeObsidian(), { source })
  assert.notDeepEqual(Plugin.channel.routes, { ...PLUGIN_ROUTES })
})

test('the plugin reaches a literal loopback address only: the egress scan passes it, and fails a variant that names a host', () => {
  const source = fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8')
  assert.deepEqual(forbiddenEgressFindingsForText(source, { file: 'plugins/obsidian/main.js', allowTestFixtures: false }), [])
  for (const text of [source, fs.readFileSync(path.join(PLUGIN_SOURCE, 'manifest.json'), 'utf8'), fs.readFileSync(path.join(PLUGIN_SOURCE, 'styles.css'), 'utf8')]) {
    assert.doesNotMatch(text, /https?:\/\/(?!127\.0\.0\.1|\[::1\])/i, 'no remote address anywhere in the shipped plugin')
  }
  for (const primitive of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\brequestUrl\b/, /\bnet\.connect\b/, /\beval\s*\(/, /\bnew Function\b/, /saveData|\.modify\(|\.create\(|writeFile|\.process\(/]) {
    assert.doesNotMatch(source, primitive, `the plugin does not use ${primitive}`)
  }
  const named = source.replace("host: channel.host === '::1' ? '::1' : '127.0.0.1', family: channel.host === '::1' ? 6 : 4,", 'host: channel.host, family: 0,')
  assert.notEqual(named, source)
  assert.ok(forbiddenEgressFindingsForText(named, { file: 'plugins/obsidian/main.js', allowTestFixtures: false }).some((finding) => finding.type === 'http-request-unresolved'), 'a request to whatever the data file names is a finding')
})

test('the channel contract refuses every request that is not exactly one of its commands', () => {
  const hello = { protocol: PLUGIN_CHANNEL_PROTOCOL, scopeId: SCOPE, pluginVersion: '1.0.0', appVersion: '1.13.7', vaultPath: '/vaults/scope-plugin' }
  assert.deepEqual(validatePluginRequest('hello', hello), { ok: true, body: hello })
  assert.deepEqual(validatePluginRequest('status', { scopeId: SCOPE }), { ok: true, body: { scopeId: SCOPE } })
  const session = `ps-${'1'.repeat(32)}`
  for (const [command, body, code] of [
    ['eval', { scopeId: SCOPE }, 'unknown-command'],
    ['status', [], 'request-malformed'],
    ['status', { scopeId: SCOPE, path: 'notes/a.md' }, 'request-malformed'],
    ['status', { scopeId: '../other' }, 'request-malformed'],
    ['lease', { scopeId: SCOPE }, 'request-malformed'],
    ['lease', { scopeId: SCOPE, sessionId: 'ps-guess' }, 'request-malformed'],
    ['release', { scopeId: SCOPE, sessionId: session, force: true }, 'request-malformed'],
    ['hello', { ...hello, protocol: 'atelier-obsidian-plugin-channel/v2' }, 'protocol-unsupported'],
    ['hello', { ...hello, vaultPath: 'relative/vault' }, 'request-malformed'],
    ['hello', { ...hello, appVersion: 'x'.repeat(41) }, 'request-malformed'],
    ['hello', { ...hello, code: 'app.vault.delete()' }, 'request-malformed'],
  ]) assert.deepEqual(validatePluginRequest(command, body), { ok: false, code }, `${command} ${JSON.stringify(body)}`)
  const document = { schema: PLUGIN_DATA_SCHEMA, channel: { host: '127.0.0.1', port: 43123 }, scopeId: SCOPE, bearer: 'b'.repeat(43) }
  assert.equal(validatePluginData(document), document)
  for (const bad of [{ ...document, channel: { host: 'localhost', port: 43123 } }, { ...document, channel: { host: '0.0.0.0', port: 43123 } }, { ...document, channel: { host: '127.0.0.1', port: 80 } }, { ...document, bearer: 'short' }, { ...document, extra: 1 }]) {
    assert.equal(validatePluginData(bad), null, JSON.stringify(bad.channel ?? bad))
  }
})

// ---------------------------------------------------------------------------
// 2. The plugin in the stand-in app, against a real listener
// ---------------------------------------------------------------------------

// A workspace with one view whose vault holds the plugin as publication puts
// it there, and a listener that holds the plugin channel of that workspace.
async function channelWorld(t, { apiVersion = '1.13.7', sessions = createPluginSessions(), primitives = SERVER_PRIMITIVES, port: fixedPort = null } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const workspaceRoot = path.join(dir, 'workspace')
  fs.mkdirSync(workspaceRoot, { mode: 0o700 })
  const vaultRoot = path.join(workspaceRoot, 'vaults', SCOPE)
  fs.mkdirSync(vaultRoot, { recursive: true, mode: 0o700 })
  const world = {
    dir, workspaceRoot, vaultRoot,
    view: { state: 'current', reason: 'published-and-verified', verified: true, generationId: 'gen-0001', preparedGenerationId: 'gen-0001', heldNoteCount: 0, retainedEdits: 0, checkedAt: '2026-01-05T10:00:00.000Z' },
    pending: 0,
    health: 'healthy',
  }
  world.statusOf = () => ({ view: world.view === null ? null : { ...world.view }, pendingEdits: { open: world.pending } })
  world.install = ({ port, bearer = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE }) }) => {
    for (const file of preparePluginFiles({ channel: { host: '127.0.0.1', port }, scopeId: SCOPE, bearer }).files) {
      fs.mkdirSync(path.dirname(path.join(vaultRoot, file.path)), { recursive: true })
      fs.writeFileSync(path.join(vaultRoot, file.path), file.bytes, { mode: file.mode })
    }
    return bearer
  }
  world.listen = async ({ port, withSessions = sessions } = {}) => {
    const identity = { serviceName: `atelier-obsidian-${WORKSPACE_ID}`, workspaceId: WORKSPACE_ID, runtimeId: `rt-${randomBytes(8).toString('hex')}`, pid: process.pid, host: '127.0.0.1', port, executableDigest: digest('entry'), startedAt: '2026-01-05T10:00:00.000Z' }
    const runtimeBearer = randomBytes(32).toString('base64url')
    const channel = createPluginChannel({ workspaceRoot, workspaceId: WORKSPACE_ID, runtimeId: identity.runtimeId, sessions: withSessions, statusOf: world.statusOf, serviceStatus: () => world.health })
    const calls = { status: 0, tick: 0, stop: 0, plugin: [] }
    const listener = createServiceServerForOracleTests({
      identity, bearer: runtimeBearer,
      operations: {
        healthStatus: () => world.health, status: () => { calls.status += 1; return { ok: true } }, tick: async () => { calls.tick += 1; return { ok: true } }, stop: async () => { calls.stop += 1 },
        pluginBearers: () => channel.bearers(), plugin: (command, request) => { calls.plugin.push(command); return channel.handle(command, request) },
      },
    }, primitives)
    await listener.listen()
    t.after(() => listener.close())
    return { listener, calls, runtimeBearer, identity, sessions: withSessions }
  }
  const port = fixedPort ?? await freePort()
  world.port = port
  world.bearer = world.install({ port })
  world.service = await world.listen({ port })
  world.fake = fakeObsidian({ apiVersion })
  world.requires = []
  world.requests = []
  world.plugin = () => {
    const Plugin = loadPluginClass(world.fake, { requires: world.requires, requests: world.requests })
    const plugin = new Plugin(fakeApp(vaultRoot, world.fake.record), shippedManifest())
    t.after(() => { try { plugin.unload() } catch { /* already unloaded */ } })
    return plugin
  }
  return world
}

const statusBarOf = (world) => world.fake.record.statusBars.at(-1).text

test('loaded in a vault Atelier published, the plugin says hello, holds a lease and shows the view current', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  const [session] = world.service.sessions.live(SCOPE)
  assert.deepEqual([session.appVersion, session.pluginVersion, world.service.sessions.live(SCOPE).length], ['1.13.7', shippedManifest().version, 1])
  assert.deepEqual(world.service.calls.plugin, ['hello', 'status'])
  // Every request went to the literal loopback address, carried this vault's bearer and named this view.
  assert.ok(world.requests.length >= 2)
  for (const request of world.requests) {
    assert.deepEqual([request.host, request.port, request.method, request.headers.Host, request.headers.Authorization], ['127.0.0.1', world.port, 'POST', authorityOf('127.0.0.1', world.port), `Bearer ${world.bearer}`])
    assert.ok(Object.values(PLUGIN_ROUTES).includes(request.path))
  }
  assert.deepEqual([...new Set(world.requires)].sort(), ['fs', 'http', 'obsidian'])
  assert.deepEqual(world.fake.record.commands.map((command) => [command.id, command.name]), [[`${PLUGIN_ID}:show-status`, 'Atelier: Show status']])
  assert.deepEqual(world.fake.record.intervals.length, 1)

  await plugin.cycle()
  assert.deepEqual(world.service.calls.plugin, ['hello', 'status', 'lease', 'status'], 'later rounds renew the lease and read the status')
  assert.equal(world.service.sessions.live(SCOPE).length, 1, 'one session per loaded plugin')
  assert.deepEqual([world.fake.record.forbidden, world.fake.record.saved, world.fake.record.notices], [[], 0, []], 'no write, no data file saved, and no notice for a view that is simply current')
})

test('the status bar follows the view and a notice marks each transition into and out of a state that needs a person', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  const shown = []
  const step = async (change) => { change(); await plugin.cycle(); shown.push(statusBarOf(world)) }
  await step(() => { world.view = { ...world.view, state: 'updating', reason: 'publishing' } })
  await step(() => { world.view = { ...world.view, state: 'current', reason: 'published-and-verified' } })
  await step(() => { world.view = { ...world.view, state: 'held-for-your-edit', reason: 'edit-pending', heldNoteCount: 2 }; world.pending = 2 })
  await step(() => { world.view = { ...world.view, state: 'current', reason: 'published-and-verified', heldNoteCount: 0 }; world.pending = 0 })
  await step(() => { world.view = { ...world.view, state: 'publisher-conflict', reason: 'editor-uncoordinated' } })
  await step(() => { world.view = { ...world.view, state: 'stale', reason: 'canonical-graph-invalid' } })
  await step(() => { world.view = null })
  await step(() => { world.view = { state: 'current', reason: 'published-and-verified', verified: true, generationId: 'gen-0002', preparedGenerationId: 'gen-0002', heldNoteCount: 0, retainedEdits: 1, checkedAt: '2026-01-05T10:05:00.000Z' } })
  assert.deepEqual(shown, ['Atelier: updating', 'Atelier: current', 'Atelier: held (2)', 'Atelier: current', 'Atelier: stale', 'Atelier: stale', 'Atelier: stale', 'Atelier: current'])
  assert.deepEqual(world.fake.record.notices, [
    'Atelier kept 2 edits you made. This view is not updated over them until they are applied or withdrawn.',
    'Atelier: this view is current again.',
    'Atelier: this view is not current. "Atelier: show status" says why.',
    'Atelier: this view is current again.',
  ], 'updating is not a notice; staying stale is one notice, not three')

  // The service stops answering, and comes back.
  await world.service.listener.close()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: service unreachable')
  assert.equal(world.fake.record.notices.at(-1), 'Atelier: the maintenance service does not answer. The vault stays as it is.')
  world.service = await world.listen({ port: world.port })
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  assert.equal(world.fake.record.notices.at(-1), 'Atelier: this view is current again.')
  assert.deepEqual(world.fake.record.forbidden, [])
})

test('"Atelier: show status" shows the view, its generation, the freshness reason and the held edits', async (t) => {
  const world = await channelWorld(t)
  world.view = { ...world.view, state: 'held-for-your-edit', reason: 'publication-withheld-for-your-edit', generationId: 'gen-0003', preparedGenerationId: 'gen-0004', heldNoteCount: 1, retainedEdits: 2 }
  world.pending = 1
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  world.fake.record.commands.find((command) => command.id.endsWith(':show-status')).callback()
  const modal = world.fake.record.modals.at(-1)
  assert.equal(modal.titleEl.text, 'Atelier status')
  const [list] = modal.contentEl.children
  const rows = []
  for (let index = 0; index < list.children.length; index += 2) rows.push([list.children[index].text, list.children[index + 1].text])
  assert.deepEqual(Object.fromEntries(rows), {
    View: SCOPE, State: 'held (1)', Reason: 'publication withheld for your edit', Generation: 'gen-0003', 'Prepared generation': 'gen-0004', 'Checked at': '2026-01-05T10:00:00.000Z',
    'Held edits': '1', 'Retained edits': '2', 'Pending edits': '1', Service: `127.0.0.1:${world.port}, healthy`, Plugin: shippedManifest().version, Obsidian: '1.13.7',
  })
  for (const [label] of rows) assert.match(label, /^[A-Z][a-z ]*$/, `${label} is in sentence case`)
  // A click on the status bar item opens the same view.
  world.fake.record.statusBars.at(-1).listeners.click[0]()
  assert.equal(world.fake.record.modals.length, 2)
})

test('the lease: renewed while the vault is open, released when the plugin unloads, lapsing on its own otherwise', async (t) => {
  let now = Date.parse('2026-01-05T10:00:00.000Z')
  const sessions = createPluginSessions({ now: () => now })
  const world = await channelWorld(t, { sessions })
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(sessions.report(SCOPE).sessions, 1)
  now += PLUGIN_LEASE_TTL_MS - 1
  await plugin.cycle()
  now += PLUGIN_LEASE_TTL_MS - 1
  assert.equal(sessions.report(SCOPE).sessions, 1, 'each renewal extends the lease')
  plugin.unload()
  await waitFor(() => sessions.report(SCOPE) === null, { label: 'the released lease' })
  assert.deepEqual(world.service.calls.plugin.slice(-1), ['release'])

  // A plugin that disappears without a word: its lease lapses by itself.
  const second = world.plugin()
  await second.load()
  await second.cycle()
  assert.equal(sessions.report(SCOPE).sessions, 1)
  now += PLUGIN_LEASE_TTL_MS
  assert.equal(sessions.report(SCOPE), null, 'no renewal within the lease: the vault no longer counts as open')
})

test('a service that started again forgets the session: the plugin says hello again and carries on', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  await world.service.listener.close()
  world.service = await world.listen({ port: world.port, withSessions: createPluginSessions() })
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  assert.deepEqual(world.service.calls.plugin, ['lease', 'hello', 'status'])
  assert.equal(world.service.sessions.report(SCOPE).sessions, 1)
})

test('a republished data file moves the plugin to the new address and bearer without a restart', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  const port = await freePort()
  fs.rmSync(path.join(pluginBearerDirectory(world.workspaceRoot), `${SCOPE}.json`))
  const bearer = world.install({ port })
  assert.notEqual(bearer, world.bearer)
  const moved = await world.listen({ port })
  await plugin.onExternalSettingsChange()
  assert.equal(statusBarOf(world), 'Atelier: current')
  assert.deepEqual(moved.calls.plugin, ['hello', 'status'])
  assert.deepEqual([world.requests.at(-1).port, world.requests.at(-1).headers.Authorization], [port, `Bearer ${bearer}`])
})

test('without usable channel data the plugin says so and makes no request', async (t) => {
  for (const [label, data] of [['no data file', null], ['a data file naming a host', { schema: PLUGIN_DATA_SCHEMA, channel: { host: 'localhost', port: 43123 }, scopeId: SCOPE, bearer: 'b'.repeat(43) }], ['a data file that is not JSON', 'not json']]) {
    const world = await channelWorld(t)
    const file = path.join(world.vaultRoot, PLUGIN_DATA_PATH)
    if (data === null) fs.rmSync(file)
    else fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
    const plugin = world.plugin()
    await plugin.load()
    await plugin.cycle()
    assert.equal(statusBarOf(world), 'Atelier: not set up', label)
    assert.deepEqual([world.requests, world.service.calls.plugin], [[], []], label)
    plugin.unload()
  }
})

test('below the app floor the plugin shows it, says it once, and opens no channel', async (t) => {
  for (const apiVersion of ['1.13.6', '1.12.7', '1.13.7-beta.1', 'unknown']) {
    const world = await channelWorld(t, { apiVersion })
    const plugin = world.plugin()
    await plugin.load()
    await plugin.cycle()
    assert.equal(statusBarOf(world), 'Atelier: needs a newer Obsidian', apiVersion)
    assert.deepEqual(world.fake.record.notices, [`Atelier's plugin needs Obsidian ${MINIMUM_APP_VERSION} or later. The vault keeps working without it.`], apiVersion)
    assert.deepEqual([world.requests, world.fake.record.intervals, world.service.calls.plugin], [[], [], []], apiVersion)
    plugin.unload()
  }
  const world = await channelWorld(t, { apiVersion: '1.14.0' })
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current', 'a newer app is admitted')
})

test('the plugin sends the real path of the vault the app has open; another vault is refused', async (t) => {
  const world = await channelWorld(t)
  // The app opened the vault through a symbolic link: the plugin resolves it.
  const link = path.join(world.dir, 'linked-vault')
  // A junction on Windows needs no privilege; elsewhere the type is ignored.
  fs.symlinkSync(world.vaultRoot, link, 'junction')
  const Plugin = loadPluginClass(world.fake, { requests: world.requests })
  const plugin = new Plugin(fakeApp(link, world.fake.record), shippedManifest())
  t.after(() => plugin.unload())
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  plugin.unload()

  // The same data file copied into another folder: the service refuses the hello.
  const elsewhere = path.join(world.dir, 'copied-vault')
  fs.cpSync(world.vaultRoot, elsewhere, { recursive: true })
  const copied = new Plugin(fakeApp(elsewhere, world.fake.record), shippedManifest())
  t.after(() => copied.unload())
  await copied.load()
  await copied.cycle()
  assert.equal(statusBarOf(world), 'Atelier: not set up', 'a copy of the vault is not the vault Atelier maintains')
  assert.equal(copied.view.reason, 'not-the-vault-atelier-maintains')
})

// ---------------------------------------------------------------------------
// 3. The listener's plugin commands: one vault's bearer, bounded, exact
// ---------------------------------------------------------------------------

async function assertOnlyTheVaultBearerActs(t, primitives) {
  const world = await channelWorld(t, { primitives })
  const { port } = world
  const Host = authorityOf('127.0.0.1', port)
  const authorised = { Host, Authorization: `Bearer ${world.bearer}` }
  // A second view of the same workspace, with its own vault and bearer.
  const otherBearer = ensurePluginBearer({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'scope-other' })
  const status = JSON.stringify({ scopeId: SCOPE })
  const hello = (extra = {}) => JSON.stringify({ protocol: PLUGIN_CHANNEL_PROTOCOL, scopeId: SCOPE, pluginVersion: '1.0.0', appVersion: '1.13.7', vaultPath: fs.realpathSync(world.vaultRoot), ...extra })
  const refused = [
    ['no bearer', { route: PLUGIN_ROUTES.status, headers: { Host }, body: status }, 401],
    ['a wrong bearer', { route: PLUGIN_ROUTES.status, headers: { Host, Authorization: `Bearer ${randomBytes(32).toString('base64url')}` }, body: status }, 401],
    ['the runtime bearer of the service', { route: PLUGIN_ROUTES.hello, headers: { Host, Authorization: `Bearer ${world.service.runtimeBearer}` }, body: hello() }, 401],
    ['the bearer under another scheme', { route: PLUGIN_ROUTES.status, headers: { Host, Authorization: `Basic ${world.bearer}` }, body: status }, 401],
    ['another vault\'s bearer naming this view', { route: PLUGIN_ROUTES.hello, headers: { Host, Authorization: `Bearer ${otherBearer}` }, body: hello() }, 403],
    ['GET on a plugin command', { method: 'GET', route: PLUGIN_ROUTES.status, headers: authorised }, 405],
    ['an oversized payload', { route: PLUGIN_ROUTES.status, headers: authorised, body: JSON.stringify({ scopeId: SCOPE, padding: 'x'.repeat(PLUGIN_MAX_REQUEST_BYTES) }) }, 413],
    ['a payload that is not JSON', { route: PLUGIN_ROUTES.status, headers: authorised, body: 'status please' }, 400],
    ['a payload with anything else in it', { route: PLUGIN_ROUTES.status, headers: authorised, body: JSON.stringify({ scopeId: SCOPE, path: 'notes/Lantern room--0123456789ab.md' }) }, 400],
    ['a hello in another protocol', { route: PLUGIN_ROUTES.hello, headers: authorised, body: hello({ protocol: 'atelier-obsidian-plugin-channel/v2' }) }, 409],
    ['a hello naming another vault', { route: PLUGIN_ROUTES.hello, headers: authorised, body: hello({ vaultPath: world.dir }) }, 409],
    ['a lease nobody was granted', { route: PLUGIN_ROUTES.lease, headers: authorised, body: JSON.stringify({ scopeId: SCOPE, sessionId: `ps-${'0'.repeat(32)}` }) }, 409],
    ['a query on a plugin command', { route: `${PLUGIN_ROUTES.status}?scope=${SCOPE}`, headers: authorised, body: status }, 404],
    ['a command that does not exist', { route: '/plugin/eval', headers: authorised, body: status }, 404],
    ['a command under another prefix', { route: '/plugins/status', headers: authorised, body: status }, 404],
    ['a hostname in Host', { route: PLUGIN_ROUTES.status, headers: { ...authorised, Host: `localhost:${port}` }, body: status }, 403],
    ['a cross-site Origin', { route: PLUGIN_ROUTES.status, headers: { ...authorised, Origin: 'app://obsidian.md' }, body: status }, 403],
    ['Sec-Fetch-Site: cross-site', { route: PLUGIN_ROUTES.status, headers: { ...authorised, 'Sec-Fetch-Site': 'cross-site' }, body: status }, 403],
    // The plugin's bearer is not the service's: none of the service's own operations answers it.
    ['the vault bearer on the service status', { method: 'GET', route: '/status', headers: authorised }, 401],
    ['the vault bearer asking for a tick', { route: '/tick', headers: authorised, body: JSON.stringify({ runtimeId: world.service.identity.runtimeId }) }, 401],
    ['the vault bearer asking the service to stop', { route: '/stop', headers: authorised, body: JSON.stringify({ runtimeId: world.service.identity.runtimeId }) }, 401],
  ]
  for (const [label, request, statusCode] of refused) assert.equal((await raw({ port, ...request })).statusCode, statusCode, label)
  assert.deepEqual([world.service.calls.status, world.service.calls.tick, world.service.calls.stop], [0, 0, 0], 'no refused request reached a service operation')
  assert.equal(world.service.sessions.report(SCOPE), null, 'no refused request opened a session')
  assert.ok(world.service.calls.plugin.every((command) => ['hello', 'lease'].includes(command)), 'only a well-formed, authorised command reached the channel')

  // The four commands, as the plugin sends them.
  const opened = await raw({ port, route: PLUGIN_ROUTES.hello, headers: authorised, body: hello() })
  assert.deepEqual([opened.statusCode, opened.body.schema, opened.body.scopeId, opened.body.leaseTtlMs, opened.body.renewEveryMs], [200, PLUGIN_CHANNEL_PROTOCOL, SCOPE, PLUGIN_LEASE_TTL_MS, PLUGIN_RENEW_INTERVAL_MS])
  const session = JSON.stringify({ scopeId: SCOPE, sessionId: opened.body.sessionId })
  assert.equal((await raw({ port, route: PLUGIN_ROUTES.lease, headers: authorised, body: session })).statusCode, 200)
  const answered = await raw({ port, route: PLUGIN_ROUTES.status, headers: authorised, body: status })
  assert.deepEqual(answered.body, { schema: PLUGIN_STATUS_SCHEMA, scopeId: SCOPE, service: { status: 'healthy' }, view: world.view, pendingEdits: { open: 0 } })
  assert.deepEqual((await raw({ port, route: PLUGIN_ROUTES.release, headers: authorised, body: session })).body, { schema: PLUGIN_CHANNEL_PROTOCOL, scopeId: SCOPE, released: true })
  assert.equal((await raw({ port, route: PLUGIN_ROUTES.lease, headers: authorised, body: session })).statusCode, 409, 'a released session renews nothing')
  // Another vault's bearer speaks for that vault only.
  assert.equal((await raw({ port, route: PLUGIN_ROUTES.status, headers: { Host, Authorization: `Bearer ${otherBearer}` }, body: JSON.stringify({ scopeId: 'scope-other' }) })).statusCode, 200)
  for (const text of [opened.text, answered.text]) {
    for (const word of [world.dir, world.workspaceRoot, world.bearer, otherBearer, 'notes/', '.md']) assert.equal(text.includes(word), false, `an answer carries ${word}`)
  }
}

test('the plugin commands answer this vault\'s bearer only, bounded and exact, and grant nothing of the service', async (t) => {
  await assertOnlyTheVaultBearerActs(t, SERVER_PRIMITIVES)
})

for (const [label, broken] of [
  ['takes any bearer for the first view it knows', { pluginBearerScope: (_presented, bearers) => [...bearers.keys()][0] ?? null }],
  ['takes the runtime bearer for a view', { pluginBearerScope: (presented, bearers) => SERVER_PRIMITIVES.pluginBearerScope(presented, bearers) ?? (presented ? SCOPE : null) }],
  ['reads plugin payloads of any size', { maxPluginRequestBytes: 1024 * 1024 }],
]) {
  test(`mutation control: a listener that ${label} fails the plugin request oracle`, async (t) => {
    await assert.rejects(assertOnlyTheVaultBearerActs(t, { ...SERVER_PRIMITIVES, ...broken }), assert.AssertionError)
  })
}

test('the plugin request bound is the service request bound', () => {
  assert.equal(PLUGIN_MAX_REQUEST_BYTES, MAX_REQUEST_BYTES)
})

test('sessions: bounded per view, renewed by their holder only, lapsing without renewal', () => {
  let now = 0
  const sessions = createPluginSessions({ now: () => now, maxPerScope: 2 })
  const first = sessions.open({ scopeId: SCOPE, pluginVersion: '1.0.0', appVersion: '1.13.7' })
  const second = sessions.open({ scopeId: SCOPE, pluginVersion: '1.0.0', appVersion: '1.13.8' })
  assert.equal(sessions.open({ scopeId: SCOPE, pluginVersion: '1.0.0', appVersion: '1.13.7' }), null, 'a third live session for one view is refused')
  assert.ok(sessions.open({ scopeId: 'scope-other', pluginVersion: '1.0.0', appVersion: '1.13.7' }), 'the bound is per view')
  assert.match(first.sessionId, /^ps-[0-9a-f]{32}$/)
  assert.equal(sessions.renew({ scopeId: 'scope-other', sessionId: first.sessionId }), null, 'a session is renewed for its own view only')
  now += 1000
  assert.equal(sessions.renew({ scopeId: SCOPE, sessionId: second.sessionId }).expiresAt, 1000 + PLUGIN_LEASE_TTL_MS)
  assert.deepEqual(sessions.report(SCOPE), { scopeId: SCOPE, appVersion: '1.13.8', pluginVersion: '1.0.0', sessions: 2, renewedAt: new Date(1000).toISOString() }, 'the most recently renewed session speaks for the view')
  now = PLUGIN_LEASE_TTL_MS
  assert.equal(sessions.report(SCOPE).sessions, 1, 'the session nobody renewed lapsed')
  assert.ok(sessions.open({ scopeId: SCOPE, pluginVersion: '1.0.0', appVersion: '1.13.7' }), 'and freed its place')
  assert.equal(sessions.release({ scopeId: 'scope-other', sessionId: second.sessionId }), false, 'a session is released for its own view only')
  assert.equal(sessions.release({ scopeId: SCOPE, sessionId: second.sessionId }), true)
})

test('vault bearers: minted once, owner-only in private state, listed per view, and a broken one is replaced', (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-bearers-'))
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  const bytes = (fill) => (size) => Buffer.alloc(size, fill)
  const first = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, randomBytes: bytes(1), clock: () => new Date(0) })
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, randomBytes: bytes(2) }), first, 'minted once')
  const second = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'scope:colon', randomBytes: bytes(3) })
  assert.deepEqual(readPluginBearers({ workspaceRoot, workspaceId: WORKSPACE_ID }), new Map([['scope:colon', second], [SCOPE, first]]))
  const directory = pluginBearerDirectory(workspaceRoot)
  const file = path.join(directory, `${SCOPE}.json`)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['bearer', 'createdAt', 'schema', 'scopeId', 'workspaceId'])
  // Another workspace's bearer, or a file under the wrong name, authenticates nothing.
  assert.deepEqual(readPluginBearers({ workspaceRoot, workspaceId: 'ws-another' }), new Map())
  fs.copyFileSync(file, path.join(directory, 'scope-renamed.json'))
  assert.equal(readPluginBearers({ workspaceRoot, workspaceId: WORKSPACE_ID }).size, 2)
  fs.writeFileSync(file, '{"schema":"atelier-obsidian-plugin-bearer/v1"}')
  assert.equal(readPluginBearers({ workspaceRoot, workspaceId: WORKSPACE_ID }).has(SCOPE), false)
  const replaced = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, randomBytes: bytes(4) })
  assert.notEqual(replaced, first)
  assert.equal(readPluginBearers({ workspaceRoot, workspaceId: WORKSPACE_ID }).get(SCOPE), replaced)
})

// ---------------------------------------------------------------------------
// 4. Publication: the plugin in every vault, owned per file and per entry
// ---------------------------------------------------------------------------

const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which the recovery suite asserts' }
const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })
const NOTE = 'notes/Harbor plan--0123456789ab.md'
const NOTE_TEXT = '# Harbor plan\n\nThe harbor opens at dawn.\n'
const PLUGIN_FILES = [...PLUGIN_SOURCE_FILES, 'data.json'].map((name) => `${PLUGIN_DIRECTORY}/${name}`)

// A prepared view as prepareView returns it for a vault that receives the
// plugin: one note, the policy settings, the plugin files, and the settings
// unit's record pinning them in the manifest.
// `community` and `onlyIfPresent` are what the service decides per vault (plugin-choice.mjs); without them the entry is
// offered and the list merged when it is published.
function pluginViewOf(generationId, { port = 43123, bearer = 'b'.repeat(43), source, notes = { [NOTE]: NOTE_TEXT }, community, onlyIfPresent = false, keep = null } = {}) {
  const files = []
  const manifest = {
    schema: 'atelier-obsidian-generation-manifest/v1', generationId, scopeId: SCOPE, snapshotId: 'snap-synthetic', notes: [], links: [], attachments: [],
    completeness: { status: 'complete', expectedNotes: Object.keys(notes).length, writtenNotes: Object.keys(notes).length },
    freshness: { status: 'current', checkedAt: '2026-01-05T10:00:00.000Z' },
  }
  for (const [notePath, text] of Object.entries(notes)) {
    const bytes = Buffer.from(text, 'utf8')
    files.push({ path: notePath, kind: 'note', bytes, digest: digest(bytes) })
    manifest.notes.push({ repoId: 'harbor', nodeId: `node-${digest(notePath).slice(7, 15)}`, path: notePath, title: 'Harbor plan', noteDigest: digest(bytes), regions: { body: { start: 0, end: bytes.length }, generated: [] } })
  }
  const prepared = preparePluginFiles({ channel: { host: '127.0.0.1', port }, scopeId: SCOPE, bearer, onlyIfPresent, ...(source ? { source } : {}) })
  const kept = keep === null ? prepared.files : prepared.files.filter((file) => keep.includes(file.path))
  const plugin = { files: kept, ownership: { ...prepared.ownership, files: prepared.ownership.files.filter((entry) => kept.some((file) => file.path === entry.path)) }, ...(community === undefined ? {} : { community }) }
  const settings = prepareSettings({ plugin })
  files.push(...settings.files)
  manifest.ext = { [OBSIDIAN_EXT_KEY]: { emitterVersion: '1.0.0', mode: 'full', settings: settings.ownership } }
  assert.deepEqual(validateObsidianContract('generation-manifest', manifest), [], 'the pinned plugin record fits the manifest contract as it is')
  return { manifest, files }
}

function publicationWorld(t, { vaultRoot } = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-publication-'))
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  const store = createRecoveryStore({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [], ...(vaultRoot ? { vaultRoot } : {}) })
  return {
    store,
    full: (relative) => path.join(store.vaultRoot, relative),
    read: (relative) => { try { return fs.readFileSync(path.join(store.vaultRoot, relative)) } catch (error) { if (error.code === 'ENOENT') return null; throw error } },
    publish: (preparedView, adapter = absentAdapter()) => publishView({ preparedView, protocolId: PROTOCOL_ID, expectedGeneration: store.readCurrent()?.generationId ?? null, recoveryStore: store, adapter, clock: () => new Date(), quietPeriodMs: 0 }),
    staged: () => { const found = []; const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name); if (entry.isDirectory()) walk(absolute); else found.push(absolute) } }; walk(store.stagingRoot); return found },
    recovered: () => {
      const found = []
      const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name); if (entry.isDirectory()) walk(absolute); else found.push(fs.readFileSync(absolute)) } }
      walk(path.join(store.workspaceRoot, 'recovery'))
      return found
    },
  }
}

const outcomeOf = (result, notePath) => result.notes.find((entry) => entry.path === notePath)

test('every published vault carries the plugin: its files byte for byte, its community entry, its data file private, its digests pinned', needsExchange, async (t) => {
  const world = publicationWorld(t)
  const view = pluginViewOf('gen-0001')
  const result = await world.publish(view)
  assert.equal(result.state, 'committed', JSON.stringify(result.notes))
  for (const name of PLUGIN_SOURCE_FILES) assert.ok(world.read(`${PLUGIN_DIRECTORY}/${name}`).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, name))), `${name} is the shipped file`)
  assert.deepEqual(JSON.parse(world.read(PLUGIN_DATA_PATH)), { schema: PLUGIN_DATA_SCHEMA, channel: { host: '127.0.0.1', port: 43123 }, scopeId: SCOPE, bearer: 'b'.repeat(43) })
  assert.deepEqual(JSON.parse(world.read(COMMUNITY_PLUGINS_PATH)), [PLUGIN_ID])
  assert.deepEqual(JSON.parse(world.read(POLICY_SETTINGS_PATH)), { publish: false, sync: false })
  assert.equal(world.read(NOTE).toString(), NOTE_TEXT)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(world.store.vaultRoot).mode & 0o777, 0o700, 'the vault root is private to this user')
    assert.equal(fs.statSync(world.full(PLUGIN_DATA_PATH)).mode & 0o777, PLUGIN_DATA_MODE, 'the data file is owner-only')
  }
  const pinned = world.store.readCurrentManifest().ext[OBSIDIAN_EXT_KEY].settings
  assert.deepEqual(pinned.pluginOwned.files.map(({ path: filePath, digest: fileDigest }) => [filePath, fileDigest]), PLUGIN_FILES.map((filePath) => [filePath, digest(world.read(filePath))]))
  assert.deepEqual(pinned.policyOwned.map((entry) => entry.path), [POLICY_SETTINGS_PATH, COMMUNITY_PLUGINS_PATH])
  assert.deepEqual(pinned.policyOwned[1].ownedEntries, [PLUGIN_ID])
  assert.equal(pinned.pluginOwned.version, shippedManifest().version)
  for (const filePath of [...PLUGIN_FILES, COMMUNITY_PLUGINS_PATH]) assert.equal(isUserOwnedSettingsPath(filePath), false, `${filePath} is Atelier's`)
  for (const filePath of ['.obsidian/plugins/dataview/data.json', '.obsidian/plugins/atelier-projection/notes.md', '.obsidian/workspace.json']) assert.equal(isUserOwnedSettingsPath(filePath), true, `${filePath} is the person's`)

  // Unchanged, it republishes nothing.
  const again = await world.publish(pluginViewOf('gen-0002'))
  assert.equal(again.state, 'committed')
  for (const filePath of PLUGIN_FILES) assert.equal(outcomeOf(again, filePath).outcome, 'unchanged', filePath)
  assert.equal(outcomeOf(again, COMMUNITY_PLUGINS_PATH).outcome, 'policy-satisfied')
})

test('a manifest that does not pin a carried plugin file, or pins one not carried, is refused before anything is written', needsExchange, async (t) => {
  const world = publicationWorld(t)
  const unpinned = pluginViewOf('gen-0001')
  unpinned.manifest.ext[OBSIDIAN_EXT_KEY].settings.pluginOwned.files.pop()
  const missing = pluginViewOf('gen-0001')
  missing.files = missing.files.filter((file) => file.path !== PLUGIN_DATA_PATH)
  const altered = pluginViewOf('gen-0001')
  altered.files.find((file) => file.path === `${PLUGIN_DIRECTORY}/main.js`).bytes = Buffer.from('module.exports = class {}')
  const foreign = pluginViewOf('gen-0001')
  foreign.files.push({ path: '.obsidian/plugins/dataview/main.js', kind: 'plugin', bytes: Buffer.from('x'), digest: digest('x') })
  for (const [label, view] of [['unpinned', unpinned], ['missing', missing], ['altered', altered], ['another plugin', foreign]]) {
    const result = await world.publish(view)
    assert.deepEqual([result.state, result.refusal?.code], ['refused', 'invalid-prepared-view'], label)
  }
  assert.deepEqual(fs.readdirSync(world.store.vaultRoot), [], 'nothing reached the vault')
})

test('a person\'s settings are never clobbered: their community plugins stay in order, other plugins\' folders are untouched, a list that is not a list is left alone', needsExchange, async (t) => {
  const world = publicationWorld(t)
  fs.mkdirSync(world.full('.obsidian/plugins/dataview'), { recursive: true })
  fs.writeFileSync(world.full(COMMUNITY_PLUGINS_PATH), JSON.stringify(['dataview', 'calendar']))
  fs.writeFileSync(world.full(POLICY_SETTINGS_PATH), JSON.stringify({ graph: true, sync: true }))
  fs.writeFileSync(world.full('.obsidian/plugins/dataview/data.json'), '{"theirs":true}')
  fs.writeFileSync(world.full('.obsidian/plugins/dataview/main.js'), 'module.exports = class Theirs {}')
  const before = ['.obsidian/plugins/dataview/data.json', '.obsidian/plugins/dataview/main.js'].map((filePath) => world.read(filePath))
  const result = await world.publish(pluginViewOf('gen-0001'))
  assert.equal(result.state, 'committed')
  assert.deepEqual(JSON.parse(world.read(COMMUNITY_PLUGINS_PATH)), ['dataview', 'calendar', PLUGIN_ID], 'appended, in the person\'s order')
  assert.deepEqual(JSON.parse(world.read(POLICY_SETTINGS_PATH)), { graph: true, sync: false, publish: false })
  assert.deepEqual(['.obsidian/plugins/dataview/data.json', '.obsidian/plugins/dataview/main.js'].map((filePath) => world.read(filePath)), before)
  assert.ok(world.recovered().some((bytes) => bytes.toString() === JSON.stringify(['dataview', 'calendar'])), 'the list as the person left it is kept in recovery')

  // A view prepared without the service's decision offers the entry: a list without it gets it appended. (The service
  // always decides; a vault that turned the plugin off is withheld, see the plugin choice tests.)
  fs.writeFileSync(world.full(COMMUNITY_PLUGINS_PATH), JSON.stringify(['dataview', 'calendar']))
  const next = await world.publish(pluginViewOf('gen-0002', { notes: { [NOTE]: `${NOTE_TEXT}Next.\n` } }))
  assert.equal(next.state, 'committed')
  assert.deepEqual(JSON.parse(world.read(COMMUNITY_PLUGINS_PATH)), ['dataview', 'calendar', PLUGIN_ID])

  // A file that is not a list is the person's to repair; the notes still converge.
  fs.writeFileSync(world.full(COMMUNITY_PLUGINS_PATH), '{"dataview":true}')
  const invalid = await world.publish(pluginViewOf('gen-0003', { notes: { [NOTE]: `${NOTE_TEXT}Later.\n` } }))
  assert.equal(invalid.state, 'committed')
  assert.deepEqual([outcomeOf(invalid, COMMUNITY_PLUGINS_PATH).outcome, outcomeOf(invalid, COMMUNITY_PLUGINS_PATH).blocking], ['settings-invalid', false])
  assert.equal(world.read(COMMUNITY_PLUGINS_PATH).toString(), '{"dataview":true}')
  assert.equal(world.read(NOTE).toString(), `${NOTE_TEXT}Later.\n`)
})

test('whatever occupies a plugin path is displaced to recovery, never lost, and never holds the view back; a new plugin version replaces its files', needsExchange, async (t) => {
  const world = publicationWorld(t)
  assert.equal((await world.publish(pluginViewOf('gen-0001'))).state, 'committed')
  // The person edits main.js; an older release left another styles.css; something made data.json a directory.
  const edited = Buffer.from(`${fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8')}\n// edited by hand\n`)
  fs.writeFileSync(world.full(`${PLUGIN_DIRECTORY}/main.js`), edited)
  fs.writeFileSync(world.full(`${PLUGIN_DIRECTORY}/styles.css`), '/* an earlier release */\n')
  fs.rmSync(world.full(PLUGIN_DATA_PATH))
  fs.mkdirSync(world.full(PLUGIN_DATA_PATH))
  const result = await world.publish(pluginViewOf('gen-0002', { notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } }))
  assert.equal(result.state, 'committed', 'no plugin file holds the notes back')
  assert.equal(world.read(NOTE).toString(), `${NOTE_TEXT}Second.\n`)
  assert.deepEqual([outcomeOf(result, `${PLUGIN_DIRECTORY}/main.js`).outcome, outcomeOf(result, `${PLUGIN_DIRECTORY}/styles.css`).outcome], ['published', 'published'])
  assert.deepEqual([outcomeOf(result, PLUGIN_DATA_PATH).outcome, outcomeOf(result, PLUGIN_DATA_PATH).blocking], ['path-unsafe', false])
  assert.ok(world.read(`${PLUGIN_DIRECTORY}/main.js`).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'))))
  const recovered = world.recovered()
  assert.ok(recovered.some((bytes) => bytes.equals(edited)), 'the hand edit is kept in recovery')
  assert.ok(recovered.some((bytes) => bytes.toString() === '/* an earlier release */\n'), 'the earlier file is kept in recovery')
  assert.equal(result.notes.some((entry) => entry.blocking), false)
  assert.deepEqual(world.staged(), [], 'the candidate of the path left for a person is retired, not left in staging')

  // A later plugin version: its files replace these through the exchange, and the ones they replace are kept.
  const source = readPluginSource()
  const newer = { version: '1.0.1', files: source.files.map((file) => (file.name === 'main.js' ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from('\n// 1.0.1\n')]) } : file)) }
  const upgraded = await world.publish(pluginViewOf('gen-0003', { source: newer, notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } }))
  assert.equal(upgraded.state, 'committed')
  assert.equal(outcomeOf(upgraded, `${PLUGIN_DIRECTORY}/main.js`).outcome, 'published')
  assert.ok(world.read(`${PLUGIN_DIRECTORY}/main.js`).toString().endsWith('// 1.0.1\n'))
  assert.ok(world.recovered().some((bytes) => bytes.equals(fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js')))), 'the replaced version is kept in recovery')
  assert.equal(world.store.readCurrentManifest().ext[OBSIDIAN_EXT_KEY].settings.pluginOwned.version, '1.0.1')
})

test('a plugin file another writer changes under a publication is a race: the view is tried again and then converges, and nothing is lost', needsExchange, async (t) => {
  const world = publicationWorld(t)
  assert.equal((await world.publish(pluginViewOf('gen-0001'))).state, 'committed')
  const target = `${PLUGIN_DIRECTORY}/styles.css`
  fs.writeFileSync(world.full(target), '/* an earlier release */\n')
  // An app that answers for this vault, and a writer that lands between the look at the file and its exchange.
  const racing = createEditorAdapter({
    processProbe: () => 'running',
    call: async (payload) => {
      if (payload.op === 'inspect' && payload.path === target) fs.writeFileSync(world.full(target), '/* written meanwhile */\n')
      return runInProcess(payload, createInProcessHost())
    },
  })
  const raced = await world.publish(pluginViewOf('gen-0002'), racing)
  assert.equal(raced.state, 'updating', 'not committed: the plugin file did not get its bytes')
  assert.deepEqual([outcomeOf(raced, target).outcome, outcomeOf(raced, target).blocking], ['plugin-file-changed', true])
  assert.equal(world.read(target).toString(), '/* written meanwhile */\n', 'the later writer\'s bytes are where it put them')
  assert.equal(raced.notes.some((entry) => ['edit-kept', 'disk-changed'].includes(entry.outcome)), false, 'nothing reads a plugin file as an edit of a note')
  const again = await world.publish(pluginViewOf('gen-0002'), racing)
  assert.equal(again.state, 'committed')
  assert.ok(world.read(target).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, 'styles.css'))))
  assert.ok(world.recovered().some((bytes) => bytes.toString() === '/* written meanwhile */\n'), 'the replaced bytes are kept')
})

test('the community list is written only over the bytes the decision was made on; withheld, it is never touched', needsExchange, async (t) => {
  const world = publicationWorld(t)
  fs.mkdirSync(world.full('.obsidian'), { recursive: true })
  const theirs = Buffer.from(JSON.stringify(['dataview']))
  fs.writeFileSync(world.full(COMMUNITY_PLUGINS_PATH), theirs)

  // Owned from exactly these bytes, and they have not changed: the entry is appended to them.
  const owned = pluginViewOf('gen-0001', { community: { entry: 'owned', existing: theirs } })
  const pinned = owned.manifest.ext[OBSIDIAN_EXT_KEY].settings
  assert.deepEqual([pinned.policyOwned[1].expectedDigest, pinned.pluginOwned.entry], [digest(theirs), 'owned'])
  assert.equal((await world.publish(owned)).state, 'committed')
  assert.deepEqual(JSON.parse(world.read(COMMUNITY_PLUGINS_PATH)), ['dataview', PLUGIN_ID])

  // Prepared while the list held the entry; the person turned the plugin off before the publication ran. The decision
  // was made on bytes that are gone: nothing is written over the person's change, and the view is tried again.
  const seen = world.read(COMMUNITY_PLUGINS_PATH)
  const stale = pluginViewOf('gen-0002', { community: { entry: 'owned', existing: seen }, notes: { [NOTE]: `${NOTE_TEXT}Two.\n` } })
  const turnedOff = Buffer.from(JSON.stringify(['dataview']))
  fs.writeFileSync(world.full(COMMUNITY_PLUGINS_PATH), turnedOff)
  const raced = await world.publish(stale)
  assert.equal(raced.state, 'updating')
  assert.deepEqual([outcomeOf(raced, COMMUNITY_PLUGINS_PATH).outcome, outcomeOf(raced, COMMUNITY_PLUGINS_PATH).blocking], ['settings-changed', true])
  assert.ok(world.read(COMMUNITY_PLUGINS_PATH).equals(turnedOff), 'the person\'s change stands')
  assert.equal(world.read(NOTE).toString(), `${NOTE_TEXT}Two.\n`, 'the notes are published all the same')

  // Absent when prepared, and still absent: the list is created. Present by now: the person made it meanwhile, so it is left.
  fs.rmSync(world.full(COMMUNITY_PLUGINS_PATH))
  const absent = pluginViewOf('gen-0002', { community: { entry: 'owned', existing: null }, notes: { [NOTE]: `${NOTE_TEXT}Two.\n` } })
  fs.writeFileSync(world.full(COMMUNITY_PLUGINS_PATH), '["calendar"]')
  const appeared = await world.publish(absent)
  assert.deepEqual([appeared.state, outcomeOf(appeared, COMMUNITY_PLUGINS_PATH).outcome], ['updating', 'settings-changed'])
  assert.equal(world.read(COMMUNITY_PLUGINS_PATH).toString(), '["calendar"]')

  // Withheld (the person turned the plugin off in this vault): the list is not carried, not pinned and not touched.
  const withheld = pluginViewOf('gen-0002', { community: { entry: 'withheld', reason: 'turned-off-in-this-vault' }, notes: { [NOTE]: `${NOTE_TEXT}Two.\n` } })
  assert.equal(withheld.files.some((file) => file.path === COMMUNITY_PLUGINS_PATH), false)
  assert.deepEqual(withheld.manifest.ext[OBSIDIAN_EXT_KEY].settings.policyOwned.map((entry) => entry.path), [POLICY_SETTINGS_PATH])
  assert.deepEqual([withheld.manifest.ext[OBSIDIAN_EXT_KEY].settings.pluginOwned.entry, withheld.manifest.ext[OBSIDIAN_EXT_KEY].settings.pluginOwned.withheldBecause], ['withheld', 'turned-off-in-this-vault'])
  const left = await world.publish(withheld)
  assert.equal(left.state, 'committed')
  assert.equal(outcomeOf(left, COMMUNITY_PLUGINS_PATH), undefined)
  assert.equal(world.read(COMMUNITY_PLUGINS_PATH).toString(), '["calendar"]')
  assert.throws(() => prepareSettings({ plugin: { files: [], ownership: {}, community: { entry: 'owned' } } }), (error) => error.code === 'invalid-settings', 'owned from bytes it does not name')
  assert.throws(() => prepareSettings({ plugin: { files: [], ownership: {}, community: { entry: 'maybe' } } }), (error) => error.code === 'invalid-settings')
})

test('while the plugin is off in a vault, the plugin files still there are kept current and a removed one is never made again', needsExchange, async (t) => {
  const world = publicationWorld(t)
  assert.equal((await world.publish(pluginViewOf('gen-0001'))).state, 'committed')
  // The person uninstalled the plugin in Obsidian: its folder is gone. Then only data.json came back somehow.
  fs.rmSync(world.full(PLUGIN_DIRECTORY), { recursive: true })
  const off = { community: { entry: 'withheld', reason: 'turned-off-in-this-vault' }, onlyIfPresent: true }
  const gone = await world.publish(pluginViewOf('gen-0002', { ...off, keep: [], notes: { [NOTE]: `${NOTE_TEXT}Two.\n` } }))
  assert.equal(gone.state, 'committed')
  assert.equal(fs.existsSync(world.full(PLUGIN_DIRECTORY)), false, 'the folder the person removed stays removed')

  // Prepared while main.js and styles.css were there; styles.css was removed before the publication ran: it is not made
  // again, and main.js, still there, is kept current.
  fs.mkdirSync(world.full(PLUGIN_DIRECTORY), { recursive: true })
  fs.writeFileSync(world.full(`${PLUGIN_DIRECTORY}/main.js`), '// an older release\n')
  const racing = pluginViewOf('gen-0003', { ...off, keep: [`${PLUGIN_DIRECTORY}/main.js`, `${PLUGIN_DIRECTORY}/styles.css`], notes: { [NOTE]: `${NOTE_TEXT}Three.\n` } })
  const updated = await world.publish(racing)
  assert.equal(updated.state, 'committed')
  assert.deepEqual([outcomeOf(updated, `${PLUGIN_DIRECTORY}/main.js`).outcome, outcomeOf(updated, `${PLUGIN_DIRECTORY}/styles.css`).outcome], ['published', 'left-absent'])
  assert.ok(world.read(`${PLUGIN_DIRECTORY}/main.js`).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'))), 'a file still there is kept current')
  assert.equal(world.read(`${PLUGIN_DIRECTORY}/styles.css`), null)
  assert.equal(world.read(PLUGIN_DATA_PATH), null)
  assert.ok(world.recovered().some((bytes) => bytes.toString() === '// an older release\n'))
  const journal = JSON.parse(fs.readFileSync(path.join(world.store.journalsRoot, world.store.readCurrent().journalId, 'header.json'), 'utf8'))
  assert.equal(JSON.stringify(journal).includes('left-absent') || JSON.stringify(journal).includes('leave-absent'), false, 'a file left absent is no unit of the journal')
})

test('the bearer goes into a private vault root only: a vault Atelier placed is made private, any other root keeps the data file out', needsExchange, async (t) => {
  if (process.platform === 'win32') return t.skip('permission bits')
  const managed = publicationWorld(t)
  fs.chmodSync(managed.store.vaultRoot, 0o755)
  assert.equal((await managed.publish(pluginViewOf('gen-0001'))).state, 'committed')
  assert.equal(fs.statSync(managed.store.vaultRoot).mode & 0o777, 0o700, 'tightened before the bearer was written')
  assert.ok(managed.read(PLUGIN_DATA_PATH))

  const outside = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-open-vault-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.chmodSync(outside, 0o755)
  const named = publicationWorld(t, { vaultRoot: outside })
  const result = await named.publish(pluginViewOf('gen-0001'))
  assert.equal(result.state, 'committed', 'the notes and the rest of the plugin are published')
  assert.deepEqual([outcomeOf(result, PLUGIN_DATA_PATH).outcome, outcomeOf(result, PLUGIN_DATA_PATH).reason, outcomeOf(result, PLUGIN_DATA_PATH).blocking], ['vault-not-private', 'vault-root-not-private', false])
  assert.equal(named.read(PLUGIN_DATA_PATH), null, 'no bearer in a vault others can read')
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755, 'a vault root Atelier did not place is never changed')
  assert.ok(named.read(`${PLUGIN_DIRECTORY}/main.js`))
  assert.equal(named.recovered().some((bytes) => bytes.includes('b'.repeat(43))), false, 'nor a copy of it anywhere in recovery')
})

// ---------------------------------------------------------------------------
// 5. The maintenance service: it publishes the plugin, holds its channel, and
//    a live plugin's app version is the checked one
// ---------------------------------------------------------------------------

const START = Date.parse('2026-01-05T10:00:00.000Z')
const TEST_SERVICE_ENTRY = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs')
const CONSENT = { actor: 'test-suite', coverage: 'service' }
const fixedRandom = (size) => Buffer.alloc(size, 0x0a)
const note = ({ id, title, body }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`

// One project with one repository and one view, its private state under a temporary data root, and its service in this process.
function serviceWorld(t) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-service-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  const files = {
    'harbor/notes/plan.md': note({ id: 'harbor:plan', title: 'Harbor plan', body: 'The harbor opens at dawn. See the [tide table](tides.md).' }),
    'harbor/notes/tides.md': note({ id: 'harbor:tides', title: 'Tide table', body: 'High water at noon.' }),
  }
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  fs.mkdirSync(path.join(projectDir, 'harbor', '.git'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  writeJson(configPath, {
    schema: 'mnstry.atelier-project-config@v1', name: 'plugin-fixture', roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'harbor', path: 'harbor', readBoundary: 'team' }],
    ext: { [OBSIDIAN_EXT_KEY]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [{ scopeId: SCOPE, mode: 'full', selector: { all: true } }] } },
  })
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: { harbor: { readBoundary: 'team' } } })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  const project = loadProject()
  const pointer = ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
  assert.equal(pointer.workspaceId, WORKSPACE_ID)
  const requested = workspaceStateRoot(dataRoot, WORKSPACE_ID)
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
  const workspaceRoot = fs.realpathSync(requested)
  writeMachineSettings({ workspaceRoot, workspaceId: WORKSPACE_ID, repositoryRoots: protectedRoots(project), settings: { schema: 'atelier-obsidian-machine-settings/v1', workspaceId: WORKSPACE_ID, maintenanceMode: 'manual', audienceAllow: ['team'], applyPolicy: null, updatedAt: new Date(START).toISOString() } })
  let nowMs = START
  const world = {
    dir, projectDir, dataRoot, configPath, env, loadProject, workspaceRoot,
    clock: () => new Date(nowMs),
    advance: (ms) => { nowMs += ms },
    vault: path.join(workspaceRoot, 'vaults', SCOPE),
    source: (relative) => path.join(projectDir, relative),
    freshness: () => createMaintenanceStateStore({ workspaceRoot, workspaceId: WORKSPACE_ID }).readFreshness().scopes.find((entry) => entry.scopeId === SCOPE),
    async service({ adapterFactory = () => absentAdapter(), appStatus, seams = {} } = {}) {
      const port = await freePort()
      writeServiceSettings({ workspaceRoot, workspaceId: WORKSPACE_ID, settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, consent: { grantedAt: new Date(START).toISOString(), ...CONSENT }, updatedAt: new Date(START).toISOString() } })
      const service = await runMaintenanceService({
        loadProject, dataRoot, env, adapterFactory, entryPath: TEST_SERVICE_ENTRY, intervalMs: 60 * 60 * 1000, clock: world.clock,
        engineOptions: { quietPeriodMs: 0, watcherFactory: () => ({ close() {} }), randomBytes: fixedRandom, seams }, ...(appStatus ? { appStatus } : {}),
      })
      t.after(() => service.shutdown('test-teardown'))
      world.port = port
      world.record = readServiceRecord({ workspaceRoot, workspaceId: WORKSPACE_ID })
      return service
    },
    statusDocument: async () => (await requestLoopback({ host: '127.0.0.1', port: world.port, method: 'GET', path: '/status', bearer: world.record.ext.bearer })).body,
    // Atelier's plugin, loaded from the vault the service published, in the stand-in app.
    plugin({ apiVersion = '1.13.7' } = {}) {
      const fake = fakeObsidian({ apiVersion })
      const source = fs.readFileSync(path.join(world.vault, PLUGIN_DIRECTORY, 'main.js'), 'utf8')
      const Plugin = loadPluginClass(fake, { source })
      const plugin = new Plugin(fakeApp(world.vault, fake.record), JSON.parse(fs.readFileSync(path.join(world.vault, PLUGIN_DIRECTORY, 'manifest.json'), 'utf8')))
      t.after(() => { try { plugin.unload() } catch { /* already unloaded */ } })
      return { plugin, fake, statusBar: () => fake.record.statusBars.at(-1).text }
    },
    async run(argv, { seams }) {
      const out = []
      const exit = await runObsidianCommandForOracleTests({ argv: [...argv, `--project=${configPath}`, `--data-root=${dataRoot}`], seams, env, cwd: projectDir, clock: world.clock, contributions: [], probeTimeoutMs: 1500, stdout: (text) => out.push(text), stderr: () => {} })
      return { exit, json: JSON.parse(out.join('\n')) }
    },
  }
  return world
}

test('the service publishes the plugin into the vault it maintains, and the plugin it published holds the view open', needsExchange, async (t) => {
  const world = serviceWorld(t)
  const reports = []
  const service = await world.service({ adapterFactory: (input) => { reports.push(input.pluginReport); return absentAdapter() } })
  const first = await service.tickNow()
  assert.ok(first.ok, JSON.stringify(first))
  assert.equal(world.freshness().state, 'current', 'the plugin files are part of a verified generation')
  for (const name of PLUGIN_SOURCE_FILES) assert.ok(fs.readFileSync(path.join(world.vault, PLUGIN_DIRECTORY, name)).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, name))), name)
  const data = JSON.parse(fs.readFileSync(path.join(world.vault, PLUGIN_DATA_PATH), 'utf8'))
  const bearers = readPluginBearers({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID })
  assert.deepEqual(data, { schema: PLUGIN_DATA_SCHEMA, channel: { host: '127.0.0.1', port: world.port }, scopeId: SCOPE, bearer: bearers.get(SCOPE) }, 'the data file names this listener and the view\'s bearer')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(world.vault, COMMUNITY_PLUGINS_PATH), 'utf8')), [PLUGIN_ID])
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(world.vault).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(world.vault, PLUGIN_DATA_PATH)).mode & 0o777, 0o600)
  }
  assert.deepEqual(reports, [null], 'no plugin held the view while it was published')
  // Nothing of the bearer reaches the status of the service or its log.
  const before = await world.statusDocument()
  assert.deepEqual(before.plugins, { schema: 'atelier-obsidian-plugin-presence/v1', leaseTtlMs: PLUGIN_LEASE_TTL_MS, scopes: [{ scopeId: SCOPE, present: false, sessions: 0, entry: 'on' }] }, 'the entry was offered and confirmed in place')
  assert.equal(JSON.stringify(before).includes(bearers.get(SCOPE)), false)

  const { plugin, statusBar } = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBar(), 'Atelier: current')
  const during = await world.statusDocument()
  assert.deepEqual(during.plugins.scopes, [{ scopeId: SCOPE, present: true, sessions: 1, appVersion: '1.13.7', pluginVersion: shippedManifest().version, renewedAt: during.plugins.scopes[0].renewedAt, entry: 'on' }])
  for (const word of [world.dir, world.vault, bearers.get(SCOPE), 'notes/', '.md']) assert.equal(JSON.stringify(during).includes(word), false, `status carries ${word}`)

  // A change at the source: the next publication is made while the plugin holds the view, and the adapter factory is told its app version.
  fs.appendFileSync(world.source('harbor/notes/tides.md'), '\nLow water at six.\n')
  world.advance(1000)
  const second = await service.tickNow()
  assert.ok(second.ok)
  assert.deepEqual(reports.at(-1), { scopeId: SCOPE, appVersion: '1.13.7', pluginVersion: shippedManifest().version, sessions: 1, renewedAt: reports.at(-1).renewedAt })
  await plugin.cycle()
  assert.equal(statusBar(), 'Atelier: current')

  plugin.unload()
  await waitFor(async () => (await world.statusDocument()).plugins.scopes[0].present === false, { label: 'the released lease' })
})

test('qualification: a live plugin\'s version is the checked version and the probe is not asked; below the floor it refuses; without a plugin the probe decides', () => {
  const built = []
  const asked = []
  const factory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => { asked.push(1); return { installed: true, cli: true, running: true, version: null, noVaultOpen: true } } }, createAdapter: (input) => { built.push(input.qualification); return { kind: 'fake' } } })
  const report = (appVersion) => ({ scopeId: SCOPE, appVersion, pluginVersion: '1.0.0', sessions: 1, renewedAt: '2026-01-05T10:00:00.000Z' })
  factory({ scope: { scopeId: SCOPE }, pluginReport: report('1.13.7') })
  assert.deepEqual(built.at(-1), { floor: MINIMUM_APP_VERSION, version: '1.13.7', running: true, versionSource: 'plugin', outcome: 'qualified', reason: 'plugin-reported', versionChecked: true })
  assert.deepEqual(asked, [], 'no command-line call: the plugin runs inside that app')
  assert.equal(factory.lastQualification().reason, 'plugin-reported')
  assert.throws(() => factory({ scope: { scopeId: SCOPE }, pluginReport: report('1.13.6') }), (error) => error.code === 'app-version-unsupported' && error.detail.reason === 'below-minimum-version')
  assert.throws(() => factory({ scope: { scopeId: SCOPE }, pluginReport: { scopeId: SCOPE } }), (error) => error.code === 'app-version-unsupported' && error.detail.reason === 'version-unknown', 'a report without a version is not an app that is missing')
  assert.deepEqual(asked, [])
  // Without a plugin, the command-line tool decides, as before: with no vault open it cannot tell the version.
  assert.throws(() => factory({ scope: { scopeId: SCOPE }, pluginReport: null }), (error) => error.code === 'app-version-unsupported' && error.detail.reason === 'no-vault-open')
  assert.deepEqual(asked, [1])
  assert.equal(factory.lastQualification().reason, 'no-vault-open')
  // The plugin's answer is never reused for a call without one.
  assert.throws(() => factory({ scope: { scopeId: SCOPE } }), (error) => error.detail.reason === 'no-vault-open')
  assert.deepEqual(qualifyApp({ versionSource: 'plugin', version: '1.14.2' }).reason, 'plugin-reported')
  assert.deepEqual(qualifyApp({ versionSource: 'plugin', version: 'soon' }).reason, 'version-unreadable')
})

test('status and open report the plugin, and open takes the app version from it where the command-line tool cannot tell', needsExchange, async (t) => {
  const world = serviceWorld(t)
  const service = await world.service()
  await service.tickNow()
  // The app runs with a vault open that the command-line tool does not answer for: it says "Vault not found.".
  const launches = []
  const seams = {
    appProbe: { inspect: async () => ({ installed: true, cli: true, running: true, version: null, noVaultOpen: true }), vaultState: async () => ({ answered: true, indexReady: true }) },
    launcher: { open: async ({ vaultRoot }) => { launches.push(vaultRoot); return { launched: true, reason: 'fake' } } },
    service: { entryPath: TEST_SERVICE_ENTRY, spawn() { throw new Error('a service was started') } },
  }
  const without = await world.run(['open', '--json', '--consent-actor', CONSENT.actor], { seams })
  assert.deepEqual([without.json.outcome, without.json.reason, without.json.plugin], ['app-version-unsupported', 'no-vault-open', { present: false, reason: 'no-live-lease' }])
  const quiet = await world.run(['status', '--json'], { seams })
  assert.deepEqual(quiet.json.scopes[0].plugin, { present: false, reason: 'no-live-lease' })

  const { plugin } = world.plugin()
  await plugin.load()
  await plugin.cycle()
  const status = await world.run(['status', '--json'], { seams })
  assert.deepEqual(status.json.scopes[0].plugin, { present: true, reason: 'live-lease', appVersion: '1.13.7', pluginVersion: shippedManifest().version, sessions: 1 })
  const opened = await world.run(['open', '--json', '--consent-actor', CONSENT.actor], { seams })
  assert.deepEqual([opened.exit, opened.json.outcome, opened.json.app.outcome, opened.json.app.reason, opened.json.app.version], [0, 'current', 'qualified', 'plugin-reported', '1.13.7'])
  assert.deepEqual(opened.json.plugin, { present: true, reason: 'live-lease', appVersion: '1.13.7', pluginVersion: shippedManifest().version, sessions: 1 })
  assert.deepEqual(launches, [fs.realpathSync(world.vault)])

  // A service that is not running reports no plugin, whatever was open before.
  plugin.unload()
  await service.shutdown('test')
  const stopped = await world.run(['status', '--json'], { seams })
  assert.deepEqual(stopped.json.scopes[0].plugin, { present: false, reason: 'service-not-running' })
})

// Seams for the command that must not reach an app or start a service.
const QUIET_SEAMS = Object.freeze({
  appProbe: { inspect() { throw new Error('the app probe was reached') }, vaultState() { throw new Error('the app probe was reached') } },
  launcher: { open() { throw new Error('the launcher was reached') } },
  service: { entryPath: TEST_SERVICE_ENTRY, spawn() { throw new Error('a service was started') } },
})

function choiceWorld(world) {
  const list = path.join(world.vault, COMMUNITY_PLUGINS_PATH)
  return {
    list,
    listed: () => JSON.parse(fs.readFileSync(list, 'utf8')),
    choice: () => { const { state, reason } = readPluginChoice({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE }); return [state, reason] },
    pluginFiles: () => (fs.existsSync(path.join(world.vault, PLUGIN_DIRECTORY)) ? fs.readdirSync(path.join(world.vault, PLUGIN_DIRECTORY)).sort() : null),
    pinned: () => createRecoveryStore({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [] }).readCurrentManifest().ext[OBSIDIAN_EXT_KEY].settings,
  }
}

test('a person who turns the plugin off in a vault is followed: the entry is not added back, a removed folder is not made again, status says so, and both ways back work', needsExchange, async (t) => {
  const world = serviceWorld(t)
  const service = await world.service()
  const vault = choiceWorld(world)
  const change = async (line) => {
    fs.appendFileSync(world.source('harbor/notes/tides.md'), `\n${line}\n`)
    world.advance(1000)
    const tick = await service.tickNow()
    assert.ok(tick.ok, JSON.stringify(tick))
    assert.equal(world.freshness().state, 'current', `after "${line}"`)
  }

  // The first publication offers the entry; once it is in place it is confirmed, and from then on its absence is a decision.
  await service.tickNow()
  assert.deepEqual(vault.listed(), [PLUGIN_ID])
  assert.deepEqual(vault.choice(), ['on', 'entry-confirmed'])

  // The person uninstalls the plugin in Obsidian: its entry leaves the list and its folder is deleted.
  fs.writeFileSync(vault.list, JSON.stringify(['dataview'], null, 2))
  fs.rmSync(path.join(world.vault, PLUGIN_DIRECTORY), { recursive: true })
  const theirs = fs.readFileSync(vault.list)
  await change('Low water at six.')
  assert.deepEqual(vault.choice(), ['off', 'entry-removed-by-person'])
  assert.ok(fs.readFileSync(vault.list).equals(theirs), 'the list is left exactly as the person wrote it')
  assert.equal(vault.pluginFiles(), null, 'the folder the person removed is not made again')
  assert.deepEqual([vault.pinned().pluginOwned.entry, vault.pinned().pluginOwned.withheldBecause, vault.pinned().pluginOwned.files, vault.pinned().policyOwned.map((entry) => entry.path)], ['withheld', 'turned-off-in-this-vault', [], [POLICY_SETTINGS_PATH]])
  const status = await world.run(['status', '--json'], { seams: QUIET_SEAMS })
  assert.deepEqual(status.json.scopes[0].plugin, { present: false, reason: 'turned-off-in-this-vault', next: turnPluginOnNext(SCOPE) })
  assert.equal((await world.statusDocument()).plugins.scopes[0].entry, 'off')
  const shown = await world.run(['plugin', 'show', '--json'], { seams: QUIET_SEAMS })
  assert.deepEqual([shown.exit, shown.json.plugins[0].choice.state, shown.json.plugins[0].presence.reason], [0, 'off', 'turned-off-in-this-vault'])
  await change('Slack water at three.')
  assert.ok(fs.readFileSync(vault.list).equals(theirs), 'nor at any later publication')
  assert.equal(vault.pluginFiles(), null)

  // The first way back: `atelier obsidian plugin on`. The view's next publication brings the entry and the files back.
  const on = await world.run(['plugin', 'on', '--json'], { seams: QUIET_SEAMS })
  assert.deepEqual([on.exit, on.json.choice.state, on.json.takesEffect], [0, 'requested', 'next-publication'])
  await change('High water at noon again.')
  assert.deepEqual(vault.listed(), ['dataview', PLUGIN_ID])
  assert.deepEqual(vault.pluginFiles(), [...PLUGIN_SOURCE_FILES, 'data.json'].sort())
  assert.deepEqual(vault.choice(), ['on', 'entry-confirmed'])

  // Off again, this time only turned off in the settings: the folder stays, and its files are kept current.
  fs.writeFileSync(vault.list, JSON.stringify(['dataview']))
  fs.writeFileSync(path.join(world.vault, PLUGIN_DIRECTORY, 'main.js'), '// an older release\n')
  await change('Neap tide next week.')
  assert.deepEqual(vault.choice(), ['off', 'entry-removed-by-person'])
  assert.deepEqual(vault.listed(), ['dataview'])
  assert.ok(fs.readFileSync(path.join(world.vault, PLUGIN_DIRECTORY, 'main.js')).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'))), 'a plugin file still there is kept current')

  // The second way back: the person turns it on in Obsidian, which lists it again.
  fs.writeFileSync(vault.list, JSON.stringify(['dataview', PLUGIN_ID]))
  await change('Spring tide after that.')
  assert.deepEqual(vault.choice(), ['on', 'entry-restored-by-person'])
  assert.deepEqual(vault.listed(), ['dataview', PLUGIN_ID])
  assert.equal((await world.run(['status', '--json'], { seams: QUIET_SEAMS })).json.scopes[0].plugin.reason, 'no-live-lease')
})

test('a change the person makes to the list while a publication runs is never written over; the next preparation reads it as their decision', needsExchange, async (t) => {
  const world = serviceWorld(t)
  let during = null
  // Runs between the view's preparation and its publication: the person turns the plugin off just then.
  const service = await world.service({ seams: { publishView: async (input) => { if (during) { during(); during = null } return publishView(input) } } })
  const vault = choiceWorld(world)
  await service.tickNow()
  assert.deepEqual(vault.choice(), ['on', 'entry-confirmed'])

  during = () => fs.writeFileSync(vault.list, '[]')
  fs.appendFileSync(world.source('harbor/notes/tides.md'), '\nLow water at six.\n')
  world.advance(1000)
  assert.ok((await service.tickNow()).ok)
  assert.deepEqual([world.freshness().state, world.freshness().reason], ['publisher-conflict', 'settings-changed'], 'held: the list changed under the publication')
  assert.equal(fs.readFileSync(vault.list, 'utf8'), '[]', 'the entry is not written back over the change')
  assert.deepEqual(vault.choice(), ['on', 'entry-confirmed'], 'nothing is decided from a change seen in passing')

  // The view is tried again at the next full reconciliation; its preparation reads the list as it is now.
  world.advance(5 * 60 * 1000)
  assert.ok((await service.tickNow()).ok)
  assert.deepEqual(vault.choice(), ['off', 'entry-removed-by-person'])
  assert.equal(fs.readFileSync(vault.list, 'utf8'), '[]')
  assert.equal(world.freshness().state, 'current')
})

test('the plugin supplies the version only: an app without the command-line capability, or a probe that fails, is reported as before', async () => {
  const live = { present: true, reason: 'live-lease', appVersion: '1.13.7', pluginVersion: '1.0.0', sessions: 1 }
  const probe = (observation) => ({ inspect: async () => { if (observation instanceof Error) throw observation; return observation }, vaultState: async () => ({ answered: true, indexReady: true }) })
  const qualified = async (observation, presence) => qualifyApp(await inspectApp(withPluginReportedVersion(probe(observation), async () => presence)), { requireVersion: true })
  assert.equal((await qualified({ installed: true, cli: true, running: true, version: null, noVaultOpen: true }, live)).reason, 'plugin-reported')
  assert.equal((await qualified({ installed: true, cli: true, running: true, version: '1.13.7' }, null)).reason, 'meets-minimum-version')
  assert.equal((await qualified({ installed: true, cli: false, running: true, version: null }, live)).reason, 'cli-capability-absent')
  assert.equal((await qualified({ installed: false, cli: false, running: null, version: null }, live)).reason, 'no-app-found')
  assert.equal((await qualified(new Error('probe failed'), live)).reason, 'no-app-found')
  assert.equal((await qualified({ installed: true, cli: true, running: true, version: null }, Promise.reject(new Error('status unreadable')))).reason, 'version-unknown')
  assert.deepEqual(pluginPresenceOf(null, SCOPE), { present: false, reason: 'service-not-running' })
  assert.deepEqual(pluginPresenceOf({ schema: 'atelier-obsidian-service-status/v1' }, SCOPE), { present: false, reason: 'service-reports-no-plugin-channel' })
  assert.deepEqual(pluginPresenceOf({ plugins: { scopes: [{ scopeId: 'scope-other', present: true, appVersion: '1.13.7' }] } }, SCOPE), { present: false, reason: 'no-live-lease' })
})

// ---------------------------------------------------------------------------
// 6. Opt-in: a real, isolated Obsidian. Opens a desktop application window;
//    never runs by default.
// ---------------------------------------------------------------------------

const REAL_APP = process.env.ATELIER_OBSIDIAN_PLUGIN === '1'
const realApp = { skip: !REAL_APP && 'set ATELIER_OBSIDIAN_PLUGIN=1 (and ATELIER_OBSIDIAN_ASAR to the pinned app archive) on a desktop host with Obsidian installed; opens an application window', timeout: 600000 }

// Every process started with exactly this profile directory, and nothing else.
function processesOfProfile(profile) {
  const table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return table.split('\n').map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .filter(([, , command]) => command.endsWith(`--user-data-dir=${profile}`) || command.includes(`--user-data-dir=${profile} `))
    .map(([, pid]) => Number(pid))
}

// A disposable instance (private HOME, private profile, mock keychain, the
// pinned app archive when ATELIER_OBSIDIAN_ASAR names one) and a disposable
// workspace whose service published its vault before the app started. The
// isolated app is the only app that can hold this vault: it is registered in
// that profile alone, so the process reading and the version reading below are
// of that instance, reached through its private HOME.
async function realAppWorld(t) {
  const { createLayout, Instance } = await import('../experiments/obsidian-publication/lib/instance.mjs')
  const appDir = process.env.ATELIER_OBSIDIAN_APP_DIR || '/Applications/Obsidian.app/Contents/MacOS'
  const cliPath = path.join(appDir, 'obsidian-cli')
  const layout = createLayout()
  const trace = []
  const real = { layout, trace, instance: null, appRunning: false, versionCalls: [], probes: [] }
  real.note = (event, detail = {}) => { trace.push({ at: new Date().toISOString(), event, ...detail }); t.diagnostic(`${event} ${JSON.stringify(detail)}`) }
  // End exactly this instance: every process started with its profile directory, and nothing else.
  t.after(async () => {
    if (real.instance) await real.instance.quit()
    for (const pid of processesOfProfile(layout.profile)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    t.diagnostic(`isolated instance processes left: ${processesOfProfile(layout.profile).length}`)
    if (process.env.ATELIER_OBSIDIAN_PLUGIN_KEEP !== '1') fs.rmSync(layout.root, { recursive: true, force: true })
    else t.diagnostic(`evidence kept at ${layout.root}`)
  })
  real.world = serviceWorld(t)
  real.adapterFactory = createQualifiedAdapterFactory({
    appProbe: {
      inspectSync() {
        if (!real.appRunning) return { installed: true, cli: true, running: false, version: null }
        const reply = spawnSync(cliPath, ['version'], { env: real.instance.env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' })
        const answer = readVersionAnswer({ stdout: reply.stdout, stderr: reply.stderr, exited: reply.error === undefined && reply.status === 0 })
        real.versionCalls.push(answer)
        return { installed: true, cli: true, running: true, version: answer.version, ...(answer.noVaultOpen ? { noVaultOpen: true } : {}) }
      },
    },
    createAdapter: ({ qualification }) => {
      const adapter = createObsidianCliAdapter({ cliPath, env: real.instance?.env ?? { ...process.env, HOME: layout.home }, processProbe: () => (real.appRunning ? 'running' : 'absent'), qualification })
      const probe = adapter.probe
      adapter.probe = async (input) => { const result = await probe(input); real.probes.push({ state: result.state, qualification: qualification.reason }); return result }
      return adapter
    },
  })
  real.service = await real.world.service({ adapterFactory: real.adapterFactory })
  const first = await real.service.tickNow()
  assert.ok(first.ok, JSON.stringify(first))
  assert.equal(real.world.freshness().state, 'current')
  real.note('published-without-app', { probes: [...real.probes], pluginFiles: fs.readdirSync(path.join(real.world.vault, PLUGIN_DIRECTORY)).sort(), communityPlugins: JSON.parse(fs.readFileSync(path.join(real.world.vault, COMMUNITY_PLUGINS_PATH), 'utf8')) })

  // Register exactly that vault in the isolated profile, the way the desktop harness does, and start the app.
  const profileFile = path.join(layout.profile, 'obsidian.json')
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
  profile.vaults = { atelierg00synthetic: { path: fs.realpathSync(real.world.vault), ts: Date.now(), open: true } }
  fs.writeFileSync(profileFile, JSON.stringify(profile))
  real.instance = new Instance({ ...layout, vault: fs.realpathSync(real.world.vault) })
  await real.instance.launch({ readyTimeoutMs: 60000 })
  real.appRunning = true
  real.appVersion = (await real.instance.version()).trim()
  real.note('app-started', { appVersion: real.appVersion, profileProcesses: processesOfProfile(layout.profile).length })
  real.evaluate = async (code) => {
    const out = await real.instance.cli('eval', `code=${code}`)
    const start = out.indexOf('=> ')
    return start < 0 ? out.trim() : out.slice(start + 3).trim()
  }
  real.prompt = () => waitFor(async () => {
    const text = await real.evaluate("(()=>{const m=document.querySelector('.modal.mod-trust-folder');return m?JSON.stringify({title:m.querySelector('.modal-title')?.textContent??null,buttons:[...m.querySelectorAll('button')].map(b=>b.textContent)}):''})()")
    return text && text !== '' ? JSON.parse(text) : null
  }, { timeoutMs: 30000, everyMs: 500, label: 'the trust prompt' })
  real.pluginLoaded = async () => (await real.evaluate(`String(Boolean(app.plugins.plugins['${PLUGIN_ID}']))`)) === 'true'
  real.statusBar = () => real.evaluate("document.querySelector('.atelier-projection-status-bar')?.textContent ?? ''")
  real.presence = async () => (await real.world.statusDocument()).plugins.scopes[0]
  // A change at the source, published by the service while the app runs.
  real.change = async (line) => {
    fs.appendFileSync(real.world.source('harbor/notes/tides.md'), `\n${line}\n`)
    real.world.advance(1000)
    const tick = await real.service.tickNow()
    assert.ok(tick.ok, JSON.stringify(tick))
    const tides = createRecoveryStore({ workspaceRoot: real.world.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [] }).readCurrentManifest().notes.find((entry) => entry.nodeId === 'harbor:tides').path
    assert.ok(fs.readFileSync(path.join(real.world.vault, tides), 'utf8').includes(line), 'the change reached the vault')
  }
  return real
}

test('real isolated Obsidian: the vault the service published asks for trust, and once trusted the plugin holds it open with the app\'s version', realApp, async (t) => {
  const real = await realAppWorld(t)
  try {
    // The trust prompt, as a person sees it; the plugin does not run yet.
    const prompt = await real.prompt()
    real.note('trust-prompt-shown', prompt)
    assert.equal(prompt.title, 'Do you trust the author of this vault?')
    assert.deepEqual(prompt.buttons, ['Browse vault in Restricted Mode', 'Trust author and enable plugins'])
    assert.equal(await real.pluginLoaded(), false)
    assert.equal((await real.presence()).present, false, 'no plugin runs before trust')

    // Answer it the way a person does: press "Trust author and enable plugins" in that window.
    const pressed = await real.evaluate("(()=>{const b=[...document.querySelectorAll('.modal.mod-trust-folder button')].find(x=>x.textContent==='Trust author and enable plugins');if(!b)return 'no-button';b.click();return 'pressed'})()")
    assert.equal(pressed, 'pressed')
    await waitFor(real.pluginLoaded, { timeoutMs: 30000, everyMs: 250, label: 'the plugin to load' })
    // Trusting opens the community plugin settings; close them so the window shows the vault.
    await real.evaluate('(app.setting.close(),"closed")')
    real.note('trusted', { loaded: true, restrictedMode: await real.evaluate('String(!app.plugins.isEnabled())') })

    const presence = await waitFor(async () => { const scope = await real.presence(); return scope.present ? scope : null }, { timeoutMs: 20000, everyMs: 250, label: 'the lease' })
    real.note('lease-seen-by-service', presence)
    assert.ok(parseAppVersion(real.appVersion), real.appVersion)
    assert.equal(presence.appVersion, real.appVersion.split(/\s+/)[0], 'the version the plugin reports is the app\'s own')
    assert.equal(presence.pluginVersion, shippedManifest().version)
    const statusBar = await waitFor(async () => { const text = await real.statusBar(); return text === 'Atelier: current' ? text : null }, { timeoutMs: 20000, everyMs: 250, label: 'the status bar item' })
    real.note('status-bar', { text: statusBar })

    // A change at the source while the plugin holds the view: published through the app, qualified by the plugin's version.
    const callsBefore = real.versionCalls.length
    await real.change('Low water at six.')
    const qualification = real.adapterFactory.lastQualification()
    real.note('published-with-plugin', { freshness: real.world.freshness().state, reason: real.world.freshness().reason, qualification: { outcome: qualification.outcome, reason: qualification.reason, version: qualification.version }, probe: real.probes.at(-1), versionCallsDuringPublication: real.versionCalls.length - callsBefore })
    assert.deepEqual([qualification.outcome, qualification.reason], ['qualified', 'plugin-reported'])
    assert.equal(real.versionCalls.length, callsBefore, 'the command-line tool was not asked for the version')
    assert.deepEqual(real.probes.at(-1), { state: 'coordinated', qualification: 'plugin-reported' })
    assert.equal(real.world.freshness().state, 'current')
    const after = await waitFor(async () => { const text = await real.statusBar(); return text === 'Atelier: current' ? text : null }, { timeoutMs: 20000, everyMs: 250, label: 'the status bar after publication' })
    real.note('status-bar-after-publication', { text: after })

    // The bearer is rotated: the old one is refused at once, the next publication replaces the data file through the
    // app, and the plugin reads it again and says hello with the new bearer, without a restart.
    const dataFile = path.join(real.world.vault, PLUGIN_DATA_PATH)
    const oldBearer = JSON.parse(fs.readFileSync(dataFile, 'utf8')).bearer
    fs.rmSync(path.join(pluginBearerDirectory(real.world.workspaceRoot), `${SCOPE}.json`))
    await real.change('Slack water at three.')
    const newBearer = JSON.parse(fs.readFileSync(dataFile, 'utf8')).bearer
    assert.notEqual(newBearer, oldBearer)
    assert.equal(readPluginBearers({ workspaceRoot: real.world.workspaceRoot, workspaceId: WORKSPACE_ID }).get(SCOPE), newBearer)
    const rotated = await waitFor(async () => { const scope = await real.presence(); return scope.present ? scope : null }, { timeoutMs: 20000, everyMs: 250, label: 'the lease under the new bearer' })
    const barAfterRotation = await waitFor(async () => { const text = await real.statusBar(); return text === 'Atelier: current' ? text : null }, { timeoutMs: 20000, everyMs: 250, label: 'the status bar after rotation' })
    real.note('bearer-rotated', { dataFileReplacedInApp: real.probes.at(-1), presence: rotated, statusBar: barAfterRotation, freshness: real.world.freshness().state })
    assert.equal(real.probes.at(-1).state, 'coordinated', 'the data file was replaced through the app')

    // The app quits: the vault stops counting as open.
    await real.instance.quit()
    real.appRunning = false
    await waitFor(async () => ((await real.presence()).present === false ? true : null), { timeoutMs: PLUGIN_LEASE_TTL_MS + 10000, everyMs: 250, label: 'the end of the presence' })
    real.note('app-quit', { presenceEnded: true })
  } finally {
    t.diagnostic(`trace ${JSON.stringify(real.trace)}`)
  }
})

test('real isolated Obsidian: in restricted mode nothing runs in the vault and the command-line path publishes as before', realApp, async (t) => {
  const { declineTrustPrompt } = await import('../scripts/obsidian/desktop-receipts.mjs')
  const real = await realAppWorld(t)
  try {
    await real.prompt()
    // The desktop procedures answer the prompt this way: they prove the command-line path.
    assert.equal(await declineTrustPrompt(real.instance), 'declined')
    const state = { restrictedMode: await real.evaluate('String(!app.plugins.isEnabled())'), loaded: await real.pluginLoaded(), prompt: await real.evaluate("String(Boolean(document.querySelector('.modal.mod-trust-folder')))"), statusBarItem: await real.statusBar() }
    real.note('declined', state)
    assert.deepEqual(state, { restrictedMode: 'true', loaded: false, prompt: 'false', statusBarItem: '' })
    await sleep(PLUGIN_RENEW_INTERVAL_MS * 2)
    assert.equal((await real.presence()).present, false, 'no plugin, no lease')

    const callsBefore = real.versionCalls.length
    await real.change('Low water at six.')
    const qualification = real.adapterFactory.lastQualification()
    real.note('published-without-plugin', { freshness: real.world.freshness().state, qualification: { outcome: qualification.outcome, reason: qualification.reason, version: qualification.version }, probe: real.probes.at(-1), versionCallsDuringPublication: real.versionCalls.length - callsBefore })
    assert.deepEqual([qualification.outcome, qualification.reason], ['qualified', 'meets-minimum-version'], 'the version came from the command-line tool, as before')
    assert.ok(real.versionCalls.length > callsBefore)
    assert.deepEqual(real.probes.at(-1), { state: 'coordinated', qualification: 'meets-minimum-version' })
    assert.equal(real.world.freshness().state, 'current')
    await real.instance.quit()
    real.appRunning = false
  } finally {
    t.diagnostic(`trace ${JSON.stringify(real.trace)}`)
  }
})
