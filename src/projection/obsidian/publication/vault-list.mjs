import fs from 'node:fs'
import path from 'node:path'
import { openRegularFileNoFollow, realPathAsStored } from '../../../project/private-state.mjs'

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
//
// The list also decides which window answers a command-line call (1.13.7): a
// first argument `vault=<value>` names the first listed vault whose id is the
// value, or whose folder's name is the value in any letter case; without one,
// the first listed vault whose folder is the tool's working directory or
// contains it takes the call, the folders compared as written; failing both,
// the vault window that had focus last. The first in list order, not the
// deepest: a vault listed at a folder above another one takes the calls run
// inside it. The app opens a vault that takes a call when it is closed.

export const OBSIDIAN_SETTINGS_FILE = 'obsidian.json'
// Far more than a list of vaults and a few settings; a larger file is not read.
export const MAX_OBSIDIAN_SETTINGS_BYTES = 4 * 1024 * 1024

// The user-data directory of the app for this account: Electron's, for an app
// named `obsidian`. Null where it is not known (another platform, no HOME). A
// Flatpak or snap build keeps its own elsewhere and is not found here (see
// obsidianSandboxedBuild). Both known platforms have POSIX paths, whatever
// platform asks.
export function obsidianUserDataDir({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME
  if (platform !== 'darwin' && platform !== 'linux') return null
  if (typeof home !== 'string' || !path.posix.isAbsolute(home)) return null
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'obsidian')
  const config = typeof env.XDG_CONFIG_HOME === 'string' && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config')
  return path.posix.join(config, 'obsidian')
}

// A Flatpak or snap build of Obsidian on Linux keeps its user-data directory
// inside its sandbox (`~/.var/app/md.obsidian.Obsidian/config/obsidian`,
// `~/snap/obsidian/current/.config/obsidian`), where Atelier does not write,
// and reads no file outside it. Which build this account uses: the one whose
// vault list was written last, since every build rewrites its own whenever a
// vault window opens or closes ('flatpak', 'snap', or null for the native
// build); only when no build wrote one, a Flatpak or snap installation, or a
// Flatpak or snap left by one. Null on any other platform. `exists` answers
// whether a path exists, `modified` when a file was last written (or null).
const modifiedAt = (file) => { try { return fs.statSync(file).mtimeMs } catch { return null } }
export function obsidianSandboxedBuild({ platform = process.platform, env = process.env, exists = fs.existsSync, modified = modifiedAt } = {}) {
  if (platform !== 'linux') return null
  const home = typeof env.HOME === 'string' && path.posix.isAbsolute(env.HOME) ? env.HOME : null
  const under = (...parts) => (home === null ? [] : [path.posix.join(home, ...parts)])
  const native = obsidianUserDataDir({ platform, env })
  const lists = [
    [null, native === null ? [] : [path.posix.join(native, OBSIDIAN_SETTINGS_FILE)]],
    ['flatpak', under('.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', OBSIDIAN_SETTINGS_FILE)],
    ['snap', under('snap', 'obsidian', 'current', '.config', 'obsidian', OBSIDIAN_SETTINGS_FILE)],
  ].flatMap(([build, files]) => files.map((file) => { let at; try { at = modified(file) } catch { at = null } return { build, at } })).filter(({ at }) => typeof at === 'number')
  if (lists.length > 0) return lists.reduce((latest, list) => (list.at > latest.at ? list : latest)).build
  const found = (paths) => paths.some((candidate) => { try { return exists(candidate) } catch { return false } })
  if (found([...under('.var', 'app', 'md.obsidian.Obsidian'), ...under('.local', 'share', 'flatpak', 'app', 'md.obsidian.Obsidian'), '/var/lib/flatpak/app/md.obsidian.Obsidian'])) return 'flatpak'
  if (found([...under('snap', 'obsidian'), '/snap/obsidian', '/var/lib/snapd/snap/obsidian'])) return 'snap'
  return null
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// The real path as stored (realPathAsStored): what the operating system reports as a working directory.
const realOrResolved = (target) => { try { return realPathAsStored(target) } catch { return path.resolve(target) } }
const listedFolders = (vaults) => (isPlainObject(vaults) ? Object.entries(vaults).filter(([, entry]) => isPlainObject(entry) && typeof entry.path === 'string' && path.isAbsolute(entry.path)) : [])

// A folder the list names, against a vault root spelled as given (`spelled`)
// and as its real path (`target`). Compared as written first; the real path of
// a listed folder is read only when its last component is the vault root's,
// as it is for the root reached through a linked parent. So a vault on a
// mount that does not answer is never waited on; a link to the vault root
// under another name is not recognised.
const namesFolder = (entryPath, { spelled, target }) => {
  const written = path.resolve(entryPath)
  if (written === spelled || written === target) return true
  return path.basename(written) === path.basename(target) && realOrResolved(entryPath) === target
}
const rootOf = (vaultRoot) => ({ spelled: path.resolve(vaultRoot), target: realOrResolved(vaultRoot) })

// The entry of the app's vault map whose folder is this vault root (see
// namesFolder); null when there is none. `vaults` is the map as the app keeps
// it, from its file or from the app itself.
export function findVaultEntry(vaults, vaultRoot) {
  if (!isPlainObject(vaults) || typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) return null
  const root = rootOf(vaultRoot)
  const found = listedFolders(vaults).find(([, entry]) => namesFolder(entry.path, root))
  return found === undefined ? null : { id: found[0], path: found[1].path, open: found[1].open === true }
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
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* read already, or refused */ }
  }
  let document
  try { document = JSON.parse(bytes.toString('utf8')) } catch { return refused('obsidian-settings-unreadable', 'the Obsidian settings file is not JSON') }
  if (!isPlainObject(document)) return refused('obsidian-settings-not-object', 'the Obsidian settings file is not a JSON object')
  if (document.vaults !== undefined && !isPlainObject(document.vaults)) return refused('obsidian-settings-not-object', 'the vault list in the Obsidian settings file is not an object')
  return { ok: true, file, document, vaults: document.vaults ?? {}, bytes, mode: leaf.mode & 0o777, links: leaf.nlink }
}

// Where a command-line call about this vault reaches the app, predicted from
// the app's list as the app routes a call (see above):
//
//   { how: 'id', id }       run in a directory that is no vault, with `vault=<id>` first: the id names this vault first.
//                           Preferred: it does not depend on how a working directory is spelled;
//   { how: 'folder', cwd }  run in the vault's folder (its real path as stored, which the tool reports), when the id
//                           names another vault first and the first listed vault that is or contains the folder is this one;
//   { how: 'unlisted' }     the list has no entry for this folder (with `open`, none that the app lists open);
//   { how: 'ambiguous' }    the id names another vault first, and a vault listed above it takes a call run in its folder.
//
// With `open`, only an entry the app lists open may take the call, so a
// closed vault window is never reopened.
export function vaultRoute({ vaults, vaultRoot, open = false } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) return { how: 'unlisted' }
  const root = rootOf(vaultRoot)
  const { target } = root
  const listed = listedFolders(vaults)
  const takes = ([, entry]) => (!open || entry.open === true) && namesFolder(entry.path, root)
  const own = listed.filter(takes)
  if (own.length === 0) return { how: 'unlisted' }
  const byName = (value) => listed.find(([id, entry]) => id === value || path.basename(entry.path).toUpperCase() === value.toUpperCase())
  const named = own.find(([id]) => byName(id)?.[0] === id)
  if (named !== undefined) return { how: 'id', id: named[0] }
  const byFolder = listed.find(([, entry]) => { const folder = path.resolve(entry.path); return target === folder || target.startsWith(folder + path.sep) })
  return byFolder !== undefined && takes(byFolder) ? { how: 'folder', cwd: target } : { how: 'ambiguous' }
}

// The listed vaults whose folder contains this vault root, as written, against
// the root as given and as its real path: the app would show this vault's
// notes in their windows too, and a call run in this vault's folder may reach
// them. No vault is added inside another one. No listed folder's real path is
// read, so a vault above the root only through a link is not found.
export function enclosingVaults({ vaults, vaultRoot } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) return []
  const { spelled, target } = rootOf(vaultRoot)
  const inside = (folder, root) => folder !== root && root.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep)
  return listedFolders(vaults).filter(([, entry]) => {
    const folder = path.resolve(entry.path)
    return !namesFolder(entry.path, { spelled, target }) && (inside(folder, target) || inside(folder, spelled))
  }).map(([id, entry]) => ({ id, path: entry.path }))
}
