import fs from 'node:fs'
import path from 'node:path'
import { validateProjectConfigDoc } from '../../project/config.mjs'
import { MAX_EXPANSION_DEPTH, OBSIDIAN_EXT_KEY, ObsidianContractRefusal } from '../../projection/obsidian/contracts.mjs'
import { readObsidianEnablement } from './enablement.mjs'
import { ObsidianMaintenanceRefusal, refuse } from './errors.mjs'

// The views a project declares, written into its `atelier.project.json` for a
// person, so nobody edits JSON by hand: `view add`, and the view a project
// that never used Obsidian gets on its first open.
//
// The project file is committed source. Atelier changes it only when asked,
// shows the exact change as a diff, and never commits. It rewrites a file only
// when the file is in the form Atelier writes JSON in (two-space indentation,
// with LF or CRLF line ends, with or without a final one), so the change is
// the Obsidian member and nothing else; and only over the bytes it read. The
// workspace pointer is only ever written into an ignored `.atelier-local/`, so
// a project where that folder is not ignored gets the ignore line in the same
// change.

export const EXT_SETTINGS_SCHEMA = 'atelier-obsidian-ext-settings/v1'
// Every note this machine may show, in one view that is the default. Its name reads well in a command
// (`--scope everything`) and in a vault's name (`harbor-notes (everything)`).
export const DEFAULT_VIEW = Object.freeze({ scopeId: 'everything', mode: 'full', selector: Object.freeze({ all: true }) })
const LOCAL_STATE_LINE = '.atelier-local/'
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_EXPANSION_NODES = 100000
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const linesOf = (text) => { const lines = text.split(/\r?\n/); if (lines.at(-1) === '') lines.pop(); return lines }
// A hunk's range: the first line and the count, or the line before an empty range.
const range = (start, count) => (count === 0 ? `${start},0` : `${start + 1},${count}`)

// The lines that differ between two texts, as one unified hunk with up to three lines of context on each side. Enough
// for a change that inserts or replaces one run of lines, which is every change made here.
export function unifiedDiff(before, after, { label }) {
  if (before === after) return ''
  const [left, right] = [linesOf(before), linesOf(after)]
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1
  const context = 3
  const start = Math.max(0, prefix - context)
  const leftEnd = Math.min(left.length, left.length - suffix + context)
  const rightEnd = Math.min(right.length, right.length - suffix + context)
  const lines = [
    `--- ${label}`, `+++ ${label}`, `@@ -${range(start, leftEnd - start)} +${range(start, rightEnd - start)} @@`,
    ...left.slice(start, prefix).map((line) => ` ${line}`),
    ...left.slice(prefix, left.length - suffix).map((line) => `-${line}`),
    ...right.slice(prefix, right.length - suffix).map((line) => `+${line}`),
    ...right.slice(right.length - suffix, rightEnd).map((line) => ` ${line}`),
  ]
  return `${lines.join('\n')}\n`
}

const jsonText = (document, { eol, final }) => {
  const text = JSON.stringify(document, null, 2)
  return `${eol === '\n' ? text : text.replaceAll('\n', '\r\n')}${final ? eol : ''}`
}

// The form `text` is `document` written in, or null when it is in none Atelier writes.
function formOf(text, document) {
  for (const eol of ['\n', '\r\n']) for (const final of [true, false]) if (text === jsonText(document, { eol, final })) return { eol, final }
  return null
}

// A file Atelier may replace: a regular file, not a link to one elsewhere. `bytes` is null when there is none.
function readRegularFile(file, { code, what }) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat === undefined) return { bytes: null, mode: null }
  if (!stat.isFile()) refuse('project-file-not-regular', `${what} is not a regular file, so Atelier does not rewrite it; make the change by hand`, { file: path.basename(file) })
  try { return { bytes: fs.readFileSync(file), mode: stat.mode & 0o777 } } catch (error) { return refuse(code, `${what} cannot be read`, { cause: error.code ?? 'unreadable' }) }
}

// The text of a file's bytes, only when they are UTF-8 that decodes and encodes back to exactly them: a file in another
// encoding is never rewritten, since a byte that is not UTF-8 would be replaced without the diff showing it.
function textOf(bytes, refusal) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) refusal()
  return text
}

// The settings as enablement will read them, or a typed refusal naming what is wrong.
function checkedSettings(document, settings) {
  try {
    readObsidianEnablement({ config: { ...document, ext: { ...(isPlainObject(document.ext) ? document.ext : {}), [OBSIDIAN_EXT_KEY]: settings } } })
  } catch (error) {
    if (error instanceof ObsidianMaintenanceRefusal || error instanceof ObsidianContractRefusal) refuse('invalid-view', 'the views would not satisfy the Obsidian settings contract; nothing was written', { errors: error.detail?.errors ?? [] })
    throw error
  }
  return settings
}

// The project file with `settings` as its Obsidian member: { file, bytes, after, mode, diff }, `bytes` being the ones
// it was made from. `document` is the file as read. Refuses a file that is not in a form Atelier writes, since
// rewriting it would change more than the member, and names the member to add by hand.
function planMember({ file, bytes, before, mode, document, settings }) {
  const form = isPlainObject(document) && (document.ext === undefined || isPlainObject(document.ext)) ? formOf(before, document) : null
  if (form === null) {
    refuse('project-config-format-unknown', `${path.basename(file)} is not in the form Atelier writes (two-space JSON), so rewriting it would change more than the Obsidian member; nothing was written. Add the member by hand, under "ext"`, { member: { [OBSIDIAN_EXT_KEY]: settings } })
  }
  const next = { ...document, ext: { ...(document.ext ?? {}), [OBSIDIAN_EXT_KEY]: settings } }
  const errors = validateProjectConfigDoc(next)
  if (errors.length > 0) refuse('invalid-view', 'the project configuration would not be valid; nothing was written', { errors })
  const after = jsonText(next, form)
  return { file, what: path.basename(file), bytes, after, mode, diff: unifiedDiff(before, after, { label: path.basename(file) }) }
}

// The ignore line a project needs before the workspace pointer can be written:
// { needed, file, bytes, after, mode, diff }.
function planIgnore(project) {
  if (project?.localState?.ignored === true) return { needed: false }
  const file = path.join(project.configDir, '.gitignore')
  const { bytes, mode } = readRegularFile(file, { code: 'gitignore-unreadable', what: 'the project\'s .gitignore' })
  const before = bytes === null ? '' : textOf(bytes, () => refuse('gitignore-not-utf8', `the project's .gitignore is not UTF-8, so Atelier does not rewrite it; add the line ${LOCAL_STATE_LINE} to it by hand; nothing was written`, { line: LOCAL_STATE_LINE }))
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  const after = `${before}${before === '' || before.endsWith('\n') ? '' : eol}${LOCAL_STATE_LINE}${eol}`
  return { needed: true, file, what: 'the project\'s .gitignore', bytes, after, mode, diff: unifiedDiff(before, after, { label: '.gitignore' }) }
}

// The project file as it is now: its bytes and their text, its mode, and its document (null when it is not JSON).
function readProjectFile(project) {
  const file = project?.configPath
  if (typeof file !== 'string') refuse('project-config-unreadable', 'this project has no configuration file to write the view into')
  const { bytes, mode } = readRegularFile(file, { code: 'project-config-unreadable', what: path.basename(file) })
  if (bytes === null) refuse('project-config-unreadable', `${path.basename(file)} is not there`)
  // Not UTF-8: in no form Atelier writes. The member is named for the person when the rest of the file can be read.
  let before
  try { before = textOf(bytes, () => { throw new SyntaxError('not UTF-8') }) } catch {
    return { file, bytes, before: null, mode, document: null }
  }
  let document = null
  try { document = JSON.parse(before) } catch { document = null }
  return { file, bytes, before, mode, document }
}

// A folder as the repository-relative prefix of the notes a view selects, `./` and a trailing `/` dropped; null for
// the whole repository.
function folderPrefix(text) {
  const cleaned = String(text).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (cleaned === '' || cleaned === '.') return null
  if (cleaned.startsWith('/') || cleaned.startsWith('~') || /^[A-Za-z]:/.test(cleaned) || cleaned.includes('\\') || cleaned.includes('\u0000') || cleaned.split('/').includes('..')) {
    refuse('invalid-view', 'a folder is written relative to its repository\'s root, with "/", and without ".." (docs/notes, say)', { folder: String(text).slice(0, 200) })
  }
  return cleaned
}

// `DEPTH:MAX`: follow outgoing links up to DEPTH steps from the selected notes, adding at most MAX notes in all.
function expansionOf(text) {
  const match = /^([0-9]{1,2}):([0-9]{1,6})$/.exec(String(text))
  const depth = match ? Number(match[1]) : NaN
  const maxNodes = match ? Number(match[2]) : NaN
  if (!(depth >= 1 && depth <= MAX_EXPANSION_DEPTH && maxNodes >= 1 && maxNodes <= MAX_EXPANSION_NODES)) {
    refuse('invalid-view', `--expand is DEPTH:MAX, a depth from 1 to ${MAX_EXPANSION_DEPTH} and at most ${MAX_EXPANSION_NODES} notes in all (2:200, say)`)
  }
  return { depth, maxNodes, direction: 'outgoing', order: 'canonical-id' }
}

// The view `view add` asks for: every note (`all`, a full view), or a scoped view of the notes under folders of one
// repository or with a tag, optionally expanded along outgoing links. `repositories` are the names of the project's
// managed repositories; `repo` may be left out when there is one. (The contract's `type` selector matches a note's
// file type, not its `kg.type`, so it is not offered here.)
export function viewFromRequest({ scopeId, all = false, folders = [], repo, tag, expand, repositories = [] }) {
  if (typeof scopeId !== 'string' || !SCOPE_ID.test(scopeId)) refuse('usage', 'a view is named by an identifier: a letter or digit, then letters, digits, ".", "_", ":" or "-", 128 at most')
  const kinds = [all === true, folders.length > 0, tag !== undefined].filter(Boolean).length
  if (kinds !== 1) refuse('usage', 'a view selects its notes with exactly one of --all, --folder PATH (as often as needed) or --tag T')
  if (repo !== undefined && folders.length === 0) refuse('usage', '--repo names the repository of --folder')
  if (all === true && expand !== undefined) refuse('usage', 'a view of every note has nothing to expand')
  const expansion = expand === undefined ? undefined : expansionOf(expand)
  let selector
  if (all === true) selector = { all: true }
  else if (tag !== undefined) selector = { tag }
  else {
    if (repo === undefined && repositories.length !== 1) refuse('view-repository-ambiguous', 'this project enrols more than one repository; name the one the folders are in with --repo', { repositories })
    const repoId = repo ?? repositories[0]
    if (!repositories.includes(repoId)) refuse('unknown-repo', 'the project enrols no repository of that name', { repositories })
    const prefixes = [...new Set(folders.map(folderPrefix))]
    const members = prefixes.includes(null) ? [{ repo: repoId }] : prefixes.map((pathPrefix) => ({ repo: repoId, pathPrefix }))
    selector = members.length === 1 ? members[0] : { union: members }
  }
  return { scopeId, mode: all === true ? 'full' : 'scoped', selector, ...(expansion === undefined ? {} : { expansion }) }
}

// One more view: the project's Obsidian member with `scope` added (the member made, enabled, when there is none), and
// the default when asked or when it is the first view. Refuses a view whose name is taken. Writes nothing:
// { settings, member, ignore, diff }, for writeViewPlan.
export function planViewAdd(project, { scope, makeDefault = false }) {
  const source = readProjectFile(project)
  const document = isPlainObject(source.document) ? source.document : project.config
  const present = isPlainObject(document?.ext) ? document.ext[OBSIDIAN_EXT_KEY] : undefined
  const scopes = Array.isArray(present?.scopes) ? present.scopes : []
  if (scopes.some((item) => item?.scopeId === scope.scopeId)) refuse('view-exists', 'the project declares a view of this name already', { scopeId: scope.scopeId })
  // A member of its own keeps its keys in their order; a new one is written as the documentation shows it.
  const next = present === undefined
    ? { schema: EXT_SETTINGS_SCHEMA, enabled: true, defaultScopeId: scope.scopeId, scopes: [scope] }
    : { ...present, scopes: [...scopes, scope], ...(makeDefault || scopes.length === 0 ? { defaultScopeId: scope.scopeId } : {}) }
  const settings = checkedSettings(document ?? {}, next)
  const member = planMember({ ...source, settings })
  const ignore = planIgnore(project)
  return { settings, member, ignore, diff: `${member.diff}${ignore.needed ? ignore.diff : ''}` }
}

// A planned file still holds exactly the bytes its plan was made from (a file that was not there is still not there).
function assertUnchanged({ file, what, bytes: planned }) {
  const { bytes } = readRegularFile(file, { code: 'project-file-unreadable', what })
  if (planned === null ? bytes !== null : bytes === null || !bytes.equals(planned)) {
    refuse('project-config-changed', `${path.basename(file)} changed while the change was prepared; nothing was written`, { file: path.basename(file) })
  }
}

// The temporary file a planned file's new text is written to, beside it: `.<name>.<pid>.<ms>.atelier.tmp`.
const temporaryOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.atelier.tmp`)
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
// Temporary files an earlier run left beside a planned file when it stopped between writing and renaming (a crash):
// removed, unless the run that made them still runs, so none is left to be committed.
function removeLeftovers(file) {
  const pattern = new RegExp(`^\\.${path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([0-9]+)\\.[0-9]+\\.atelier\\.tmp$`)
  let names = []
  try { names = fs.readdirSync(path.dirname(file)) } catch { return }
  for (const name of names) {
    const match = pattern.exec(name)
    if (match !== null && (Number(match[1]) === process.pid || !isAlive(Number(match[1])))) fs.rmSync(path.join(path.dirname(file), name), { force: true })
  }
}

// A planned file's new text in its temporary file, keeping its mode, and on the disk before any file is replaced.
function writeTemporary({ file, after, mode }) {
  const temporary = temporaryOf(file)
  const descriptor = fs.openSync(temporary, 'wx', mode ?? 0o666)
  try {
    fs.writeFileSync(descriptor, after)
    if (mode !== null) fs.fchmodSync(descriptor, mode)
    fs.fsyncSync(descriptor)
  } catch (error) {
    fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
    throw error
  } finally {
    try { fs.closeSync(descriptor) } catch { /* closed above */ }
  }
  return temporary
}

// The folder of a replaced file, on the disk, so the renames survive a crash. A system that cannot sync a folder
// (Windows) keeps the renames all the same.
function syncFolder(folder) {
  let descriptor
  try { descriptor = fs.openSync(folder, 'r'); fs.fsyncSync(descriptor) } catch { /* not supported here */ } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}

// Writes a plan of planViewAdd when every file it changes still holds the bytes it was made from: every new text is
// written and synced to its temporary file first, then the files are replaced, the ignore line first, so a project
// file that names a view never waits on it. A failure before the first replacement changes nothing
// (`project-files-not-written`); one after it says which files changed (`project-files-partly-written`). No temporary
// file is left. Commits nothing. Answers the files written. `rename` is injectable for tests.
export function writeViewPlan(plan, { rename = fs.renameSync } = {}) {
  const targets = [...(plan.ignore.needed ? [plan.ignore] : []), plan.member]
  for (const target of targets) removeLeftovers(target.file)
  for (const target of targets) assertUnchanged(target)
  const prepared = []
  const discard = () => { for (const { temporary } of prepared) fs.rmSync(temporary, { force: true }) }
  try {
    for (const target of targets) prepared.push({ target, temporary: writeTemporary(target) })
  } catch (error) {
    discard()
    refuse('project-files-not-written', 'the change could not be written; nothing was changed', { cause: error.code ?? String(error.message) })
  }
  const written = []
  for (const { target, temporary } of prepared) {
    try { rename(temporary, target.file) } catch (error) {
      discard()
      const names = (list) => list.map((file) => path.basename(file))
      const rest = targets.map((item) => item.file).filter((file) => !written.includes(file))
      if (written.length === 0) refuse('project-files-not-written', 'the change could not be written; nothing was changed', { cause: error.code ?? String(error.message) })
      refuse('project-files-partly-written', `${names(written).join(', ')} changed, and ${names(rest).join(', ')} could not be; finish the change by hand, or undo it`, { written: names(written), notWritten: names(rest), cause: error.code ?? String(error.message) })
    }
    written.push(target.file)
  }
  for (const folder of new Set(written.map((file) => path.dirname(file)))) syncFolder(folder)
  return { written }
}
