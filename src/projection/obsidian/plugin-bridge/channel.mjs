// The channel between Atelier's own plugin, inside a vault Atelier manages,
// and the maintenance service of the workspace that manages that vault.
//
// A closed command surface over the service's literal loopback listener:
//
//   POST /plugin/hello     who asks: protocol, view, plugin and app versions,
//                          and the real path of the vault the app has open
//   POST /plugin/lease     "this vault is open in an app", renewed every two
//                          seconds; it lapses on its own six seconds later
//   POST /plugin/release   the vault closed, or the plugin unloaded
//   POST /plugin/status    freshness, reason and held edits of this view
//
// Every request carries the bearer of its vault, which Atelier writes into the
// plugin's data file of that vault only, and a JSON object of at most 1 KiB
// naming the view it is about. Nothing here takes a path to act on, a command
// or code: `vaultPath` is compared with the vault the service manages for the
// view and is never opened. The plugin forwards and presents; it holds no
// manifest, no edit and no decision, and every command maps to state the
// service already keeps (see docs/obsidian-plugin.md).
//
// The plugin cannot import this module: it runs inside the app, from the
// vault. It carries the same constants, and the test suite holds the two to
// each other.

export const PLUGIN_ID = 'atelier-projection'
export const PLUGIN_DIRECTORY = `.obsidian/plugins/${PLUGIN_ID}`
// Shipped with the package under plugins/obsidian/ and copied into every vault unchanged.
export const PLUGIN_SOURCE_FILES = Object.freeze(['manifest.json', 'main.js', 'styles.css'])
// Written per vault: the channel address and that vault's bearer.
export const PLUGIN_DATA_FILE = 'data.json'
export const PLUGIN_DATA_PATH = `${PLUGIN_DIRECTORY}/${PLUGIN_DATA_FILE}`

export const PLUGIN_CHANNEL_PROTOCOL = 'atelier-obsidian-plugin-channel/v1'
export const PLUGIN_DATA_SCHEMA = 'atelier-obsidian-plugin-data/v1'
export const PLUGIN_STATUS_SCHEMA = 'atelier-obsidian-plugin-status/v1'

export const PLUGIN_COMMANDS = Object.freeze(['hello', 'lease', 'release', 'status'])
export const PLUGIN_ROUTES = Object.freeze(Object.fromEntries(PLUGIN_COMMANDS.map((command) => [command, `/plugin/${command}`])))
export const PLUGIN_REQUEST_FIELDS = Object.freeze({
  hello: Object.freeze(['protocol', 'scopeId', 'pluginVersion', 'appVersion', 'vaultPath']),
  lease: Object.freeze(['scopeId', 'sessionId']),
  release: Object.freeze(['scopeId', 'sessionId']),
  status: Object.freeze(['scopeId']),
})

export const PLUGIN_MAX_REQUEST_BYTES = 1024
export const PLUGIN_RENEW_INTERVAL_MS = 2000
// Three renewals may be missed before a vault stops counting as open.
export const PLUGIN_LEASE_TTL_MS = 3 * PLUGIN_RENEW_INTERVAL_MS
export const PLUGIN_MAX_SESSIONS_PER_SCOPE = 8
// The app version the plugin needs, the floor of the publication protocol (app-capability.mjs).
export const PLUGIN_MINIMUM_APP_VERSION = '1.13.7'

export const PLUGIN_BEARER = /^[A-Za-z0-9_-]{43}$/
export const PLUGIN_SESSION_ID = /^ps-[0-9a-f]{32}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,40}$/
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1'])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The route of a request path, or null. Exact paths only: no query, no prefix.
export function pluginCommandOf(requestPath) {
  return PLUGIN_COMMANDS.find((command) => PLUGIN_ROUTES[command] === requestPath) ?? null
}

// { ok: true, body } or { ok: false, code }. The body has exactly the fields
// of its command, each a bounded string of its own shape; anything else refuses.
export function validatePluginRequest(command, body) {
  const fields = PLUGIN_REQUEST_FIELDS[command]
  if (fields === undefined) return { ok: false, code: 'unknown-command' }
  if (!isPlainObject(body)) return { ok: false, code: 'request-malformed' }
  const keys = Object.keys(body)
  if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(body, field))) return { ok: false, code: 'request-malformed' }
  if (typeof body.scopeId !== 'string' || !IDENTIFIER.test(body.scopeId)) return { ok: false, code: 'request-malformed' }
  if (command === 'lease' || command === 'release') {
    if (typeof body.sessionId !== 'string' || !PLUGIN_SESSION_ID.test(body.sessionId)) return { ok: false, code: 'request-malformed' }
  }
  if (command === 'hello') {
    if (body.protocol !== PLUGIN_CHANNEL_PROTOCOL) return { ok: false, code: 'protocol-unsupported' }
    for (const field of ['pluginVersion', 'appVersion']) if (typeof body[field] !== 'string' || !VERSION_TEXT.test(body[field])) return { ok: false, code: 'request-malformed' }
    if (typeof body.vaultPath !== 'string' || body.vaultPath.length > 1024 || body.vaultPath.includes('\u0000') || !(body.vaultPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(body.vaultPath))) {
      return { ok: false, code: 'request-malformed' }
    }
  }
  return { ok: true, body }
}

// The plugin's data file of one vault: where the service listens and the
// bearer of this vault. Canonical bytes, so an unchanged channel republishes
// nothing.
export function pluginDataDocument({ host, port, scopeId, bearer }) {
  const document = { schema: PLUGIN_DATA_SCHEMA, channel: { host, port }, scopeId, bearer }
  if (validatePluginData(document) === null) throw new TypeError('the plugin data needs a literal loopback address, a port, a view and a bearer')
  return document
}

export function pluginDataBytes(input) {
  const { schema, channel, scopeId, bearer } = pluginDataDocument(input)
  return Buffer.from(`${JSON.stringify({ schema, channel: { host: channel.host, port: channel.port }, scopeId, bearer }, null, 2)}\n`, 'utf8')
}

// The document when it is exactly a plugin data document, else null.
export function validatePluginData(document) {
  if (!isPlainObject(document) || Object.keys(document).sort().join(',') !== 'bearer,channel,schema,scopeId') return null
  if (document.schema !== PLUGIN_DATA_SCHEMA || typeof document.scopeId !== 'string' || !IDENTIFIER.test(document.scopeId)) return null
  if (typeof document.bearer !== 'string' || !PLUGIN_BEARER.test(document.bearer)) return null
  const { channel } = document
  if (!isPlainObject(channel) || Object.keys(channel).sort().join(',') !== 'host,port') return null
  if (!LOOPBACK_HOSTS.includes(channel.host) || !Number.isInteger(channel.port) || channel.port < 1024 || channel.port > 65535) return null
  return document
}
