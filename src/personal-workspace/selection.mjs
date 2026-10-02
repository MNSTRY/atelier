// Explicit selection, inventory and restore for a personal workspace's private
// home. Composition decides eligibility; this module records a person's choice,
// lists what the home retains, and restores authored inputs from an earlier
// generation without ever widening enrollment or bindings. It never deletes
// authored inputs, generations or records; it removes only its own temporary
// files. Every failure is a PersonalWorkspaceRefusal with a stable code and no path.
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
// The generation module bounds every generation file at eight times its input limit.
const MAX_GENERATION_FILE = 8 * 1024 * 1024
const MAX_RESTORE_RECORD = 4 * MAX_RECORD
const ID = /^[0-9a-f]{64}$/
const TEMPORARY = /^\.(selection|restore|validate)-[0-9a-f-]{36}(-[a-z]+)?\.json$/
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sortObject = (v) => Array.isArray(v) ? v.map(sortObject) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortObject(v[k])])) : v
// The same canonical form the generation id is computed over.
const canonical = (v) => `${JSON.stringify(sortObject(v))}\n`
const refuse = (code, extra) => { throw Object.assign(new PersonalWorkspaceRefusal(code), extra ?? {}) }
const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
const restorePlans = new WeakSet()

// Maps any non-refusal failure to a stable code, so no raw error or path escapes.
function safe(fn, fallback) {
  try { return fn() } catch (error) { if (error instanceof PersonalWorkspaceRefusal) throw error; refuse(fallback) }
}
function privateHome(personalHome) {
  if (typeof personalHome !== 'string' || !path.isAbsolute(personalHome) || path.resolve(personalHome) !== personalHome) refuse('path-not-absolute')
  if (process.platform === 'win32' || typeof process.getuid !== 'function') refuse('private-root-unverifiable')
  let stat
  try { stat = fs.lstatSync(personalHome) } catch { refuse('root-missing') }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(personalHome) !== personalHome) refuse('root-symlinked')
  if (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) refuse('not-private-location')
  return personalHome
}
function readBytes(file, limit, tooLarge = 'malformed-input') {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) refuse('malformed-input')
    if (stat.size > limit) refuse(tooLarge)
    const bytes = fs.readFileSync(fd)
    if (bytes.length > limit) refuse(tooLarge)
    return bytes
  } finally { fs.closeSync(fd) }
}
const bytesOrNull = (file, limit) => { try { return readBytes(file, limit) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
function checkPrivateDir(dir) {
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) refuse('not-private-location')
  return dir
}
function privateDir(personalHome, name, create) {
  const dir = path.join(personalHome, name)
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); syncDir(personalHome) } catch (error) { if (error.code !== 'EEXIST') throw error }
  } else {
    try { fs.lstatSync(dir) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  return checkPrivateDir(dir)
}
function writeExclusive(file, content) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
// Writes complete bytes to a temporary name, then publishes them under `final`
// with link, which never replaces an existing name. A crash leaves only a
// temporary file, which readers ignore and the inventory lists.
function publishExclusive(dir, final, content, kind) {
  const temporary = path.join(dir, `.${kind}-${randomUUID()}.json`)
  writeExclusive(temporary, content)
  try { fs.linkSync(temporary, path.join(dir, final)) } finally { fs.unlinkSync(temporary) }
  syncDir(dir)
}
const eligibility = (personalHome, generationId) => {
  try { composePersonalWorkspace({ personalHome, generationId }); return { eligible: true, reason: null } }
  catch (error) { if (error instanceof PersonalWorkspaceRefusal) return { eligible: false, reason: error.code }; throw error }
}
// Validates exact bytes with the module's own loader, through a private temporary copy.
function validateBytes(personalHome, bytes, kind) {
  const temporary = path.join(personalHome, `.validate-${randomUUID()}.json`)
  writeExclusive(temporary, bytes)
  try { return (kind === 'manifest' ? loadPersonalManifest : loadPersonalOverlay)(temporary, { personalHome }) }
  finally { fs.unlinkSync(temporary) }
}

// The selection history is an append-only hash chain of numbered records. The
// chain detects any change to a record other than the last, and any reordering or
// renumbering. Deleting or rewriting the last record changes the head; a host that
// needs to detect that keeps the head it last observed and compares it.
function readHistory(personalHome) {
  const dir = privateDir(personalHome, 'selections', false)
  if (!dir) return { records: [], files: [], head: GENESIS }
  const names = fs.readdirSync(dir).filter((name) => !name.startsWith('.')).sort()
  const records = [], files = []
  let head = GENESIS
  for (const [index, name] of names.entries()) {
    if (name !== `${String(index + 1).padStart(6, '0')}.json`) refuse('selection-history-corrupt')
    const bytes = readBytes(path.join(dir, name), MAX_RECORD, 'selection-history-corrupt')
    let record
    try { record = JSON.parse(bytes) } catch { refuse('selection-history-corrupt') }
    if (record?.schema !== SELECTION_SCHEMA || record.sequence !== index + 1 || record.previous !== head || !ID.test(record.generationId ?? '') ||
      canonical(record) !== bytes.toString('utf8')) refuse('selection-history-corrupt')
    records.push(record)
    head = hash(bytes)
    files.push({ name, bytes: bytes.length, digest: head })
  }
  return { records, files, head }
}
export const selectionConfirmDigest = ({ generationId, previous }) => `sha256:${hash(canonical({ action: 'select', generationId, previous }))}`

// Records the person's explicit choice of the currently eligible generation.
// The caller first reads the current head and shows the person what it selects.
export function selectPersonalGeneration({ personalHome, generationId, confirm } = {}) {
  return safe(() => {
    privateHome(personalHome)
    if (typeof generationId !== 'string' || !ID.test(generationId)) refuse('malformed-input')
    const { records, head } = readHistory(personalHome)
    if (confirm !== selectionConfirmDigest({ generationId, previous: head })) refuse('confirmation-mismatch')
    const { eligible, reason } = eligibility(personalHome, generationId)
    if (!eligible) refuse(reason)
    const dir = privateDir(personalHome, 'selections', true)
    const record = { schema: SELECTION_SCHEMA, sequence: records.length + 1, previous: head, generationId }
    const content = canonical(record)
    try { publishExclusive(dir, `${String(record.sequence).padStart(6, '0')}.json`, content, 'selection') }
    catch (error) { if (error.code === 'EEXIST') refuse('selection-concurrent'); throw error }
    return freeze({ generationId, sequence: record.sequence, head: hash(content) })
  }, 'selection-write-failed')
}

// The current selection and whether it is still eligible now. A selection never
// keeps a generation eligible after its inputs, roots or enrollment change.
export function readPersonalSelection({ personalHome } = {}) {
  return safe(() => {
    privateHome(personalHome)
    const { records, head } = readHistory(personalHome)
    const current = records.at(-1) ?? null
    if (!current) return freeze({ selected: null, head, eligible: false, reason: 'nothing-selected' })
    return freeze({ selected: current.generationId, sequence: current.sequence, head, ...eligibility(personalHome, current.generationId) })
  }, 'personal-home-unavailable')
}

function listFiles(dir, keep) {
  if (!dir) return []
  return fs.readdirSync(dir).filter(keep).sort().map((name) => {
    const bytes = readBytes(path.join(dir, name), MAX_RESTORE_RECORD, 'record-too-large')
    return { name, bytes: bytes.length, digest: hash(bytes) }
  })
}
// A read-only inventory of everything the private home retains, for a person to
// review before any deletion they choose to confirm. It writes and deletes nothing.
export function inventoryPersonalHome({ personalHome } = {}) {
  return safe(() => {
    privateHome(personalHome)
    const authored = [MANIFEST_FILE, OVERLAY_FILE].map((name) => {
      const bytes = bytesOrNull(path.join(personalHome, name), MAX_RECORD)
      return { name, bytes: bytes?.length ?? null, digest: bytes ? hash(bytes) : null }
    })
    const root = privateDir(personalHome, 'generations', false)
    const entries = root ? fs.readdirSync(root).sort() : []
    const generations = entries.filter((name) => ID.test(name)).map((generationId) => {
      const record = bytesOrNull(path.join(root, generationId, 'generation.json'), MAX_GENERATION_FILE)
      return { generationId, recordDigest: record ? hash(record) : null, ...eligibility(personalHome, generationId) }
    })
    const staging = entries.filter((name) => name.startsWith('.staging-'))
    const selectionsDir = privateDir(personalHome, 'selections', false)
    const restoresDir = privateDir(personalHome, 'restores', false)
    const { files: selections, head } = readHistory(personalHome)
    const restores = listFiles(restoresDir, (name) => !name.startsWith('.'))
    const temporary = [
      ...listFiles(personalHome, (name) => TEMPORARY.test(name)).map((file) => ({ ...file, location: '.' })),
      ...listFiles(selectionsDir, (name) => TEMPORARY.test(name)).map((file) => ({ ...file, location: 'selections' })),
      ...listFiles(restoresDir, (name) => TEMPORARY.test(name)).map((file) => ({ ...file, location: 'restores' })),
    ]
    return freeze({ authored, generations, staging, selections: { head, records: selections }, restores, temporary })
  }, 'personal-home-unavailable')
}

// A generation's recorded inputs, verified against its own id: the id is the
// digest of the canonical inputs and this private home, so altered or moved
// history cannot be restored.
function recordedInputs(personalHome, generationId) {
  if (typeof generationId !== 'string' || !ID.test(generationId)) refuse('malformed-input')
  const root = privateDir(personalHome, 'generations', false)
  if (!root) refuse('generation-missing')
  try { fs.lstatSync(path.join(root, generationId)) } catch { refuse('generation-missing') }
  let bytes
  try { bytes = readBytes(path.join(root, generationId, 'inputs.json'), MAX_GENERATION_FILE, 'generation-inputs-too-large') }
  catch (error) { if (error instanceof PersonalWorkspaceRefusal) throw error; refuse('generation-corrupt') }
  if (hash(canonical({ inputsDigest: hash(bytes), personalHome })) !== generationId) refuse('generation-corrupt')
  let inputs
  try { inputs = JSON.parse(bytes) } catch { refuse('generation-corrupt') }
  if (!inputs?.manifest || !inputs?.overlay || canonical(inputs) !== bytes.toString('utf8')) refuse('generation-corrupt')
  return inputs
}
// The current authored file, read once: its exact bytes, digest and validated value.
function currentAuthored(personalHome, name, kind) {
  const bytes = bytesOrNull(path.join(personalHome, name), MAX_RECORD)
  if (bytes === null) refuse('malformed-input')
  return { bytes, digest: hash(bytes), value: validateBytes(personalHome, bytes, kind) }
}
// A restore may narrow enrollment and bindings, never widen them: every
// repository the target enrolls must be enrolled now with the same root and
// remote, and every binding the target declares must be declared now.
function wideningCheck(target, current) {
  const now = new Map(current.repos.filter((r) => r.enrolled).map((r) => [r.repoId, r]))
  const readmitted = [], changed = []
  for (const repo of target.repos.filter((r) => r.enrolled)) {
    const present = now.get(repo.repoId)
    if (!present) readmitted.push(repo.repoId)
    else if (present.root !== repo.root || present.remote !== repo.remote) changed.push(repo.repoId)
  }
  if (readmitted.length) refuse('rollback-readmits-repository', { repoIds: Object.freeze(readmitted.sort()) })
  if (changed.length) refuse('rollback-identity-changed', { repoIds: Object.freeze(changed.sort()) })
  const added = target.bindings.filter((binding) => !current.bindings.includes(binding))
  if (added.length) refuse('rollback-readds-binding', { count: added.length })
}
const summaryOf = (target, current, targets) => ({
  enrollmentRemoved: current.repos.filter((r) => r.enrolled && !target.repos.some((t) => t.enrolled && t.repoId === r.repoId)).map((r) => r.repoId).sort(),
  bindingsRemoved: current.bindings.filter((b) => !target.bindings.includes(b)).length,
  manifestChanged: targets.manifestChanged,
  overlayChanged: targets.overlayChanged,
})
export const restoreConfirmDigest = (plan) => `sha256:${hash(canonical({ action: 'restore', generationId: plan.generationId, from: plan.from, to: plan.to }))}`

// Plans restoring the authored manifest and overlay recorded by an earlier
// generation. Re-admission or a re-added binding is the person's fresh edit,
// never a restore's side effect.
export function planPersonalRestore({ personalHome, generationId } = {}) {
  return safe(() => {
    privateHome(personalHome)
    const inputs = recordedInputs(personalHome, generationId)
    const manifest = currentAuthored(personalHome, MANIFEST_FILE, 'manifest')
    const overlay = currentAuthored(personalHome, OVERLAY_FILE, 'overlay')
    wideningCheck(inputs.manifest, manifest.value)
    const to = { manifest: hash(canonical(inputs.manifest)), overlay: hash(canonical(inputs.overlay)) }
    const from = { manifest: manifest.digest, overlay: overlay.digest }
    const fields = { generationId, from, to }
    const plan = freeze({ ...fields, summary: summaryOf(inputs.manifest, manifest.value, { manifestChanged: from.manifest !== to.manifest, overlayChanged: from.overlay !== to.overlay }),
      confirm: restoreConfirmDigest(fields) })
    restorePlans.add(plan)
    return plan
  }, 'personal-home-unavailable')
}

// Restores a plan from planPersonalRestore. The current authored bytes are read
// once, validated, checked again against the plan and re-checked for widening;
// those exact bytes are kept in an append-only restore record before anything is
// replaced. Each file is staged, validated and renamed only if its bytes are
// still the ones that were checked. A rerun completes an interrupted restore.
export function restorePersonalInputs(plan, { personalHome, confirm } = {}) {
  return safe(() => {
    privateHome(personalHome)
    if (!restorePlans.has(plan) || confirm !== plan.confirm || confirm !== restoreConfirmDigest(plan)) refuse('confirmation-mismatch')
    const inputs = recordedInputs(personalHome, plan.generationId)
    const targets = { manifest: [MANIFEST_FILE, canonical(inputs.manifest)], overlay: [OVERLAY_FILE, canonical(inputs.overlay)] }
    const current = {}
    for (const [key, [name, content]] of Object.entries(targets)) {
      if (hash(content) !== plan.to[key]) refuse('generation-corrupt')
      current[key] = currentAuthored(personalHome, name, key)
      if (current[key].digest !== plan.from[key] && current[key].digest !== plan.to[key]) refuse('authored-input-changed')
    }
    wideningCheck(inputs.manifest, current.manifest.value)
    const dir = privateDir(personalHome, 'restores', true)
    const record = canonical({ schema: RESTORE_SCHEMA, generationId: plan.generationId, from: plan.from, to: plan.to,
      replaced: { manifest: current.manifest.bytes.toString('base64'), overlay: current.overlay.bytes.toString('base64') } })
    publishExclusive(dir, `${Date.now()}-${randomUUID()}.json`, record, 'restore')
    for (const [key, [name, content]] of Object.entries(targets)) {
      if (current[key].digest === plan.to[key]) continue
      const file = path.join(personalHome, name)
      const staged = path.join(personalHome, `.restore-${randomUUID()}-${key}.json`)
      writeExclusive(staged, content)
      try {
        (key === 'manifest' ? loadPersonalManifest : loadPersonalOverlay)(staged, { personalHome })
        const now = bytesOrNull(file, MAX_RECORD)
        if (now === null || hash(now) !== current[key].digest) refuse('authored-input-changed')
        fs.renameSync(staged, file)
      } catch (error) { fs.rmSync(staged, { force: true }); throw error }
      syncDir(personalHome)
    }
    return freeze({ generationId: plan.generationId, ...eligibility(personalHome, plan.generationId) })
  }, 'restore-write-failed')
}
