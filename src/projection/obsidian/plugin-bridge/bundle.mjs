import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { refuse, sha256Digest } from '../materialize/byte-lens.mjs'
import { PLUGIN_DATA_FILE, PLUGIN_DIRECTORY, PLUGIN_ID, PLUGIN_MINIMUM_APP_VERSION, PLUGIN_SOURCE_FILES, pluginDataBytes } from './channel.mjs'

// The files of Atelier's plugin as they go into one vault: the three shipped
// source files, byte for byte, and that vault's data file. Pure apart from
// reading the shipped source once; nothing here writes anywhere.

export const PLUGIN_SOURCE_ROOT = fileURLToPath(new URL('../../../../plugins/obsidian/', import.meta.url))

// The data file names a bearer: only the person who runs the vault reads it.
export const PLUGIN_DATA_MODE = 0o600
export const PLUGIN_SOURCE_MODE = 0o644

let cached = null

// { version, files: [{ name, bytes }] } of the shipped plugin. The manifest
// must name this plugin, the protocol's app floor and a desktop-only plugin.
export function readPluginSource({ root = PLUGIN_SOURCE_ROOT } = {}) {
  if (root === PLUGIN_SOURCE_ROOT && cached) return cached
  const files = PLUGIN_SOURCE_FILES.map((name) => ({ name, bytes: fs.readFileSync(path.join(root, name)) }))
  let manifest
  try { manifest = JSON.parse(files.find((file) => file.name === 'manifest.json').bytes.toString('utf8')) } catch { refuse('plugin-source-invalid', 'the shipped plugin manifest is not JSON') }
  if (manifest?.id !== PLUGIN_ID || manifest.minAppVersion !== PLUGIN_MINIMUM_APP_VERSION || manifest.isDesktopOnly !== true || typeof manifest.version !== 'string' || manifest.version === '') {
    refuse('plugin-source-invalid', 'the shipped plugin manifest does not name this plugin, its app floor and a desktop-only plugin')
  }
  const source = Object.freeze({ version: manifest.version, files: Object.freeze(files) })
  if (root === PLUGIN_SOURCE_ROOT) cached = source
  return source
}

// Prepared files of kind `plugin` for one vault, and the record that pins
// their digests in the generation manifest. `channel` is where the service of
// the workspace listens; `bearer` is this vault's.
export function preparePluginFiles({ channel, scopeId, bearer, source = readPluginSource() }) {
  const files = [
    ...source.files.map(({ name, bytes }) => ({ path: `${PLUGIN_DIRECTORY}/${name}`, kind: 'plugin', bytes, digest: sha256Digest(bytes), mode: PLUGIN_SOURCE_MODE })),
    (() => {
      const bytes = pluginDataBytes({ host: channel?.host, port: channel?.port, scopeId, bearer })
      return { path: `${PLUGIN_DIRECTORY}/${PLUGIN_DATA_FILE}`, kind: 'plugin', bytes, digest: sha256Digest(bytes), mode: PLUGIN_DATA_MODE }
    })(),
  ]
  return {
    files,
    ownership: { id: PLUGIN_ID, version: source.version, directory: PLUGIN_DIRECTORY, files: files.map(({ path, digest, bytes }) => ({ path, digest, byteLength: bytes.length })) },
  }
}
