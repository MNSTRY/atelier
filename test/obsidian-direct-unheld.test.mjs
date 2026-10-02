import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { OBSIDIAN_EXT_KEY, validateObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import { PROTOCOL_ID, createEditorAdapter, resolveExchange } from '../src/projection/obsidian/publication/index.mjs'
import { PUBLICATION_PRIMITIVES, publishView, publishViewForOracleTests } from '../src/projection/obsidian/publication/publisher.mjs'
import { CRASH_INJECTION_TEST_SEAM } from '../src/projection/obsidian/publication/test-seam.mjs'
import { VAULT_LOCK_DIRECTORY, createRecoveryStore, listJournals, recoverPublications } from '../src/projection/obsidian/recovery/index.mjs'
import { createProductionUnheldEvidence, readUnheldEvidence } from '../src/runtime/obsidian/unheld-evidence.mjs'
import { ensureVaultAllocation } from '../src/runtime/obsidian/vault-location.mjs'

// First publication into a vault no Obsidian lists (the publisher's
// `direct-unheld` path): the rules of docs/obsidian-contract.md, "First
// publication into a vault no Obsidian lists", each against the production
// publisher on a real file system in temporary folders. The app is a model
// that answers for another vault; its list is a document handed to the
// evidence reader, or a settings file under a temporary HOME. Nothing here
// starts an app, reads a real HOME or sends a signal to a process it did not
// start. Invented, synthetic content only.

const SELF = fileURLToPath(import.meta.url)
const TMP = fs.realpathSync(os.tmpdir())
const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const POSIX = process.platform === 'darwin' || process.platform === 'linux'
const needsExchange = EXCHANGE_HERE && POSIX ? {} : { skip: 'the publisher publishes only on macOS and Linux, where an atomic exchange exists' }
const WORKSPACE_ID = `ws-${'0d'.repeat(12)}`
const SCOPE = 'everything'
const NOW = '2026-01-05T10:00:00.000Z'
const EXT = OBSIDIAN_EXT_KEY
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const hex = (value) => createHash('sha256').update(value).digest('hex')
const clock = () => new Date()

const NOTE = 'notes/Quay notes--0123456789ab.md'
const OTHER = 'notes/Harbour log--ba9876543210.md'
const THIRD = 'notes/Tide table--00112233aabb.md'
const FOURTH = 'notes/Buoy list--aabbccddeeff.md'
const PICTURE = 'attachments/quay.png'
const POLICY = '.obsidian/core-plugins.json'
const PLUGIN_MAIN = '.obsidian/plugins/atelier-projection/main.js'
const PLUGIN_DATA = '.obsidian/plugins/atelier-projection/data.json'
const TEXT = (label) => `# ${label}\n\nGenerated body for ${label}.\n`
const POLICY_BYTES = '{\n  "publish": false,\n  "sync": false\n}\n'

// A prepared view, built by hand so each case states its bytes.
function viewOf(generationId, { notes = {}, attachments = {}, settings = false, plugin = false, onlyIfPresent = false } = {}) {
  const files = []
  const manifest = {
    schema: 'atelier-obsidian-generation-manifest/v1', generationId, scopeId: SCOPE, snapshotId: 'snap-synthetic',
    notes: [], links: [], attachments: [],
    completeness: { status: 'complete', expectedNotes: Object.keys(notes).length, writtenNotes: Object.keys(notes).length },
    freshness: { status: 'current', checkedAt: NOW },
  }
  for (const [notePath, text] of Object.entries(notes)) {
    const bytes = Buffer.from(text, 'utf8')
    files.push({ path: notePath, kind: 'note', bytes, digest: digest(bytes) })
    manifest.notes.push({ repoId: 'north-desk', nodeId: `node-${hex(notePath).slice(0, 8)}`, path: notePath, title: 'Synthetic', noteDigest: digest(bytes), regions: { body: { start: 0, end: bytes.length }, generated: [] } })
  }
  for (const [filePath, bytes] of Object.entries(attachments)) {
    files.push({ path: filePath, kind: 'attachment', bytes, digest: digest(bytes) })
    manifest.attachments.push({ path: filePath, digest: digest(bytes), byteLength: bytes.length })
  }
  if (settings) {
    const bytes = Buffer.from(POLICY_BYTES)
    files.push({ path: POLICY, kind: 'settings', bytes, digest: digest(bytes) })
  }
  if (plugin) {
    const main = Buffer.from(typeof plugin === 'string' ? plugin : 'module.exports = class AtelierProjection {}\n')
    const data = Buffer.from('{"bearer":"synthetic-bearer"}\n')
    const present = onlyIfPresent ? { onlyIfPresent: true } : {}
    files.push({ path: PLUGIN_MAIN, kind: 'plugin', bytes: main, digest: digest(main), mode: 0o644, ...present }, { path: PLUGIN_DATA, kind: 'plugin', bytes: data, digest: digest(data), mode: 0o600, ...present })
    manifest.ext = { [EXT]: { settings: { pluginOwned: { files: [{ path: PLUGIN_MAIN, digest: digest(main) }, { path: PLUGIN_DATA, digest: digest(data) }] } } } }
  }
  return { manifest, files }
}

const FULL_VIEW = (generationId = 'gen-0001') => viewOf(generationId, { notes: { [NOTE]: TEXT('quay'), [OTHER]: TEXT('harbour') }, attachments: { [PICTURE]: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }, settings: true, plugin: true })

// An Obsidian that runs and answers for another vault, as the real one does for a call about a vault it does not list.
// Every call is recorded: the only one the publisher may make on this path is its probe.
function runningApp({ processes = 'running' } = {}) {
  const calls = []
  const adapter = createEditorAdapter({
    call: async (payload) => { calls.push(payload.op); return { status: 'vault-mismatch' } },
    processProbe: () => processes,
    kind: 'model',
  })
  adapter.calls = calls
  return adapter
}
const absentApp = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })

// A workspace whose view was allocated a folder `<parent>/harbor-notes (everything)`, and its store.
function allocatedWorld(t, { root } = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(TMP, 'atelier-unheld-'))
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const workspaceRoot = path.join(dir, 'data', 'obsidian', WORKSPACE_ID)
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
  const parent = path.join(dir, 'Atelier')
  if (!fs.existsSync(parent)) ensureVaultAllocation({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, location: { parent }, projectName: 'harbor-notes', repositoryRoots: [], now: NOW })
  const store = createRecoveryStore({ workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [] })
  // The app's own list, as a document the evidence reader is handed; another vault B is listed and open.
  const other = path.join(dir, 'Other vault')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'b.md'), 'B stays as it is\n')
  const list = { vaults: { bbbbbbbbbbbbbbbb: { path: other, ts: 1, open: true } } }
  const reads = []
  const evidence = ({ vaultRoot }) => readUnheldEvidence({ vaultRoot, read: () => { reads.push(Date.now()); return { ok: true, vaults: structuredClone(list.vaults) } }, sandboxed: () => false })
  const world = {
    dir, workspaceRoot, parent, store, other, list, reads, evidence,
    vault: store.vaultRoot,
    full: (relative) => path.join(store.vaultRoot, relative),
    read: (relative) => { try { return fs.readFileSync(path.join(store.vaultRoot, relative), 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error } },
    publish: (preparedView, adapter, { publisher = publishView, unheldEvidence = evidence, ...extra } = {}) => publisher({
      preparedView, protocolId: PROTOCOL_ID, expectedGeneration: store.readCurrent()?.generationId ?? null, recoveryStore: store, adapter, clock, quietPeriodMs: 0, unheldEvidence, ...extra,
    }),
  }
  return world
}

function listing(directory) {
  const found = {}
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(directory, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) { found[`${relative}/`] = 'directory'; walk(absolute) } else found[relative] = digest(fs.readFileSync(absolute))
    }
  }
  if (fs.existsSync(directory)) walk(directory)
  return found
}
// What the vault holds apart from the vault lock, which every publication takes before it chooses a path.
const vaultFiles = (world) => Object.fromEntries(Object.entries(listing(world.vault)).filter(([relative]) => !relative.startsWith(`${VAULT_LOCK_DIRECTORY}/`)))
const noteResult = (result, notePath) => result.notes.find((item) => item.path === notePath)
const journalsOf = (store) => listJournals(store).map((journal) => journal.document())
const modeOf = (document) => document.ext?.[EXT]?.mode

function assertJournalsValid(store) {
  const documents = journalsOf(store)
  assert.ok(documents.length > 0)
  for (const document of documents) assert.deepEqual(validateObsidianContract('publication-journal', document), [])
  return documents
}

// ---------------------------------------------------------------------------
// Child process entry: a direct-unheld (or direct) publication killed at a named point, by itself
// ---------------------------------------------------------------------------

if (process.env.ATELIER_UNHELD_CHILD) {
  const job = JSON.parse(process.env.ATELIER_UNHELD_CHILD)
  const seam = { at: job.crashAt, halt: () => process.kill(process.pid, 'SIGKILL') }
  let result
  if (job.direct) {
    const store = createRecoveryStore({ workspaceRoot: job.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [] })
    result = await publishView({ preparedView: crashView(), protocolId: PROTOCOL_ID, expectedGeneration: null, recoveryStore: store, adapter: absentApp(), clock, quietPeriodMs: 0, [CRASH_INJECTION_TEST_SEAM]: seam })
  } else {
    const world = allocatedWorld(null, { root: job.root })
    result = await world.publish(crashView(), runningApp(), { [CRASH_INJECTION_TEST_SEAM]: seam })
  }
  process.stdout.write(JSON.stringify({ state: result.state }))
  process.exit(0)
}

// The settings file first, so a crash at the first `after-publish` leaves it created, then two notes.
function crashView() {
  const view = viewOf('gen-0001', { notes: { [NOTE]: TEXT('quay'), [OTHER]: TEXT('harbour') }, settings: true })
  view.files.sort((left, right) => (left.kind === 'settings' ? -1 : right.kind === 'settings' ? 1 : 0))
  return view
}

function crashChild(job) {
  const env = { ...process.env, ATELIER_UNHELD_CHILD: JSON.stringify(job) }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 60000 })
}

// ---------------------------------------------------------------------------
// The evidence
// ---------------------------------------------------------------------------

test('the evidence: only a list that was read and names no folder on the way to the vault, nor inside it, is evidence; everything else is none', { skip: POSIX ? false : 'POSIX paths' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-unheld-evidence-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const parent = path.join(dir, 'Atelier')
  const vault = path.join(parent, 'harbor-notes (everything)')
  fs.mkdirSync(vault, { recursive: true })
  const linked = path.join(dir, 'linked')
  fs.symlinkSync(parent, linked)
  const read = (vaults) => () => ({ ok: true, vaults })
  const ask = (vaults, extra = {}) => readUnheldEvidence({ vaultRoot: vault, read: read(vaults), sandboxed: () => false, sleep: async () => {}, ...extra })
  const entry = (folder) => ({ bbbbbbbbbbbbbbbb: { path: folder, ts: 1 } })
  assert.deepEqual(await ask({}), { unlisted: true }, 'a list of no vault')
  assert.deepEqual(await ask(entry(path.join(dir, 'Other vault'))), { unlisted: true }, 'another vault beside it')
  assert.deepEqual(await ask(entry(path.join(parent, 'harbor-notes (everything 2)'))), { unlisted: true }, 'a vault whose name begins like it is another vault')
  const cases = [
    [entry(vault), 'vault-listed', 'the vault as written'],
    [entry(path.join(linked, 'harbor-notes (everything)')), 'vault-listed', 'the vault through a linked parent: its real path'],
    [entry(vault.toUpperCase()), 'vault-listed', 'another letter case, which a volume that folds case takes for the same folder'],
    [entry(`${vault}/`), 'vault-listed', 'a trailing separator'],
    [entry(parent), 'vault-inside-listed-vault', 'a folder above it'],
    [entry(dir), 'vault-inside-listed-vault', 'a folder further above'],
    [entry(linked), 'vault-inside-listed-vault', 'a folder above it, through a link'],
    [entry(path.join(vault, 'inner')), 'listed-vault-inside-vault', 'a folder inside it'],
    [{ bbbbbbbbbbbbbbbb: { path: 'relative/vault', ts: 1 } }, 'obsidian-settings-entry-unreadable', 'an entry whose folder is not absolute'],
    [{ bbbbbbbbbbbbbbbb: 'not an entry' }, 'obsidian-settings-entry-unreadable', 'an entry that is not an object'],
    [[], 'obsidian-settings-not-object', 'a list that is not an object'],
  ]
  for (const [vaults, reason, label] of cases) assert.equal((await ask(vaults)).reason, reason, label)
  // A `..` after a link names, physically, a folder the text does not show: `<dir>/lnk/../../Atelier` is the vault's
  // parent when `lnk` leads to `<dir>/x/y`. An entry with a `..` segment is not understood, and gives no evidence.
  fs.mkdirSync(path.join(dir, 'x', 'y'), { recursive: true })
  fs.symlinkSync(path.join(dir, 'x', 'y'), path.join(dir, 'lnk'))
  assert.deepEqual(fs.readdirSync(`${path.join(dir, 'lnk')}/../../Atelier`), ['harbor-notes (everything)'], 'the entry leads to the vault\'s parent')
  assert.equal((await ask(entry(`${path.join(dir, 'lnk')}/../../Atelier`))).reason, 'obsidian-settings-entry-unreadable', 'a `..` after a link')
  assert.equal((await ask(entry(`${path.join(dir, 'Other vault')}/../Elsewhere`))).reason, 'obsidian-settings-entry-unreadable', 'any `..` segment')
  // Letter case is folded even where no file system can resolve it: a folder that is not there yet.
  const notYet = await readUnheldEvidence({ vaultRoot: path.join(dir, 'Absent', 'harbor (x)'), read: read(entry(path.join(dir, 'ABSENT', 'HARBOR (X)'))), sandboxed: () => false })
  assert.equal(notYet.reason, 'vault-listed', 'another letter case of a folder that does not exist yet')
  assert.equal((await ask({}, { sandboxed: () => true })).reason, 'obsidian-sandboxed')
  assert.equal((await ask({}, { sandboxed: () => { throw new Error('cannot tell') } })).reason, 'obsidian-sandboxed', 'a build that cannot be ruled out is present')
  assert.equal((await ask({}, { read: () => ({ ok: false, code: 'obsidian-settings-missing' }) })).reason, 'obsidian-settings-missing', 'an app that never wrote its list gives no evidence')
  assert.equal((await ask({}, { read: () => { throw new Error('boom') } })).reason, 'obsidian-settings-unreadable')
  assert.equal((await ask({}, { read: undefined })).reason, 'obsidian-settings-location-unknown')
  assert.equal((await readUnheldEvidence({ vaultRoot: 'relative', read: read({}), sandboxed: () => false })).reason, 'vault-root-unknown')
  // A file the app is writing: read again, up to three times 50 ms apart, then none.
  let reads = 0
  const waits = []
  const unreadable = await ask({}, { read: () => { reads += 1; return { ok: false, code: 'obsidian-settings-unreadable' } }, sleep: async (ms) => { waits.push(ms) } })
  assert.deepEqual([unreadable.reason, reads, waits], ['obsidian-settings-unreadable', 3, [50, 50]])
  reads = 0
  assert.deepEqual(await ask({}, { read: () => ((reads += 1) < 3 ? { ok: false, code: 'obsidian-settings-unreadable' } : { ok: true, vaults: {} }) }), { unlisted: true }, 'read whole at the third reading')
})

test('the production evidence reads the settings file of the app under HOME: a truncated file gives none after three readings, a file written in between gives it, a missing one none, and a Flatpak or snap build none', { skip: POSIX ? false : 'POSIX paths' }, async (t) => {
  const home = fs.mkdtempSync(path.join(TMP, 'atelier-unheld-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const vault = path.join(home, 'Atelier', 'harbor-notes (everything)')
  fs.mkdirSync(vault, { recursive: true })
  // The system-wide places a Flatpak or snap build is installed (/var/lib/flatpak, /snap, ...) are looked up under a
  // scratch folder, so this host's own installation decides nothing here.
  const system = path.join(home, 'system')
  const scratchSystem = (candidate) => fs.existsSync(candidate.startsWith(`${home}${path.sep}`) ? candidate : path.join(system, candidate))
  for (const platform of ['darwin', 'linux']) {
    const env = { HOME: home }
    const userData = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'obsidian') : path.join(home, '.config', 'obsidian')
    const evidence = createProductionUnheldEvidence({ platform, env, exists: scratchSystem })
    fs.rmSync(userData, { recursive: true, force: true })
    assert.equal((await evidence({ vaultRoot: vault })).reason, 'obsidian-settings-missing', `${platform}: no settings file`)
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
    const file = path.join(userData, 'obsidian.json')
    fs.writeFileSync(file, JSON.stringify({ vaults: { bbbbbbbbbbbbbbbb: { path: path.join(home, 'Other vault'), ts: 1, open: true } } }))
    assert.deepEqual(await evidence({ vaultRoot: vault }), { unlisted: true }, `${platform}: another vault`)
    fs.writeFileSync(file, '{"vaults":{"bbbbbbbbbbbbbbbb":{"path":"')
    const started = Date.now()
    assert.equal((await evidence({ vaultRoot: vault })).reason, 'obsidian-settings-unreadable', `${platform}: cut short`)
    assert.ok(Date.now() - started >= 90, 'read three times, 50 ms apart')
    fs.writeFileSync(file, '')
    setTimeout(() => fs.writeFileSync(file, JSON.stringify({ vaults: {} })), 20)
    assert.deepEqual(await evidence({ vaultRoot: vault }), { unlisted: true }, `${platform}: emptied while the app writes it, whole at a later reading`)
    fs.writeFileSync(file, JSON.stringify({ vaults: { bbbbbbbbbbbbbbbb: { path: vault, ts: 1 } } }))
    assert.equal((await evidence({ vaultRoot: vault })).reason, 'vault-listed', `${platform}: listed`)
    fs.writeFileSync(file, JSON.stringify({ vaults: {} }))
  }
  // Linux: a Flatpak or a snap anywhere on this account, whichever list was written last.
  for (const sandbox of [['.var', 'app', 'md.obsidian.Obsidian'], ['snap', 'obsidian']]) {
    fs.mkdirSync(path.join(home, ...sandbox), { recursive: true })
    const answer = await createProductionUnheldEvidence({ platform: 'linux', env: { HOME: home }, exists: scratchSystem })({ vaultRoot: vault })
    assert.equal(answer.reason, 'obsidian-sandboxed', sandbox.join('/'))
    fs.rmSync(path.join(home, sandbox[0]), { recursive: true, force: true })
  }
  // A system-wide installation counts too.
  for (const installed of ['var/lib/flatpak/app/md.obsidian.Obsidian', 'snap/obsidian', 'var/lib/snapd/snap/obsidian']) {
    fs.mkdirSync(path.join(system, installed), { recursive: true })
    const answer = await createProductionUnheldEvidence({ platform: 'linux', env: { HOME: home }, exists: scratchSystem })({ vaultRoot: vault })
    assert.equal(answer.reason, 'obsidian-sandboxed', installed)
    fs.rmSync(system, { recursive: true, force: true })
  }
  assert.deepEqual(await createProductionUnheldEvidence({ platform: 'linux', env: { HOME: home }, exists: scratchSystem })({ vaultRoot: vault }), { unlisted: true }, 'control: none installed')
})

const SYSTEM_SANDBOXES = ['/var/lib/flatpak/app/md.obsidian.Obsidian', '/snap/obsidian', '/var/lib/snapd/snap/obsidian']
const systemSandbox = process.platform === 'linux' && SYSTEM_SANDBOXES.some((candidate) => fs.existsSync(candidate))

test('the maintenance service\'s own adapter hands its engine the reader of the app\'s settings file under HOME, called in a child whose HOME is a scratch folder', { skip: !POSIX ? 'POSIX paths' : systemSandbox ? 'a system-wide Flatpak or snap Obsidian on this host is, rightly, no evidence' : false }, async (t) => {
  const home = fs.mkdtempSync(path.join(TMP, 'atelier-unheld-wiring-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const config = path.join(home, '.config')
  const userData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'obsidian') : path.join(config, 'obsidian')
  const listed = path.join(home, 'Atelier', 'harbor-notes (everything)')
  const unlisted = path.join(home, 'Atelier', 'harbor-notes (discovery)')
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(userData, 'obsidian.json'), JSON.stringify({ vaults: { bbbbbbbbbbbbbbbb: { path: listed, ts: 1, open: true } } }))
  // Building the production adapter loads the production seams: only in this child, whose HOME and XDG folders are the
  // scratch folder. The only one it calls is the reader, which reads the scratch settings file.
  const entry = new URL('../src/runtime/obsidian/service-main.mjs', import.meta.url).href
  const code = `const { SERVICE_ADAPTERS } = await import(${JSON.stringify(entry)}); const { engineOptions } = await SERVICE_ADAPTERS['obsidian-cli'](); const read = engineOptions.readUnheldEvidence; process.stdout.write(JSON.stringify({ listed: await read({ vaultRoot: ${JSON.stringify(listed)} }), unlisted: await read({ vaultRoot: ${JSON.stringify(unlisted)} }), list: typeof engineOptions.readAppVaultList }))`
  const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: path.join(home, 'run'), XDG_DATA_HOME: path.join(home, 'data') }
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, cwd: home, encoding: 'utf8', timeout: 30000 })
  assert.equal(child.status, 0, child.stderr)
  const answer = JSON.parse(child.stdout)
  assert.deepEqual([answer.listed.unlisted, answer.listed.reason, answer.listed.path], [false, 'vault-listed', listed])
  assert.deepEqual(answer.unlisted, { unlisted: true })
  assert.equal(answer.list, 'function')
})

// ---------------------------------------------------------------------------
// The path
// ---------------------------------------------------------------------------

test('publication while an app runs, into an allocated vault no list names, commits by creating every file: notes, attachments, the settings file and the plugin files', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  const app = runningApp()
  const otherBefore = listing(world.other)
  const result = await world.publish(FULL_VIEW(), app)
  assert.equal(result.state, 'committed', JSON.stringify(result))
  assert.equal(result.mode, 'direct-unheld')
  assert.deepEqual(result.notes.map((item) => [item.path, item.outcome, item.blocking]).sort(), [
    [PLUGIN_DATA, 'created', false], [PLUGIN_MAIN, 'created', false], [POLICY, 'created', false], [OTHER, 'created', false], [NOTE, 'created', false], [PICTURE, 'created', false],
  ].sort())
  assert.deepEqual([world.read(NOTE), world.read(OTHER), world.read(POLICY)], [TEXT('quay'), TEXT('harbour'), POLICY_BYTES])
  assert.equal(fs.statSync(world.full(PLUGIN_DATA)).mode & 0o777, 0o600, 'the bearer goes into a vault private to this user')
  assert.equal(fs.statSync(world.vault).mode & 0o777, 0o700)
  assert.equal(world.store.readCurrent().generationId, 'gen-0001')
  // The only call the app got is the probe that found it answering for another vault.
  assert.deepEqual(app.calls, ['inspect'])
  // Read at path selection and again immediately before the first unit. A slow host can add the publisher's
  // periodic re-check, which reads again only once more than two seconds have passed since its last check
  // (publisher.mjs), so any further read is spaced, never a repeat of the one before.
  assert.ok(world.reads.length >= 2, `read at path selection and before the first unit, got ${world.reads.length}`)
  for (let index = 2; index < world.reads.length; index += 1) {
    assert.ok(world.reads[index] - world.reads[index - 1] >= 1000, 'a further read is only the periodic re-check')
  }
  // Besides notes, attachments, the settings file and the plugin files, only the vault lock is written.
  assert.deepEqual(Object.keys(vaultFiles(world)).filter((relative) => !relative.endsWith('/')).sort(), [NOTE, OTHER, PICTURE, POLICY, PLUGIN_MAIN, PLUGIN_DATA].sort())
  assert.equal(fs.statSync(path.join(world.vault, VAULT_LOCK_DIRECTORY)).isDirectory(), true, 'the vault lock is still taken')
  // The journal says so, and a restart treats it as any other.
  const [document] = assertJournalsValid(world.store)
  assert.equal(modeOf(document), 'direct-unheld')
  assert.deepEqual(document.ext[EXT].units.map((unit) => unit.op).sort(), ['create', 'create', 'create', 'create', 'create', 'settings'])
  assert.deepEqual(result.lateWriters, [], 'the late-writer check ran, and found nothing: nothing was displaced')
  assert.deepEqual(listing(world.other), otherBefore, 'the vault the app holds is untouched')
})

test('a vault a list names refuses as before, whether it is named as written, through a linked parent, in another letter case, or has a listed vault inside it', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  const linked = path.join(world.dir, 'linked')
  fs.symlinkSync(world.parent, linked)
  const named = [world.vault, path.join(linked, path.basename(world.vault)), world.vault.toUpperCase(), path.join(world.vault, 'inner vault')]
  for (const folder of named) {
    world.list.vaults.cccccccccccccccc = { path: folder, ts: 2 }
    const app = runningApp()
    const result = await world.publish(FULL_VIEW(), app)
    assert.deepEqual([result.state, result.refusal?.code], ['refused', 'editor-uncoordinated'], folder)
    assert.deepEqual(vaultFiles(world), {}, `nothing is written: ${folder}`)
    assert.equal(world.store.readCurrent(), null)
  }
  // Control: it was the entry. Without it the same view is published on this path.
  delete world.list.vaults.cccccccccccccccc
  const control = await world.publish(FULL_VIEW(), runningApp())
  assert.deepEqual([control.state, control.mode], ['committed', 'direct-unheld'])
})

test('a vault inside a folder a list names refuses as before', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  for (const folder of [world.parent, world.dir]) {
    world.list.vaults.cccccccccccccccc = { path: folder, ts: 2 }
    const result = await world.publish(FULL_VIEW(), runningApp())
    assert.deepEqual([result.state, result.refusal?.code], ['refused', 'editor-uncoordinated'], folder)
    assert.deepEqual(vaultFiles(world), {})
  }
  // Control: it was the entry. Without it the same view is published on this path.
  delete world.list.vaults.cccccccccccccccc
  const control = await world.publish(FULL_VIEW(), runningApp())
  assert.deepEqual([control.state, control.mode], ['committed', 'direct-unheld'])
})

test('a second generation is never published on this path: once a generation is committed, a running app that is not coordinated with refuses as before', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  assert.equal((await world.publish(FULL_VIEW(), runningApp())).state, 'committed')
  const before = vaultFiles(world)
  const second = viewOf('gen-0002', { notes: { [NOTE]: TEXT('quay, again'), [OTHER]: TEXT('harbour'), [THIRD]: TEXT('tide') }, settings: true, plugin: true })
  const result = await world.publish(second, runningApp())
  assert.deepEqual([result.state, result.refusal?.code], ['refused', 'editor-uncoordinated'])
  assert.deepEqual(vaultFiles(world), before, 'not even a new note is created')
  assert.equal(world.store.readCurrent().generationId, 'gen-0001')
})

test('a file already at a note path is kept as create-conflict; the other files are created and nothing is committed', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  fs.mkdirSync(path.dirname(world.full(NOTE)), { recursive: true })
  fs.writeFileSync(world.full(NOTE), 'Somebody wrote this first\n')
  const result = await world.publish(FULL_VIEW(), runningApp())
  assert.equal(result.state, 'updating')
  assert.equal(result.mode, 'direct-unheld')
  assert.deepEqual([noteResult(result, NOTE).outcome, noteResult(result, NOTE).blocking], ['create-conflict', true])
  assert.equal(world.read(NOTE), 'Somebody wrote this first\n')
  assert.equal(world.read(OTHER), TEXT('harbour'))
  assert.equal(world.store.readCurrent(), null)
})

test('a settings file already there blocks: it is never written over, no candidate is staged for it, and nothing is committed', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  fs.mkdirSync(path.dirname(world.full(POLICY)), { recursive: true })
  const theirs = '{\n  "file-explorer": true,\n  "publish": true\n}\n'
  fs.writeFileSync(world.full(POLICY), theirs)
  const result = await world.publish(FULL_VIEW(), runningApp())
  assert.equal(result.state, 'updating')
  assert.deepEqual([noteResult(result, POLICY).outcome, noteResult(result, POLICY).blocking], ['editor-uncoordinated', true])
  assert.equal(world.read(POLICY), theirs)
  assert.equal(world.store.readCurrent(), null)
  const [document] = journalsOf(world.store)
  assert.equal(document.entries.some((entry) => entry.ext?.[EXT]?.code === 'late-candidate'), false, 'no late candidate is written ahead for it')
  // One that is not even the policy's shape blocks too: it is somebody's.
  fs.writeFileSync(world.full(POLICY), 'not json')
  const again = await world.publish(FULL_VIEW(), runningApp())
  assert.deepEqual([again.state, noteResult(again, POLICY).outcome, world.read(POLICY)], ['updating', 'editor-uncoordinated', 'not json'])
})

// Every way a unit other than a create could be written on this path. `publisher` is the production one or a
// deliberately broken one: the rule must be what keeps each file as it is.
async function assertCreatesOnly(t, publisher) {
  const world = allocatedWorld(t)
  const publish = (view) => world.publish(view, runningApp(), { publisher })
  // An earlier publication on this path stopped by a file in its way: two notes and the plugin files were published,
  // nothing was committed, and the journal trusts what it published.
  fs.mkdirSync(path.dirname(world.full(THIRD)), { recursive: true })
  fs.writeFileSync(world.full(THIRD), 'In the way\n')
  const first = await publish(viewOf('gen-0001', { notes: { [NOTE]: TEXT('quay'), [OTHER]: TEXT('harbour'), [THIRD]: TEXT('tide'), [FOURTH]: TEXT('buoys') }, plugin: true }))
  assert.equal(first.state, 'updating')
  fs.rmSync(world.full(THIRD))
  // A note the earlier run published, removed since: the next view changes it, so it is planned as a replacement of a
  // file that is gone. No candidate is staged for a replacement, and it is never turned into a create.
  fs.rmSync(world.full(FOURTH))
  // The settings file somebody else made, and a plugin file changed since.
  fs.mkdirSync(path.dirname(world.full(POLICY)), { recursive: true })
  fs.writeFileSync(world.full(POLICY), '{"publish":true}\n')
  fs.writeFileSync(world.full(PLUGIN_MAIN), '// somebody changed this\n')
  const before = vaultFiles(world)
  // The next view replaces NOTE, removes OTHER, writes the settings file and the plugin's main file.
  const next = viewOf('gen-0002', { notes: { [NOTE]: TEXT('quay, rewritten'), [THIRD]: TEXT('tide'), [FOURTH]: TEXT('buoys, rewritten') }, settings: true, plugin: 'module.exports = class Newer {}\n' })
  const result = await publish(next)
  assert.equal(result.mode, 'direct-unheld')
  const after = vaultFiles(world)
  delete after[THIRD]
  assert.deepEqual(after, before, 'no file that was there is replaced or removed')
  assert.equal(result.state, 'updating')
  for (const [notePath, op] of [[NOTE, 'replace'], [OTHER, 'remove'], [POLICY, 'settings'], [PLUGIN_MAIN, 'replace'], [FOURTH, 'replace']]) {
    assert.deepEqual([noteResult(result, notePath).op, noteResult(result, notePath).outcome, noteResult(result, notePath).blocking], [op, 'editor-uncoordinated', true], notePath)
  }
  assert.deepEqual([noteResult(result, THIRD).outcome, world.read(THIRD)], ['created', TEXT('tide')], 'a note where nothing is is still created')
  const documents = journalsOf(world.store)
  const latest = documents.find((document) => document.targetGeneration === 'gen-0002')
  assert.deepEqual((latest.ext[EXT].staged ?? []).map((item) => item.path), [THIRD], 'no candidate is staged but for the create')
  assert.equal(latest.entries.some((entry) => entry.ext?.[EXT]?.code === 'late-candidate'), false)
  assert.equal(world.store.readCurrent(), null)
}

test('no replacement, removal, settings file over an existing one, plugin replacement or late candidate but a create is written on this path', needsExchange, async (t) => {
  await assertCreatesOnly(t, publishView)
})

test('mutation control: a publisher that lets a replacement through on this path fails the creates-only oracle', needsExchange, async (t) => {
  const lenient = (options) => publishViewForOracleTests(options, { ...PUBLICATION_PRIMITIVES, unheldWrites: () => true })
  await assert.rejects(assertCreatesOnly(t, lenient), (error) => error instanceof assert.AssertionError && error.message.startsWith('no file that was there is replaced or removed'))
})

test('the evidence is read again before the first unit and every two seconds: once a reading gives none, every remaining unit refuses, a kept one included, and nothing is committed', needsExchange, async (t) => {
  // Listed between path selection and the first unit: nothing is written at all.
  const early = allocatedWorld(t)
  let asked = 0
  const listedAfterSelection = (input) => ((asked += 1) === 1 ? early.evidence(input) : { unlisted: false, reason: 'vault-listed' })
  const stopped = await early.publish(FULL_VIEW(), runningApp(), { unheldEvidence: listedAfterSelection })
  assert.deepEqual([stopped.state, asked], ['updating', 2])
  assert.ok(stopped.notes.every((item) => item.outcome === 'editor-uncoordinated' && item.blocking), JSON.stringify(stopped.notes))
  assert.deepEqual(vaultFiles(early), {})

  // Listed two seconds into the run: the notes created before stay, the rest refuse, nothing is committed.
  const world = allocatedWorld(t)
  let readings = 0
  const listedLater = async (input) => {
    readings += 1
    if (readings === 2) await sleep(2100)
    return readings <= 2 ? world.evidence(input) : { unlisted: false, reason: 'vault-listed' }
  }
  const view = viewOf('gen-0001', { notes: { [NOTE]: TEXT('quay'), [OTHER]: TEXT('harbour'), [THIRD]: TEXT('tide') } })
  const result = await world.publish(view, runningApp(), { unheldEvidence: listedLater })
  assert.equal(readings, 3, 'path selection, the first unit, and the unit after two seconds')
  assert.equal(result.state, 'updating')
  assert.deepEqual(result.notes.map((item) => [item.path, item.outcome, item.blocking]), [[NOTE, 'created', false], [OTHER, 'editor-uncoordinated', true], [THIRD, 'editor-uncoordinated', true]])
  assert.deepEqual([world.read(NOTE), world.read(OTHER), world.read(THIRD)], [TEXT('quay'), null, null])
  assert.equal(world.store.readCurrent(), null)

  // A unit that would leave a file absent refuses too once a reading fails: the run says why it stopped, and commits
  // nothing, although no unit after the failed reading would have written.
  const absent = allocatedWorld(t)
  let absentReadings = 0
  const listedAtLeaveAbsent = async (input) => {
    absentReadings += 1
    if (absentReadings === 2) await sleep(2100)
    return absentReadings <= 2 ? absent.evidence(input) : { unlisted: false, reason: 'vault-listed' }
  }
  const leaving = await absent.publish(viewOf('gen-0001', { notes: { [NOTE]: TEXT('quay') }, plugin: true, onlyIfPresent: true }), runningApp(), { unheldEvidence: listedAtLeaveAbsent })
  assert.equal(absentReadings, 3)
  assert.deepEqual(leaving.notes.map((item) => [item.path, item.op, item.outcome, item.blocking]), [
    [NOTE, 'create', 'created', false], [PLUGIN_MAIN, 'leave-absent', 'editor-uncoordinated', true], [PLUGIN_DATA, 'leave-absent', 'editor-uncoordinated', true],
  ])
  assert.deepEqual([leaving.state, absent.store.readCurrent()], ['updating', null])

  // A kept unit refuses too once a reading fails, so a run whose remaining units write nothing still commits nothing.
  let again = 0
  const failsAtFirstUnit = (input) => ((again += 1) === 1 ? world.evidence(input) : Promise.reject(new Error('the file vanished')))
  const kept = await world.publish(viewOf('gen-0001', { notes: { [NOTE]: TEXT('quay') } }), runningApp(), { unheldEvidence: failsAtFirstUnit })
  assert.deepEqual([kept.state, noteResult(kept, NOTE).op, noteResult(kept, NOTE).outcome, noteResult(kept, NOTE).blocking], ['updating', 'keep', 'editor-uncoordinated', true])
  assert.equal(world.store.readCurrent(), null)
})

test('each condition that does not hold leaves the publication as it was: refused, and nothing written', needsExchange, async (t) => {
  const refusedAsBefore = async (world, label, extra = {}, adapter = runningApp()) => {
    const result = await world.publish(FULL_VIEW(), adapter, extra)
    assert.deepEqual([result.state, result.refusal?.code], ['refused', extra.expectedCode ?? 'editor-uncoordinated'], label)
    assert.deepEqual(vaultFiles(world), {}, label)
  }
  const world = allocatedWorld(t)
  await refusedAsBefore(world, 'no evidence reader', { unheldEvidence: null })
  await refusedAsBefore(world, 'an evidence reader that throws', { unheldEvidence: () => { throw new Error('boom') } })
  await refusedAsBefore(world, 'an answer that is not exactly `unlisted: true`', { unheldEvidence: () => ({ unlisted: 'yes' }) })
  await refusedAsBefore(world, 'a list that is missing', { unheldEvidence: ({ vaultRoot }) => readUnheldEvidence({ vaultRoot, read: () => ({ ok: false, code: 'obsidian-settings-missing' }), sandboxed: () => false }) })
  await refusedAsBefore(world, 'a list that stays cut short', { unheldEvidence: ({ vaultRoot }) => readUnheldEvidence({ vaultRoot, read: () => ({ ok: false, code: 'obsidian-settings-unreadable' }), sandboxed: () => false, sleep: async () => {} }) })
  await refusedAsBefore(world, 'a Flatpak or snap build', { unheldEvidence: ({ vaultRoot }) => readUnheldEvidence({ vaultRoot, read: () => ({ ok: true, vaults: {} }), sandboxed: () => true }) })
  await refusedAsBefore(world, 'a platform other than macOS or Linux', { platform: 'win32' })
  // The route already found a vault above this one or the same folder listed twice: the refusal is the route's.
  const routed = createEditorAdapter({ call: async () => { const error = new Error('no call'); throw Object.assign(error, { code: 'vault-inside-another-vault' }) }, processProbe: () => 'running' })
  routed.probe = async () => ({ state: 'uncoordinated', code: 'vault-open-in-several-windows', reason: 'two windows' })
  await refusedAsBefore(world, 'a route refusal', { expectedCode: 'vault-open-in-several-windows' }, routed)
  // A folder that is not the one recorded (its inode differs), though the store has not noticed.
  const moved = Object.assign(Object.create(world.store), { allocation: { ...world.store.allocation, inode: String(BigInt(world.store.allocation.inode) + 1n) }, checkAllocatedVault() {} })
  const result = await publishView({ preparedView: FULL_VIEW(), protocolId: PROTOCOL_ID, expectedGeneration: null, recoveryStore: moved, adapter: runningApp(), clock, quietPeriodMs: 0, unheldEvidence: world.evidence })
  assert.deepEqual([result.state, result.refusal?.code], ['refused', 'editor-uncoordinated'], 'a device or inode that does not match the record')
  assert.deepEqual(vaultFiles(world), {})

  // A vault under the data root (no allocation), and one a caller named: never this path.
  const legacyRoot = fs.mkdtempSync(path.join(TMP, 'atelier-unheld-legacy-'))
  t.after(() => fs.rmSync(legacyRoot, { recursive: true, force: true }))
  const legacy = createRecoveryStore({ workspaceRoot: path.join(legacyRoot, 'ws'), workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [] })
  const named = createRecoveryStore({ workspaceRoot: path.join(legacyRoot, 'ws2'), workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [], vaultRoot: path.join(legacyRoot, 'named vault') })
  for (const [store, origin] of [[legacy, 'legacy-data-root'], [named, 'explicit']]) {
    assert.equal(store.vaultOrigin, origin)
    const evidence = ({ vaultRoot }) => readUnheldEvidence({ vaultRoot, read: () => ({ ok: true, vaults: {} }), sandboxed: () => false })
    const answer = await publishView({ preparedView: FULL_VIEW(), protocolId: PROTOCOL_ID, expectedGeneration: null, recoveryStore: store, adapter: runningApp(), clock, quietPeriodMs: 0, unheldEvidence: evidence })
    assert.deepEqual([answer.state, answer.refusal?.code], ['refused', 'editor-uncoordinated'], origin)
    assert.deepEqual(Object.keys(listing(store.vaultRoot)).filter((relative) => !relative.startsWith(VAULT_LOCK_DIRECTORY)), [], origin)
  }
  // Control: the same world with every condition holding publishes.
  assert.equal((await world.publish(FULL_VIEW(), runningApp())).state, 'committed')
})

test('with no app the path is `direct`, as before, and the evidence is never read; an unknowable process table is an app that may run', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  const result = await world.publish(FULL_VIEW(), absentApp())
  assert.deepEqual([result.state, result.mode, world.reads.length], ['committed', 'direct', 0])
  // An unknowable process table is an app that may run: this path, when it applies.
  const unknown = allocatedWorld(t)
  const answer = await unknown.publish(FULL_VIEW(), runningApp({ processes: 'unknown' }))
  assert.deepEqual([answer.state, answer.mode], ['committed', 'direct-unheld'])
})

test('an interrupted publication on this path is recovered exactly as one on the direct path, and the next run converges on this path', needsExchange, async (t) => {
  const world = allocatedWorld(t)
  const killed = crashChild({ root: world.dir, crashAt: 'after-publish' })
  assert.equal(killed.signal, 'SIGKILL', killed.stderr)
  assert.equal(world.read(POLICY), POLICY_BYTES, 'the settings file was created before the crash')
  assert.equal(world.store.readCurrent(), null)
  // The same crash on the direct path, into a vault under another data root.
  const directRoot = fs.mkdtempSync(path.join(TMP, 'atelier-unheld-direct-'))
  t.after(() => fs.rmSync(directRoot, { recursive: true, force: true }))
  const directWorkspace = path.join(directRoot, 'ws')
  const directKilled = crashChild({ direct: true, workspaceRoot: directWorkspace, crashAt: 'after-publish' })
  assert.equal(directKilled.signal, 'SIGKILL', directKilled.stderr)
  const directStore = createRecoveryStore({ workspaceRoot: directWorkspace, workspaceId: WORKSPACE_ID, scopeId: SCOPE, repositoryRoots: [] })

  // Restart recovery settles both the same way: the same entries, step for step.
  const shape = (store) => journalsOf(store).map((document) => document.entries.map((entry) => [entry.step, entry.outcome, entry.state, entry.notePath ?? null, entry.ext?.[EXT]?.code ?? null]))
  recoverPublications({ store: world.store, clock })
  recoverPublications({ store: directStore, clock })
  assert.deepEqual(shape(world.store), shape(directStore))
  assert.deepEqual(journalsOf(world.store).map(modeOf), ['direct-unheld'])
  assert.deepEqual(journalsOf(directStore).map(modeOf), ['direct'])

  // The next run takes this path again (nothing is committed yet), keeps the settings file it made, and commits.
  const result = await world.publish(crashView(), runningApp())
  assert.equal(result.state, 'committed', JSON.stringify(result))
  assert.equal(result.mode, 'direct-unheld')
  assert.equal(noteResult(result, POLICY).outcome, 'policy-satisfied', 'the settings file it created is its own, and holds what the policy asks')
  assert.deepEqual([world.read(POLICY), world.read(NOTE), world.read(OTHER)], [POLICY_BYTES, TEXT('quay'), TEXT('harbour')])
  assertJournalsValid(world.store)
  assert.deepEqual(filesUnder(path.join(world.workspaceRoot, 'staging')), [], 'nothing is left in staging')
})

function filesUnder(directory) {
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else found.push(absolute)
    }
  }
  if (fs.existsSync(directory)) walk(directory)
  return found
}
