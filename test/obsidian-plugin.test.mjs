import assert from 'node:assert/strict'
import crypto, { createHash, randomBytes } from 'node:crypto'
import childProcess, { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// No child of this suite reaches the developer's own Obsidian. The app, its
// command-line tool, an app link, and anything that takes the command-line
// adapter or loads the production app seams run only with a private HOME: the
// tool finds the app through a socket under HOME. The real-app tests give each
// disposable instance its own; an attempt with the developer's HOME throws
// here instead of running.
const REACHES_THE_APP = [/obsidian-cli/, /\/Obsidian$/, /--adapter=obsidian-cli/, /app-production-seams/, /obsidian:\/\//i]
const REAL_HOMES = [os.homedir(), process.env.HOME].filter((home) => typeof home === 'string' && home !== '').map((home) => path.resolve(home))
function guardSpawn(command, args, options) {
  const words = [command, ...(Array.isArray(args) ? args : [])].map(String)
  const home = options?.env ? options.env.HOME : process.env.HOME
  if (words.some((word) => REACHES_THE_APP.some((pattern) => pattern.test(word))) && (typeof home !== 'string' || home === '' || REAL_HOMES.includes(path.resolve(home)))) {
    throw new Error('spawn guard: a child that can reach a running Obsidian needs a private HOME, never the developer\'s own')
  }
}
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  // exec and execSync take one shell line, and their options come second.
  const check = (command, args, rest) => (method === 'exec' || method === 'execSync' ? guardSpawn('sh', String(command).split(/\s+/), args) : guardSpawn(command, args, Array.isArray(args) ? rest[0] : args))
  const guarded = function guarded(command, args, ...rest) { check(command, args, rest); return original.call(this, command, args, ...rest) }
  // exec and execFile have a promisified form of their own ({ stdout, stderr }); it is kept, and guarded the same way.
  const custom = original[promisify.custom]
  if (typeof custom === 'function') guarded[promisify.custom] = function guardedPromise(command, args, ...rest) { check(command, args, rest); return custom.call(this, command, args, ...rest) }
  childProcess[method] = guarded
}
syncBuiltinESMExports()
import { forbiddenEgressFindingsForText } from '../src/egress/forbidden-egress.mjs'
import { OBSIDIAN_EXT_KEY, validateObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import { COMMUNITY_PLUGINS_PATH, POLICY_SETTINGS_PATH, isUserOwnedSettingsPath, prepareSettings } from '../src/projection/obsidian/materialize/index.mjs'
import {
  PLUGIN_CHALLENGE_WINDOW_MS, PLUGIN_CHANNEL_PROTOCOL, PLUGIN_DATA_MODE, PLUGIN_DATA_PATH, PLUGIN_DATA_SCHEMA, PLUGIN_DIRECTORY, PLUGIN_HANDSHAKE_TTL_MS, PLUGIN_ID, PLUGIN_LEASE_TTL_MS, PLUGIN_MAX_PENDING_HANDSHAKES_PER_SCOPE,
  PLUGIN_MAX_REQUEST_BYTES, PLUGIN_MAX_SESSION_AGE_MS, PLUGIN_MINIMUM_APP_VERSION, PLUGIN_RENEW_INTERVAL_MS, PLUGIN_ROUTES, PLUGIN_SOURCE_FILES, PLUGIN_STATUS_SCHEMA, pluginClientProof,
  pluginKeyHint, pluginRequestMac, pluginResponseMac, pluginServerProof, pluginSessionKey, pluginVaultProof, preparePluginFiles, readPluginSource, validatePluginData, validatePluginRequest,
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
import {
  PLUGIN_CHANNEL_PRIMITIVES, createPluginBearerCache, createPluginChannelForOracleTests, createPluginSessions, ensurePluginBearer, pluginBearerDirectory, readPluginBearers,
} from '../src/runtime/obsidian/plugin-channel.mjs'
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
// request the plugin makes through `http`, as it was asked for, with the exact
// body it sent.
function loadPluginClass(fake, { requires = [], requests = [], source = fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8') } = {}) {
  const recordingHttp = {
    request(options, onResponse) {
      const entry = { host: options.host, port: options.port, method: options.method, path: options.path, headers: { ...options.headers }, body: null }
      requests.push(entry)
      const request = http.request(options, onResponse)
      const end = request.end.bind(request)
      request.end = (chunk, ...rest) => { entry.body = chunk === undefined ? null : String(chunk); return end(chunk, ...rest) }
      return request
    },
  }
  const factory = (0, eval)(`(function anonymous(require,module,exports){${source}\n})\n//# sourceURL=plugin:${PLUGIN_ID}\n`)
  const module = { exports: {} }
  factory((name) => {
    requires.push(name)
    if (name === 'obsidian') return fake.module
    if (name === 'http') return recordingHttp
    if (name === 'fs') return fs
    if (name === 'crypto') return crypto
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

test('the spawn guard: a child that can reach a running Obsidian runs only with a private HOME', async (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-guard-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const reaching = ['-e', '0', '--', '--adapter=obsidian-cli']
  assert.throws(() => childProcess.spawnSync(process.execPath, reaching), /private HOME/)
  assert.throws(() => spawnSync(process.execPath, reaching, { env: { ...process.env } }), /private HOME/, 'the named import is guarded too')
  assert.throws(() => execFileSync('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli', ['version'], { env: { ...process.env, HOME: os.homedir() } }), /private HOME/)
  assert.throws(() => childProcess.execSync('/usr/bin/open "obsidian://open?path=/tmp"'), /private HOME/)
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  assert.equal(spawnSync(process.execPath, reaching, { env: { ...process.env, HOME: home } }).status, 0, 'a private HOME lets it run')
  assert.equal(spawnSync(process.execPath, ['-e', '0']).status, 0, 'a child that reaches no app runs with any HOME')
  // The promisified execFile keeps its own form, as the isolated-instance helper relies on, and is guarded too.
  assert.throws(() => promisify(childProcess.execFile)(process.execPath, reaching), /private HOME/)
  const answered = await promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")', '--', '--adapter=obsidian-cli'], { env: { ...process.env, HOME: home } })
  assert.deepEqual(answered, { stdout: 'ok', stderr: '' })
})

// Every released plugin version and the code it shipped. A vault keeps running an older main.js until the app
// reloads the plugin, so a change to the code without a new version would leave two plugins under one version.
const RELEASED_PLUGIN_CODE = Object.freeze({
  '1.0.0': 'sha256:57f6cf1613c45f677438e86cc470094b73fda37bd9f3a62fb4aba42decc98294',
  '1.1.0': 'sha256:7a4ed9bd7a9092e55e874b6ac722bcb6c8fabefdf85470ba5ded6e3e083cb347',
})

test('the plugin\'s version changes whenever its code does', () => {
  const hash = createHash('sha256')
  for (const name of ['main.js', 'styles.css']) { hash.update(`${name}\u0000`); hash.update(fs.readFileSync(path.join(PLUGIN_SOURCE, name))); hash.update('\u0000') }
  const code = `sha256:${hash.digest('hex')}`
  const { version } = shippedManifest()
  assert.ok(Object.hasOwn(RELEASED_PLUGIN_CODE, version), `plugin version ${version} is not recorded here; record it with its code digest ${code}`)
  assert.equal(code, RELEASED_PLUGIN_CODE[version], `the code of plugin ${version} changed: raise the version in plugins/obsidian/manifest.json and record ${code} under it`)
})

function assertConstantsParity(Plugin) {
  assert.deepEqual(Plugin.channel, {
    pluginId: PLUGIN_ID, protocol: PLUGIN_CHANNEL_PROTOCOL, dataSchema: PLUGIN_DATA_SCHEMA, statusSchema: PLUGIN_STATUS_SCHEMA, routes: { ...PLUGIN_ROUTES },
    renewEveryMs: PLUGIN_RENEW_INTERVAL_MS, requestTimeoutMs: Plugin.channel.requestTimeoutMs, maxResponseBytes: 64 * 1024, minimumAppVersion: PLUGIN_MINIMUM_APP_VERSION,
  })
  assert.ok(Plugin.channel.requestTimeoutMs < PLUGIN_RENEW_INTERVAL_MS, 'one round trip gives up before the next renewal is due')
  assert.ok(PLUGIN_LEASE_TTL_MS >= 3 * PLUGIN_RENEW_INTERVAL_MS, 'three renewals can be missed before a vault stops counting as open')
}

test('parity: the constants the plugin carries are the channel contract\'s', () => {
  assertConstantsParity(loadPluginClass(fakeObsidian()))
})

test('mutation control: a plugin that carries another route fails the parity oracle', () => {
  const source = fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8').replace("lease: '/plugin/lease'", "lease: '/plugin/renew'")
  assert.notEqual(source, fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8'))
  assert.throws(() => assertConstantsParity(loadPluginClass(fakeObsidian(), { source })), assert.AssertionError)
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
  const hex = (fill, length = 64) => fill.repeat(length)
  const challenge = { protocol: PLUGIN_CHANNEL_PROTOCOL, keyHint: hex('a'), clientNonce: hex('b'), issuedAt: 1767607200000 }
  const hello = { handshakeId: `ph-${hex('1', 32)}`, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${hex('2', 32)}`, vaultProof: hex('c'), clientProof: hex('d') }
  const sealed = { sessionId: `ps-${hex('3', 32)}`, counter: 1, mac: hex('e') }
  assert.deepEqual(validatePluginRequest('challenge', challenge), { ok: true, body: challenge })
  assert.deepEqual(validatePluginRequest('hello', hello), { ok: true, body: hello })
  for (const command of ['lease', 'release', 'status']) assert.deepEqual(validatePluginRequest(command, sealed), { ok: true, body: sealed })
  for (const [command, body, code] of [
    ['eval', sealed, 'unknown-command'],
    ['status', [], 'request-malformed'],
    ['status', { ...sealed, path: 'notes/a.md' }, 'request-malformed'],
    ['status', { scopeId: SCOPE }, 'request-malformed'],
    ['lease', { ...sealed, sessionId: 'ps-guess' }, 'request-malformed'],
    ['lease', { ...sealed, counter: 0 }, 'request-malformed'],
    ['lease', { ...sealed, counter: '2' }, 'request-malformed'],
    ['lease', { ...sealed, counter: 2 ** 53 }, 'request-malformed'],
    ['release', { ...sealed, mac: hex('E') }, 'request-malformed'],
    ['release', { ...sealed, force: true }, 'request-malformed'],
    ['challenge', { ...challenge, protocol: 'atelier-obsidian-plugin-channel/v1' }, 'protocol-unsupported'],
    // The first thing a plugin sends names no view, no vault and no key.
    ['challenge', { ...challenge, scopeId: SCOPE }, 'request-malformed'],
    ['challenge', { ...challenge, keyHint: 'b'.repeat(43) }, 'request-malformed'],
    ['challenge', { ...challenge, clientNonce: hex('b', 32) }, 'request-malformed'],
    ['challenge', { ...challenge, issuedAt: '1767607200000' }, 'request-malformed'],
    ['challenge', { ...challenge, issuedAt: 0 }, 'request-malformed'],
    ['hello', { ...hello, vaultPath: '/vaults/scope-plugin' }, 'request-malformed'],
    ['hello', { ...hello, handshakeId: 'ph-guess' }, 'request-malformed'],
    ['hello', { ...hello, instanceId: `ps-${hex('2', 32)}` }, 'request-malformed'],
    ['hello', { ...hello, appVersion: 'x'.repeat(41) }, 'request-malformed'],
    ['hello', { ...hello, code: 'app.vault.delete()' }, 'request-malformed'],
  ]) assert.deepEqual(validatePluginRequest(command, body), { ok: false, code }, `${command} ${JSON.stringify(body)}`)
  const document = { schema: PLUGIN_DATA_SCHEMA, channel: { host: '127.0.0.1', port: 43123 }, scopeId: SCOPE, bearer: 'b'.repeat(43) }
  assert.equal(validatePluginData(document), document)
  for (const bad of [{ ...document, channel: { host: 'localhost', port: 43123 } }, { ...document, channel: { host: '0.0.0.0', port: 43123 } }, { ...document, channel: { host: '127.0.0.1', port: 80 } }, { ...document, bearer: 'short' }, { ...document, extra: 1 }]) {
    assert.equal(validatePluginData(bad), null, JSON.stringify(bad.channel ?? bad))
  }
})

test('the handshake computations: each binds everything it names, and no two of them agree', () => {
  const base = { bearer: 'k'.repeat(43), scopeId: SCOPE, authority: '127.0.0.1:43123', clientNonce: 'a'.repeat(64), serverNonce: 'b'.repeat(64), handshakeId: `ph-${'1'.repeat(32)}` }
  const proof = pluginServerProof(base)
  assert.match(proof, /^[0-9a-f]{64}$/)
  // Change any one input and the proof changes: the view, the listener's exact address, either nonce, the handshake, the key.
  for (const [field, value] of [['scopeId', 'scope-other'], ['authority', '127.0.0.1:43124'], ['authority', '[::1]:43123'], ['clientNonce', 'c'.repeat(64)], ['serverNonce', 'c'.repeat(64)], ['handshakeId', `ph-${'2'.repeat(32)}`], ['bearer', 'j'.repeat(43)]]) {
    assert.notEqual(pluginServerProof({ ...base, [field]: value }), proof, field)
  }
  const sessionKey = pluginSessionKey(base)
  const vaultProof = pluginVaultProof({ sessionKey, vaultPath: '/vaults/scope-plugin' })
  const client = pluginClientProof({ ...base, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${'3'.repeat(32)}`, vaultProof })
  for (const [field, value] of [['pluginVersion', '1.1.1'], ['appVersion', '1.13.5'], ['instanceId', `pi-${'4'.repeat(32)}`], ['vaultProof', 'd'.repeat(64)]]) {
    assert.notEqual(pluginClientProof({ ...base, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${'3'.repeat(32)}`, vaultProof, [field]: value }), client, field)
  }
  assert.notEqual(pluginVaultProof({ sessionKey, vaultPath: '/vaults/scope-plugin-copy' }), vaultProof)
  const sessionId = `ps-${'5'.repeat(32)}`
  const request = pluginRequestMac({ sessionKey, command: 'lease', sessionId, counter: 1 })
  assert.notEqual(pluginRequestMac({ sessionKey, command: 'lease', sessionId, counter: 2 }), request, 'a counter is bound')
  assert.notEqual(pluginRequestMac({ sessionKey, command: 'status', sessionId, counter: 1 }), request, 'the command is bound')
  const answer = pluginResponseMac({ sessionKey, command: 'lease', sessionId, counter: 1, payload: '{}' })
  assert.notEqual(pluginResponseMac({ sessionKey, command: 'lease', sessionId, counter: 1, payload: '{ }' }), answer, 'the exact bytes of an answer are bound')
  // Separate labels: no proof can stand in for another, nor a request for an answer.
  const hint = pluginKeyHint({ bearer: base.bearer, clientNonce: base.clientNonce, issuedAt: 1767607200000 })
  assert.equal(new Set([proof, client, vaultProof, request, answer, hint, sessionKey.toString('hex')]).size, 7)
  assert.notEqual(pluginKeyHint({ bearer: base.bearer, clientNonce: 'c'.repeat(64), issuedAt: 1767607200000 }), hint, 'a hint is fresh with every nonce')
  assert.notEqual(pluginKeyHint({ bearer: base.bearer, clientNonce: base.clientNonce, issuedAt: 1767607200001 }), hint, 'and bound to the time the challenge names')
})

// ---------------------------------------------------------------------------
// 2. The plugin in the stand-in app, against a real listener
// ---------------------------------------------------------------------------

// A workspace with one view whose vault holds the plugin as publication puts
// it there, and a listener that holds the plugin channel of that workspace.
async function channelWorld(t, { apiVersion = '1.13.7', sessions = createPluginSessions(), primitives = SERVER_PRIMITIVES, channelPrimitives = PLUGIN_CHANNEL_PRIMITIVES, now = () => Date.now(), port: fixedPort = null } = {}) {
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
    const channel = createPluginChannelForOracleTests({ workspaceRoot, workspaceId: WORKSPACE_ID, runtimeId: identity.runtimeId, sessions: withSessions, statusOf: world.statusOf, serviceStatus: () => world.health, now }, channelPrimitives)
    const calls = { status: 0, tick: 0, stop: 0, plugin: [] }
    const listener = createServiceServerForOracleTests({
      identity, bearer: runtimeBearer,
      operations: {
        healthStatus: () => world.health, status: () => { calls.status += 1; return { ok: true } }, tick: async () => { calls.tick += 1; return { ok: true } }, stop: async () => { calls.stop += 1 },
        plugin: async (command, request) => { calls.plugin.push(command); await world.hold?.(command); return channel.handle(command, request) },
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

test('loaded in a vault Atelier published, the plugin shakes hands, holds a lease and shows the view current, and its key never leaves the vault', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  const [session] = world.service.sessions.live(SCOPE)
  assert.deepEqual([session.appVersion, session.pluginVersion, world.service.sessions.live(SCOPE).length], ['1.13.7', shippedManifest().version, 1])
  assert.match(session.instanceId, /^pi-[0-9a-f]{32}$/)
  assert.equal(Object.hasOwn(session, 'sessionKey'), false, 'a session handed out carries no key')
  assert.deepEqual(world.service.calls.plugin, ['challenge', 'hello', 'status'])
  // Every request went to the literal loopback address with no credential in it: not the bearer, nor anything naming
  // the vault. The first one names nothing at all.
  assert.equal(world.requests.length, 3)
  for (const request of world.requests) {
    assert.deepEqual([request.host, request.port, request.method, request.headers.Host, request.headers.Authorization], ['127.0.0.1', world.port, 'POST', authorityOf('127.0.0.1', world.port), undefined])
    assert.ok(Object.values(PLUGIN_ROUTES).includes(request.path))
    for (const secret of [world.bearer, world.vaultRoot, fs.realpathSync(world.vaultRoot)]) assert.equal(request.body.includes(secret), false, `${request.path} carries ${secret}`)
  }
  assert.deepEqual([world.requests[0].path, Object.keys(JSON.parse(world.requests[0].body)).sort()], [PLUGIN_ROUTES.challenge, ['clientNonce', 'issuedAt', 'keyHint', 'protocol']])
  assert.equal(world.requests[0].body.includes(SCOPE), false, 'the challenge does not name the view')
  assert.deepEqual([...new Set(world.requires)].sort(), ['crypto', 'fs', 'http', 'obsidian'])
  assert.deepEqual(world.fake.record.commands.map((command) => [command.id, command.name]), [[`${PLUGIN_ID}:show-status`, 'Atelier: Show status']])
  assert.deepEqual(world.fake.record.intervals.length, 1)

  await plugin.cycle()
  assert.deepEqual(world.service.calls.plugin, ['challenge', 'hello', 'status', 'lease', 'status'], 'later rounds renew the lease and read the status')
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

test('a service that started again forgets the session: the plugin shakes hands again and carries on', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  await world.service.listener.close()
  world.service = await world.listen({ port: world.port, withSessions: createPluginSessions() })
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  assert.deepEqual(world.service.calls.plugin, ['lease', 'challenge', 'hello', 'status'])
  assert.equal(world.service.sessions.report(SCOPE).sessions, 1)
})

test('a republished data file moves the plugin to the new address and key without a restart', async (t) => {
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
  assert.deepEqual(moved.calls.plugin, ['challenge', 'hello', 'status'])
  assert.equal(world.requests.at(-1).port, port)
  assert.ok(world.requests.every((request) => !request.body.includes(bearer) && !request.body.includes(world.bearer)), 'neither key went out')
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

test('the plugin proves the real path of the vault the app has open without sending it; another folder is refused', async (t) => {
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

  // The same data file copied into another folder: the vault the plugin proves is not the view's, and the service refuses the hello.
  const elsewhere = path.join(world.dir, 'copied-vault')
  fs.cpSync(world.vaultRoot, elsewhere, { recursive: true })
  const copied = new Plugin(fakeApp(elsewhere, world.fake.record), shippedManifest())
  t.after(() => copied.unload())
  await copied.load()
  await copied.cycle()
  assert.equal(statusBarOf(world), 'Atelier: not set up', 'a copy of the vault is not the vault Atelier maintains')
  assert.equal(copied.view.reason, 'not-the-vault-atelier-maintains')
})

// Parity of the computations: the plugin completes a handshake and a round with the channel's own code, and a
// plugin that computes any one of them otherwise does not.
test('parity: the plugin computes every proof and MAC the channel does, and a plugin that computes one otherwise gets nowhere', async (t) => {
  const source = fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'), 'utf8')
  const control = await channelWorld(t)
  const plugin = control.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(control), 'Atelier: current', 'the shipped plugin and the channel agree')
  for (const label of ['key-hint', 'server-proof', 'session-key', 'vault', 'client-proof', 'request', 'response']) {
    const mutated = source.replaceAll(`'${label}'`, `'${label}-otherwise'`)
    assert.notEqual(mutated, source, label)
    const world = await channelWorld(t)
    const Plugin = loadPluginClass(world.fake, { source: mutated })
    const variant = new Plugin(fakeApp(world.vaultRoot, world.fake.record), shippedManifest())
    t.after(() => variant.unload())
    await variant.load()
    await variant.cycle()
    await variant.cycle()
    assert.notEqual(statusBarOf(world), 'Atelier: current', label)
    assert.equal(world.service.sessions.live(SCOPE).some((session) => session.counter > 0), false, `${label}: no request of a session was ever accepted`)
  }
})

// A program at the service's address while the service is down: it records
// every request it receives, headers and exact body, and answers as it likes.
async function squatter(t, port, answerOf = () => ({ statusCode: 503, body: { error: 'service-unavailable' } })) {
  const captured = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      const entry = { path: request.url, headers: { ...request.headers }, body: Buffer.concat(chunks).toString('utf8') }
      captured.push(entry)
      const { statusCode, body } = await answerOf(entry)
      const text = JSON.stringify(body)
      response.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' })
      response.end(text)
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port }, resolve) })
  let closed = null
  const close = () => { closed ??= new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }); return closed }
  t.after(close)
  return { captured, close }
}

test('a program squatting the service\'s address while it is down learns nothing it can use: no key, no vault, no view, no session, no app version', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')

  // The service stops. Another program binds its address and answers as a restarted service would ("session
  // unknown"), and every challenge with a proof it made up.
  await world.service.listener.close()
  const squat = await squatter(t, world.port, (entry) => (entry.path === PLUGIN_ROUTES.challenge
    ? { statusCode: 200, body: { protocol: PLUGIN_CHANNEL_PROTOCOL, handshakeId: `ph-${randomBytes(16).toString('hex')}`, serverNonce: randomBytes(32).toString('hex'), serverProof: randomBytes(32).toString('hex') } }
    : { statusCode: 409, body: { error: 'session-unknown' } }))
  for (let round = 0; round < 3; round += 1) await plugin.cycle()
  assert.deepEqual([statusBarOf(world), plugin.view.reason], ['Atelier: service unreachable', 'listener-not-proven'])
  const paths = squat.captured.map((entry) => entry.path)
  assert.deepEqual(paths, [PLUGIN_ROUTES.lease, PLUGIN_ROUTES.challenge, PLUGIN_ROUTES.challenge, PLUGIN_ROUTES.challenge], 'one renewal of the old session, then only challenges')
  const everything = JSON.stringify(squat.captured)
  for (const secret of [world.bearer, world.vaultRoot, fs.realpathSync(world.vaultRoot), SCOPE]) assert.equal(everything.includes(secret), false, `the squatter received ${secret}`)
  assert.ok(squat.captured.every((entry) => entry.headers.authorization === undefined))
  const hints = squat.captured.filter((entry) => entry.path === PLUGIN_ROUTES.challenge).map((entry) => JSON.parse(entry.body).keyHint)
  assert.equal(new Set(hints).size, hints.length, 'no two challenges of this vault look alike')
  await squat.close()

  // The service starts again at the same address, with the same key. Everything the squatter received, replayed,
  // opens no session: a replayed challenge is answered, but a hello needs the key.
  const sessions = createPluginSessions()
  world.service = await world.listen({ port: world.port, withSessions: sessions })
  const Host = authorityOf('127.0.0.1', world.port)
  let answered = 0
  for (const entry of squat.captured) {
    const replayed = await raw({ port: world.port, route: entry.path, headers: { Host }, body: entry.body })
    if (entry.path !== PLUGIN_ROUTES.challenge) { assert.equal(replayed.statusCode, 409, `${entry.path} replayed`); continue }
    assert.equal(replayed.statusCode, 200)
    answered += 1
    const forged = await raw({ port: world.port, route: PLUGIN_ROUTES.hello, headers: { Host }, body: JSON.stringify({ handshakeId: replayed.body.handshakeId, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${randomBytes(16).toString('hex')}`, vaultProof: randomBytes(32).toString('hex'), clientProof: randomBytes(32).toString('hex') }) })
    assert.equal(forged.statusCode, 401, 'a hello that does not prove the key')
    const again = await raw({ port: world.port, route: entry.path, headers: { Host }, body: entry.body })
    assert.deepEqual([again.statusCode, again.body.error], [401, 'challenge-replayed'], 'and it is answered once')
  }
  assert.equal(answered, 3)
  assert.equal(sessions.report(SCOPE), null, 'no session for the squatter')
  // So no app version it would claim reaches qualification: an app below the floor stays refused.
  const factory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => ({ installed: true, cli: true, running: true, version: '1.13.5' }) }, createAdapter: ({ qualification }) => ({ qualification }) })
  assert.throws(() => factory({ scope: { scopeId: SCOPE }, pluginReport: sessions.report(SCOPE) }), (error) => error.detail?.reason === 'below-minimum-version')

  // The plugin shakes hands with the service that proves itself, and carries on.
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  assert.equal(sessions.report(SCOPE).sessions, 1)
})

test('an answer relayed from the service at another address does not verify, and the relay is told nothing more', async (t) => {
  const world = await channelWorld(t)
  // The service listens elsewhere, with the vault's key; a program at the address the vault names relays to it.
  await world.service.listener.close()
  const elsewhere = await freePort()
  world.service = await world.listen({ port: elsewhere })
  const relay = await squatter(t, world.port, async (entry) => {
    const answer = await raw({ port: elsewhere, route: entry.path, headers: { Host: authorityOf('127.0.0.1', elsewhere) }, body: entry.body })
    return { statusCode: answer.statusCode, body: answer.body }
  })
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.deepEqual([statusBarOf(world), plugin.view.reason], ['Atelier: service unreachable', 'listener-not-proven'])
  assert.deepEqual(relay.captured.map((entry) => entry.path), [PLUGIN_ROUTES.challenge])
  assert.equal(world.service.sessions.report(SCOPE), null)
})

test('an answer that is not sealed with the session\'s key is not believed', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  // Between two rounds the service goes away, and a program answers the lease and the status as if all were well.
  await world.service.listener.close()
  const forged = (document) => ({ statusCode: 200, body: { payload: JSON.stringify(document), mac: randomBytes(32).toString('hex') } })
  let refuse = false
  const squat = await squatter(t, world.port, (entry) => {
    if (refuse) return { statusCode: 401, body: { error: 'request-not-authenticated' } }
    return entry.path === PLUGIN_ROUTES.lease ? forged({ schema: PLUGIN_CHANNEL_PROTOCOL, scopeId: SCOPE }) : forged({ schema: PLUGIN_STATUS_SCHEMA, scopeId: SCOPE, view: { ...world.view } })
  })
  await plugin.cycle()
  assert.deepEqual([statusBarOf(world), plugin.view.reason], ['Atelier: service unreachable', 'answer-not-authenticated'])
  assert.deepEqual(squat.captured.map((entry) => entry.path), [PLUGIN_ROUTES.lease], 'nothing more once an answer did not verify')
  // That session is over: the next round starts a handshake, which the listener cannot answer.
  refuse = true
  await plugin.cycle()
  assert.deepEqual(squat.captured.map((entry) => entry.path), [PLUGIN_ROUTES.lease, PLUGIN_ROUTES.challenge])
})

test('a listener that answers every request with an error gets one renewal of the session and nothing more of it', async (t) => {
  for (const failing of [{ statusCode: 503, body: { error: 'service-unavailable' } }, { statusCode: 401, body: { error: 'request-not-authenticated' } }, { statusCode: 500, body: {} }]) {
    const world = await channelWorld(t)
    const plugin = world.plugin()
    await plugin.load()
    await plugin.cycle()
    assert.equal(statusBarOf(world), 'Atelier: current')
    await world.service.listener.close()
    const squat = await squatter(t, world.port, () => failing)
    for (let round = 0; round < 5; round += 1) await plugin.cycle()
    const paths = squat.captured.map((entry) => entry.path)
    assert.deepEqual([paths[0], paths.filter((route) => route === PLUGIN_ROUTES.lease).length], [PLUGIN_ROUTES.lease, 1], `${failing.statusCode}: one renewal`)
    assert.ok(paths.slice(1).every((route) => route === PLUGIN_ROUTES.challenge), `${failing.statusCode}: then only challenges`)
    await squat.close()
    plugin.unload()
  }
})

test('the status bar does not flip between "not set up" and "service unreachable": a failure other than the one shown takes two rounds that agree', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  await world.service.listener.close()
  // A listener that answers the one way and then the other: one request per round once the session ended.
  let answered = 0
  let alternate = true
  const squat = await squatter(t, world.port, () => {
    answered += 1
    return alternate && answered % 2 === 1 ? { statusCode: 503, body: { error: 'service-unavailable' } } : { statusCode: 401, body: { error: 'plugin-key-unknown' } }
  })
  const shown = []
  for (let round = 0; round < 5; round += 1) { await plugin.cycle(); shown.push(statusBarOf(world)) }
  assert.deepEqual(shown, Array(5).fill('Atelier: service unreachable'))
  assert.equal(answered, 5)
  // Two rounds in a row that agree move it, and the reason shown is the new one.
  alternate = false
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: service unreachable')
  await plugin.cycle()
  assert.deepEqual([statusBarOf(world), plugin.view.reason], ['Atelier: not set up', 'key-not-known-to-the-service'])
  // Anything but a change between the two failures is shown at once: the service back is current in one round.
  await squat.close()
  world.service = await world.listen({ port: world.port, withSessions: createPluginSessions() })
  await plugin.cycle()
  assert.equal(statusBarOf(world), 'Atelier: current')
  plugin.unload()
})

test('a challenge the service found stale or answered already is not shown as a key it does not know', async (t) => {
  // The service's clock runs a minute ahead of the plugin's: every challenge is stale when it arrives.
  const skewed = await channelWorld(t, { now: () => Date.now() + 60_000 })
  const plugin = skewed.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.deepEqual([statusBarOf(skewed), plugin.view.reason], ['Atelier: service unreachable', 'challenge-stale'])
  assert.deepEqual(skewed.service.calls.plugin, ['challenge'])
  plugin.unload()
  // Answered already, and then a key the service does not know: only that one says "not set up".
  const world = await channelWorld(t)
  await world.service.listener.close()
  let error = 'challenge-replayed'
  const squat = await squatter(t, world.port, () => ({ statusCode: 401, body: { error } }))
  const second = world.plugin()
  await second.load()
  await second.cycle()
  assert.deepEqual([statusBarOf(world), second.view.reason], ['Atelier: service unreachable', 'challenge-replayed'])
  error = 'plugin-key-unknown'
  await second.cycle()
  await second.cycle()
  assert.deepEqual([statusBarOf(world), second.view.reason], ['Atelier: not set up', 'key-not-known-to-the-service'])
  await squat.close()
  second.unload()
})

test('a plugin unloaded while its hello is under way lets that session go at once, and shows nothing afterwards', async (t) => {
  const world = await channelWorld(t)
  let answerHello = null
  world.hold = (command) => (command === 'hello' ? new Promise((resolve) => { answerHello = resolve }) : null)
  const plugin = world.plugin()
  // onload starts the first round without waiting for it.
  await plugin.load()
  await waitFor(() => answerHello, { label: 'the hello under way' })
  const notices = world.fake.record.notices.length
  const shown = statusBarOf(world)
  plugin.unload()
  world.hold = null
  answerHello()
  await waitFor(() => world.service.calls.plugin.includes('release'), { label: 'the session let go' })
  assert.equal(world.service.sessions.report(SCOPE), null)
  assert.deepEqual(world.service.calls.plugin, ['challenge', 'hello', 'release'], 'no lease and no status after the unload')
  assert.deepEqual([world.fake.record.notices.length, statusBarOf(world)], [notices, shown], 'nothing shown after the unload')
})

test('a session whose vault key was rotated ends; the plugin waits for the new key and carries on with it', async (t) => {
  const world = await channelWorld(t)
  const plugin = world.plugin()
  await plugin.load()
  await plugin.cycle()
  // The key is rotated in private state; the vault still holds the old one until its next publication.
  fs.rmSync(path.join(pluginBearerDirectory(world.workspaceRoot), `${SCOPE}.json`))
  const rotated = ensurePluginBearer({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE })
  assert.notEqual(rotated, world.bearer)
  await plugin.cycle()
  assert.deepEqual([statusBarOf(world), plugin.view.reason], ['Atelier: not set up', 'key-not-known-to-the-service'])
  assert.equal(world.service.sessions.report(SCOPE), null, 'the session made with the old key is gone')
  world.install({ port: world.port, bearer: rotated })
  await plugin.onExternalSettingsChange()
  assert.equal(statusBarOf(world), 'Atelier: current')
})

// ---------------------------------------------------------------------------
// 3. The listener's plugin commands: a handshake over one vault's key, then
//    sealed requests; bounded and exact
// ---------------------------------------------------------------------------

// A client that holds a vault's key and speaks the channel the way the plugin does, one step at a time.
function keyHolder({ port, bearer, scopeId = SCOPE, vaultPath, pluginVersion = '1.1.0', appVersion = '1.13.7', instanceId = `pi-${randomBytes(16).toString('hex')}`, clock = () => Date.now() }) {
  const authority = authorityOf('127.0.0.1', port)
  const send = (route, body) => raw({ port, route, headers: { Host: authority }, body: JSON.stringify(body) })
  const holder = {
    // `clientNonce` and `issuedAt` can be forced, to send a challenge again or out of its time.
    async challenge({ clientNonce = randomBytes(32).toString('hex'), issuedAt = clock() } = {}) {
      return { answer: await send(PLUGIN_ROUTES.challenge, { protocol: PLUGIN_CHANNEL_PROTOCOL, keyHint: pluginKeyHint({ bearer, clientNonce, issuedAt }), clientNonce, issuedAt }), clientNonce, issuedAt }
    },
    // The hello that answers a challenge; `overrides` replace what is sent.
    helloFor({ answer, clientNonce }, overrides = {}) {
      const bound = { bearer, scopeId, authority, clientNonce, serverNonce: answer.body.serverNonce, handshakeId: answer.body.handshakeId }
      const sessionKey = pluginSessionKey(bound)
      const vaultProof = pluginVaultProof({ sessionKey, vaultPath })
      return { bound, sessionKey, body: { handshakeId: bound.handshakeId, pluginVersion, appVersion, instanceId, vaultProof, clientProof: pluginClientProof({ ...bound, pluginVersion, appVersion, instanceId, vaultProof }), ...overrides } }
    },
    async hello(challenged, overrides) {
      const { bound, sessionKey, body } = holder.helloFor(challenged, overrides)
      return { answer: await send(PLUGIN_ROUTES.hello, body), bound, sessionKey }
    },
    // A session command as the plugin sends it; `counter` and `mac` can be forced.
    async command(session, command, { counter = session.counter + 1, mac } = {}) {
      session.counter = Math.max(session.counter, counter)
      const answer = await send(PLUGIN_ROUTES[command], { sessionId: session.id, counter, mac: mac ?? pluginRequestMac({ sessionKey: session.key, command, sessionId: session.id, counter }) })
      return { answer, counter }
    },
  }
  return holder
}

// The document of a sealed answer, after its MAC verified.
function unsealed({ answer, counter }, { key, id }, command) {
  assert.equal(answer.statusCode, 200, JSON.stringify(answer.body))
  const document = JSON.parse(answer.body.payload)
  assert.equal(answer.body.mac, pluginResponseMac({ sessionKey: key, command, sessionId: id ?? document.sessionId, counter, payload: answer.body.payload }), `the ${command} answer is sealed with the session's key`)
  return document
}

async function assertOnlyTheVaultKeyActs(t, { primitives = SERVER_PRIMITIVES, channelPrimitives = PLUGIN_CHANNEL_PRIMITIVES } = {}) {
  let now = Date.parse('2026-01-05T10:00:00.000Z')
  const sessions = createPluginSessions({ now: () => now })
  const world = await channelWorld(t, { primitives, channelPrimitives, sessions, now: () => now })
  const { port } = world
  const Host = authorityOf('127.0.0.1', port)
  const send = (route, body, headers = {}, method = 'POST') => raw({ port, method, route, headers: { Host, ...headers }, body: body === null ? null : typeof body === 'string' ? body : JSON.stringify(body) })
  const vaultPath = fs.realpathSync(world.vaultRoot)
  const clock = () => now
  const client = keyHolder({ port, bearer: world.bearer, vaultPath, clock })
  const otherBearer = ensurePluginBearer({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'scope-other' })
  const challenge = () => { const clientNonce = randomBytes(32).toString('hex'); return { protocol: PLUGIN_CHANNEL_PROTOCOL, keyHint: pluginKeyHint({ bearer: world.bearer, clientNonce, issuedAt: now }), clientNonce, issuedAt: now } }
  const expect = async (label, pending, statusCode) => { const answer = await pending; assert.equal(answer.statusCode, statusCode, label); return answer }
  const stranger = keyHolder({ port, bearer: randomBytes(32).toString('base64url'), vaultPath, clock })

  // Who may start a handshake, and the shape of every request.
  await expect('a challenge made with a key the service does not hold', stranger.challenge().then(({ answer }) => answer), 401)
  await expect('a challenge in another protocol', send(PLUGIN_ROUTES.challenge, { ...challenge(), protocol: 'atelier-obsidian-plugin-channel/v1' }), 409)
  await expect('a challenge that names the view', send(PLUGIN_ROUTES.challenge, { ...challenge(), scopeId: SCOPE }), 400)
  await expect('a bearer in the header of a plugin command', send(PLUGIN_ROUTES.challenge, challenge(), { Authorization: `Bearer ${world.bearer}` }), 400)
  await expect('the runtime bearer on a plugin command', send(PLUGIN_ROUTES.challenge, challenge(), { Authorization: `Bearer ${world.service.runtimeBearer}` }), 400)
  await expect('GET on a plugin command', send(PLUGIN_ROUTES.challenge, null, {}, 'GET'), 405)
  await expect('an oversized payload', send(PLUGIN_ROUTES.challenge, { ...challenge(), padding: 'x'.repeat(PLUGIN_MAX_REQUEST_BYTES) }), 413)
  await expect('a payload that is not JSON', send(PLUGIN_ROUTES.challenge, 'challenge please'), 400)
  await expect('a query on a plugin command', send(`${PLUGIN_ROUTES.challenge}?scope=${SCOPE}`, challenge()), 404)
  await expect('a command that does not exist', send('/plugin/eval', challenge()), 404)
  await expect('a command under another prefix', send('/plugins/challenge', challenge()), 404)
  await expect('a hostname in Host', send(PLUGIN_ROUTES.challenge, challenge(), { Host: `localhost:${port}` }), 403)
  await expect('a cross-site Origin', send(PLUGIN_ROUTES.challenge, challenge(), { Origin: 'app://obsidian.md' }), 403)
  await expect('Sec-Fetch-Site: cross-site', send(PLUGIN_ROUTES.challenge, challenge(), { 'Sec-Fetch-Site': 'cross-site' }), 403)
  // A vault's key is not the service's bearer: none of the service's own operations answers it.
  await expect('the vault key on the service status', send('/status', null, { Authorization: `Bearer ${world.bearer}` }, 'GET'), 401)
  await expect('the vault key asking for a tick', send('/tick', { runtimeId: world.service.identity.runtimeId }, { Authorization: `Bearer ${world.bearer}` }), 401)
  await expect('the vault key asking the service to stop', send('/stop', { runtimeId: world.service.identity.runtimeId }, { Authorization: `Bearer ${world.bearer}` }), 401)
  assert.deepEqual([world.service.calls.status, world.service.calls.tick, world.service.calls.stop], [0, 0, 0], 'no refused request reached a service operation')

  // A challenge is answered once, and only while it is fresh: one recorded and sent again, or sent late, is refused.
  const once = await client.challenge()
  assert.equal(once.answer.statusCode, 200)
  await expect('a challenge sent a second time', client.challenge(once).then(({ answer }) => answer), 401)
  await expect('a challenge whose time left the window', client.challenge({ issuedAt: now - PLUGIN_CHALLENGE_WINDOW_MS - 1 }).then(({ answer }) => answer), 401)
  await expect('a challenge whose time lies ahead', client.challenge({ issuedAt: now + PLUGIN_CHALLENGE_WINDOW_MS + 1 }).then(({ answer }) => answer), 401)

  // The service proves the key first, bound to its own exact address.
  const challenged = await client.challenge()
  assert.equal(challenged.answer.statusCode, 200)
  const proven = client.helloFor(challenged)
  assert.equal(challenged.answer.body.serverProof, pluginServerProof(proven.bound))
  // A hello that does not prove the key opens nothing and uses the handshake up; so does a hello that proves it late.
  await expect('a hello with a handshake nobody offered', send(PLUGIN_ROUTES.hello, { ...proven.body, handshakeId: `ph-${randomBytes(16).toString('hex')}` }), 401)
  const otherProof = pluginClientProof({ ...proven.bound, bearer: otherBearer, pluginVersion: proven.body.pluginVersion, appVersion: proven.body.appVersion, instanceId: proven.body.instanceId, vaultProof: proven.body.vaultProof })
  await expect('a hello proven with another vault\'s key', client.hello(challenged, { clientProof: otherProof }).then(({ answer }) => answer), 401)
  await expect('a handshake used a second time', client.hello(challenged).then(({ answer }) => answer), 401)
  const late = await client.challenge()
  now += PLUGIN_HANDSHAKE_TTL_MS
  await expect('a hello after its handshake lapsed', client.hello(late).then(({ answer }) => answer), 401)
  const copy = keyHolder({ port, bearer: world.bearer, vaultPath: fs.realpathSync(world.dir), clock })
  await expect('a hello that proves another folder', copy.hello(await copy.challenge()).then(({ answer }) => answer), 409)
  assert.equal(sessions.report(SCOPE), null, 'no refused request opened a session')

  // A session, as the plugin opens and uses it; every answer is sealed with the session's key.
  const opened = await client.hello(await client.challenge())
  const hello = unsealed({ answer: opened.answer, counter: 0 }, { key: opened.sessionKey, id: null }, 'hello')
  assert.deepEqual([hello.schema, hello.scopeId, hello.leaseTtlMs, hello.renewEveryMs], [PLUGIN_CHANNEL_PROTOCOL, SCOPE, PLUGIN_LEASE_TTL_MS, PLUGIN_RENEW_INTERVAL_MS])
  const session = { id: hello.sessionId, key: opened.sessionKey, counter: 0 }
  assert.equal(unsealed(await client.command(session, 'lease'), session, 'lease').sessionId, session.id)
  await expect('a request replayed', client.command(session, 'lease', { counter: session.counter }).then(({ answer }) => answer), 401)
  await expect('a request whose MAC was made up', client.command(session, 'status', { mac: randomBytes(32).toString('hex') }).then(({ answer }) => answer), 401)
  await expect('a MAC made for another command', client.command(session, 'status', { mac: pluginRequestMac({ sessionKey: session.key, command: 'lease', sessionId: session.id, counter: session.counter + 1 }) }).then(({ answer }) => answer), 401)
  await expect('a session nobody was granted', keyHolder({ port, bearer: world.bearer, vaultPath, clock }).command({ id: `ps-${'0'.repeat(32)}`, key: session.key, counter: 0 }, 'lease').then(({ answer }) => answer), 409)
  const statusAnswer = await client.command(session, 'status')
  assert.deepEqual(unsealed(statusAnswer, session, 'status'), { schema: PLUGIN_STATUS_SCHEMA, scopeId: SCOPE, service: { status: 'healthy' }, view: world.view, pendingEdits: { open: 0 } })
  assert.deepEqual(unsealed(await client.command(session, 'release'), session, 'release'), { schema: PLUGIN_CHANNEL_PROTOCOL, scopeId: SCOPE, released: true })
  await expect('a released session', client.command(session, 'lease').then(({ answer }) => answer), 409)
  assert.equal(sessions.report(SCOPE), null)

  // Another vault's key opens a session for that vault only.
  const otherVault = path.join(world.workspaceRoot, 'vaults', 'scope-other')
  fs.mkdirSync(otherVault, { mode: 0o700 })
  const other = keyHolder({ port, bearer: otherBearer, scopeId: 'scope-other', vaultPath: fs.realpathSync(otherVault), clock })
  const otherOpened = await other.hello(await other.challenge())
  assert.equal(unsealed({ answer: otherOpened.answer, counter: 0 }, { key: otherOpened.sessionKey, id: null }, 'hello').scopeId, 'scope-other')
  assert.deepEqual([sessions.report('scope-other')?.sessions, sessions.report(SCOPE)], [1, null])
  for (const text of [opened.answer.text, statusAnswer.answer.text, challenged.answer.text]) {
    for (const word of [world.dir, world.workspaceRoot, world.bearer, otherBearer, 'notes/', '.md']) assert.equal(text.includes(word), false, `an answer carries ${word}`)
  }
}

test('the plugin commands answer only a handshake over this vault\'s key, bounded and exact, and grant nothing of the service', async (t) => {
  await assertOnlyTheVaultKeyActs(t)
})

for (const [label, broken] of [
  ['takes any MAC or proof for a match', { channelPrimitives: { ...PLUGIN_CHANNEL_PRIMITIVES, macMatches: () => true } }],
  ['takes a counter it has already seen', { channelPrimitives: { ...PLUGIN_CHANNEL_PRIMITIVES, counterIsNew: () => true } }],
  ['lets one handshake open more than one hello', { channelPrimitives: { ...PLUGIN_CHANNEL_PRIMITIVES, handshakeUsedOnce: false } }],
  ['answers a challenge it has answered before', { channelPrimitives: { ...PLUGIN_CHANNEL_PRIMITIVES, noncesAnsweredOnce: false } }],
  ['answers a challenge whatever time it names', { channelPrimitives: { ...PLUGIN_CHANNEL_PRIMITIVES, challengeWindowMs: Number.MAX_SAFE_INTEGER } }],
  ['reads plugin payloads of any size', { primitives: { ...SERVER_PRIMITIVES, maxPluginRequestBytes: 1024 * 1024 } }],
]) {
  test(`mutation control: a channel that ${label} fails the plugin request oracle`, async (t) => {
    await assert.rejects(assertOnlyTheVaultKeyActs(t, broken), assert.AssertionError)
  })
}

test('a hello must reach the address its handshake was made at; a challenge is answered once and only while fresh; waiting handshakes are bounded per view', (t) => {
  let now = Date.parse('2026-01-05T10:00:00.000Z')
  const workspaceRoot = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-handshakes-'))
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  for (const scopeId of [SCOPE, 'scope-other']) fs.mkdirSync(path.join(workspaceRoot, 'vaults', scopeId), { recursive: true })
  const bearer = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE })
  const otherBearer = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'scope-other' })
  const sessions = createPluginSessions({ now: () => now })
  const channel = createPluginChannelForOracleTests({ workspaceRoot, workspaceId: WORKSPACE_ID, runtimeId: 'rt-1', sessions, statusOf: () => ({ view: null, pendingEdits: null }), serviceStatus: () => 'healthy', now: () => now })
  const authority = '127.0.0.1:43123'
  const challenge = (key = bearer, { clientNonce = randomBytes(32).toString('hex'), issuedAt = now } = {}) => (
    { clientNonce, issuedAt, answer: channel.handle('challenge', { body: { protocol: PLUGIN_CHANNEL_PROTOCOL, keyHint: pluginKeyHint({ bearer: key, clientNonce, issuedAt }), clientNonce, issuedAt }, authority }) })
  const helloAt = ({ clientNonce, answer }, at) => {
    const bound = { bearer, scopeId: SCOPE, authority, clientNonce, serverNonce: answer.body.serverNonce, handshakeId: answer.body.handshakeId }
    const vaultProof = pluginVaultProof({ sessionKey: pluginSessionKey(bound), vaultPath: fs.realpathSync(path.join(workspaceRoot, 'vaults', SCOPE)) })
    return channel.handle('hello', { body: { handshakeId: bound.handshakeId, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${'1'.repeat(32)}`, vaultProof, clientProof: pluginClientProof({ ...bound, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${'1'.repeat(32)}`, vaultProof }) }, authority: at })
  }
  assert.equal(helloAt(challenge(), '127.0.0.1:43124').statusCode, 401, 'a hello at another address')
  assert.equal(helloAt(challenge(), authority).statusCode, 200)

  // A challenge recorded while the service was down and sent to it later is answered at most once, and only while fresh.
  const recorded = { clientNonce: randomBytes(32).toString('hex'), issuedAt: now }
  assert.equal(challenge(bearer, recorded).answer.statusCode, 200)
  assert.deepEqual(challenge(bearer, recorded).answer, { statusCode: 401, body: { error: 'challenge-replayed' } })
  const late = { clientNonce: randomBytes(32).toString('hex'), issuedAt: now }
  now += PLUGIN_CHALLENGE_WINDOW_MS + 1
  assert.deepEqual(challenge(bearer, late).answer, { statusCode: 401, body: { error: 'challenge-stale' } })
  assert.equal(challenge(bearer, { issuedAt: now + PLUGIN_CHALLENGE_WINDOW_MS + 1 }).answer.statusCode, 401, 'a time ahead of the clock too')

  // However many recorded challenges one view's are, its waiting handshakes never hold up another view's.
  const waiting = []
  for (let index = 0; index < PLUGIN_MAX_PENDING_HANDSHAKES_PER_SCOPE; index += 1) waiting.push(challenge().answer.statusCode)
  assert.deepEqual(new Set(waiting), new Set([200]))
  assert.deepEqual(challenge().answer, { statusCode: 429, body: { error: 'too-many-handshakes' } }, 'no more handshakes wait for one view than its bound')
  assert.equal(challenge(otherBearer).answer.statusCode, 200, 'another view is not held up')
  now += PLUGIN_HANDSHAKE_TTL_MS
  assert.equal(challenge().answer.statusCode, 200, 'lapsed handshakes free their places')
})

test('the plugin request bound is the service request bound', () => {
  assert.equal(PLUGIN_MAX_REQUEST_BYTES, MAX_REQUEST_BYTES)
})

test('sessions: bounded per view, keyed for the channel only, lapsing without renewal and ending at their maximum age', () => {
  let now = 0
  const sessions = createPluginSessions({ now: () => now, maxPerScope: 2 })
  const key = Buffer.alloc(32, 1)
  const open = (extra = {}) => sessions.open({ scopeId: SCOPE, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${'1'.repeat(32)}`, sessionKey: key, keyDigest: Buffer.alloc(32, 2), ...extra })
  const first = open()
  const second = open({ appVersion: '1.13.8', instanceId: `pi-${'2'.repeat(32)}` })
  assert.equal(open(), null, 'a third live session for one view is refused')
  assert.ok(open({ scopeId: 'scope-other' }), 'the bound is per view')
  assert.match(first.sessionId, /^ps-[0-9a-f]{32}$/)
  assert.deepEqual([Object.hasOwn(first, 'sessionKey'), Object.hasOwn(first, 'keyDigest')], [false, false], 'what a session hands out carries no key')
  assert.equal(sessions.held(first.sessionId).sessionKey, key)
  assert.ok(sessions.live(SCOPE).every((session) => !Object.hasOwn(session, 'sessionKey')))
  now += 1000
  assert.equal(sessions.renew(second.sessionId).expiresAt, 1000 + PLUGIN_LEASE_TTL_MS)
  assert.deepEqual(sessions.report(SCOPE), { scopeId: SCOPE, appVersion: '1.13.8', pluginVersion: '1.1.0', sessions: 2, instances: 2, renewedAt: new Date(1000).toISOString() }, 'the most recently renewed session speaks for the view; two launches hold it')
  now = PLUGIN_LEASE_TTL_MS
  assert.deepEqual([sessions.report(SCOPE).sessions, sessions.report(SCOPE).instances], [1, 1], 'the session nobody renewed lapsed')
  assert.ok(open(), 'and freed its place')
  assert.equal(sessions.release(second.sessionId), true)
  assert.equal(sessions.held(second.sessionId), null)
  // However often it is renewed, a session ends at its maximum age, and its key with it.
  const aged = createPluginSessions({ now: () => now, maxAgeMs: PLUGIN_MAX_SESSION_AGE_MS })
  const lasting = aged.open({ scopeId: SCOPE, pluginVersion: '1.1.0', appVersion: '1.13.7', instanceId: `pi-${'1'.repeat(32)}`, sessionKey: key, keyDigest: key })
  const openedAt = now
  while (now + PLUGIN_RENEW_INTERVAL_MS < openedAt + PLUGIN_MAX_SESSION_AGE_MS) { now += PLUGIN_RENEW_INTERVAL_MS; assert.ok(aged.renew(lasting.sessionId)) }
  now = openedAt + PLUGIN_MAX_SESSION_AGE_MS
  assert.equal(aged.held(lasting.sessionId), null)
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

test('the bearers are read into memory once, and again only when their directory changed, however many requests arrive', async (t) => {
  let reads = 0
  const counting = (input) => { reads += 1; return readPluginBearers(input) }
  const workspaceRoot = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-cache-'))
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  const cache = createPluginBearerCache({ workspaceRoot, workspaceId: WORKSPACE_ID, read: counting })
  assert.deepEqual([cache.current().size, reads], [0, 1], 'no directory yet')
  const first = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE })
  for (let index = 0; index < 50; index += 1) assert.equal(cache.current().get(SCOPE), first)
  assert.equal(reads, 2, 'fifty lookups, one read after the bearer was minted')
  // Another view's bearer minted, and one deleted to rotate it: each is seen at the next lookup, on every platform.
  ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'scope-other' })
  assert.equal(cache.current().size, 2)
  fs.rmSync(path.join(pluginBearerDirectory(workspaceRoot), `${SCOPE}.json`))
  assert.equal(cache.current().has(SCOPE), false)
  assert.equal(reads, 4)
  // A bearer replaced under the same name by whoever minted it is seen once that is announced.
  const file = path.join(pluginBearerDirectory(workspaceRoot), 'scope-other.json')
  fs.writeFileSync(file, '{"schema":"atelier-obsidian-plugin-bearer/v1"}')
  const replaced = ensurePluginBearer({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'scope-other' })
  cache.invalidate()
  assert.equal(cache.current().get('scope-other'), replaced)

  // Through the listener: fifty requests from a program without a key cost one read in all.
  const world = await channelWorld(t)
  const listenerReads = { count: 0 }
  const counted = createPluginBearerCache({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID, read: (input) => { listenerReads.count += 1; return readPluginBearers(input) } })
  const channel = createPluginChannelForOracleTests({ workspaceRoot: world.workspaceRoot, workspaceId: WORKSPACE_ID, runtimeId: 'rt-1', sessions: createPluginSessions(), statusOf: world.statusOf, serviceStatus: () => 'healthy', bearers: counted })
  const port = await freePort()
  const identity = { serviceName: 'svc', workspaceId: WORKSPACE_ID, runtimeId: 'rt-1', pid: process.pid, host: '127.0.0.1', port, executableDigest: digest('entry'), startedAt: '2026-01-05T10:00:00.000Z' }
  const listener = createServiceServerForOracleTests({ identity, bearer: randomBytes(32).toString('base64url'), operations: { healthStatus: () => 'healthy', status: () => ({}), tick: async () => ({}), stop: async () => {}, plugin: (command, request) => channel.handle(command, request) } }, SERVER_PRIMITIVES)
  await listener.listen()
  t.after(() => listener.close())
  for (let index = 0; index < 50; index += 1) {
    const clientNonce = randomBytes(32).toString('hex')
    const answer = await raw({ port, route: PLUGIN_ROUTES.challenge, headers: { Host: authorityOf('127.0.0.1', port) }, body: JSON.stringify({ protocol: PLUGIN_CHANNEL_PROTOCOL, keyHint: randomBytes(32).toString('hex'), clientNonce, issuedAt: Date.now() }) })
    assert.equal(answer.statusCode, 401)
  }
  assert.equal(listenerReads.count, 1, 'the store was read once')
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

// `before(workspaceRoot)` runs before the store is made, for what must be there when it is.
function publicationWorld(t, { vaultRoot, before = () => {} } = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-publication-'))
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  before(workspaceRoot)
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
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755, 'the mode of a vault root Atelier did not place is never changed')
  assert.ok(named.read(`${PLUGIN_DIRECTORY}/main.js`))
  assert.equal(named.recovered().some((bytes) => bytes.includes('b'.repeat(43))), false, 'nor a copy of it anywhere in recovery')
})

test('a vault path Atelier placed that is a link is never made private and never receives the bearer', needsExchange, async (t) => {
  if (process.platform === 'win32') return t.skip('permission bits')
  const elsewhere = fs.mkdtempSync(path.join(TMP, 'atelier-plugin-linked-vault-'))
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }))
  fs.chmodSync(elsewhere, 0o755)
  const world = publicationWorld(t, { before: (workspaceRoot) => { fs.mkdirSync(path.join(workspaceRoot, 'vaults'), { recursive: true, mode: 0o700 }); fs.symlinkSync(elsewhere, path.join(workspaceRoot, 'vaults', SCOPE)) } })
  assert.deepEqual([world.store.managedVaultRoot, world.store.linkedVaultRoot, world.store.vaultRoot], [false, true, fs.realpathSync(elsewhere)])
  const result = await world.publish(pluginViewOf('gen-0001'))
  assert.equal(result.state, 'committed', 'the notes and the rest of the plugin are published')
  assert.deepEqual([outcomeOf(result, PLUGIN_DATA_PATH).outcome, outcomeOf(result, PLUGIN_DATA_PATH).reason, outcomeOf(result, PLUGIN_DATA_PATH).blocking], ['vault-not-private', 'vault-root-is-a-link', false])
  assert.equal(fs.statSync(elsewhere).mode & 0o777, 0o755, 'the mode of the folder the link leads to is never changed')
  assert.equal(world.read(PLUGIN_DATA_PATH), null)
  // Private behind the link or not: the folder was chosen elsewhere, and the bearer does not go there.
  fs.chmodSync(elsewhere, 0o700)
  const again = await world.publish(pluginViewOf('gen-0002', { notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } }))
  assert.deepEqual([again.state, outcomeOf(again, PLUGIN_DATA_PATH).reason, world.read(PLUGIN_DATA_PATH)], ['committed', 'vault-root-is-a-link', null])
})

test('a plugin file the person repaired, changed or removed is written again when the same generation is published again', needsExchange, async (t) => {
  const world = publicationWorld(t)
  const second = () => pluginViewOf('gen-0002', { notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } })
  assert.equal((await world.publish(pluginViewOf('gen-0001'))).state, 'committed')
  // A folder where the data file goes: left for the person, and the generation commits without it.
  fs.rmSync(world.full(PLUGIN_DATA_PATH))
  fs.mkdirSync(world.full(PLUGIN_DATA_PATH))
  const withheld = await world.publish(second())
  assert.deepEqual([withheld.state, outcomeOf(withheld, PLUGIN_DATA_PATH).outcome], ['committed', 'path-unsafe'])
  // The person repairs it. Nothing else of the view changed, so it is the same generation, and it is published again.
  fs.rmdirSync(world.full(PLUGIN_DATA_PATH))
  const repaired = await world.publish(second())
  assert.deepEqual([repaired.state, repaired.alreadyCommitted ?? false, repaired.generationId, outcomeOf(repaired, PLUGIN_DATA_PATH).outcome], ['committed', false, 'gen-0002', 'created'])
  assert.ok(world.read(PLUGIN_DATA_PATH))
  assert.equal(outcomeOf(repaired, NOTE).outcome, 'unchanged', 'the notes are kept as they are')
  // With nothing drifted, the same generation is not published again.
  assert.equal((await world.publish(second())).alreadyCommitted, true)
  // A plugin file changed by hand is written again, and what it held is kept in recovery; a removed folder comes back.
  fs.writeFileSync(world.full(`${PLUGIN_DIRECTORY}/main.js`), '// changed by hand\n')
  const edited = await world.publish(second())
  assert.deepEqual([edited.alreadyCommitted ?? false, outcomeOf(edited, `${PLUGIN_DIRECTORY}/main.js`).outcome], [false, 'published'])
  assert.ok(world.read(`${PLUGIN_DIRECTORY}/main.js`).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'))))
  assert.ok(world.recovered().some((bytes) => bytes.toString() === '// changed by hand\n'))
  fs.rmSync(world.full(PLUGIN_DIRECTORY), { recursive: true })
  assert.equal((await world.publish(second())).state, 'committed')
  assert.deepEqual(fs.readdirSync(world.full(PLUGIN_DIRECTORY)).sort(), [...PLUGIN_SOURCE_FILES, 'data.json'].sort())
  // A file prepared only where present that is gone is the person's decision, not a drift.
  fs.rmSync(world.full(PLUGIN_DIRECTORY), { recursive: true })
  const off = { community: { entry: 'withheld', reason: 'turned-off-in-this-vault' }, onlyIfPresent: true, notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } }
  assert.equal((await world.publish(pluginViewOf('gen-0003', off))).state, 'committed')
  assert.equal((await world.publish(pluginViewOf('gen-0003', off))).alreadyCommitted, true)
  assert.equal(fs.existsSync(world.full(PLUGIN_DIRECTORY)), false)
})

test('a plugin folder the person can read but not write is reported and holds no note back: a file that cannot be made or replaced there is typed', needsExchange, async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permission bits')
  const world = publicationWorld(t)
  assert.equal((await world.publish(pluginViewOf('gen-0001'))).state, 'committed')
  // The data file is gone and the folder is read-only; a later plugin version wants to replace main.js there.
  fs.rmSync(world.full(PLUGIN_DATA_PATH))
  const folder = world.full(PLUGIN_DIRECTORY)
  fs.chmodSync(folder, 0o555)
  t.after(() => { try { fs.chmodSync(folder, 0o755) } catch { /* gone */ } })
  const source = readPluginSource()
  const newer = { version: '1.1.1', files: source.files.map((file) => (file.name === 'main.js' ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from('\n// 1.1.1\n')]) } : file)) }
  const result = await world.publish(pluginViewOf('gen-0002', { source: newer, notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } }))
  assert.equal(result.state, 'committed', 'the notes are committed all the same')
  assert.equal(world.read(NOTE).toString(), `${NOTE_TEXT}Second.\n`)
  const replaced = outcomeOf(result, `${PLUGIN_DIRECTORY}/main.js`)
  const created = outcomeOf(result, PLUGIN_DATA_PATH)
  assert.deepEqual([replaced.outcome, replaced.blocking, created.outcome, created.blocking, created.errorCode], ['exchange-failed', false, 'create-failed', false, 'EACCES'])
  assert.ok(world.read(`${PLUGIN_DIRECTORY}/main.js`).equals(fs.readFileSync(path.join(PLUGIN_SOURCE, 'main.js'))), 'the file there is left as it was')
  assert.deepEqual(world.staged(), [], 'the candidates are retired, not left in staging')
  // Writable again: the same generation is published again, and the files are written.
  fs.chmodSync(folder, 0o755)
  const again = await world.publish(pluginViewOf('gen-0002', { source: newer, notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } }))
  assert.deepEqual([again.state, outcomeOf(again, `${PLUGIN_DIRECTORY}/main.js`).outcome, outcomeOf(again, PLUGIN_DATA_PATH).outcome], ['committed', 'published', 'created'])
})

test('an unreadable plugin or settings file is left for a person and holds nothing back; an unreadable note is refused, typed, as before, and nothing throws', needsExchange, async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permission bits')
  const world = publicationWorld(t)
  assert.equal((await world.publish(pluginViewOf('gen-0001'))).state, 'committed')
  const locked = (relative) => { const file = world.full(relative); fs.chmodSync(file, 0o000); t.after(() => { try { fs.chmodSync(file, 0o644) } catch { /* gone */ } }); return file }
  locked(`${PLUGIN_DIRECTORY}/main.js`)
  locked(POLICY_SETTINGS_PATH)
  const second = await world.publish(pluginViewOf('gen-0002', { notes: { [NOTE]: `${NOTE_TEXT}Second.\n` } }))
  assert.equal(second.state, 'committed')
  for (const relative of [`${PLUGIN_DIRECTORY}/main.js`, POLICY_SETTINGS_PATH]) {
    const unit = outcomeOf(second, relative)
    assert.deepEqual([unit.outcome, unit.blocking, unit.errorCode], ['path-unsafe', false, 'EACCES'], relative)
  }
  assert.equal(world.read(NOTE).toString(), `${NOTE_TEXT}Second.\n`, 'the notes are published all the same')
  // A note nobody may read keeps its view from committing, as before: refused while its candidate is staged, typed.
  locked(NOTE)
  const third = await world.publish(pluginViewOf('gen-0003', { notes: { [NOTE]: `${NOTE_TEXT}Third.\n` } }))
  assert.deepEqual([third.state, third.refusal?.code, third.refusal?.detail?.cause], ['refused', 'staging-failed', 'EACCES'])
  assert.equal(world.store.readCurrent().generationId, 'gen-0002')
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
  assert.deepEqual(reports.at(-1), { scopeId: SCOPE, appVersion: '1.13.7', pluginVersion: shippedManifest().version, sessions: 1, instances: 1, renewedAt: reports.at(-1).renewedAt })
  await plugin.cycle()
  assert.equal(statusBar(), 'Atelier: current')

  plugin.unload()
  await waitFor(async () => (await world.statusDocument()).plugins.scopes[0].present === false, { label: 'the released lease' })
})

test('with two launches of the plugin holding one view, neither version decides: the probe is asked as if no plugin were there', needsExchange, async (t) => {
  const world = serviceWorld(t)
  const reports = []
  const service = await world.service({ adapterFactory: (input) => { reports.push(input.pluginReport); return absentAdapter() } })
  assert.ok((await service.tickNow()).ok)
  const change = async (line) => {
    fs.appendFileSync(world.source('harbor/notes/tides.md'), `\n${line}\n`)
    world.advance(1000)
    assert.ok((await service.tickNow()).ok)
  }
  const first = world.plugin()
  await first.plugin.load()
  await first.plugin.cycle()
  const second = world.plugin()
  await second.plugin.load()
  await second.plugin.cycle()
  assert.equal((await world.statusDocument()).plugins.scopes[0].sessions, 2)
  await change('Low water at six.')
  assert.equal(reports.at(-1), null, 'two apps hold the vault: which one the command-line tool reaches is not known')
  second.plugin.unload()
  await waitFor(async () => (await world.statusDocument()).plugins.scopes[0].sessions === 1, { label: 'one launch left' })
  await change('Slack water at three.')
  assert.deepEqual([reports.at(-1)?.instances, reports.at(-1)?.appVersion], [1, '1.13.7'])
})

test('qualification: the command-line tool\'s version decides wherever it gives one, a live plugin\'s stands in where it gives none, and without a plugin the probe decides', () => {
  let at = 0
  const built = []
  const asked = []
  let observation = { installed: true, cli: true, running: true, version: null, noVaultOpen: true }
  const factory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => { asked.push(at); return { ...observation } } }, createAdapter: (input) => { built.push(input.qualification); return { kind: 'fake' } }, now: () => at })
  const report = (appVersion) => ({ scopeId: SCOPE, appVersion, pluginVersion: '1.1.0', sessions: 1, instances: 1, renewedAt: '2026-01-05T10:00:00.000Z' })
  // A new answer from the app, after the remembered one has aged out.
  const next = (seen) => { observation = seen; at += 60_000 }
  const scope = { scopeId: SCOPE }

  // The tool gives no version (it says no vault is open, as it does while a vault is still loading): the plugin's stands in.
  factory({ scope, pluginReport: report('1.13.7') })
  assert.deepEqual(built.at(-1), { floor: MINIMUM_APP_VERSION, version: '1.13.7', running: true, versionSource: 'plugin', outcome: 'qualified', reason: 'plugin-reported', versionChecked: true })
  assert.equal(factory.lastQualification().reason, 'plugin-reported')
  assert.throws(() => factory({ scope, pluginReport: report('1.13.6') }), (error) => error.code === 'app-version-unsupported' && error.detail.reason === 'below-minimum-version')
  assert.throws(() => factory({ scope, pluginReport: { scopeId: SCOPE } }), (error) => error.code === 'app-version-unsupported' && error.detail.reason === 'version-unknown', 'a report without a version is not an app that is missing')
  assert.deepEqual(asked, [0], 'the tool is asked with a plugin as without one, through the remembered answer')

  // The tool gives a version: it reaches the app a publication coordinates with, so it decides, whatever the plugin reports.
  next({ installed: true, cli: true, running: true, version: '1.13.5' })
  assert.throws(() => factory({ scope, pluginReport: report('1.13.7') }), (error) => error.code === 'app-version-unsupported' && error.detail.reason === 'below-minimum-version' && error.detail.version === '1.13.5')
  next({ installed: true, cli: true, running: true, version: '1.13.7' })
  factory({ scope, pluginReport: report('1.13.8') })
  assert.deepEqual([built.at(-1).reason, built.at(-1).version, built.at(-1).versionSource], ['meets-minimum-version', '1.13.7', undefined])

  // Installation and the command-line tool are the probe's answer, with a plugin as without one.
  next({ installed: true, cli: false, running: true, version: null })
  assert.throws(() => factory({ scope, pluginReport: report('1.13.7') }), (error) => error.code === 'app-cli-unavailable' && error.detail.reason === 'cli-capability-absent')
  next({ installed: false, cli: false, running: true, version: null })
  factory({ scope, pluginReport: report('1.13.7') })
  assert.deepEqual([built.at(-1).outcome, built.at(-1).versionChecked], ['app-missing', undefined], 'not where Atelier looks: an adapter that coordinates with no running app')

  // Without a plugin, the command-line tool decides, as before: with no vault open it cannot tell the version.
  next({ installed: true, cli: true, running: true, version: null, noVaultOpen: true })
  assert.throws(() => factory({ scope, pluginReport: null }), (error) => error.code === 'app-version-unsupported' && error.detail.reason === 'no-vault-open')
  assert.equal(factory.lastQualification().reason, 'no-vault-open')
  // The plugin's answer is never reused for a call without one.
  assert.throws(() => factory({ scope }), (error) => error.detail.reason === 'no-vault-open')
  assert.deepEqual(qualifyApp({ versionSource: 'plugin', installed: true, cli: true, version: '1.14.2' }).reason, 'plugin-reported')
  assert.deepEqual(qualifyApp({ versionSource: 'plugin', installed: true, cli: true, version: 'soon' }).reason, 'version-unreadable')
  assert.deepEqual(qualifyApp({ versionSource: 'plugin', version: '1.14.2' }).outcome, 'app-missing', 'a plugin report alone does not say where the app is installed')
})

test('a lease that outlives its app vouches for no version: with no app in the process table the probe\'s own answer stands, and an app started since is never coordinated with on the old report', async () => {
  // The app crashed a moment ago: the process table shows none, and its plugin's lease lapses within the lease time.
  const report = { scopeId: SCOPE, appVersion: '1.13.7', pluginVersion: '1.1.0', sessions: 1, instances: 1, renewedAt: '2026-01-05T10:00:00.000Z' }
  const built = []
  const factory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => ({ installed: true, cli: true, running: false, version: null }) }, createAdapter: (input) => { built.push(input.qualification); return { kind: 'fake' } } })
  factory({ scope: { scopeId: SCOPE }, pluginReport: report })
  assert.deepEqual(built.at(-1), { floor: MINIMUM_APP_VERSION, version: null, running: false, outcome: 'qualified', reason: 'app-not-running-version-not-needed', versionChecked: false })
  assert.equal(factory.lastQualification().reason, 'app-not-running-version-not-needed')
  // An adapter built on that answer publishes to the files while no app runs, and never coordinates with an app found
  // running later (restarted, perhaps as a newer version): its version is asked for at the next qualification.
  let processes = 'absent'
  const adapter = createEditorAdapter({ call: async () => { throw new Error('no app answers') }, processProbe: () => processes, qualification: built.at(-1) })
  assert.equal((await adapter.probe({ vaultRoot: '/vault' })).state, 'absent')
  processes = 'running'
  const later = await adapter.probe({ vaultRoot: '/vault' })
  assert.deepEqual([later.state, later.reason.split(':')[0]], ['uncoordinated', 'app-version-unchecked'])
  // open follows the same rule.
  const presence = async () => ({ present: true, reason: 'live-lease', appVersion: '1.13.7', pluginVersion: '1.1.0', sessions: 1 })
  const stopped = { installed: true, cli: true, running: false, version: null }
  const inspected = await withPluginReportedVersion({ inspect: async () => ({ ...stopped }), vaultState: async () => ({ answered: false, indexReady: false }) }, presence).inspect()
  assert.deepEqual(inspected, stopped)
  // Where the process table cannot tell, the plugin's version still stands in.
  const unknown = await withPluginReportedVersion({ inspect: async () => ({ ...stopped, running: null }), vaultState: async () => ({ answered: false, indexReady: false }) }, presence).inspect()
  assert.deepEqual([unknown.versionSource, unknown.version], ['plugin', '1.13.7'])
})

test('status and open report the plugin, and open takes the app version from it where the command-line tool cannot tell', needsExchange, async (t) => {
  const world = serviceWorld(t)
  const service = await world.service()
  await service.tickNow()
  // The app runs with the vault open, and the command-line tool answers for it, but its version call gives no answer
  // (it timed out, say): the version cannot be told from the tool.
  const launches = []
  const seams = {
    appProbe: { inspect: async () => ({ installed: true, cli: true, running: true, version: null }), vaultState: async () => ({ answered: true, indexReady: true }) },
    launcher: { open: async ({ vaultRoot }) => { launches.push(vaultRoot); return { launched: true, reason: 'fake' } } },
    service: { entryPath: TEST_SERVICE_ENTRY, spawn() { throw new Error('a service was started') } },
  }
  const without = await world.run(['open', '--json', '--consent-actor', CONSENT.actor], { seams })
  assert.deepEqual([without.json.outcome, without.json.reason, without.json.plugin], ['app-version-unsupported', 'version-unknown', { present: false, reason: 'no-live-lease' }])
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
  // Status says so at once, from the vault's own list; the record follows with the view's next preparation.
  const seen = await world.run(['plugin', 'show', '--json'], { seams: QUIET_SEAMS })
  assert.deepEqual(seen.json.plugins[0].choice, { state: 'off', reason: 'entry-removed-by-person', since: null, pending: true })
  assert.equal(seen.json.plugins[0].presence.reason, 'turned-off-in-this-vault')
  assert.equal((await world.statusDocument()).plugins.scopes[0].entry, 'off')
  assert.deepEqual(vault.choice(), ['on', 'entry-confirmed'], 'status records nothing')
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

  // The second way back: the person turns it on in Obsidian, which lists it again. Status follows at once.
  fs.writeFileSync(vault.list, JSON.stringify(['dataview', PLUGIN_ID]))
  assert.equal((await world.run(['status', '--json'], { seams: QUIET_SEAMS })).json.scopes[0].plugin.reason, 'no-live-lease')
  await change('Spring tide after that.')
  assert.deepEqual(vault.choice(), ['on', 'entry-restored-by-person'])
  assert.deepEqual(vault.listed(), ['dataview', PLUGIN_ID])
  assert.equal((await world.run(['status', '--json'], { seams: QUIET_SEAMS })).json.scopes[0].plugin.reason, 'no-live-lease')
})

test('an entry written while an app held the vault is only offered: that app writing back its list without it is no decision of the person\'s, until the plugin ran there', needsExchange, async (t) => {
  const world = serviceWorld(t)
  // An app that answers for the vault: every publication is made through it.
  const inApp = () => createEditorAdapter({ processProbe: () => 'running', call: async (payload) => runInProcess(payload, createInProcessHost()) })
  const service = await world.service({ adapterFactory: inApp })
  const vault = choiceWorld(world)
  const change = async (line) => {
    fs.appendFileSync(world.source('harbor/notes/tides.md'), `\n${line}\n`)
    world.advance(1000)
    assert.ok((await service.tickNow()).ok)
    assert.equal(world.freshness().state, 'current', `after "${line}"`)
  }
  assert.ok((await service.tickNow()).ok)
  assert.equal(world.freshness().state, 'current')
  assert.deepEqual(vault.listed(), [PLUGIN_ID])
  assert.deepEqual(vault.choice(), ['offered', 'entry-offered-while-the-app-runs'])

  // The app writes back the list it read before the entry was there: not the person's decision, and the entry is offered again.
  fs.writeFileSync(vault.list, JSON.stringify(['dataview']))
  await change('Low water at six.')
  assert.deepEqual(vault.choice(), ['offered', 'entry-offered-while-the-app-runs'])
  assert.deepEqual(vault.listed(), ['dataview', PLUGIN_ID])
  assert.notEqual((await world.run(['status', '--json'], { seams: QUIET_SEAMS })).json.scopes[0].plugin.reason, 'turned-off-in-this-vault')

  // The plugin runs in the app: the app has the entry, and from now on a list without it is the person's.
  const { plugin } = world.plugin()
  await plugin.load()
  await plugin.cycle()
  assert.deepEqual(vault.choice(), ['on', 'entry-seen-by-the-app'])
  plugin.unload()
  fs.writeFileSync(vault.list, JSON.stringify(['dataview']))
  await change('Slack water at three.')
  assert.deepEqual(vault.choice(), ['off', 'entry-removed-by-person'])
  assert.deepEqual(vault.listed(), ['dataview'])
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
  // A version the tool did answer must meet the floor as well: the tool may reach another app that holds the vault.
  const older = await qualified({ installed: true, cli: true, running: true, version: '1.13.5' }, live)
  assert.deepEqual([older.reason, older.version], ['below-minimum-version', '1.13.5'])
  // The presence costs a round trip to the service: it is asked at most once a second, however often the app is.
  let now = 0
  let reads = 0
  const polled = withPluginReportedVersion(probe({ installed: true, cli: true, running: true, version: null, noVaultOpen: true }), async () => { reads += 1; return live }, { now: () => now })
  for (let poll = 0; poll < 10; poll += 1) { assert.equal((await polled.inspect()).versionSource, 'plugin'); now += 50 }
  assert.equal(reads, 1)
  now += 1000
  await polled.inspect()
  assert.equal(reads, 2)
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
  real.launch = async () => {
    real.instance = new Instance({ ...layout, vault: fs.realpathSync(real.world.vault) })
    await real.instance.launch({ readyTimeoutMs: 60000 })
    real.appRunning = true
  }
  await real.launch()
  real.appVersion = (await real.instance.version()).trim()
  real.note('app-started', { appVersion: real.appVersion, profileProcesses: processesOfProfile(layout.profile).length })
  real.evaluate = async (code) => {
    const out = await real.instance.cli('eval', `code=${code}`)
    const start = out.indexOf('=> ')
    return start < 0 ? out.trim() : out.slice(start + 3).trim()
  }
  // A read the command-line transport lost (it happens while the app stays responsive) is asked again: by the caller's
  // poll (peek), or here, twice (read).
  real.peek = async (code) => { try { return await real.evaluate(code) } catch { real.note('transport-reply-lost', { code: code.slice(0, 60) }); return null } }
  real.read = async (code) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await real.evaluate(code) } catch (error) { if (attempt >= 2) throw error; real.note('transport-reply-lost', { code: code.slice(0, 60) }) }
    }
  }
  // Every change of what the window shows is noted. The window takes focus when it starts, so input from outside the
  // harness can answer the prompt before the first look: the failure says so instead of only timing out. A test whose
  // subject comes after trust passes `orTrusted`, and a vault already trusted that way will do for it.
  real.prompt = async ({ orTrusted = false } = {}) => {
    let last = null
    try {
      return await waitFor(async () => {
        const text = await real.peek("(()=>{const m=document.querySelector('.modal.mod-trust-folder');return JSON.stringify({prompt:m?{title:m.querySelector('.modal-title')?.textContent??null,buttons:[...m.querySelectorAll('button')].map(b=>b.textContent)}:null,modals:[...document.querySelectorAll('.modal')].map(x=>x.className),answer:localStorage.getItem('enable-plugin-'+app.appId),loaded:Object.keys(app.plugins.plugins)})})()")
        if (text && text !== last) { real.note('prompt-poll', { seen: text }); last = text }
        const seen = text ? JSON.parse(text) : null
        if (seen?.prompt) return seen.prompt
        return orTrusted && seen?.answer === 'true' ? { trustedBeforeTheHarnessLooked: true } : null
      }, { timeoutMs: 60000, everyMs: 500, label: 'the trust prompt' })
    } catch (error) {
      const answered = last !== null && JSON.parse(last).answer !== null
      throw new Error(`${error.message}; the app shows ${last}${answered ? ' (the prompt was answered before the harness looked, by input from outside the harness)' : ''}`)
    }
  }
  real.pluginLoaded = async () => (await real.peek(`String(Boolean(app.plugins.plugins['${PLUGIN_ID}']))`)) === 'true'
  real.statusBar = () => real.read("document.querySelector('.atelier-projection-status-bar')?.textContent ?? ''")
  // Pressing a button is not repeated blindly: a lost reply is judged by what followed it.
  real.trust = async () => {
    let pressed
    try { pressed = await real.evaluate("(()=>{const b=[...document.querySelectorAll('.modal.mod-trust-folder button')].find(x=>x.textContent==='Trust author and enable plugins');if(!b)return 'no-button';b.click();return 'pressed'})()") } catch { pressed = 'reply-lost' }
    await waitFor(real.pluginLoaded, { timeoutMs: 30000, everyMs: 250, label: 'the plugin to load' })
    await real.peek('(app.setting.close(),"closed")')
    return pressed
  }
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

    // Answer it the way a person does: press "Trust author and enable plugins" in that window. Trusting opens the
    // community plugin settings, which are closed again so the window shows the vault.
    const pressed = await real.trust()
    assert.ok(['pressed', 'reply-lost'].includes(pressed), pressed)
    real.note('trusted', { pressed, loaded: true, restrictedMode: await real.peek('String(!app.plugins.isEnabled())') })

    const presence = await waitFor(async () => { const scope = await real.presence(); return scope.present ? scope : null }, { timeoutMs: 20000, everyMs: 250, label: 'the lease' })
    real.note('lease-seen-by-service', presence)
    assert.ok(parseAppVersion(real.appVersion), real.appVersion)
    assert.equal(presence.appVersion, real.appVersion.split(/\s+/)[0], 'the version the plugin reports is the app\'s own')
    assert.equal(presence.pluginVersion, shippedManifest().version)
    const statusBar = await waitFor(async () => { const text = await real.statusBar(); return text === 'Atelier: current' ? text : null }, { timeoutMs: 20000, everyMs: 250, label: 'the status bar item' })
    real.note('status-bar', { text: statusBar })

    // A change at the source while the plugin holds the view: published through the app. The command-line tool answers
    // with a version, so its answer qualifies the app, as it would without a plugin; both name the same app here.
    await real.change('Low water at six.')
    const qualification = real.adapterFactory.lastQualification()
    real.note('published-with-plugin', { freshness: real.world.freshness().state, reason: real.world.freshness().reason, qualification: { outcome: qualification.outcome, reason: qualification.reason, version: qualification.version }, probe: real.probes.at(-1), versionCalls: real.versionCalls.length })
    assert.deepEqual([qualification.outcome, qualification.reason], ['qualified', 'meets-minimum-version'])
    assert.equal(parseAppVersion(qualification.version).minor, parseAppVersion(presence.appVersion).minor, 'the tool and the plugin name the same app')
    assert.ok(real.versionCalls.length > 0, 'the command-line tool was asked for the version')
    assert.deepEqual(real.probes.at(-1), { state: 'coordinated', qualification: 'meets-minimum-version' })
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

test('the desktop procedures decline the trust prompt; after a lost reply the app\'s own restricted mode says how it was answered', async () => {
  const { declineTrustPrompt } = await import('../scripts/obsidian/desktop-receipts.mjs')
  // A scripted command-line tool: the first press's reply is lost, the prompt is gone after it, and the app answers
  // for its own restricted mode.
  const replyLost = (restricted) => {
    let presses = 0
    const asked = []
    return {
      asked,
      async cli(command, code) {
        assert.equal(command, 'eval')
        if (code.includes('mod-trust-folder')) {
          presses += 1
          asked.push('press')
          if (presses === 1) throw new Error('the reply was lost')
          return '=> no-prompt'
        }
        if (code.includes('app.plugins.isEnabled()')) { asked.push('restricted-mode'); return `=> ${restricted}` }
        throw new Error(`no answer for ${code.slice(0, 60)}`)
      },
    }
  }
  const declined = replyLost(true)
  assert.equal(await declineTrustPrompt(declined, { everyMs: 1 }), 'declined-reply-lost')
  assert.deepEqual(declined.asked, ['press', 'press', 'restricted-mode'])
  // The prompt gone with community plugins on: someone answered it the other way, and that is no decline.
  assert.equal(await declineTrustPrompt(replyLost(false), { everyMs: 1 }), 'not-declined')
  // A press whose reply arrives is the decline itself; no prompt at all is no action.
  assert.equal(await declineTrustPrompt({ cli: async () => '=> declined' }, { everyMs: 1 }), 'declined')
  assert.equal(await declineTrustPrompt({ cli: async () => '=> no-prompt' }, { waitMs: 20, everyMs: 1 }), 'no-prompt')
})

test('real isolated Obsidian: in restricted mode nothing runs in the vault and the command-line path publishes as before', realApp, async (t) => {
  const { declineTrustPrompt } = await import('../scripts/obsidian/desktop-receipts.mjs')
  const real = await realAppWorld(t)
  try {
    await real.prompt()
    // The desktop procedures answer the prompt this way: they prove the command-line path.
    assert.ok(['declined', 'declined-reply-lost'].includes(await declineTrustPrompt(real.instance)))
    const state = { restrictedMode: await real.read('String(!app.plugins.isEnabled())'), loaded: await real.pluginLoaded(), prompt: await real.read("String(Boolean(document.querySelector('.modal.mod-trust-folder')))"), statusBarItem: await real.statusBar() }
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

test('real isolated Obsidian: uninstalling the plugin in the app is followed until `atelier obsidian plugin on` brings it back', realApp, async (t) => {
  const real = await realAppWorld(t)
  const list = path.join(real.world.vault, COMMUNITY_PLUGINS_PATH)
  const folder = path.join(real.world.vault, PLUGIN_DIRECTORY)
  const choice = () => readPluginChoice({ workspaceRoot: real.world.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE })
  try {
    // Trust is where this test starts, not what it proves (the first real-app test proves the prompt).
    if ((await real.prompt({ orTrusted: true })).trustedBeforeTheHarnessLooked !== true) await real.trust()
    await waitFor(async () => (await real.presence()).present, { timeoutMs: 20000, everyMs: 250, label: 'the lease' })
    real.note('trusted', { choice: choice().state })
    assert.equal(choice().state, 'on')

    // The person uninstalls it from Settings, Community plugins: Obsidian removes the entry and deletes the folder.
    // Not repeated if its reply is lost: what the app wrote is looked at next.
    try { await real.evaluate(`(app.plugins.uninstallPlugin('${PLUGIN_ID}').then(()=>'uninstalled'))`) } catch { real.note('transport-reply-lost', { code: 'uninstallPlugin' }) }
    await waitFor(() => !fs.existsSync(folder) && fs.existsSync(list) && !JSON.parse(fs.readFileSync(list, 'utf8')).includes(PLUGIN_ID), { timeoutMs: 20000, everyMs: 250, label: 'the app to write its list' })
    const theirs = fs.readFileSync(list)
    await waitFor(async () => ((await real.presence()).present === false ? true : null), { timeoutMs: PLUGIN_LEASE_TTL_MS + 10000, everyMs: 250, label: 'the end of the presence' })
    await real.change('Low water at six.')
    const off = { choice: choice(), listUntouched: fs.readFileSync(list).equals(theirs), folderMadeAgain: fs.existsSync(folder), entry: (await real.presence()).entry, freshness: real.world.freshness().state }
    real.note('uninstalled-and-followed', { ...off, list: JSON.parse(theirs.toString('utf8')) })
    assert.deepEqual([off.choice.state, off.choice.reason, off.listUntouched, off.folderMadeAgain, off.entry, off.freshness], ['off', 'entry-removed-by-person', true, false, 'off', 'current'])

    // `atelier obsidian plugin on`, then the view's next publication: the entry and the folder come back.
    const on = await real.world.run(['plugin', 'on', '--json'], { seams: QUIET_SEAMS })
    assert.equal(on.json.choice.state, 'requested')
    await real.change('Slack water at three.')
    const back = { choice: choice(), listed: JSON.parse(fs.readFileSync(list, 'utf8')), files: fs.existsSync(folder) ? fs.readdirSync(folder).sort() : null }
    real.note('plugin-on', back)
    // Published through the running app, which read its list before: offered, not yet confirmed.
    assert.deepEqual([back.choice.state, back.choice.reason, back.listed.includes(PLUGIN_ID), back.files], ['offered', 'entry-offered-while-the-app-runs', true, [...PLUGIN_SOURCE_FILES, 'data.json'].sort()])

    // The app reads its plugin list when it starts: after a restart the plugin runs again, and the vault's trust was kept.
    await real.instance.quit()
    real.appRunning = false
    await real.launch()
    await waitFor(real.pluginLoaded, { timeoutMs: 30000, everyMs: 250, label: 'the plugin to load after the restart' })
    const again = await waitFor(async () => { const scope = await real.presence(); return scope.present ? scope : null }, { timeoutMs: 20000, everyMs: 250, label: 'the lease after the restart' })
    const promptAgain = await real.read("String(Boolean(document.querySelector('.modal.mod-trust-folder')))")
    real.note('restarted', { presence: again, promptShownAgain: promptAgain, choice: choice() })
    assert.equal(promptAgain, 'false')
    assert.deepEqual([choice().state, choice().reason], ['on', 'entry-seen-by-the-app'], 'the plugin running in the app confirms the entry')
    await real.instance.quit()
    real.appRunning = false
  } finally {
    t.diagnostic(`trace ${JSON.stringify(real.trace)}`)
  }
})
