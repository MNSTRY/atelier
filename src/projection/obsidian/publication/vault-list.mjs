import fs from 'node:fs'
import path from 'node:path'
import { openRegularFileNoFollow } from '../../../project/private-state.mjs'

// Obsidian's own list of the folders it knows as vaults, read only.
//
// The app keeps the list in `obsidian.json` in its user-data directory, as
// `{ "vaults": { "<id>": { "path", "ts", "open"? } }, ...other settings }`.
// It reads the file when it starts and rewrites the whole file whenever the
// list changes. `open` is true while a window of that vault is open, and stays
// true for the vaults that were open when the app quit, which it reopens on its
// next start. `obsidian://open?path=` finds a vault only through this list.
//
// Nothing here writes the file. The one write Atelier makes to it is in
// src/runtime/obsidian/app-registration.mjs, and only while no Obsidian runs.

export const OBSIDIAN_SETTINGS_FILE = 'obsidian.json'
// Far more than a list of vaults and a few settings; a larger file is not read.
export const MAX_OBSIDIAN_SETTINGS_BYTES = 4 * 1024 * 1024

// The user-data directory of the app for this account: Electron's, for an app
// named `obsidian`. Null where it is not known (another platform, no HOME). A
// Flatpak or snap build keeps its own elsewhere and is not found here. Both
// known platforms have POSIX paths, whatever platform asks.
export function obsidianUserDataDir({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME
  if (platform !== 'darwin' && platform !== 'linux') return null
  if (typeof home !== 'string' || !path.posix.isAbsolute(home)) return null
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'obsidian')
  const config = typeof env.XDG_CONFIG_HOME === 'string' && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config')
  return path.posix.join(config, 'obsidian')
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const realOrResolved = (target) => { try { return fs.realpathSync(target) } catch { return path.resolve(target) } }

// The entry of the app's vault map whose folder is this vault root, compared
// by real path; null when there is none. `vaults` is the map as the app keeps
// it, from its file or from the app itself.
export function findVaultEntry(vaults, vaultRoot) {
  if (!isPlainObject(vaults) || typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) return null
  const target = realOrResolved(vaultRoot)
  for (const [id, entry] of Object.entries(vaults)) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) continue
    if (realOrResolved(entry.path) === target) return { id, path: entry.path, open: entry.open === true }
  }
  return null
}

const refused = (code, message) => ({ ok: false, code, message })
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null)

// Reads the settings file without following a link and without writing:
// { ok: true, file, document, vaults, bytes, mode } or a typed refusal
// { ok: false, code, message }. The user-data directory and the file must be
// this user's own, a real directory and a regular file; the file must be a
// JSON object whose `vaults`, when present, is an object. A missing directory
// or file means Obsidian has not run on this account.
export function readObsidianSettings({ userDataDir, uid = currentUid() } = {}) {
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) return refused('obsidian-settings-location-unknown', 'where Obsidian keeps its settings on this system is not known')
  const owned = (stat) => uid === null || stat.uid === uid
  let directory
  try { directory = fs.lstatSync(userDataDir) } catch (error) {
    if (error.code === 'ENOENT') return refused('obsidian-settings-missing', 'Obsidian has no settings directory on this account; it has not run here')
    return refused('obsidian-settings-unreadable', 'the Obsidian settings directory cannot be read')
  }
  if (directory.isSymbolicLink() || !directory.isDirectory()) return refused('obsidian-settings-unsafe', 'the Obsidian settings directory is a link or not a directory')
  if (!owned(directory)) return refused('obsidian-settings-not-owned', 'the Obsidian settings directory belongs to another user')
  const file = path.join(userDataDir, OBSIDIAN_SETTINGS_FILE)
  let leaf
  try { leaf = fs.lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') return refused('obsidian-settings-missing', 'Obsidian has no settings file on this account; it has not run here')
    return refused('obsidian-settings-unreadable', 'the Obsidian settings file cannot be read')
  }
  if (leaf.isSymbolicLink() || !leaf.isFile()) return refused('obsidian-settings-unsafe', 'the Obsidian settings file is a link or not a regular file')
  if (!owned(leaf)) return refused('obsidian-settings-not-owned', 'the Obsidian settings file belongs to another user')
  if (leaf.size > MAX_OBSIDIAN_SETTINGS_BYTES) return refused('obsidian-settings-unreadable', 'the Obsidian settings file is larger than a settings file can be')
  let bytes
  let descriptor
  try {
    descriptor = openRegularFileNoFollow(file)
    const opened = fs.fstatSync(descriptor)
    if (!owned(opened)) return refused('obsidian-settings-not-owned', 'the Obsidian settings file belongs to another user')
    bytes = fs.readFileSync(descriptor)
  } catch {
    return refused('obsidian-settings-unreadable', 'the Obsidian settings file cannot be read')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  let document
  try { document = JSON.parse(bytes.toString('utf8')) } catch { return refused('obsidian-settings-unreadable', 'the Obsidian settings file is not JSON') }
  if (!isPlainObject(document)) return refused('obsidian-settings-not-object', 'the Obsidian settings file is not a JSON object')
  if (document.vaults !== undefined && !isPlainObject(document.vaults)) return refused('obsidian-settings-not-object', 'the vault list in the Obsidian settings file is not an object')
  return { ok: true, file, document, vaults: document.vaults ?? {}, bytes, mode: leaf.mode & 0o777 }
}

// Whether the app lists this vault as open in a window, from its settings
// file. False whenever that cannot be read.
export function vaultOpenInApp({ vaultRoot, userDataDir }) {
  const settings = readObsidianSettings({ userDataDir })
  return settings.ok && findVaultEntry(settings.vaults, vaultRoot)?.open === true
}
