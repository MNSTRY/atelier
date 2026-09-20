import fs from 'node:fs'
import path from 'node:path'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, readRegularTextNoFollow } from '../../../project/private-state.mjs'
import { canonicalJson, closedObject, compareText } from '../../../runtime/obsidian/documents.mjs'
import { refuse } from '../../../runtime/obsidian/errors.mjs'
import { assertOutsideRepositories } from '../../../runtime/obsidian/machine-settings.mjs'
import { SCOPE_MODES, assertObsidianContract } from '../contracts.mjs'
import { SETTINGS_ROOT } from '../materialize/settings.mjs'
import { FOCUS_BOOKMARK_TYPE, FOCUS_QUERY_VERSION } from './focus.mjs'
import { SELECTION_SCHEMA } from './selection.mjs'

// Where a selector is kept: Atelier's own private state of the workspace,
//
//   <data>/obsidian/<workspace-id>/state/selection/<scope-id>.json
//
// beside the maintenance and settings documents AOP-1 keeps there, through
// the same private-state primitives (owner-only, atomic replace, no symlink
// following) and the same guard that keeps private state outside every
// enrolled repository. It is not under any vault, and it is never one of the
// files the app's UI owns under `.obsidian/`.

export const SELECTION_STATE_SCHEMA = 'atelier-obsidian-selection-state/v1'
export const SELECTION_DIRECTORY = path.join('state', 'selection')

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const segment = (identifier) => identifier.replaceAll(':', '_')

export function validateSelectionState(document, workspaceId) {
  const code = 'invalid-selection-state'
  closedObject(document, { required: ['schema', 'workspaceId', 'scopeId', 'mode', 'selector', 'expansion', 'focus', 'updatedAt'] }, code, 'the selection state')
  if (document.schema !== SELECTION_STATE_SCHEMA) refuse(code, 'the selection state names an unknown schema')
  if (document.workspaceId !== workspaceId) refuse(code, 'the selection state belongs to another workspace')
  if (typeof document.scopeId !== 'string' || !IDENTIFIER.test(document.scopeId)) refuse(code, 'the selection state names no scope')
  if (!SCOPE_MODES.includes(document.mode)) refuse(code, 'the selection state carries an unknown mode')
  // The selector and the expansion are exactly a scope document's: the contract decides whether they are well formed.
  assertObsidianContract('scope', { schema: 'atelier-obsidian-scope/v1', scopeId: document.scopeId, mode: document.mode, selector: document.selector, ...(document.expansion === null ? {} : { expansion: document.expansion }) })
  if (document.focus !== null) {
    closedObject(document.focus, { required: ['version', 'query', 'queryDigest', 'paths', 'bookmark'] }, code, 'the persisted focus')
    if (document.focus.version !== FOCUS_QUERY_VERSION || typeof document.focus.query !== 'string' || document.focus.query === '' || !DIGEST.test(String(document.focus.queryDigest))) refuse(code, 'the persisted focus is malformed')
    if (!Array.isArray(document.focus.paths) || document.focus.paths.length === 0 || document.focus.paths.some((item) => typeof item !== 'string')) refuse(code, 'the persisted focus names no path')
    closedObject(document.focus.bookmark, { required: ['type', 'title', 'options'] }, code, 'the persisted bookmark payload')
    if (document.focus.bookmark.type !== FOCUS_BOOKMARK_TYPE) refuse(code, 'the persisted bookmark payload is not a graph bookmark')
  }
  if (document.mode === 'focus' ? document.focus === null : document.focus !== null) refuse(code, 'a focus is persisted exactly for a focus scope')
  if (typeof document.updatedAt !== 'string' || !TIMESTAMP.test(document.updatedAt)) refuse(code, 'updatedAt must be a UTC timestamp')
  return document
}

// A path Atelier may write: under the workspace's private state and never under a vault's `.obsidian/`.
export function assertWritableSelectionPath({ workspaceRoot, file }) {
  const relative = path.relative(workspaceRoot, file)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) refuse('selection-state-outside-workspace', 'the selection state is written under the workspace private state only')
  const parts = relative.split(path.sep)
  if (parts.includes(SETTINGS_ROOT) || parts[0] === 'vaults') refuse('ui-owned-file-refused', 'Atelier never writes a vault or a file under .obsidian/; the app owns those')
  if (parts.length !== 3 || parts[0] !== 'state' || parts[1] !== 'selection') refuse('selection-state-outside-workspace', 'the selection state lives in state/selection')
  return file
}

export function selectionStateDocument({ workspaceId, selection, now }) {
  if (selection?.schema !== SELECTION_SCHEMA) refuse('invalid-selection', 'a resolved selection is persisted, nothing else')
  return {
    schema: SELECTION_STATE_SCHEMA,
    workspaceId,
    scopeId: selection.scope.scopeId,
    mode: selection.scope.mode,
    selector: selection.scope.selector,
    expansion: selection.scope.expansion ?? null,
    focus: selection.focus === null ? null : { version: selection.focus.version, query: selection.focus.query, queryDigest: selection.focus.queryDigest, paths: selection.focus.paths, bookmark: selection.focus.bookmark },
    updatedAt: now,
  }
}

const selectionFile = (workspaceRoot, scopeId) => path.join(workspaceRoot, SELECTION_DIRECTORY, `${segment(scopeId)}.json`)

// Writes only when the bytes change. Returns { file, changed, document }.
export function writeSelectionState({ workspaceRoot, workspaceId, repositoryRoots, selection, now }) {
  const document = validateSelectionState(selectionStateDocument({ workspaceId, selection, now }), workspaceId)
  assertOutsideRepositories({ managedRoot: workspaceRoot, repositoryRoots })
  const file = assertWritableSelectionPath({ workspaceRoot, file: selectionFile(workspaceRoot, document.scopeId) })
  const text = canonicalJson(document)
  let existing = null
  try { existing = readRegularTextNoFollow(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  // A rewrite that changes only the time is not a change to the selection.
  if (existing !== null) {
    let previous = null
    try { previous = JSON.parse(existing) } catch { previous = null }
    if (previous !== null && canonicalJson({ ...previous, updatedAt: document.updatedAt }) === text) return { file, changed: false, document: previous }
  }
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
  const directory = ensureContainedPrivateDirectory({ workspaceRoot, directory: path.join(workspaceRoot, SELECTION_DIRECTORY), label: 'Obsidian selection state' })
  atomicReplacePrivateText(path.join(directory, path.basename(file)), text)
  return { file, changed: true, document }
}

export function readSelectionState({ workspaceRoot, workspaceId, scopeId }) {
  if (typeof scopeId !== 'string' || !IDENTIFIER.test(scopeId)) refuse('invalid-scope', 'name the scope whose selection to read')
  let text
  try { text = readRegularTextNoFollow(selectionFile(workspaceRoot, scopeId)) } catch (error) {
    if (error.code === 'ENOENT') return null
    refuse('invalid-selection-state', 'the selection state cannot be read', { cause: error.code ?? String(error.message) })
  }
  let document
  try { document = JSON.parse(text) } catch { refuse('invalid-selection-state', 'the selection state is not JSON') }
  const validated = validateSelectionState(document, workspaceId)
  if (validated.scopeId !== scopeId) refuse('invalid-selection-state', 'the selection state names another scope')
  return validated
}

export function listSelectionStates({ workspaceRoot, workspaceId }) {
  let names
  try { names = fs.readdirSync(path.join(workspaceRoot, SELECTION_DIRECTORY)) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const documents = []
  for (const name of names.filter((item) => item.endsWith('.json')).sort(compareText)) {
    const text = readRegularTextNoFollow(path.join(workspaceRoot, SELECTION_DIRECTORY, name))
    let document
    try { document = JSON.parse(text) } catch { refuse('invalid-selection-state', 'a selection state is not JSON', { file: name }) }
    documents.push(validateSelectionState(document, workspaceId))
  }
  return documents.sort((left, right) => compareText(left.scopeId, right.scopeId))
}
