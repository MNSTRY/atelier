import { isPlainObject } from './documents.mjs'

// What `status` and `open` say about Atelier's plugin, read from the status
// document of the running service (`plugins`, see plugin-channel.mjs). The
// plugin is present for a view while it holds a live lease on it.

export const PLUGIN_PRESENCE_REASONS = Object.freeze(['live-lease', 'no-live-lease', 'service-not-running', 'service-reports-no-plugin-channel'])

export function pluginPresenceOf(statusDocument, scopeId) {
  if (!isPlainObject(statusDocument)) return { present: false, reason: 'service-not-running' }
  const scopes = isPlainObject(statusDocument.plugins) && Array.isArray(statusDocument.plugins.scopes) ? statusDocument.plugins.scopes : null
  if (scopes === null) return { present: false, reason: 'service-reports-no-plugin-channel' }
  const entry = scopes.find((item) => isPlainObject(item) && item.scopeId === scopeId)
  if (entry?.present !== true || typeof entry.appVersion !== 'string') return { present: false, reason: 'no-live-lease' }
  return { present: true, reason: 'live-lease', appVersion: entry.appVersion, pluginVersion: typeof entry.pluginVersion === 'string' ? entry.pluginVersion : null, sessions: Number.isInteger(entry.sessions) ? entry.sessions : 1 }
}

// An app probe that takes the version from the plugin when one holds the view:
// that plugin runs inside the app, so its version is the app's, whatever the
// command-line tool answers or fails to answer. Whether the app is installed
// and has its command-line capability is still the probe's answer; that
// capability opens and coordinates the vault in this phase.
export function withPluginReportedVersion(appProbe, readPresence) {
  return {
    async inspect() {
      const [observation, presence] = await Promise.all([appProbe.inspect(), Promise.resolve().then(readPresence).catch(() => null)])
      if (presence?.present !== true || observation?.installed !== true || observation?.cli !== true) return observation
      return { ...observation, running: true, version: presence.appVersion, noVaultOpen: false, versionSource: 'plugin' }
    },
    vaultState: (input) => appProbe.vaultState(input),
  }
}
