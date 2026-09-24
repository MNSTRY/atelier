import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, readRegularTextNoFollow } from '../../project/private-state.mjs'
import {
  PLUGIN_BEARER, PLUGIN_CHANNEL_PROTOCOL, PLUGIN_LEASE_TTL_MS, PLUGIN_MAX_SESSIONS_PER_SCOPE, PLUGIN_RENEW_INTERVAL_MS, PLUGIN_STATUS_SCHEMA,
} from '../../projection/obsidian/plugin-bridge/channel.mjs'
import { canonicalJson, compareText, isPlainObject, isoTime } from './documents.mjs'

// The service's half of the plugin channel (plugin-bridge/channel.mjs).
//
//   bearers    one random bearer per view, minted when the view's vault first
//              receives the plugin, kept owner-only under state/plugin/ and
//              written into that vault's plugin data file, nowhere else
//   sessions   who holds a view open right now: a plugin that said hello and
//              renews its lease; in memory, gone when the service stops
//   commands   hello, lease, release and status, answered from state the
//              service already keeps; nothing here writes a vault, a source,
//              a manifest or an edit, and no command decides anything
//
// A live session also tells the app version the plugin runs in. That version
// counts as checked for app qualification (app-capability.mjs): the plugin
// runs inside exactly that app.

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

// Sessions of the plugin, per view. A session lives as long as its lease: a
// hello grants one, each renewal extends it by `ttlMs`, and a release or a
// lapse ends it. At most `maxPerScope` live sessions per view.
export function createPluginSessions({ now = () => Date.now(), ttlMs = PLUGIN_LEASE_TTL_MS, maxPerScope = PLUGIN_MAX_SESSIONS_PER_SCOPE, randomBytes = cryptoRandomBytes } = {}) {
  const sessions = new Map()
  const prune = () => { const at = now(); for (const [sessionId, session] of sessions) if (session.expiresAt <= at) sessions.delete(sessionId) }
  const liveFor = (scopeId) => { prune(); return [...sessions.values()].filter((session) => session.scopeId === scopeId) }
  return {
    open({ scopeId, pluginVersion, appVersion }) {
      if (liveFor(scopeId).length >= maxPerScope) return null
      const at = now()
      const session = { sessionId: `ps-${randomBytes(16).toString('hex')}`, scopeId, pluginVersion, appVersion, openedAt: at, renewedAt: at, expiresAt: at + ttlMs }
      sessions.set(session.sessionId, session)
      return { ...session }
    },
    renew({ scopeId, sessionId }) {
      prune()
      const session = sessions.get(sessionId)
      if (!session || session.scopeId !== scopeId) return null
      session.renewedAt = now()
      session.expiresAt = session.renewedAt + ttlMs
      return { ...session }
    },
    release({ scopeId, sessionId }) {
      const session = sessions.get(sessionId)
      if (!session || session.scopeId !== scopeId) return false
      return sessions.delete(sessionId)
    },
    live: (scopeId) => liveFor(scopeId).map((session) => ({ ...session })),
    // What the most recently renewed live session reports, or null when no plugin holds the view.
    report(scopeId) {
      const live = liveFor(scopeId).sort((left, right) => right.renewedAt - left.renewedAt)
      if (live.length === 0) return null
      const [newest] = live
      return { scopeId, appVersion: newest.appVersion, pluginVersion: newest.pluginVersion, sessions: live.length, renewedAt: new Date(newest.renewedAt).toISOString() }
    },
    scopeIds() { prune(); return [...new Set([...sessions.values()].map((session) => session.scopeId))] },
  }
}

// The commands of the plugin channel. `statusOf(scopeId)` returns the view's
// freshness entry as the service reports it and its open pending edits; the
// vault root a hello must name is the view's vault under the workspace state.
export function createPluginChannel({ workspaceRoot, workspaceId, runtimeId, sessions, statusOf, serviceStatus }) {
  const vaultRootOf = (scopeId) => { try { return fs.realpathSync(path.join(workspaceRoot, 'vaults', segment(scopeId))) } catch { return null } }
  const answer = (statusCode, body) => ({ statusCode, body })
  const commands = {
    hello({ scopeId, body }) {
      // Compared, never opened: the path the plugin names is the vault the app has open.
      const vaultRoot = vaultRootOf(scopeId)
      if (vaultRoot === null || body.vaultPath !== vaultRoot) return answer(409, { error: 'wrong-vault' })
      const session = sessions.open({ scopeId, pluginVersion: body.pluginVersion, appVersion: body.appVersion })
      if (session === null) return answer(429, { error: 'too-many-sessions' })
      return answer(200, { schema: PLUGIN_CHANNEL_PROTOCOL, scopeId, sessionId: session.sessionId, runtimeId, leaseTtlMs: session.expiresAt - session.openedAt, renewEveryMs: PLUGIN_RENEW_INTERVAL_MS })
    },
    lease({ scopeId, body }) {
      const session = sessions.renew({ scopeId, sessionId: body.sessionId })
      return session === null ? answer(409, { error: 'session-unknown' }) : answer(200, { schema: PLUGIN_CHANNEL_PROTOCOL, scopeId, sessionId: session.sessionId, leaseTtlMs: session.expiresAt - session.renewedAt })
    },
    release({ scopeId, body }) {
      return answer(200, { schema: PLUGIN_CHANNEL_PROTOCOL, scopeId, released: sessions.release({ scopeId, sessionId: body.sessionId }) })
    },
    status({ scopeId }) {
      const { view, pendingEdits } = statusOf(scopeId)
      return answer(200, { schema: PLUGIN_STATUS_SCHEMA, scopeId, service: { status: serviceStatus() }, view, pendingEdits })
    },
  }
  return {
    bearers: () => readPluginBearers({ workspaceRoot, workspaceId }),
    handle: (command, request) => commands[command](request),
  }
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
