import { isPlainObject } from './documents.mjs'

// What `status` and `open` say about Atelier's plugin, read from the status
// document of the running service (`plugins`, see plugin-channel.mjs). The
// plugin is present for a view while it holds a live lease on it.

export const PLUGIN_PRESENCE_REASONS = Object.freeze(['live-lease', 'no-live-lease', 'turned-off-in-this-vault', 'service-not-running', 'service-reports-no-plugin-channel'])

// The two ways back, for a view whose vault turned the plugin off.
export const turnPluginOnNext = (scopeId) => `turn Atelier on in Obsidian (Settings, Community plugins), or run \`atelier obsidian plugin on --scope ${scopeId}\`, which restores it at the view's next publication`

export function pluginPresenceOf(statusDocument, scopeId) {
  if (!isPlainObject(statusDocument)) return { present: false, reason: 'service-not-running' }
  const scopes = isPlainObject(statusDocument.plugins) && Array.isArray(statusDocument.plugins.scopes) ? statusDocument.plugins.scopes : null
  if (scopes === null) return { present: false, reason: 'service-reports-no-plugin-channel' }
  const entry = scopes.find((item) => isPlainObject(item) && item.scopeId === scopeId)
  if (entry?.present === true && typeof entry.appVersion === 'string') {
    return { present: true, reason: 'live-lease', appVersion: entry.appVersion, pluginVersion: typeof entry.pluginVersion === 'string' ? entry.pluginVersion : null, sessions: Number.isInteger(entry.sessions) ? entry.sessions : 1 }
  }
  if (entry?.entry === 'off') return { present: false, reason: 'turned-off-in-this-vault', next: turnPluginOnNext(scopeId) }
  return { present: false, reason: 'no-live-lease' }
}

// An app probe that takes the version from the plugin when one holds the view
// and the command-line tool gives none: that plugin runs inside the app, so its
// version is the app's. A version the tool did give decides, since the tool may
// reach another app that holds the same vault. Whether the app is installed and
// has its command-line capability is still the probe's answer; that capability
// opens and coordinates the vault in this phase.
// The presence is asked at most once per `maxAgeMs`: open's wait loop asks the
// app far more often, and each answer about the plugin costs a round trip to
// the service.
export function withPluginReportedVersion(appProbe, readPresence, { maxAgeMs = 1000, now = () => Date.now() } = {}) {
  let last = null
  const presenceNow = () => {
    if (last === null || now() - last.at >= maxAgeMs) last = { at: now(), presence: Promise.resolve().then(readPresence).catch(() => null) }
    return last.presence
  }
  return {
    async inspect() {
      const [observation, presence] = await Promise.all([appProbe.inspect(), presenceNow()])
      if (presence?.present !== true || observation?.installed !== true || observation?.cli !== true || typeof observation.version === 'string') return observation
      return { ...observation, running: true, version: presence.appVersion, noVaultOpen: false, versionSource: 'plugin' }
    },
    vaultState: (input) => appProbe.vaultState(input),
  }
}
