import { refuse, sha256Digest } from './byte-lens.mjs'

// Policy-owned Obsidian settings. Atelier owns exactly two keys of one file:
// the built-in Sync and Publish core plugins stay disabled, because a generated
// view must not leave the machine through the editor. Every other path under
// the settings directory, and every other key of that file, belongs to the
// person using the vault and is never prepared, replaced or removed here.

export const SETTINGS_ROOT = '.obsidian'
export const POLICY_SETTINGS_PATH = `${SETTINGS_ROOT}/core-plugins.json`
export const POLICY_DISABLED_CORE_PLUGINS = Object.freeze(['publish', 'sync'])

export function isPolicySettingsPath(relativePath) {
  return relativePath === POLICY_SETTINGS_PATH
}

export function isUserOwnedSettingsPath(relativePath) {
  return (relativePath === SETTINGS_ROOT || relativePath.startsWith(`${SETTINGS_ROOT}/`)) && !isPolicySettingsPath(relativePath)
}

const serialize = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')

// `existing` is the current bytes of the policy file when the vault already
// has one, so keys the person set survive. Bytes that already satisfy the
// policy are returned untouched.
export function prepareSettings({ existing = null } = {}) {
  let bytes
  if (existing === null || existing === undefined) {
    bytes = serialize(Object.fromEntries(POLICY_DISABLED_CORE_PLUGINS.map((id) => [id, false])))
  } else {
    if (!Buffer.isBuffer(existing)) refuse('invalid-settings', 'existing settings must be supplied as a Buffer')
    let current
    try {
      current = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existing))
    } catch {
      refuse('invalid-settings', 'existing core plugin settings do not parse; they are left alone')
    }
    if (Array.isArray(current)) {
      // Older list form: membership means enabled.
      const kept = current.filter((id) => !POLICY_DISABLED_CORE_PLUGINS.includes(id))
      bytes = kept.length === current.length ? existing : serialize(kept)
    } else if (current !== null && typeof current === 'object') {
      const satisfied = POLICY_DISABLED_CORE_PLUGINS.every((id) => current[id] === false)
      bytes = satisfied ? existing : serialize({ ...current, ...Object.fromEntries(POLICY_DISABLED_CORE_PLUGINS.map((id) => [id, false])) })
    } else {
      refuse('invalid-settings', 'existing core plugin settings have an unknown shape; they are left alone')
    }
  }
  return {
    files: [{ path: POLICY_SETTINGS_PATH, kind: 'settings', bytes, digest: sha256Digest(bytes) }],
    ownership: {
      policyOwned: [{ path: POLICY_SETTINGS_PATH, ownedKeys: [...POLICY_DISABLED_CORE_PLUGINS], digest: sha256Digest(bytes), byteLength: bytes.length }],
      userOwnedRoot: SETTINGS_ROOT,
      rule: 'every-other-path-and-key-is-user-owned',
    },
  }
}
