import fs from 'node:fs'
import path from 'node:path'
import { checkManagedRoots, realLocation } from '../../project/file-class.mjs'
import { realPathAsStored } from '../../project/private-state.mjs'
import { VAULT_ALLOCATION_SCHEMA, VAULT_LOCK_DIRECTORY, hasCommittedGeneration, readVaultAllocation, writeVaultAllocation } from '../../projection/obsidian/recovery/store.mjs'
import { refuse } from './errors.mjs'

// Where the vaults of a workspace live when a person decided it (the
// `location` decision of its machine settings), and the folder each view
// gets there.
//
//   <location>/<project> (<view>)          e.g. ~/Atelier/harbor-notes (everything)
//
// The folder's name is the vault's name in Obsidian (its vault switcher, its
// window title, a `vault=` call), so it carries the project and the view:
// readable, the same in the file manager and in the app, and unique across
// projects and views. The view is the text in the last parentheses, and no
// name of this form is the beginning of another one's path, which matters
// because the app matches an `obsidian://open?path=` by the longest string
// prefix among the folders it lists.
//
// A folder is allocated once per view, at its first publication, by the
// maintenance engine under its lock, and recorded (see
// src/projection/obsidian/recovery/store.mjs). It is never recomputed: a
// renamed project or a new location leaves an allocated vault where it is.
// A view published before, under the data root, stays there; a workspace
// that decided no location publishes there as before.

export const MAX_PROJECT_NAME_BYTES = 80

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\:*?"<>|#^[\]()]/g
const INVISIBLE = /[\u202a-\u202e\u2066-\u2069\ufeff\u200b]/g
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// The longest start of `text` of at most `maxBytes` bytes that ends between two characters as a person reads them: a
// letter and its accents, or an emoji sequence, stay together or go together.
function cutToBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let cut = ''
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (Buffer.byteLength(cut + segment, 'utf8') > maxBytes) break
    cut += segment
  }
  return cut
}

// A piece of text as a folder name on macOS, Linux and Windows, and in the app: NFC, no control, separator, reserved
// or link character, no parentheses (they end the view's part), single spaces, no leading or trailing space or dot
// (a leading dot hides a folder from the app), cut to a number of bytes between two characters as a person reads them,
// and no Windows device name. May be empty.
export function safeFolderPart(text, maxBytes = MAX_PROJECT_NAME_BYTES) {
  const cleaned = String(text ?? '').normalize('NFC').replace(INVISIBLE, '').replace(UNSAFE, ' ').replace(/\s+/gu, ' ').replace(/^[\s.]+|[\s.]+$/gu, '')
  const cut = cutToBytes(cleaned, maxBytes).replace(/[\s.]+$/u, '')
  return WINDOWS_DEVICE.test(cut.split('.')[0]) ? `_${cut}` : cut
}

// The name people and Obsidian read for a project: its configured `name`, else the name of its folder.
export function projectDisplayName(project) {
  return safeFolderPart(project?.config?.name) || safeFolderPart(path.basename(String(project?.configDir ?? ''))) || 'project'
}

// `<project> (<view>)`, or `<project> (<view> <number>)` from the second.
export function vaultFolderName({ projectName, scopeId, number = 1 }) {
  const view = String(scopeId).replaceAll(':', '_')
  return `${projectName} (${view}${number > 1 ? ` ${number}` : ''})`
}

const isInside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) }
const isSameOrInside = (parent, child) => parent === child || isInside(parent, child)

// The nearest folder that exists on the way up from `target` (itself included).
function nearestExisting(target) {
  let current = path.resolve(target)
  for (;;) {
    if (fs.existsSync(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}

// A path compared with another as a volume that folds letter case would: NFC, lower case. Used where a false match
// only refuses (an enclosing vault, a synced or protected folder, a listed name), so a case-sensitive volume is at worst
// refused a folder whose name differs from a listed vault's in letter case only.
const folded = (target) => target.normalize('NFC').toLowerCase()
const foldedInside = (parent, child) => isSameOrInside(folded(parent), folded(child))
// The real path of a folder that may not exist yet, as the file system stores it (realPathAsStored): the nearest
// existing folder on the way up resolved, links and letter case included, and the missing tail appended.
export const realPathOfLocation = (target) => realLocation(target, realPathAsStored)
// The same, for a folder read from somewhere else (the app's list, the home folder): its lexical path when it cannot be
// resolved, since it may be on a volume that is gone.
const realOrLexical = (target) => { try { return realPathOfLocation(target) } catch { return path.resolve(target) } }
// A path as written and as its real path, both.
const spellings = (target) => [...new Set([path.resolve(target), realOrLexical(target)])]

// A folder a sync client of this account keeps in step with other machines, by name; null for any other folder.
// `exists` answers whether a path exists. iCloud also syncs Desktop and Documents when "Desktop & Documents Folders"
// is on, which shows as their folders inside iCloud Drive.
export function syncedFolderOf(target, { homedir, exists = fs.existsSync } = {}) {
  if (typeof homedir !== 'string' || !path.isAbsolute(homedir)) return null
  const resolved = path.resolve(target)
  const within = (...parts) => foldedInside(path.join(homedir, ...parts), resolved)
  if (within('Library', 'Mobile Documents')) return 'iCloud Drive'
  if (within('Library', 'CloudStorage')) return 'a cloud storage provider'
  for (const [folder, name] of [['Dropbox', 'Dropbox'], ['OneDrive', 'OneDrive'], ['Google Drive', 'Google Drive'], ['Box', 'Box']]) if (within(folder)) return name
  for (const folder of ['Desktop', 'Documents']) {
    if (!within(folder)) continue
    try { if (exists(path.join(homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', folder))) return `iCloud (${folder})` } catch { /* not known */ }
  }
  return null
}

// A folder for which macOS asks a person before an app, or a background service, may read it; null otherwise.
export function protectedFolderOf(target, { homedir, platform = process.platform } = {}) {
  if (platform !== 'darwin' || typeof homedir !== 'string' || !path.isAbsolute(homedir)) return null
  const resolved = path.resolve(target)
  return ['Desktop', 'Documents', 'Downloads'].find((folder) => foldedInside(path.join(homedir, folder), resolved)) ?? null
}

// The folder of a vault Atelier publishes into that contains `target`, or null: the vault lock of a published vault,
// or a folder another view of this workspace was allocated.
function enclosingAtelierVault(target, allocatedPaths = []) {
  const candidates = spellings(target)
  for (const allocated of allocatedPaths) if (spellings(allocated).some((folder) => candidates.some((candidate) => foldedInside(folder, candidate)))) return allocated
  for (const resolved of candidates) {
    let current = resolved
    for (;;) {
      try { if (fs.statSync(path.join(current, VAULT_LOCK_DIRECTORY)).isDirectory()) return current } catch { /* not a published vault */ }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return null
}

// The folder of a vault the app lists that contains `target` or is it; null when there is none or no list is known.
// `vaults` is the app's own map, id -> { path }. Both sides are compared as written and as their real paths, in any
// letter case, so neither a link nor another spelling of a listed folder hides it.
function enclosingListedVault(target, vaults) {
  if (vaults === null || typeof vaults !== 'object') return null
  const candidates = spellings(target)
  for (const entry of Object.values(vaults)) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) continue
    if (spellings(entry.path).some((folder) => candidates.some((candidate) => foldedInside(folder, candidate)))) return entry.path
  }
  return null
}

// A folder a sync client keeps in step, or one macOS protects, for any spelling of the target and the home folder.
const anySpelling = (check, target, homedir) => {
  if (typeof homedir !== 'string' || !path.isAbsolute(homedir)) return null
  for (const home of spellings(homedir)) for (const candidate of spellings(target)) { const found = check(candidate, home); if (found !== null) return found }
  return null
}

// Whether `parent` may hold this workspace's vaults, checked before it is decided and again before a folder is
// allocated there. Refuses, typed, a folder inside an enrolled repository or the project, inside a vault Atelier
// publishes, inside a vault the app lists (when `vaults` is known), or on another volume than the workspace's private
// state (the atomic exchange that publishes a note cannot cross volumes); and a folder a sync client keeps in step,
// unless `allowSynced`. Answers the warnings a person should hear: { synced, protected }. `deviceOf` answers the
// device a path is on.
export function checkVaultParent({ parent, workspaceRoot, repositoryRoots, vaults = null, allocatedPaths = [], allowSynced = false, homedir, platform = process.platform, deviceOf = (target) => fs.statSync(target).dev }) {
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || path.resolve(parent) !== parent) refuse('vault-location-not-absolute', 'where vaults live must be an absolute folder, written plainly')
  // A repository beside the vaults, below the same folder (a home folder, say), is no overlap: each vault folder is
  // checked again against every repository when its store is made.
  const overlaps = checkManagedRoots({ managedRoots: [parent], repositoryRoots }).refusals.filter(({ code }) => code !== 'repository-inside-managed-root')
  if (overlaps.length > 0) refuse('vault-location-inside-repository', 'vaults never live inside an enrolled repository or the project', { refusals: overlaps.map(({ code }) => code) })
  const inAtelierVault = enclosingAtelierVault(parent, allocatedPaths)
  if (inAtelierVault !== null) refuse('vault-location-inside-vault', 'vaults never live inside a vault Atelier publishes', { vault: inAtelierVault })
  const inListedVault = enclosingListedVault(parent, vaults)
  if (inListedVault !== null) refuse('vault-location-inside-vault', 'vaults never live inside a folder Obsidian lists as a vault: that vault would show their notes too, and a call run in their folders would reach it', { vault: inListedVault })
  if (typeof workspaceRoot === 'string' && deviceOf(nearestExisting(parent)) !== deviceOf(nearestExisting(workspaceRoot))) {
    refuse('vault-location-other-volume', 'vaults live on the volume of Atelier\'s private data, because a note is published by an exchange that cannot cross volumes; name another data root (--data-root) on that volume to use it')
  }
  const synced = anySpelling((candidate, home) => syncedFolderOf(candidate, { homedir: home }), parent, homedir)
  if (synced !== null && !allowSynced) {
    refuse('vault-location-synced', `this folder is kept in step by ${synced}: another machine's Obsidian could hold a vault there unseen, and a sync conflict is not a publication; pass --allow-synced-location to use it anyway`, { synced })
  }
  return { synced, protected: anySpelling((candidate, home) => protectedFolderOf(candidate, { homedir: home, platform }), parent, homedir) }
}

// The view's allocation, allocated now when this workspace decided where its vaults live and the view has none yet
// and was never published under the data root; null when the view's vault stays under the data root. The folder is
// made here, exclusively and private to this user, under the first name that is free: taken by nothing on the disk
// and, when the app's list is known, by no vault it lists with that name in any letter case.
export function ensureVaultAllocation({ workspaceRoot, workspaceId, scopeId, location, projectName, repositoryRoots, vaults = null, allocatedPaths = [], homedir, now }) {
  const existing = readVaultAllocation({ workspaceRoot, workspaceId, scopeId })
  if (existing !== null) return existing
  if (location === null || location === undefined || hasCommittedGeneration({ workspaceRoot, scopeId })) return null
  const parent = location.parent
  // A synced location was allowed when it was decided; it is checked again for everything else.
  checkVaultParent({ parent, workspaceRoot, repositoryRoots, vaults, allocatedPaths, allowSynced: true, homedir })
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  // The folder is recorded by its real path, as the file system stores it: a link on the way to the location decided
  // then leads nowhere else later, and the path is the one the app and every check see.
  const realParent = realPathAsStored(parent)
  const listedNames = new Set(Object.values(vaults ?? {}).filter((entry) => typeof entry?.path === 'string').map((entry) => folded(path.basename(entry.path))))
  for (let number = 1; number <= 99; number += 1) {
    const name = vaultFolderName({ projectName, scopeId, number })
    const folder = path.join(realParent, name)
    if (listedNames.has(folded(name)) || fs.lstatSync(folder, { throwIfNoEntry: false }) !== undefined) continue
    try { fs.mkdirSync(folder, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') continue; throw error }
    try { fs.chmodSync(folder, 0o700) } catch { /* a file system without modes */ }
    return writeVaultAllocation({ workspaceRoot, allocation: { schema: VAULT_ALLOCATION_SCHEMA, workspaceId, scopeId, path: folder, name, parent: realParent, allocatedAt: now } })
  }
  return refuse('vault-location-full', 'no free vault name is left for this view in that folder', { parent })
}
