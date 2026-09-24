import { PLUGIN_DATA_FILE, PLUGIN_DIRECTORY, PLUGIN_ID, PLUGIN_SOURCE_FILES } from '../plugin-bridge/channel.mjs'
import { refuse, sha256Digest } from './byte-lens.mjs'

// Policy-owned Obsidian settings. Atelier owns exactly these, and nothing
// else under the settings directory:
//
//   core-plugins.json          two keys: the built-in Sync and Publish core
//                              plugins stay disabled, because a generated view
//                              must not leave the machine through the editor
//   community-plugins.json     one entry: Atelier's own plugin is enabled
//   plugins/atelier-projection/{manifest.json,main.js,styles.css,data.json}
//                              Atelier's own plugin, whole files
//
// Every other path under the settings directory, every other key of
// core-plugins.json and every other entry of community-plugins.json belongs to
// the person using the vault and is never prepared, replaced or removed here.
// The two settings files are merged with the bytes on disk when they are
// published; the plugin files are Atelier's bytes and their digests are pinned
// in the generation manifest.

export const SETTINGS_ROOT = '.obsidian'
export const POLICY_SETTINGS_PATH = `${SETTINGS_ROOT}/core-plugins.json`
export const POLICY_DISABLED_CORE_PLUGINS = Object.freeze(['publish', 'sync'])
export const COMMUNITY_PLUGINS_PATH = `${SETTINGS_ROOT}/community-plugins.json`
export const POLICY_ENABLED_COMMUNITY_PLUGINS = Object.freeze([PLUGIN_ID])
export const POLICY_SETTINGS_PATHS = Object.freeze([POLICY_SETTINGS_PATH, COMMUNITY_PLUGINS_PATH])
export const PLUGIN_OWNED_PATHS = Object.freeze([...PLUGIN_SOURCE_FILES, PLUGIN_DATA_FILE].map((name) => `${PLUGIN_DIRECTORY}/${name}`))

export function isPolicySettingsPath(relativePath) {
  return POLICY_SETTINGS_PATHS.includes(relativePath)
}

export function isPluginOwnedPath(relativePath) {
  return PLUGIN_OWNED_PATHS.includes(relativePath)
}

export function isUserOwnedSettingsPath(relativePath) {
  return (relativePath === SETTINGS_ROOT || relativePath.startsWith(`${SETTINGS_ROOT}/`)) && !isPolicySettingsPath(relativePath) && !isPluginOwnedPath(relativePath)
}

const serialize = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')

function parseExisting(existing, label) {
  if (!Buffer.isBuffer(existing)) refuse('invalid-settings', 'existing settings must be supplied as a Buffer')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existing))
  } catch {
    return refuse('invalid-settings', `existing ${label} do not parse; they are left alone`)
  }
}

// core-plugins.json: the owned keys set to false, every other key kept.
function coreCandidate(existing) {
  if (existing === null || existing === undefined) return serialize(Object.fromEntries(POLICY_DISABLED_CORE_PLUGINS.map((id) => [id, false])))
  const current = parseExisting(existing, 'core plugin settings')
  if (Array.isArray(current)) {
    // Older list form: membership means enabled.
    const kept = current.filter((id) => !POLICY_DISABLED_CORE_PLUGINS.includes(id))
    return kept.length === current.length ? existing : serialize(kept)
  }
  if (current !== null && typeof current === 'object') {
    const satisfied = POLICY_DISABLED_CORE_PLUGINS.every((id) => current[id] === false)
    return satisfied ? existing : serialize({ ...current, ...Object.fromEntries(POLICY_DISABLED_CORE_PLUGINS.map((id) => [id, false])) })
  }
  return refuse('invalid-settings', 'existing core plugin settings have an unknown shape; they are left alone')
}

// community-plugins.json: the list of enabled plugins, in the person's order,
// with Atelier's own appended when it is missing.
function communityCandidate(existing) {
  if (existing === null || existing === undefined) return serialize([...POLICY_ENABLED_COMMUNITY_PLUGINS])
  const current = parseExisting(existing, 'community plugin settings')
  if (!Array.isArray(current)) refuse('invalid-settings', 'existing community plugin settings are not a list; they are left alone')
  const missing = POLICY_ENABLED_COMMUNITY_PLUGINS.filter((id) => !current.includes(id))
  return missing.length === 0 ? existing : serialize([...current, ...missing])
}

const CANDIDATES = Object.freeze({ [POLICY_SETTINGS_PATH]: coreCandidate, [COMMUNITY_PLUGINS_PATH]: communityCandidate })
const OWNED = Object.freeze({ [POLICY_SETTINGS_PATH]: { ownedKeys: [...POLICY_DISABLED_CORE_PLUGINS] }, [COMMUNITY_PLUGINS_PATH]: { ownedEntries: [...POLICY_ENABLED_COMMUNITY_PLUGINS] } })

// The bytes one policy settings file should hold, given its bytes on disk now.
// Bytes that already satisfy the policy are returned untouched.
export function preparePolicySettingsFile(relativePath, existing = null) {
  if (!isPolicySettingsPath(relativePath)) refuse('invalid-settings', 'only a policy settings file is prepared here')
  const bytes = CANDIDATES[relativePath](existing)
  return { path: relativePath, kind: 'settings', bytes, digest: sha256Digest(bytes) }
}

// `existing` is the current bytes of core-plugins.json when the vault already
// has one, so keys the person set survive. `plugin`, when given, is Atelier's
// plugin for this vault (preparePluginFiles): its files are carried, its
// community plugin entry is owned, and its digests are pinned.
export function prepareSettings({ existing = null, plugin = null } = {}) {
  const settings = [preparePolicySettingsFile(POLICY_SETTINGS_PATH, existing), ...(plugin === null ? [] : [preparePolicySettingsFile(COMMUNITY_PLUGINS_PATH, null)])]
  if (plugin !== null && (!Array.isArray(plugin.files) || plugin.files.some((file) => file.kind !== 'plugin' || !isPluginOwnedPath(file.path)))) {
    refuse('invalid-settings', 'plugin files must be Atelier\'s own plugin files')
  }
  return {
    files: [...settings, ...(plugin === null ? [] : plugin.files)],
    ownership: {
      policyOwned: settings.map((file) => ({ path: file.path, ...OWNED[file.path], digest: file.digest, byteLength: file.bytes.length })),
      ...(plugin === null ? {} : { pluginOwned: plugin.ownership }),
      userOwnedRoot: SETTINGS_ROOT,
      rule: 'every-other-path-and-key-is-user-owned',
    },
  }
}
