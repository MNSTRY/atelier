import fs from 'node:fs'
import path from 'node:path'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, openRegularFileNoFollow, readRegularTextNoFollow } from '../../project/private-state.mjs'
import { PLUGIN_ID } from '../../projection/obsidian/plugin-bridge/channel.mjs'
import { COMMUNITY_PLUGINS_PATH } from '../../projection/obsidian/materialize/settings.mjs'
import { sha256Digest } from '../../projection/obsidian/materialize/byte-lens.mjs'
import { canonicalJson, isPlainObject, isoTime } from './documents.mjs'

// Whether the person wants Atelier's plugin in one vault, as the vault itself
// says it: the `atelier-projection` entry of .obsidian/community-plugins.json.
//
//   (no record)   nothing decided yet: Atelier offers the entry and the files
//   requested     `atelier obsidian plugin on` asked for it: offered again
//   on            the entry was confirmed in place after a publication; from
//                 now on a list without it is the person's decision
//   off           the person removed the entry (turned the plugin off, or
//                 uninstalled it, in Obsidian): Atelier never adds it back and
//                 never creates a plugin file that is not there; it only keeps
//                 the files that are present current
//
// The decision is read before a view is prepared, from the bytes of the file
// on disk, and those bytes travel with the prepared view: the publisher writes
// the entry only over exactly those bytes, so a change the person makes while
// a publication runs is never written over, and the next preparation reads it.
// A file that is absent or is not a list decides nothing. A record that cannot
// be read counts as `off`: nothing is re-added on a guess. Status reads the
// same change without recording it (currentPluginChoice), so it says what the
// person did before the view's next preparation records it.

export const PLUGIN_CHOICE_SCHEMA = 'atelier-obsidian-plugin-choice/v1'
export const PLUGIN_CHOICE_STATES = Object.freeze(['requested', 'on', 'off'])
const REASONS = Object.freeze(['requested-by-command', 'entry-confirmed', 'entry-removed-by-person', 'entry-restored-by-person'])
const MAX_SETTINGS_BYTES = 256 * 1024
const segment = (identifier) => identifier.replaceAll(':', '_')

export const pluginChoiceDirectory = (workspaceRoot) => path.join(workspaceRoot, 'state', 'plugin', 'choices')
// Where the recovery store places a view's vault.
export const viewVaultRoot = (workspaceRoot, scopeId) => path.join(workspaceRoot, 'vaults', segment(scopeId))
const choiceFile = (workspaceRoot, scopeId) => path.join(pluginChoiceDirectory(workspaceRoot), `${segment(scopeId)}.json`)

function validChoice(document, { workspaceId, scopeId }) {
  return isPlainObject(document) && Object.keys(document).sort().join(',') === 'reason,schema,scopeId,since,state,workspaceId'
    && document.schema === PLUGIN_CHOICE_SCHEMA && document.workspaceId === workspaceId && document.scopeId === scopeId
    && PLUGIN_CHOICE_STATES.includes(document.state) && REASONS.includes(document.reason) && typeof document.since === 'string'
}

// { state: 'undecided' | 'requested' | 'on' | 'off', reason, since, unreadable? }
export function readPluginChoice({ workspaceRoot, workspaceId, scopeId }) {
  let text
  try { text = readRegularTextNoFollow(choiceFile(workspaceRoot, scopeId)) } catch (error) {
    if (error.code === 'ENOENT') return { state: 'undecided', reason: null, since: null }
    return { state: 'off', reason: 'choice-unreadable', since: null, unreadable: true }
  }
  let document = null
  try { document = JSON.parse(text) } catch { document = null }
  if (!validChoice(document, { workspaceId, scopeId })) return { state: 'off', reason: 'choice-unreadable', since: null, unreadable: true }
  return { state: document.state, reason: document.reason, since: document.since }
}

export function writePluginChoice({ workspaceRoot, workspaceId, scopeId, state, reason, clock = () => new Date() }) {
  const document = { schema: PLUGIN_CHOICE_SCHEMA, workspaceId, scopeId, state, reason, since: isoTime(clock) }
  if (!validChoice(document, { workspaceId, scopeId })) throw new TypeError('a plugin choice names a known state and reason')
  ensureContainedPrivateDirectory({ workspaceRoot, directory: pluginChoiceDirectory(workspaceRoot), label: 'Obsidian plugin state' })
  atomicReplacePrivateText(choiceFile(workspaceRoot, scopeId), canonicalJson(document))
  return { state, reason, since: document.since }
}

// 'absent', 'unreadable' (a parent is a link or not a directory) or 'reachable'.
function parentsOf(vaultRoot, relativePath) {
  let current = vaultRoot
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) return 'absent'
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unreadable'
  }
  return 'reachable'
}

// Whether a vault path holds a regular file under real directories.
export function vaultFilePresent(vaultRoot, relativePath) {
  return parentsOf(vaultRoot, relativePath) === 'reachable' && fs.lstatSync(path.join(vaultRoot, relativePath), { throwIfNoEntry: false })?.isFile() === true
}

// The bytes of a settings file of a vault, read without following a link and
// bounded: { state: 'absent' | 'present' | 'unreadable', bytes, digest }.
export function readVaultSettingsFile(vaultRoot, relativePath) {
  const parents = parentsOf(vaultRoot, relativePath)
  if (parents !== 'reachable') return { state: parents, bytes: null, digest: null }
  let descriptor
  try { descriptor = openRegularFileNoFollow(path.join(vaultRoot, relativePath)) } catch (error) {
    return error.code === 'ENOENT' ? { state: 'absent', bytes: null, digest: null } : { state: 'unreadable', bytes: null, digest: null }
  }
  try {
    if (fs.fstatSync(descriptor).size > MAX_SETTINGS_BYTES) return { state: 'unreadable', bytes: null, digest: null }
    const bytes = fs.readFileSync(descriptor)
    return { state: 'present', bytes, digest: sha256Digest(bytes) }
  } finally {
    fs.closeSync(descriptor)
  }
}

// What the vault's community plugin list says about Atelier's entry:
// 'listed', 'not-listed' (a list without it), or 'no-list' (absent, unreadable
// or not a list), with the bytes read.
export function readCommunityEntry(vaultRoot) {
  const file = readVaultSettingsFile(vaultRoot, COMMUNITY_PLUGINS_PATH)
  if (file.state !== 'present') return { entry: 'no-list', file }
  let list = null
  try { list = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)) } catch { list = null }
  if (!Array.isArray(list)) return { entry: 'no-list', file }
  return { entry: list.includes(PLUGIN_ID) ? 'listed' : 'not-listed', file }
}

// A change of the decision the vault shows against the record, or null: an
// entry removed after it was confirmed is the person turning the plugin off; an
// entry the person put back turns it on again.
function changeShown(choice, entry) {
  if (choice.state === 'on' && entry === 'not-listed') return { state: 'off', reason: 'entry-removed-by-person' }
  if (choice.state === 'off' && !choice.unreadable && entry === 'listed') return { state: 'on', reason: 'entry-restored-by-person' }
  return null
}

// The decision for one view, from its record and what its vault says now, as
// the view is prepared: a change is recorded here.
export function decidePluginChoice({ workspaceRoot, workspaceId, scopeId, vaultRoot, clock }) {
  const recorded = readPluginChoice({ workspaceRoot, workspaceId, scopeId })
  const community = readCommunityEntry(vaultRoot)
  const change = changeShown(recorded, community.entry)
  return { choice: change === null ? recorded : writePluginChoice({ workspaceRoot, workspaceId, scopeId, ...change, clock }), community }
}

// The same decision for status, read only: a change not recorded yet is marked
// `pending` (the view's next preparation records it).
export function currentPluginChoice({ workspaceRoot, workspaceId, scopeId }) {
  const recorded = readPluginChoice({ workspaceRoot, workspaceId, scopeId })
  const change = changeShown(recorded, readCommunityEntry(viewVaultRoot(workspaceRoot, scopeId)).entry)
  return change === null ? recorded : { ...change, since: null, pending: true }
}

// After a publication: an offered entry that is now in place is confirmed.
const IN_PLACE = new Set(['policy-satisfied', 'created', 'published', 'published-external-captured', 'already-current'])
export function confirmPluginEntry({ workspaceRoot, workspaceId, scopeId, result, clock }) {
  const unit = (result?.notes ?? []).find((entry) => entry.path === COMMUNITY_PLUGINS_PATH)
  if (!unit || !IN_PLACE.has(unit.outcome) || unit.changedAfterPublication === true) return null
  const choice = readPluginChoice({ workspaceRoot, workspaceId, scopeId })
  if (choice.state !== 'undecided' && choice.state !== 'requested') return null
  return writePluginChoice({ workspaceRoot, workspaceId, scopeId, state: 'on', reason: 'entry-confirmed', clock })
}
