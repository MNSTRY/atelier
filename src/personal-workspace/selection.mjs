// Explicit selection, inventory and restore for a personal workspace's private
// home. Composition decides eligibility; this module records a person's choice,
// lists what the home retains, and restores authored inputs from an earlier
// generation without ever widening enrollment. It deletes nothing.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { composePersonalWorkspace, loadPersonalManifest, loadPersonalOverlay, PersonalWorkspaceRefusal } from './index.mjs'

const MANIFEST_FILE = 'atelier.personal.json'
const OVERLAY_FILE = 'atelier.overlay.json'
const SELECTION_SCHEMA = 'atelier-personal-workspace-selection@v1'
const RESTORE_SCHEMA = 'atelier-personal-workspace-restore@v1'
const GENESIS = 'genesis'
const MAX_RECORD = 1024 * 1024
const ID = /^[0-9a-f]{64}$/
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sortObject = (v) => Array.isArray(v) ? v.map(sortObject) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortObject(v[k])])) : v
// The same canonical form the generation id is computed over.
const canonical = (v) => `${JSON.stringify(sortObject(v))}\n`
const refuse = (code) => { throw new PersonalWorkspaceRefusal(code) }
const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }

function privateHome(personalHome) {
  if (typeof personalHome !== 'string' || !path.isAbsolute(personalHome) || path.resolve(personalHome) !== personalHome) refuse('path-not-absolute')
  if (process.platform === 'win32' || typeof process.getuid !== 'function') refuse('private-root-unverifiable')
  let stat
  try { stat = fs.lstatSync(personalHome) } catch { refuse('root-missing') }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(personalHome) !== personalHome) refuse('root-symlinked')
  if (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) refuse('not-private-location')
  return personalHome
}
function readBytes(file, limit = MAX_RECORD) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) refuse('malformed-input')
    return fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
}
const digestOrNull = (file) => { try { return hash(readBytes(file)) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
function privateDir(personalHome, name, create) {
  const dir = path.join(personalHome, name)
  if (create && !fs.existsSync(dir)) { fs.mkdirSync(dir, { mode: 0o700 }); syncDir(personalHome) }
  if (!fs.existsSync(dir)) return null
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) refuse('not-private-location')
  return dir
}
function writeExclusive(file, content) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  syncDir(path.dirname(file))
}
const eligibility = (personalHome, generationId) => {
  try { composePersonalWorkspace({ personalHome, generationId }); return { eligible: true, reason: null } }
  catch (error) { if (error instanceof PersonalWorkspaceRefusal) return { eligible: false, reason: error.code }; throw error }
}

// The selection history is an append-only hash chain of numbered records.
function readHistory(personalHome) {
  const dir = privateDir(personalHome, 'selections', false)
  if (!dir) return { records: [], head: GENESIS }
  const names = fs.readdirSync(dir).filter((name) => !name.startsWith('.'))
  const records = []
  let head = GENESIS
  for (const [index, name] of names.sort().entries()) {
    if (name !== `${String(index + 1).padStart(6, '0')}.json`) refuse('selection-history-corrupt')
    const bytes = readBytes(path.join(dir, name))
    let record
    try { record = JSON.parse(bytes) } catch { refuse('selection-history-corrupt') }
    if (record?.schema !== SELECTION_SCHEMA || record.sequence !== index + 1 || record.previous !== head || !ID.test(record.generationId ?? '') ||
      canonical(record) !== bytes.toString('utf8')) refuse('selection-history-corrupt')
    records.push(record)
    head = hash(bytes)
  }
  return { records, head }
}
export const selectionConfirmDigest = ({ generationId, previous }) => `sha256:${hash(canonical({ action: 'select', generationId, previous }))}`

// Records the person's explicit choice of the currently eligible generation.
// The caller first reads the current head and shows the person what it selects.
export function selectPersonalGeneration({ personalHome, generationId, confirm } = {}) {
  privateHome(personalHome)
  if (typeof generationId !== 'string' || !ID.test(generationId)) refuse('malformed-input')
  const { records, head } = readHistory(personalHome)
  if (confirm !== selectionConfirmDigest({ generationId, previous: head })) refuse('confirmation-mismatch')
  const { eligible, reason } = eligibility(personalHome, generationId)
  if (!eligible) refuse(reason)
  const dir = privateDir(personalHome, 'selections', true)
  const record = { schema: SELECTION_SCHEMA, sequence: records.length + 1, previous: head, generationId }
  try { writeExclusive(path.join(dir, `${String(record.sequence).padStart(6, '0')}.json`), canonical(record)) }
  catch (error) { if (error.code === 'EEXIST') refuse('selection-concurrent'); throw error }
  return freeze({ generationId, sequence: record.sequence, head: hash(canonical(record)) })
}

// The current selection and whether it is still eligible now. A selection never
// keeps a generation eligible after its inputs, roots or enrollment change.
export function readPersonalSelection({ personalHome } = {}) {
  privateHome(personalHome)
  const { records, head } = readHistory(personalHome)
  const current = records.at(-1) ?? null
  if (!current) return freeze({ selected: null, head, eligible: false, reason: 'nothing-selected' })
  return freeze({ selected: current.generationId, sequence: current.sequence, head, ...eligibility(personalHome, current.generationId) })
}

// A read-only inventory of what the private home retains. It writes and deletes nothing.
export function inventoryPersonalHome({ personalHome } = {}) {
  privateHome(personalHome)
  const authored = [MANIFEST_FILE, OVERLAY_FILE].map((name) => {
    const file = path.join(personalHome, name)
    const digest = digestOrNull(file)
    return { name, digest, bytes: digest === null ? null : fs.statSync(file).size }
  })
  const root = privateDir(personalHome, 'generations', false)
  const entries = root ? fs.readdirSync(root).sort() : []
  const generations = entries.filter((name) => ID.test(name)).map((generationId) => {
    const record = path.join(root, generationId, 'generation.json')
    return { generationId, recordDigest: digestOrNull(record), ...eligibility(personalHome, generationId) }
  })
  const staging = entries.filter((name) => name.startsWith('.staging-')).length
  const { records, head } = readHistory(personalHome)
  const restoresDir = privateDir(personalHome, 'restores', false)
  const restores = restoresDir ? fs.readdirSync(restoresDir).filter((name) => !name.startsWith('.')).sort() : []
  return freeze({ authored, generations, staging, selections: { count: records.length, head }, restores: restores.length })
}

// A generation's recorded inputs, verified against its own id: the id is the
// digest of the canonical inputs and this private home, so altered or moved
// history cannot be restored.
function recordedInputs(personalHome, generationId) {
  if (typeof generationId !== 'string' || !ID.test(generationId)) refuse('malformed-input')
  const root = privateDir(personalHome, 'generations', false)
  if (!root || !fs.existsSync(path.join(root, generationId))) refuse('generation-missing')
  let bytes
  try { bytes = readBytes(path.join(root, generationId, 'inputs.json')) } catch { refuse('generation-corrupt') }
  if (hash(canonical({ inputsDigest: hash(bytes), personalHome })) !== generationId) refuse('generation-corrupt')
  let inputs
  try { inputs = JSON.parse(bytes) } catch { refuse('generation-corrupt') }
  if (!inputs?.manifest || !inputs?.overlay || canonical(inputs) !== bytes.toString('utf8')) refuse('generation-corrupt')
  return inputs
}
const enrolled = (manifest) => new Map(manifest.repos.filter((r) => r.enrolled).map((r) => [r.repoId, r]))
export const restoreConfirmDigest = (plan) => `sha256:${hash(canonical({ action: 'restore', generationId: plan.generationId, from: plan.from, to: plan.to }))}`

// Plans restoring the authored manifest and overlay recorded by an earlier
// generation. A restore never widens enrollment: a repository enrolled there
// must be enrolled now with the same root and remote. Re-admission is the
// person's fresh enrollment, never a restore's side effect.
export function planPersonalRestore({ personalHome, generationId } = {}) {
  privateHome(personalHome)
  const inputs = recordedInputs(personalHome, generationId)
  const current = loadPersonalManifest(path.join(personalHome, MANIFEST_FILE), { personalHome })
  const now = enrolled(current)
  const readmitted = [], changed = []
  for (const [repoId, repo] of enrolled(inputs.manifest)) {
    const present = now.get(repoId)
    if (!present) readmitted.push(repoId)
    else if (present.root !== repo.root || present.remote !== repo.remote) changed.push(repoId)
  }
  if (readmitted.length) throw Object.assign(new PersonalWorkspaceRefusal('rollback-readmits-repository'), { repoIds: Object.freeze(readmitted.sort()) })
  if (changed.length) throw Object.assign(new PersonalWorkspaceRefusal('rollback-identity-changed'), { repoIds: Object.freeze(changed.sort()) })
  const to = { manifest: hash(canonical(inputs.manifest)), overlay: hash(canonical(inputs.overlay)) }
  const from = { manifest: digestOrNull(path.join(personalHome, MANIFEST_FILE)), overlay: digestOrNull(path.join(personalHome, OVERLAY_FILE)) }
  const plan = { generationId, from, to }
  return freeze({ ...plan, confirm: restoreConfirmDigest(plan) })
}

// Restores the planned authored files. The replaced bytes are kept in an
// append-only restore record first, so history is never lost. Each file is
// validated as the exact bytes to be installed, then renamed into place. A rerun
// after an interruption completes the files not yet restored.
export function restorePersonalInputs(plan, { personalHome, confirm } = {}) {
  privateHome(personalHome)
  if (!plan || confirm !== plan.confirm || confirm !== restoreConfirmDigest(plan)) refuse('confirmation-mismatch')
  const inputs = recordedInputs(personalHome, plan.generationId)
  const targets = { manifest: [MANIFEST_FILE, canonical(inputs.manifest)], overlay: [OVERLAY_FILE, canonical(inputs.overlay)] }
  for (const [key, [name, content]] of Object.entries(targets)) {
    const present = digestOrNull(path.join(personalHome, name))
    if (present !== plan.from[key] && present !== hash(content)) refuse('authored-input-changed')
    if (hash(content) !== plan.to[key]) refuse('generation-corrupt')
  }
  const dir = privateDir(personalHome, 'restores', true)
  const replaced = Object.fromEntries(Object.entries(targets).map(([key, [name]]) => {
    const file = path.join(personalHome, name)
    return [key, fs.existsSync(file) ? readBytes(file).toString('base64') : null]
  }))
  writeExclusive(path.join(dir, `${Date.now()}-${randomUUID()}.json`), canonical({ schema: RESTORE_SCHEMA, generationId: plan.generationId, from: plan.from, to: plan.to, replaced }))
  for (const [key, [name, content]] of Object.entries(targets)) {
    const file = path.join(personalHome, name)
    if (digestOrNull(file) === hash(content)) continue
    const staged = path.join(personalHome, `.restore-${key}-${randomUUID()}.json`)
    writeExclusive(staged, content)
    try { (key === 'manifest' ? loadPersonalManifest : loadPersonalOverlay)(staged, { personalHome }) } catch (error) { fs.rmSync(staged, { force: true }); throw error }
    fs.renameSync(staged, file)
    syncDir(personalHome)
  }
  return freeze({ generationId: plan.generationId, ...eligibility(personalHome, plan.generationId) })
}
