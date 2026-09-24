import { createHmac } from 'node:crypto'

// The channel between Atelier's own plugin, inside a vault Atelier manages,
// and the maintenance service of the workspace that manages that vault.
//
// A closed command surface over the service's literal loopback listener:
//
//   POST /plugin/challenge  a fresh nonce and the time it was made, and a hint
//                           at which vault's key it means that only the holder
//                           of that key can read; the service answers, once
//                           and only while it is fresh, with its own nonce and
//                           a proof that it holds the key
//   POST /plugin/hello      only after the plugin checked that proof: its own
//                           proof, the plugin and app versions, an id of this
//                           launch of the plugin, and a proof of the vault path
//                           the app has open (the path itself is never sent)
//   POST /plugin/lease      "this vault is open in an app", renewed every two
//                           seconds; it lapses on its own six seconds later
//   POST /plugin/release    the vault closed, or the plugin unloaded
//   POST /plugin/status     freshness, reason and held edits of this view
//
// The key is the vault's bearer, which Atelier writes into the plugin's data
// file of that vault only and keeps in private state. It never crosses the
// wire, and neither does anything that names the view or the vault before the
// listener proved it holds the key: a program squatting the service's port
// while the service is down learns a nonce and a hint it cannot link to a
// vault, and cannot answer. Both proofs bind the listener's exact address, so
// an answer relayed from a service listening elsewhere does not verify.
//
// A challenge recorded by such a program and sent to the service later is
// worth little: the service answers a challenge only within thirty seconds of
// the time it names, and a nonce only once, and at most four handshakes wait
// for their hello per view, so one view's challenges never hold up another's.
//
// The handshake derives a key for one session. Every later request carries
// the session, a counter that only goes up, and a MAC over both and the
// command under that key; every answer carries a MAC over the request's counter
// and the exact bytes of the answer. A handshake is used once and lapses after
// five seconds, a session after fifteen minutes. Nothing here takes a path to
// act on, a command or code, and every command maps to state the service
// already keeps (see docs/obsidian-plugin.md).
//
// The plugin cannot import this module: it runs inside the app, from the
// vault. It carries the same constants and the same computations, and the test
// suite holds the two to each other: a plugin that computes any one of them
// otherwise cannot complete a handshake.

export const PLUGIN_ID = 'atelier-projection'
export const PLUGIN_DIRECTORY = `.obsidian/plugins/${PLUGIN_ID}`
// Shipped with the package under plugins/obsidian/ and copied into every vault unchanged.
export const PLUGIN_SOURCE_FILES = Object.freeze(['manifest.json', 'main.js', 'styles.css'])
// Written per vault: the channel address and that vault's bearer.
export const PLUGIN_DATA_FILE = 'data.json'
export const PLUGIN_DATA_PATH = `${PLUGIN_DIRECTORY}/${PLUGIN_DATA_FILE}`
// The data file holds the vault's key: only the person who runs the vault reads it. The app reads the others.
export const PLUGIN_DATA_MODE = 0o600
export const PLUGIN_SOURCE_MODE = 0o644

export const PLUGIN_CHANNEL_PROTOCOL = 'atelier-obsidian-plugin-channel/v2'
export const PLUGIN_DATA_SCHEMA = 'atelier-obsidian-plugin-data/v1'
export const PLUGIN_STATUS_SCHEMA = 'atelier-obsidian-plugin-status/v1'

export const PLUGIN_COMMANDS = Object.freeze(['challenge', 'hello', 'lease', 'release', 'status'])
export const PLUGIN_ROUTES = Object.freeze(Object.fromEntries(PLUGIN_COMMANDS.map((command) => [command, `/plugin/${command}`])))
export const PLUGIN_REQUEST_FIELDS = Object.freeze({
  challenge: Object.freeze(['protocol', 'keyHint', 'clientNonce', 'issuedAt']),
  hello: Object.freeze(['handshakeId', 'pluginVersion', 'appVersion', 'instanceId', 'vaultProof', 'clientProof']),
  lease: Object.freeze(['sessionId', 'counter', 'mac']),
  release: Object.freeze(['sessionId', 'counter', 'mac']),
  status: Object.freeze(['sessionId', 'counter', 'mac']),
})

export const PLUGIN_MAX_REQUEST_BYTES = 1024
export const PLUGIN_RENEW_INTERVAL_MS = 2000
// Three renewals may be missed before a vault stops counting as open.
export const PLUGIN_LEASE_TTL_MS = 3 * PLUGIN_RENEW_INTERVAL_MS
export const PLUGIN_MAX_SESSIONS_PER_SCOPE = 8
export const PLUGIN_HANDSHAKE_TTL_MS = 5000
// A challenge is answered only this close to the time it names (both sides read one machine's clock).
export const PLUGIN_CHALLENGE_WINDOW_MS = 30 * 1000
export const PLUGIN_MAX_PENDING_HANDSHAKES_PER_SCOPE = 4
// A session key is short-lived: the plugin shakes hands again after this long.
export const PLUGIN_MAX_SESSION_AGE_MS = 15 * 60 * 1000
// The app version the plugin needs, the floor of the publication protocol (app-capability.mjs).
export const PLUGIN_MINIMUM_APP_VERSION = '1.13.7'

export const PLUGIN_BEARER = /^[A-Za-z0-9_-]{43}$/
export const PLUGIN_NONCE = /^[0-9a-f]{64}$/
// A key hint, a proof and a MAC are each one HMAC-SHA256, in hex.
export const PLUGIN_MAC = /^[0-9a-f]{64}$/
export const PLUGIN_HANDSHAKE_ID = /^ph-[0-9a-f]{32}$/
export const PLUGIN_SESSION_ID = /^ps-[0-9a-f]{32}$/
export const PLUGIN_INSTANCE_ID = /^pi-[0-9a-f]{32}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,40}$/
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1'])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The route of a request path, or null. Exact paths only: no query, no prefix.
export function pluginCommandOf(requestPath) {
  return PLUGIN_COMMANDS.find((command) => PLUGIN_ROUTES[command] === requestPath) ?? null
}

// { ok: true, body } or { ok: false, code }. The body has exactly the fields
// of its command, each of its own shape; anything else refuses.
export function validatePluginRequest(command, body) {
  const fields = PLUGIN_REQUEST_FIELDS[command]
  if (fields === undefined) return { ok: false, code: 'unknown-command' }
  if (!isPlainObject(body)) return { ok: false, code: 'request-malformed' }
  const keys = Object.keys(body)
  if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(body, field))) return { ok: false, code: 'request-malformed' }
  const shaped = (field, pattern) => typeof body[field] === 'string' && pattern.test(body[field])
  if (command === 'challenge') {
    if (body.protocol !== PLUGIN_CHANNEL_PROTOCOL) return { ok: false, code: 'protocol-unsupported' }
    if (!shaped('keyHint', PLUGIN_MAC) || !shaped('clientNonce', PLUGIN_NONCE) || !Number.isSafeInteger(body.issuedAt) || body.issuedAt < 1) return { ok: false, code: 'request-malformed' }
  } else if (command === 'hello') {
    if (!shaped('handshakeId', PLUGIN_HANDSHAKE_ID) || !shaped('instanceId', PLUGIN_INSTANCE_ID) || !shaped('vaultProof', PLUGIN_MAC) || !shaped('clientProof', PLUGIN_MAC)) return { ok: false, code: 'request-malformed' }
    if (!shaped('pluginVersion', VERSION_TEXT) || !shaped('appVersion', VERSION_TEXT)) return { ok: false, code: 'request-malformed' }
  } else if (!shaped('sessionId', PLUGIN_SESSION_ID) || !shaped('mac', PLUGIN_MAC) || !Number.isSafeInteger(body.counter) || body.counter < 1) {
    return { ok: false, code: 'request-malformed' }
  }
  return { ok: true, body }
}

// The computations of the handshake and the session, shared with the plugin.
// Every input but a vault path is one of the shapes above, without a line
// break, and a vault path is the only input of its computation, so joining
// them by lines is unambiguous. `key` is the vault's bearer text, or a
// session key.
const transcript = (label, fields) => [PLUGIN_CHANNEL_PROTOCOL, label, ...fields.map(String)].join('\n')
const hmac = (key, label, fields) => createHmac('sha256', key).update(transcript(label, fields), 'utf8').digest()
const hmacHex = (key, label, fields) => hmac(key, label, fields).toString('hex')

// A hint at the vault's key, fresh with every nonce and bound to the time the
// challenge names: the service finds the key it names by computing it for each
// key it holds, and a listener that holds none cannot tell two hints of one
// vault apart, nor move one to another time.
export const pluginKeyHint = ({ bearer, clientNonce, issuedAt }) => hmacHex(bearer, 'key-hint', [clientNonce, issuedAt])
// What binds a handshake: the view, the listener's exact address, both nonces and the handshake.
const handshakeFields = ({ scopeId, authority, clientNonce, serverNonce, handshakeId }) => [scopeId, authority, clientNonce, serverNonce, handshakeId]
export const pluginServerProof = (input) => hmacHex(input.bearer, 'server-proof', handshakeFields(input))
export const pluginSessionKey = (input) => hmac(input.bearer, 'session-key', handshakeFields(input))
// The vault the app has open, proven under the session key rather than named.
export const pluginVaultProof = ({ sessionKey, vaultPath }) => hmacHex(sessionKey, 'vault', [vaultPath])
export const pluginClientProof = (input) => hmacHex(input.bearer, 'client-proof', [...handshakeFields(input), input.pluginVersion, input.appVersion, input.instanceId, input.vaultProof])
export const pluginRequestMac = ({ sessionKey, command, sessionId, counter }) => hmacHex(sessionKey, 'request', [command, sessionId, counter])
// An answer is the exact text of its JSON document and a MAC over it, the command and the request's counter.
export const pluginResponseMac = ({ sessionKey, command, sessionId, counter, payload }) => hmacHex(sessionKey, 'response', [command, sessionId, counter, payload])

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
