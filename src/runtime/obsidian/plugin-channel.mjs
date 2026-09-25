import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, readRegularTextNoFollow, realPathAsStored } from '../../project/private-state.mjs'
import {
  PLUGIN_BEARER, PLUGIN_CHALLENGE_WINDOW_MS, PLUGIN_CHANNEL_PROTOCOL, PLUGIN_HANDSHAKE_TTL_MS, PLUGIN_LEASE_TTL_MS, PLUGIN_MAX_PENDING_HANDSHAKES_PER_SCOPE, PLUGIN_MAX_SESSION_AGE_MS, PLUGIN_MAX_SESSIONS_PER_SCOPE,
  PLUGIN_RENEW_INTERVAL_MS, PLUGIN_STATUS_SCHEMA, pluginClientProof, pluginKeyHint, pluginRequestMac, pluginResponseMac, pluginServerProof, pluginSessionKey, pluginVaultProof,
} from '../../projection/obsidian/plugin-bridge/channel.mjs'
import { canonicalJson, compareText, isPlainObject, isoTime } from './documents.mjs'

// The service's half of the plugin channel (plugin-bridge/channel.mjs).
//
//   bearers    one random bearer per view, minted when the view's vault first
//              receives the plugin, kept owner-only under state/plugin/ and
//              written into that vault's plugin data file, nowhere else; it
//              is the key of the handshake and never crosses the wire
//   sessions   who holds a view open right now: a plugin that proved it holds
//              the vault's key and renews its lease; in memory, gone when the
//              service stops
//   commands   challenge, hello, lease, release and status, answered from
//              state the service already keeps; nothing here writes a vault, a
//              source, a manifest or an edit, and no command decides anything
//
// A live session also tells the app version the plugin runs in, and an id of
// that launch of the plugin. That version counts as checked for app
// qualification (app-capability.mjs) while one launch alone holds the view:
// the plugin runs inside exactly that app.

export const PLUGIN_BEARER_SCHEMA = 'atelier-obsidian-plugin-bearer/v1'
export const PLUGIN_PRESENCE_SCHEMA = 'atelier-obsidian-plugin-presence/v1'
const MAX_BEARER_FILES = 256
const segment = (identifier) => identifier.replaceAll(':', '_')

export function pluginBearerDirectory(workspaceRoot) {
  return path.join(workspaceRoot, 'state', 'plugin')
}

function readBearerFile(file, workspaceId) {
  let document
  try { document = JSON.parse(readRegularTextNoFollow(file)) } catch { return null }
  if (!isPlainObject(document) || Object.keys(document).sort().join(',') !== 'bearer,createdAt,schema,scopeId,workspaceId') return null
  if (document.schema !== PLUGIN_BEARER_SCHEMA || document.workspaceId !== workspaceId || typeof document.scopeId !== 'string' || !PLUGIN_BEARER.test(document.bearer ?? '')) return null
  return document
}

// The bearer of one view's vault, minted on first use. A file that does not
// read as this view's bearer is replaced: it cannot authenticate anything, and
// the vault receives the new bearer with its next publication.
export function ensurePluginBearer({ workspaceRoot, workspaceId, scopeId, randomBytes = cryptoRandomBytes, clock = () => new Date() }) {
  const directory = ensureContainedPrivateDirectory({ workspaceRoot, directory: pluginBearerDirectory(workspaceRoot), label: 'Obsidian plugin state' })
  const file = path.join(directory, `${segment(scopeId)}.json`)
  const existing = readBearerFile(file, workspaceId)
  if (existing?.scopeId === scopeId) return existing.bearer
  const bearer = randomBytes(32).toString('base64url')
  atomicReplacePrivateText(file, canonicalJson({ schema: PLUGIN_BEARER_SCHEMA, workspaceId, scopeId, bearer, createdAt: isoTime(clock) }))
  return bearer
}

// Every view's bearer this workspace has minted: scopeId -> bearer.
export function readPluginBearers({ workspaceRoot, workspaceId }) {
  const directory = pluginBearerDirectory(workspaceRoot)
  let names
  try { names = fs.readdirSync(directory) } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error }
  const bearers = new Map()
  for (const name of names.filter((item) => item.endsWith('.json')).sort().slice(0, MAX_BEARER_FILES)) {
    const document = readBearerFile(path.join(directory, name), workspaceId)
    if (document !== null && name === `${segment(document.scopeId)}.json`) bearers.set(document.scopeId, document.bearer)
  }
  return bearers
}

// The bearers in memory. They are read again only when the directory changed
// (a bearer minted, replaced, or deleted to rotate it), so a request costs a
// stat and a listing of the directory, not a read of every file. The names
// are part of what is compared: not every platform changes a directory's times
// when an entry goes away. A bearer the service replaces under the same name
// is announced with `invalidate()`.
export function createPluginBearerCache({ workspaceRoot, workspaceId, read = readPluginBearers }) {
  const directory = pluginBearerDirectory(workspaceRoot)
  const signature = () => {
    try {
      const stat = fs.statSync(directory, { bigint: true })
      return `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${fs.readdirSync(directory).sort().join('/')}`
    } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error }
  }
  let seen = null
  let bearers = new Map()
  return {
    current() {
      // Taken before the read: a change during the read is seen by the next call.
      const now = signature()
      if (now !== seen) { bearers = read({ workspaceRoot, workspaceId }); seen = now }
      return bearers
    },
    invalidate() { seen = null },
  }
}

// The decisions the channel's oracles are sensitive to; tests substitute broken ones to prove the oracles can fail.
export const PLUGIN_CHANNEL_PRIMITIVES = Object.freeze({
  // Two HMACs in hex of validated shape, compared in constant time.
  macMatches: (presented, expected) => typeof presented === 'string' && presented.length === expected.length && timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex')),
  counterIsNew: (counter, last) => counter > last,
  handshakeUsedOnce: true,
  // A challenge is answered only within this long of the time it names, and each of its nonces once.
  challengeWindowMs: PLUGIN_CHALLENGE_WINDOW_MS,
  noncesAnsweredOnce: true,
})

// Sessions of the plugin, per view. A session lives as long as its lease: a
// hello grants one, each renewal extends it by `ttlMs`, and a release, a lapse
// or `maxAgeMs` ends it. At most `maxPerScope` live sessions per view. A
// session holds the key its handshake derived; nothing it hands out carries it.
export function createPluginSessions({ now = () => Date.now(), ttlMs = PLUGIN_LEASE_TTL_MS, maxPerScope = PLUGIN_MAX_SESSIONS_PER_SCOPE, maxAgeMs = PLUGIN_MAX_SESSION_AGE_MS, randomBytes = cryptoRandomBytes } = {}) {
  const sessions = new Map()
  const prune = () => { const at = now(); for (const [sessionId, session] of sessions) if (session.expiresAt <= at || at - session.openedAt >= maxAgeMs) sessions.delete(sessionId) }
  const liveFor = (scopeId) => { prune(); return [...sessions.values()].filter((session) => session.scopeId === scopeId) }
  const shown = ({ sessionKey: _key, keyDigest: _digest, ...session }) => ({ ...session })
  return {
    open({ scopeId, pluginVersion, appVersion, instanceId, sessionKey, keyDigest }) {
      if (liveFor(scopeId).length >= maxPerScope) return null
      const at = now()
      const session = { sessionId: `ps-${randomBytes(16).toString('hex')}`, scopeId, pluginVersion, appVersion, instanceId, sessionKey, keyDigest, counter: 0, openedAt: at, renewedAt: at, expiresAt: at + ttlMs }
      sessions.set(session.sessionId, session)
      return shown(session)
    },
    // The live session with this id, key included, for the channel only; null once it lapsed or was released.
    held(sessionId) { prune(); return sessions.get(sessionId) ?? null },
    renew(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return null
      session.renewedAt = now()
      session.expiresAt = session.renewedAt + ttlMs
      return shown(session)
    },
    release: (sessionId) => sessions.delete(sessionId),
    live: (scopeId) => liveFor(scopeId).map(shown),
    // What the most recently renewed live session reports, or null when no plugin holds the view. `instances` counts
    // the launches of the plugin behind the live sessions: more than one means more than one app holds the vault.
    report(scopeId) {
      const live = liveFor(scopeId).sort((left, right) => right.renewedAt - left.renewedAt)
      if (live.length === 0) return null
      const [newest] = live
      return { scopeId, appVersion: newest.appVersion, pluginVersion: newest.pluginVersion, sessions: live.length, instances: new Set(live.map((session) => session.instanceId)).size, renewedAt: new Date(newest.renewedAt).toISOString() }
    },
    scopeIds() { prune(); return [...new Set([...sessions.values()].map((session) => session.scopeId))] },
  }
}

// The commands of the plugin channel (plugin-bridge/channel.mjs). `statusOf(scopeId)`
// returns the view's freshness entry as the service reports it and its open
// pending edits; the vault a hello must prove is the view's vault under the
// workspace state. `authority` is the exact address the request reached.
export function createPluginChannelForOracleTests({
  workspaceRoot, workspaceId, runtimeId, sessions, statusOf, serviceStatus, now = () => Date.now(), randomBytes = cryptoRandomBytes,
  bearers = createPluginBearerCache({ workspaceRoot, workspaceId }),
  // Told each time a plugin opened a session for a view: the app it runs in has the view's entry.
  onSessionOpened = () => {},
}, primitives = PLUGIN_CHANNEL_PRIMITIVES) {
  const rules = { ...PLUGIN_CHANNEL_PRIMITIVES, ...primitives }
  // As the file system stores the path, as the store registers the vault in the app (realPathAsStored): a data root given
  // in another letter case names the same vault.
  const vaultRootOf = (scopeId) => { try { return realPathAsStored(path.join(workspaceRoot, 'vaults', segment(scopeId))) } catch { return null } }
  const keyDigestOf = (bearer) => createHash('sha256').update(bearer, 'utf8').digest()
  const handshakes = new Map()
  const pruneHandshakes = () => { const at = now(); for (const [handshakeId, handshake] of handshakes) if (handshake.expiresAt <= at) handshakes.delete(handshakeId) }
  // The nonces of the challenges each view's key answered, until their time has left the window: a challenge recorded
  // by whoever squatted the address, sent later, is answered at most once and only while it is fresh.
  const answered = new Map()
  const seenBefore = (scopeId, clientNonce, issuedAt) => {
    const at = now()
    const nonces = answered.get(scopeId) ?? new Map()
    for (const [nonce, until] of nonces) if (until <= at) nonces.delete(nonce)
    const seen = nonces.has(clientNonce)
    if (rules.noncesAnsweredOnce) nonces.set(clientNonce, issuedAt + rules.challengeWindowMs + 1)
    answered.set(scopeId, nonces)
    return seen
  }
  const answer = (statusCode, body) => ({ statusCode, body })
  // An answer only the session's key can have made: the exact text of the document, and a MAC over it.
  const sealed = ({ sessionKey, command, sessionId, counter }, document) => {
    const payload = JSON.stringify(document)
    return answer(200, { payload, mac: pluginResponseMac({ sessionKey, command, sessionId, counter, payload }) })
  }
  // A request of a session: its MAC verifies under the session's key and its counter was never seen. A session
  // whose vault's bearer was rotated since its handshake ends: its key came from the old bearer.
  const authenticated = (command, body) => {
    const session = sessions.held(body.sessionId)
    if (session === null) return { refusal: answer(409, { error: 'session-unknown' }) }
    if (!rules.macMatches(body.mac, pluginRequestMac({ sessionKey: session.sessionKey, command, sessionId: session.sessionId, counter: body.counter }))) return { refusal: answer(401, { error: 'request-not-authenticated' }) }
    if (!rules.counterIsNew(body.counter, session.counter)) return { refusal: answer(401, { error: 'request-replayed' }) }
    session.counter = body.counter
    const bearer = bearers.current().get(session.scopeId)
    if (typeof bearer !== 'string' || !timingSafeEqual(keyDigestOf(bearer), session.keyDigest)) {
      sessions.release(session.sessionId)
      return { refusal: answer(409, { error: 'session-unknown' }) }
    }
    return { session, seal: (document) => sealed({ sessionKey: session.sessionKey, command, sessionId: session.sessionId, counter: body.counter }, document) }
  }
  const commands = {
    challenge({ body, authority }) {
      if (Math.abs(now() - body.issuedAt) > rules.challengeWindowMs) return answer(401, { error: 'challenge-stale' })
      // The key the hint was made with: every key is tried, all of them, whichever matches.
      let found = null
      for (const [scopeId, bearer] of bearers.current()) {
        if (rules.macMatches(body.keyHint, pluginKeyHint({ bearer, clientNonce: body.clientNonce, issuedAt: body.issuedAt })) && found === null) found = { scopeId, bearer }
      }
      if (found === null) return answer(401, { error: 'plugin-key-unknown' })
      if (seenBefore(found.scopeId, body.clientNonce, body.issuedAt)) return answer(401, { error: 'challenge-replayed' })
      pruneHandshakes()
      // Bounded per view: one view's waiting handshakes never hold up another's.
      if ([...handshakes.values()].filter((handshake) => handshake.scopeId === found.scopeId).length >= PLUGIN_MAX_PENDING_HANDSHAKES_PER_SCOPE) return answer(429, { error: 'too-many-handshakes' })
      const handshake = { handshakeId: `ph-${randomBytes(16).toString('hex')}`, scopeId: found.scopeId, authority, clientNonce: body.clientNonce, serverNonce: randomBytes(32).toString('hex'), expiresAt: now() + PLUGIN_HANDSHAKE_TTL_MS }
      handshakes.set(handshake.handshakeId, handshake)
      return answer(200, { protocol: PLUGIN_CHANNEL_PROTOCOL, handshakeId: handshake.handshakeId, serverNonce: handshake.serverNonce, serverProof: pluginServerProof({ bearer: found.bearer, ...handshake }) })
    },
    hello({ body, authority }) {
      pruneHandshakes()
      const handshake = handshakes.get(body.handshakeId) ?? null
      if (rules.handshakeUsedOnce) handshakes.delete(body.handshakeId)
      const bearer = handshake === null ? undefined : bearers.current().get(handshake.scopeId)
      if (handshake === null || handshake.authority !== authority || typeof bearer !== 'string') return answer(401, { error: 'handshake-unknown' })
      const { scopeId } = handshake
      const bound = { bearer, scopeId, authority, clientNonce: handshake.clientNonce, serverNonce: handshake.serverNonce, handshakeId: handshake.handshakeId }
      const expected = pluginClientProof({ ...bound, pluginVersion: body.pluginVersion, appVersion: body.appVersion, instanceId: body.instanceId, vaultProof: body.vaultProof })
      if (!rules.macMatches(body.clientProof, expected)) return answer(401, { error: 'plugin-not-authenticated' })
      const sessionKey = pluginSessionKey(bound)
      // Compared, never named: the vault the app has open, proven under this session's key.
      const vaultRoot = vaultRootOf(scopeId)
      if (vaultRoot === null || !rules.macMatches(body.vaultProof, pluginVaultProof({ sessionKey, vaultPath: vaultRoot }))) return answer(409, { error: 'wrong-vault' })
      const session = sessions.open({ scopeId, pluginVersion: body.pluginVersion, appVersion: body.appVersion, instanceId: body.instanceId, sessionKey, keyDigest: keyDigestOf(bearer) })
      if (session === null) return answer(429, { error: 'too-many-sessions' })
      onSessionOpened(scopeId)
      return sealed({ sessionKey, command: 'hello', sessionId: session.sessionId, counter: 0 }, {
        schema: PLUGIN_CHANNEL_PROTOCOL, scopeId, sessionId: session.sessionId, runtimeId, leaseTtlMs: session.expiresAt - session.openedAt, renewEveryMs: PLUGIN_RENEW_INTERVAL_MS,
      })
    },
    lease({ body }) {
      const request = authenticated('lease', body)
      if (request.refusal) return request.refusal
      const session = sessions.renew(request.session.sessionId)
      return request.seal({ schema: PLUGIN_CHANNEL_PROTOCOL, scopeId: session.scopeId, sessionId: session.sessionId, leaseTtlMs: session.expiresAt - session.renewedAt })
    },
    release({ body }) {
      const request = authenticated('release', body)
      if (request.refusal) return request.refusal
      return request.seal({ schema: PLUGIN_CHANNEL_PROTOCOL, scopeId: request.session.scopeId, released: sessions.release(request.session.sessionId) })
    },
    status({ body }) {
      const request = authenticated('status', body)
      if (request.refusal) return request.refusal
      const { scopeId } = request.session
      const { view, pendingEdits } = statusOf(scopeId)
      return request.seal({ schema: PLUGIN_STATUS_SCHEMA, scopeId, service: { status: serviceStatus() }, view, pendingEdits })
    },
  }
  return {
    bearers: () => bearers.current(),
    // The service minted a bearer: whatever the directory's times say, the next lookup reads the bearers again.
    bearersChanged: () => bearers.invalidate?.(),
    handle: (command, request) => commands[command](request),
  }
}

export function createPluginChannel(options) {
  return createPluginChannelForOracleTests(options, PLUGIN_CHANNEL_PRIMITIVES)
}

// Which views a plugin holds open, for the service's status document, and
// whether the person wants the plugin in each vault (`entry`: undecided,
// requested, on or off; see plugin-choice.mjs). Counts, versions and states
// only: no vault path, no session identity.
export function pluginPresence({ sessions, scopeIds, entryOf = () => null }) {
  const scopes = [...new Set([...scopeIds, ...sessions.scopeIds()])].sort(compareText).map((scopeId) => {
    const report = sessions.report(scopeId)
    const entry = entryOf(scopeId)
    const presence = report === null ? { scopeId, present: false, sessions: 0 } : { scopeId, present: true, sessions: report.sessions, appVersion: report.appVersion, pluginVersion: report.pluginVersion, renewedAt: report.renewedAt }
    return entry === null ? presence : { ...presence, entry }
  })
  return { schema: PLUGIN_PRESENCE_SCHEMA, leaseTtlMs: PLUGIN_LEASE_TTL_MS, scopes }
}
