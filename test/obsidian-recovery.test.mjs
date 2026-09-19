import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { acquirePrivateLock } from '../src/project/durable-state.mjs'
import { validateObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import {
  PROTOCOL_ID,
  TransportTimeout,
  buildEvalCode,
  createEditorAdapter,
  createInProcessCall,
  createInProcessHost,
  createObsidianCliAdapter,
  createObsidianCliCall,
  defaultObsidianProcessProbe,
  exchangeFiles,
  probeExchange,
  publishView,
  resetExchangeProbeCache,
  resolveExchange,
  runInProcess,
  validatePayload,
} from '../src/projection/obsidian/publication/index.mjs'
import { CRASH_INJECTION_TEST_SEAM } from '../src/projection/obsidian/publication/test-seam.mjs'

// The publisher refuses outright where no atomic exchange exists (Windows today),
// so every case that needs a publication is skipped there with this reason. The
// native refusal itself is asserted on every platform further down.
const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which is asserted separately' }
import { EXCHANGE_CANDIDATE_NAME, LATE_EXCHANGE_CANDIDATE_NAME, VAULT_LOCK_DIRECTORY, acquireVaultLock, classifyCandidateFile, createRecoveryStore, listJournals, namedCandidates, recheckDisplacedFiles, recoverPublications } from '../src/projection/obsidian/recovery/index.mjs'

// Every G00 interleaving, replayed against the production publisher on a real
// filesystem. The editor is a model: an in-process object with the surface the
// fixed script uses (leaves, views, a dirty flag, the saved-content field, an
// editor that applies transactions), driven by the same script body the real
// app receives. Invented, synthetic content only.

const SELF = fileURLToPath(import.meta.url)
const TMP = fs.realpathSync(os.tmpdir())
const BASE = '# Synthetic note\n\nThe quick brown fox jumps.\n\nUnrelated closing paragraph.\n'
const CANDIDATE = '# Synthetic note\n\nThe quick GENERATED fox jumps.\n\nUnrelated closing paragraph.\n\nGenerated relation: [[Other]]\n'
const NOTE = 'notes/Synthetic note--0123456789ab.md'
const OTHER = 'notes/Other--ba9876543210.md'
const POLICY = '.obsidian/core-plugins.json'
const EDITED = `${BASE}EDITED ON DISK\n`
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const hex = (value) => createHash('sha256').update(value).digest('hex')
const clock = () => new Date()

// ---------------------------------------------------------------------------
// Prepared views, built by hand so each case states its bytes
// ---------------------------------------------------------------------------

function viewOf(generationId, { notes = {}, attachments = {}, settings = false, scopeId = 'scope-synthetic' } = {}) {
  const files = []
  const manifest = {
    schema: 'atelier-obsidian-generation-manifest/v1', generationId, scopeId, snapshotId: 'snap-synthetic',
    notes: [], links: [], attachments: [],
    completeness: { status: 'complete', expectedNotes: Object.keys(notes).length, writtenNotes: Object.keys(notes).length },
    freshness: { status: 'current', checkedAt: '2026-01-05T10:00:00.000Z' },
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
    const bytes = Buffer.from('{\n  "publish": false,\n  "sync": false\n}\n')
    files.push({ path: POLICY, kind: 'settings', bytes, digest: digest(bytes) })
  }
  return { manifest, files }
}

// ---------------------------------------------------------------------------
// Model editor
// ---------------------------------------------------------------------------

class ModelView {
  constructor(app, notePath, ownerDocument, { savedField = true } = {}) {
    this.app = app
    this.file = { path: notePath }
    this.full = path.join(app.vaultRoot, notePath)
    this.data = fs.readFileSync(this.full, 'utf8')
    this.dirty = false
    if (savedField) this.lastSavedData = this.data
    this.containerEl = { ownerDocument }
    this.transactions = 0
    this.setValues = 0
    this.diskWrites = 0
    const view = this
    this.editor = {
      getValue: () => view.data,
      offsetToPos(offset) {
        const before = view.data.slice(0, offset)
        return { line: before.split('\n').length - 1, ch: offset - (before.lastIndexOf('\n') + 1) }
      },
      posToOffset({ line, ch }) {
        const lines = view.data.split('\n')
        let offset = 0
        for (let index = 0; index < line; index += 1) offset += lines[index].length + 1
        return offset + ch
      },
      // All positions refer to the document before the transaction, as in the real editor.
      transaction({ changes }) {
        const resolved = changes.map((change) => ({ from: view.editor.posToOffset(change.from), to: view.editor.posToOffset(change.to), text: change.text })).sort((left, right) => right.from - left.from)
        for (const change of resolved) view.data = view.data.slice(0, change.from) + change.text + view.data.slice(change.to)
        view.transactions += 1
        view.dirty = true
      },
      setValue(text) { view.data = text; view.setValues += 1; view.dirty = true },
    }
  }

  getViewData() { return this.data }

  // Text entry by the person: the buffer changes at once, the file later.
  type(text, anchor) {
    const at = this.data.indexOf(anchor)
    assert.ok(at >= 0, `anchor ${anchor} not in the buffer`)
    this.data = this.data.slice(0, at + anchor.length) + text + this.data.slice(at + anchor.length)
    this.dirty = true
  }

  // The app's delayed save: it writes the file in place, and only when the buffer differs from what it last saved.
  save() {
    if (this.data === this.lastSavedData) { this.dirty = false; return false }
    fs.writeFileSync(this.full, this.data)
    this.lastSavedData = this.data
    this.dirty = false
    this.diskWrites += 1
    return true
  }
}

class ModelApp {
  constructor(vaultRoot) {
    this.vaultRoot = vaultRoot
    this.leaves = []
    this.window = {}
    this.mainDocument = { name: 'main' }
    this.vault = { adapter: { getBasePath: () => vaultRoot } }
    this.workspace = { iterateAllLeaves: (callback) => this.leaves.forEach(callback) }
  }

  open(notePath, { popout = false, savedField = true } = {}) {
    const view = new ModelView(this, notePath, popout ? { name: 'popout' } : this.mainDocument, { savedField })
    this.leaves.push({ view })
    return view
  }

  flushSaves() { return this.leaves.map((leaf) => leaf.view.save()) }
}

// The production adapter rules over an in-process call into the model app.
// `plan` injects transport faults and interleavings around single calls.
function modelAdapter(app, { plan = {}, crashSeam, processProbe = () => 'running' } = {}) {
  const calls = []
  const inProcess = createInProcessCall(createInProcessHost({ app, window: app.window, document: app.mainDocument, crashSeam }))
  const call = async (payload) => {
    const index = calls.filter((item) => item.op === payload.op).length
    calls.push({ op: payload.op, path: payload.path })
    if (plan.before) await plan.before(payload, index)
    if (plan.dropBefore?.(payload, index)) throw new Error('connection lost before the call reached the app')
    const reply = await inProcess(payload)
    if (plan.after) await plan.after(payload, index, reply)
    if (plan.loseReply?.(payload, index)) throw new TransportTimeout('reply lost')
    if (plan.dropAfter?.(payload, index)) throw new Error('connection lost after the call ran')
    return reply
  }
  const adapter = createEditorAdapter({ call, processProbe, kind: 'model' })
  adapter.calls = calls
  adapter.count = (op) => calls.filter((item) => item.op === op).length
  return adapter
}

const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

function makeWorld(t, { root } = {}) {
  const workspaceRoot = root ?? fs.mkdtempSync(path.join(TMP, 'atelier-recovery-'))
  if (t) t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  const store = createRecoveryStore({ workspaceRoot, workspaceId: 'ws-synthetic-0003', scopeId: 'scope-synthetic', repositoryRoots: [] })
  const world = {
    root: store.workspaceRoot,
    store,
    vault: store.vaultRoot,
    full: (relative) => path.join(store.vaultRoot, relative),
    read: (relative) => { try { return fs.readFileSync(path.join(store.vaultRoot, relative), 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error } },
    // Every production publication ends with the staging check below.
    publish: async (preparedView, adapter, { publisher = publishView, ...extra } = {}) => {
      const result = await publisher({ preparedView, protocolId: PROTOCOL_ID, expectedGeneration: store.readCurrent()?.generationId ?? null, recoveryStore: store, adapter, clock, quietPeriodMs: 0, ...extra })
      if (publisher === publishView) assertStagingNeverHoldsDisplacedBytes(extra.recoveryStore ?? store)
      return result
    },
  }
  return world
}

async function seeded(t, notes = { [NOTE]: BASE }, options = {}) {
  const world = makeWorld(t, options)
  const result = await world.publish(viewOf('gen-0001', { notes }), absentAdapter())
  assert.equal(result.state, 'committed', JSON.stringify(result))
  assert.equal(result.mode, 'direct')
  return world
}

function filesUnder(directory) {
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) found.push(absolute)
    }
  }
  if (fs.existsSync(directory)) walk(directory)
  return found
}

// Every byte string kept in recovery. Staging is declared discardable, so it never counts as a place where
// somebody's bytes are kept.
const keptTexts = (world) => filesUnder(path.join(world.root, 'recovery')).map((file) => fs.readFileSync(file, 'utf8'))
const stagedTexts = (world) => filesUnder(path.join(world.root, 'staging')).map((file) => fs.readFileSync(file, 'utf8'))

// The staging oracle. At every crash point and after every run, no file under staging has ever held or holds
// displaced bytes: displaced bytes are only ever at the vault path, at the unit's exchange candidate path in
// recovery, or at the recovery store's final names.
//   ever: an exchange leaves the displaced bytes at exactly the candidate path that the unit's write-ahead entry
//         (and the header) names, so no replacement may name a candidate path outside its own unit recovery directory;
//   now:  every file under staging is, byte for byte, a generated candidate the journal recorded, and is none of
//         the texts the case knows to be a person's.
const EXT = 'mnstry.atelier.obsidian'
function assertStagingNeverHoldsDisplacedBytes(store, { persons = [] } = {}) {
  const recorded = new Set()
  for (const journal of listJournals(store)) {
    const document = journal.document()
    const unitRef = (unit) => `recovery/${document.journalId.replaceAll(':', '_')}/${String(unit).padStart(6, '0')}/`
    const opOf = new Map((document.ext?.[EXT]?.units ?? []).map((item) => [item.unit, item.op]))
    const exchanged = []
    for (const item of namedCandidates(document)) {
      recorded.add(item.candidateDigest)
      if (item.late || opOf.get(item.unit) === 'replace') exchanged.push(item)
    }
    for (const entry of document.entries) {
      const detail = entry.ext?.[EXT] ?? {}
      if (entry.step !== 'capture' || !detail.stagedRef) continue
      if (entry.afterDigest) recorded.add(entry.afterDigest)
      if (detail.op === 'replace') exchanged.push({ unit: detail.unit, stagedRef: detail.stagedRef })
    }
    for (const item of exchanged) {
      assert.ok(item.stagedRef.startsWith(unitRef(item.unit)) && !item.stagedRef.startsWith('staging/'),
        `an exchange candidate is outside its unit recovery directory, so displaced bytes would sit there: ${item.stagedRef}`)
    }
  }
  const personDigests = new Set(persons.map((text) => digest(text)))
  for (const file of filesUnder(store.stagingRoot)) {
    const found = digest(fs.readFileSync(file))
    assert.ok(recorded.has(found), `staging holds bytes that are not a recorded candidate: ${path.relative(store.workspaceRoot, file)}`)
    assert.ok(!personDigests.has(found), `staging holds a person's bytes: ${path.relative(store.workspaceRoot, file)}`)
  }
}

// Mutation control for the oracle: the old layout, in which a candidate that will be exchanged waits in staging.
const exchangeInStaging = (store) => Object.assign(Object.create(store), {
  exchangeCandidatePath: (journalId, unit, { late = false } = {}) => path.join(store.stagingDir(journalId), `${String(unit).padStart(6, '0')}.exchange${late ? '.late' : ''}.candidate`),
})
const exchangeCandidateFiles = (world) => filesUnder(path.join(world.root, 'recovery')).filter((file) => [EXCHANGE_CANDIDATE_NAME, LATE_EXCHANGE_CANDIDATE_NAME].includes(path.basename(file)))
const keptSomewhere = (world, text, notePath = NOTE) => world.read(notePath) === text || keptTexts(world).includes(text)
const snapshotTree = (world) => Object.fromEntries(filesUnder(world.root).filter((file) => !file.includes(`${path.sep}state${path.sep}locks${path.sep}`) && !file.includes(`${path.sep}${VAULT_LOCK_DIRECTORY}${path.sep}`)).sort().map((file) => [path.relative(world.root, file), hex(fs.readFileSync(file))]))
const stamp = (file) => { const stat = fs.statSync(file, { bigint: true }); return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` }
const noteResult = (result, notePath = NOTE) => result.notes.find((item) => item.path === notePath)

function assertJournalsValid(world) {
  const journals = listJournals(world.store)
  assert.ok(journals.length > 0)
  for (const journal of journals) {
    const document = journal.document()
    assert.deepEqual(validateObsidianContract('publication-journal', document), [])
    assert.equal(document.protocolId, PROTOCOL_ID)
  }
  return journals.map((journal) => journal.document())
}

// ---------------------------------------------------------------------------
// Mutation control: a publisher with the same interface that checks the base
// and then replaces the note with a plain rename. It must fail the cases below.
// ---------------------------------------------------------------------------

async function renamingPublisher(options) {
  const { preparedView, recoveryStore: store, adapter } = options
  const seam = options[CRASH_INJECTION_TEST_SEAM]
  const prior = new Map((store.readCurrentManifest()?.notes ?? []).map((note) => [note.path, note.noteDigest]))
  const notes = []
  for (const file of preparedView.files.filter((item) => item.kind === 'note')) {
    const target = path.join(store.vaultRoot, file.path)
    const onDisk = fs.existsSync(target) ? digest(fs.readFileSync(target)) : null
    if (onDisk !== null && onDisk !== prior.get(file.path)) { notes.push({ path: file.path, outcome: 'disk-changed', blocking: true }); continue }
    await adapter.inspect({ vaultRoot: store.vaultRoot, path: file.path }).catch(() => null)
    fs.writeFileSync(`${target}.tmp~`, file.bytes)
    fs.renameSync(`${target}.tmp~`, target) // unconditional replacement of an editable path
    if (seam?.at === 'after-publish') seam.halt('after-publish')
    notes.push({ path: file.path, outcome: 'published', blocking: false })
  }
  store.commitManifest({ manifestBytes: Buffer.from(JSON.stringify(preparedView.manifest)), generationId: preparedView.manifest.generationId, journalId: 'journal-renaming', retained: [], committedAt: new Date().toISOString() })
  return { state: 'committed', notes, retainedEdits: [], lateWriters: [] }
}

const PUBLISHERS = { production: publishView, renaming: renamingPublisher }

// ---------------------------------------------------------------------------
// Child process entry: a publication that is killed at a named point
// ---------------------------------------------------------------------------

if (process.env.ATELIER_OBSIDIAN_RECOVERY_CHILD) {
  const job = JSON.parse(process.env.ATELIER_OBSIDIAN_RECOVERY_CHILD)
  const world = makeWorld(null, { root: job.root })
  const recoveryStore = job.layout === 'exchange-in-staging' ? exchangeInStaging(world.store) : world.store
  const seam = { at: job.crashAt, halt: () => process.kill(process.pid, 'SIGKILL') }
  const app = new ModelApp(world.vault)
  const opened = job.coordinated ? app.open(NOTE) : null
  // Two ways into the retirement of a staged candidate: the note was edited on disk before the run (the unit is
  // settled as a conflict first), or typing lands after the inspection (the refusal comes back from the critical
  // section while the unit's write-ahead entry is still pending).
  if (job.scenario === 'retire-settled') fs.writeFileSync(world.full(NOTE), EDITED)
  const plan = job.scenario === 'retire-pending' ? { after: (payload) => { if (payload.op === 'inspect' && payload.path === NOTE) opened.type('TYPED', 'brown') } } : {}
  const adapter = job.coordinated ? modelAdapter(app, { crashSeam: seam, plan }) : absentAdapter()
  const view = job.scenario === 'remove' ? viewOf('gen-0002', { notes: { [OTHER]: BASE } })
    : job.scenario === 'settings' ? viewOf('gen-0002', { notes: { [NOTE]: BASE, [OTHER]: BASE }, settings: true })
      : viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE, [OTHER]: BASE } })
  const result = await PUBLISHERS[job.publisher]({ preparedView: view, protocolId: PROTOCOL_ID, expectedGeneration: 'gen-0001', recoveryStore, adapter, clock, quietPeriodMs: 0, [CRASH_INJECTION_TEST_SEAM]: seam })
  process.stdout.write(JSON.stringify({ state: result.state }))
  process.exit(0)
}

function crashChild(job) {
  const env = { ...process.env, ATELIER_OBSIDIAN_RECOVERY_CHILD: JSON.stringify(job) }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 60000 })
}

// ---------------------------------------------------------------------------
// Store construction
// ---------------------------------------------------------------------------

test('a store refuses, before creating anything, a workspace root or vault that overlaps an enrolled repository', (t) => {
  const base = fs.mkdtempSync(path.join(TMP, 'atelier-store-guard-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const repo = path.join(base, 'projects', 'alpha-notes')
  fs.mkdirSync(repo, { recursive: true })
  const ids = { workspaceId: 'ws-synthetic-0005', scopeId: 'scope-synthetic' }
  const data = path.join(base, 'data')
  const refusal = (options, code) => assert.throws(() => createRecoveryStore({ ...ids, ...options }), (error) => error.name === 'PublicationRefusal' && error.code === code && error.detail.refusals.length > 0, code)

  assert.throws(() => createRecoveryStore({ ...ids, workspaceRoot: data }), TypeError, 'the enrolled repository roots are required')
  assert.throws(() => createRecoveryStore({ ...ids, workspaceRoot: data, repositoryRoots: ['relative/repo'] }), TypeError)
  refusal({ workspaceRoot: path.join(repo, 'atelier-output'), repositoryRoots: [repo] }, 'managed-root-inside-repository')
  refusal({ workspaceRoot: path.join(base, 'projects'), repositoryRoots: [repo] }, 'repository-inside-managed-root')
  refusal({ workspaceRoot: data, vaultRoot: path.join(repo, 'vault'), repositoryRoots: [repo] }, 'managed-root-inside-repository')
  refusal({ workspaceRoot: data, vaultRoot: base, repositoryRoots: [repo] }, 'repository-inside-managed-root')
  assert.deepEqual(fs.readdirSync(base), ['projects'], 'a refused store created nothing')
  assert.deepEqual(fs.readdirSync(repo), [])

  if (process.platform !== 'win32') {
    fs.symlinkSync(repo, path.join(base, 'innocent'), 'dir')
    refusal({ workspaceRoot: path.join(base, 'innocent', 'state'), repositoryRoots: [repo] }, 'managed-root-symlink-alias')
    assert.deepEqual(fs.readdirSync(repo), [])
  }

  const store = createRecoveryStore({ ...ids, workspaceRoot: data, repositoryRoots: [repo] })
  assert.equal(store.vaultRoot, path.join(fs.realpathSync(data), 'vaults', 'scope-synthetic'))
})

// ---------------------------------------------------------------------------
// Payload and script
// ---------------------------------------------------------------------------

const replacePayload = (overrides = {}) => ({ op: 'publish', mode: 'replace', vaultRoot: '/vault', path: 'notes/Example.md', operationId: 'journal-1:0', baseSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64),
  stagedPath: '/state/staged', recoveryPath: '/state/recovery', ...overrides })

test('bridge payload is closed: three operations, no test-only keys, no path the person owns', needsExchange, () => {
  assert.doesNotThrow(() => validatePayload(replacePayload()))
  assert.doesNotThrow(() => validatePayload({ op: 'inspect', vaultRoot: '/vault', path: POLICY }))
  const { candidateSha256, stagedPath, ...removal } = replacePayload({ mode: 'remove' })
  assert.doesNotThrow(() => validatePayload(removal))
  for (const bad of [
    replacePayload({ haltAt: 'after-exchange' }),
    replacePayload({ crashSeam: { at: 'after-exchange' } }),
    replacePayload({ exchange: 'link-rename' }),
    replacePayload({ editorRoute: 'app-save' }),
    replacePayload({ code: 'app.vault.delete()' }),
    replacePayload({ op: 'eval' }),
    replacePayload({ mode: 'overwrite' }),
    replacePayload({ path: '../outside.md' }),
    replacePayload({ path: '/absolute.md' }),
    replacePayload({ path: '.obsidian/workspace.json' }),
    replacePayload({ path: '.obsidian/plugins/x/main.js' }),
    replacePayload({ baseSha256: 'not-a-digest' }),
    replacePayload({ candidateSha256: 'a'.repeat(64) }),
    replacePayload({ stagedPath: 'relative/staged' }),
    replacePayload({ vaultRoot: 'relative' }),
    replacePayload({ operationId: '' }),
    { ...removal, stagedPath: '/state/staged' },
    { op: 'inspect', vaultRoot: '/vault', path: 'notes/Example.md', stagedPath: '/x' },
    { op: 'collect', vaultRoot: '/vault' },
  ]) assert.throws(() => validatePayload(bad), TypeError, JSON.stringify(bad))
})

test('note text never becomes code, the script body is constant, and the crash seam is not in it', needsExchange, () => {
  const hostile = "notes/');process.exit(1);('.md"
  const code = buildEvalCode({ op: 'inspect', vaultRoot: '/vault', path: hostile })
  assert.ok(!code.includes('process.exit(1)'))
  const encoded = /atob\('([A-Za-z0-9+/=]+)'\)/.exec(code)
  assert.deepEqual(JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')), { op: 'inspect', vaultRoot: '/vault', path: hostile })
  const fixed = (payload) => buildEvalCode(payload).replace(/atob\('[A-Za-z0-9+/=]+'\)/, 'atob()')
  assert.equal(fixed({ op: 'inspect', vaultRoot: '/vault', path: 'notes/A.md' }), fixed(replacePayload()))
  const hostLiteral = code.slice(code.lastIndexOf(',{app,'))
  assert.match(hostLiteral, /^,\{app,window,document,require,process,performance,exchange:\{.*\}\}\)$/s)
  assert.ok(!hostLiteral.includes('crashSeam'), 'the code sent to an app never carries the crash seam')
  assert.ok(!code.includes('python'), 'the exchange no longer depends on the system Python')
  assert.doesNotThrow(() => new Function(`return ${code.slice(0, code.lastIndexOf(')(JSON.parse')).slice(1)}`), 'the serialized script parses on its own')
})

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

test('atomic exchange swaps two files, fails without changing anything, and refuses where it is unavailable', needsExchange, (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-exchange-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const [first, second] = [path.join(dir, 'a'), path.join(dir, 'b')]
  fs.writeFileSync(first, 'A'); fs.writeFileSync(second, 'B')
  exchangeFiles(first, second)
  assert.deepEqual([fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8')], ['B', 'A'])
  assert.throws(() => exchangeFiles(first, path.join(dir, 'missing')), (error) => error.code === 'exchange-failed' && error.detail.exitStatus === 2)
  assert.equal(fs.readFileSync(first, 'utf8'), 'B')
  resetExchangeProbeCache()
  assert.equal(probeExchange({ directory: dir }).supported, true)
  assert.equal(probeExchange({ directory: dir, platform: 'win32' }).code, 'exchange-unsupported-platform')
  assert.equal(probeExchange({ directory: dir, platform: 'linux', arch: 'riscv64' }).code, 'exchange-unsupported-architecture')
  assert.equal(probeExchange({ directory: dir, perlPath: path.join(dir, 'no-perl') }).code, 'exchange-interpreter-missing')
  fs.writeFileSync(path.join(dir, 'false-perl'), '#!/bin/sh\nexit 45\n', { mode: 0o755 })
  const rootOwned = () => ({ uid: 0, mode: 0o100755 })
  assert.equal(probeExchange({ directory: dir, perlPath: path.join(dir, 'false-perl'), statSync: rootOwned }).code, 'exchange-unsupported-filesystem')
  // The same stand-in as it really is, owned by this user: refused before it is ever run.
  resetExchangeProbeCache()
  assert.equal(probeExchange({ directory: dir, perlPath: path.join(dir, 'false-perl') }).code, 'exchange-interpreter-untrusted')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a', 'b', 'false-perl'], 'the probe leaves no scratch files')
})

test('the exchange interpreter is used only when root owns it and neither group nor others can write it', needsExchange, async (t) => {
  const stats = { 'owned by a user': { uid: 501, mode: 0o100755 }, 'group-writable': { uid: 0, mode: 0o100775 }, 'world-writable': { uid: 0, mode: 0o100757 } }
  for (const [label, stat] of Object.entries(stats)) {
    assert.throws(() => resolveExchange({ statSync: () => stat }), (error) => error.code === 'exchange-interpreter-untrusted', label)
  }
  assert.throws(() => resolveExchange({ statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }), (error) => error.code === 'exchange-interpreter-untrusted')
  assert.doesNotThrow(() => resolveExchange({ statSync: () => ({ uid: 0, mode: 0o100755 }) }))
  assert.doesNotThrow(() => resolveExchange({}), 'the system perl on this host passes as it is')

  // The publisher refuses the whole publication and touches nothing.
  const world = await seeded(t)
  resetExchangeProbeCache()
  const before = snapshotTree(world)
  const refused = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter(), { exchangeOptions: { statSync: () => stats['group-writable'] } })
  assert.equal(refused.refusal.code, 'exchange-interpreter-untrusted')
  assert.deepEqual(snapshotTree(world), before)
  resetExchangeProbeCache()

  // The fixed script makes the same check where it runs, which may be inside the app.
  for (const [label, stat] of Object.entries(stats)) {
    const host = createInProcessHost()
    const realRequire = host.require
    const realFs = realRequire('fs')
    host.require = (name) => (name !== 'fs' ? realRequire(name) : new Proxy(realFs, { get: (target, key) => (key !== 'statSync' ? target[key] : (file, ...rest) => (/perl$/.test(file) ? stat : realFs.statSync(file, ...rest))) }))
    const staged = path.join(world.root, 'manual', `${stat.mode}-${stat.uid}.candidate`)
    fs.mkdirSync(path.dirname(staged), { recursive: true })
    fs.writeFileSync(staged, CANDIDATE)
    const reply = runInProcess({ op: 'publish', mode: 'replace', vaultRoot: world.vault, path: NOTE, operationId: 'manual:9', baseSha256: hex(BASE), candidateSha256: hex(CANDIDATE), stagedPath: staged, recoveryPath: path.join(world.root, 'recovery', 'untrusted.displaced') }, host)
    assert.deepEqual([reply.status, reply.wrote], ['exchange-interpreter-untrusted', false], label)
    assert.equal(world.read(NOTE), BASE)
    assert.equal(fs.readFileSync(staged, 'utf8'), CANDIDATE)
  }
  const code = buildEvalCode({ op: 'inspect', vaultRoot: '/vault', path: NOTE })
  assert.ok(code.includes('exchange-interpreter-untrusted'), 'the check travels in the code sent to an app')
})

test('an unsupported platform refuses the whole publication and touches nothing', needsExchange, async (t) => {
  const world = await seeded(t)
  resetExchangeProbeCache()
  const before = snapshotTree(world)
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter(), { exchangeOptions: { platform: 'win32' } })
  assert.equal(result.state, 'refused')
  assert.equal(result.refusal.code, 'exchange-unsupported-platform')
  assert.deepEqual(snapshotTree(world), before)
  resetExchangeProbeCache()
})

test('where this platform has no atomic exchange, the publisher refuses natively and touches nothing', { skip: EXCHANGE_HERE && 'this platform has an exchange; the injected-platform case above covers the refusal' }, async (t) => {
  const world = makeWorld(t)
  fs.mkdirSync(path.dirname(world.full(NOTE)), { recursive: true })
  fs.writeFileSync(world.full(NOTE), BASE)
  const before = snapshotTree(world)
  const result = await world.publish(viewOf('gen-0001', { notes: { [NOTE]: CANDIDATE } }), absentAdapter())
  assert.equal(result.state, 'refused')
  assert.match(result.refusal.code, /^exchange-unsupported-/)
  assert.equal(world.read(NOTE), BASE)
  assert.deepEqual(snapshotTree(world), before)
})

// ---------------------------------------------------------------------------
// G00 interleavings against the production publisher
// ---------------------------------------------------------------------------

test('I00 clean open note publishes; the editor shows the candidate through one transaction and is recorded as saved', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const view = app.open(NOTE)
  const adapter = modelAdapter(app)
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(result.state, 'committed', JSON.stringify(result))
  assert.equal(result.mode, 'in-app')
  assert.equal(noteResult(result).outcome, 'published')
  assert.equal(world.read(NOTE), CANDIDATE)
  assert.equal(view.data, CANDIDATE)
  assert.equal(view.lastSavedData, CANDIDATE)
  assert.deepEqual([view.transactions, view.setValues], [1, 0], 'minimal hunks in one transaction, no whole-buffer replacement')
  assert.equal(fs.readFileSync(world.store.resolve(noteResult(result).recoveryRef), 'utf8'), BASE, 'the displaced base is the recovery file')
  assert.equal(world.store.readObject(digest(BASE)).toString('utf8'), BASE, 'the comparison baseline is retained immutably')
  assert.equal(world.store.readCurrent().generationId, 'gen-0002')
  assert.equal(adapter.count('publish'), 1)
  const [, journal] = assertJournalsValid(world)
  assert.equal(journal.state, 'committed')
  assert.deepEqual(journal.entries.map((entry) => entry.step), ['capture', 'conditional-update', 'verify', 'verify', 'manifest-commit'])
  assert.deepEqual(fs.readdirSync(path.join(world.root, 'staging')), [], 'staging is empty after a committed publication')
})

test('I01/I02 an edit saved before capture, or between capture and the conditional update, refuses without writing', needsExchange, async (t) => {
  for (const when of ['before-capture', 'between-capture-and-update']) {
    const world = await seeded(t)
    const app = new ModelApp(world.vault)
    const view = app.open(NOTE)
    const saveEdit = () => { view.type('SAVEDEDIT', 'brown'); view.save() }
    if (when === 'before-capture') saveEdit()
    const adapter = modelAdapter(app, { plan: { after: (payload) => { if (when !== 'before-capture' && payload.op === 'inspect' && payload.path === NOTE) saveEdit() } } })
    const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
    assert.equal(result.state, 'updating', when)
    // Between capture and update the critical section sees both the changed file and the changed buffer; it names the first it checks.
    assert.ok((when === 'before-capture' ? ['disk-changed'] : ['disk-changed', 'editor-edit']).includes(noteResult(result).outcome), `${when}: ${noteResult(result).outcome}`)
    assert.ok(world.read(NOTE).includes('SAVEDEDIT') && view.data.includes('SAVEDEDIT'), when)
    assert.equal(world.store.readCurrent().generationId, 'gen-0001', 'the trusted manifest is not committed')
    assert.equal(adapter.count('publish'), when === 'before-capture' ? 0 : 1)
    assert.ok(keptTexts(world).some((text) => text.includes('SAVEDEDIT')), 'an observed edit is also preserved in recovery')
    assertJournalsValid(world)
  }
})

test('I03 an unsaved buffer refuses; the delayed save then keeps the edit; a later run still does not overwrite it', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const view = app.open(NOTE)
  view.type('UNSAVED', 'brown')
  const adapter = modelAdapter(app)
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(noteResult(result).outcome, 'editor-edit')
  assert.equal(result.state, 'updating')
  assert.equal(world.read(NOTE), BASE, 'nothing written at refusal')
  app.flushSaves()
  assert.ok(world.read(NOTE).includes('UNSAVED'))
  const again = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(noteResult(again).outcome, 'disk-changed')
  assert.ok(world.read(NOTE).includes('UNSAVED') && view.data.includes('UNSAVED'))
})

test('I04 typing racing the critical section never loses the typed text (25 rounds at every await point)', needsExchange, async (t) => {
  const tally = {}
  for (let round = 0; round < 25; round += 1) {
    const world = await seeded(null)
    try {
      const app = new ModelApp(world.vault)
      const view = app.open(NOTE)
      const typed = `RACE${round}X`
      const slot = round % 5
      let typedAt = null
      const typeOnce = (where) => { if (typedAt === null) { view.type(typed, 'quick'); typedAt = where } }
      const adapter = modelAdapter(app, { plan: {
        before: (payload) => { if ((slot === 0 && payload.op === 'inspect' && payload.path === NOTE) || (slot === 2 && payload.op === 'publish')) typeOnce(`before-${payload.op}`) },
        after: (payload) => { if ((slot === 1 && payload.op === 'inspect' && payload.path === NOTE) || (slot === 3 && payload.op === 'publish')) typeOnce(`after-${payload.op}`) },
      } })
      const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
      if (slot === 4) typeOnce('after-publication')
      app.flushSaves()
      const outcome = noteResult(result).outcome
      tally[outcome] = (tally[outcome] ?? 0) + 1
      assert.ok(view.data.includes(typed), `round ${round}: typed text left the buffer (${typedAt}, ${outcome})`)
      assert.ok(world.read(NOTE).includes(typed), `round ${round}: typed text never reached disk (${typedAt}, ${outcome})`)
      if (slot <= 2) assert.equal(outcome, 'editor-edit', `round ${round}: a dirty buffer at critical-section time must refuse`)
      else assert.equal(outcome, 'published', `round ${round}`)
      if (slot >= 3) assert.ok(world.read(NOTE).includes('GENERATED'), 'text typed after publication lands on top of the candidate')
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true })
    }
  }
  t.diagnostic(`I04 outcomes: ${JSON.stringify(tally)}`)
})

test('I05 a second window: clean windows both receive the candidate; an unsaved edit in the other window refuses', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const main = app.open(NOTE)
  const popout = app.open(NOTE, { popout: true })
  const adapter = modelAdapter(app)
  const clean = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(noteResult(clean).outcome, 'published')
  assert.equal(noteResult(clean).openViews, 2)
  assert.deepEqual([main.data, popout.data, main.lastSavedData, popout.lastSavedData], [CANDIDATE, CANDIDATE, CANDIDATE, CANDIDATE])
  app.flushSaves()
  popout.type('POPOUTEDIT', 'GENERATED')
  const next = `${CANDIDATE}Second generation.\n`
  const dirty = await world.publish(viewOf('gen-0003', { notes: { [NOTE]: next } }), adapter)
  assert.equal(noteResult(dirty).outcome, 'editor-edit')
  assert.equal(world.read(NOTE), CANDIDATE)
  app.flushSaves()
  assert.ok(world.read(NOTE).includes('POPOUTEDIT'))
})

async function outsideWriterBetweenCaptureAndUpdate(t, publisher) {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const external = `${BASE}EXTERNAL WRITER\n`
  const adapter = modelAdapter(app, { plan: { after: (payload) => {
    if (payload.op !== 'inspect' || payload.path !== NOTE) return
    fs.writeFileSync(`${world.full(NOTE)}.ext~`, external)
    fs.renameSync(`${world.full(NOTE)}.ext~`, world.full(NOTE))
  } } })
  await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter, { publisher })
  return { safe: keptSomewhere(world, external), world }
}

test('I06 an outside atomic-rename writer landing between capture and update is never lost', needsExchange, async (t) => {
  const { safe, world } = await outsideWriterBetweenCaptureAndUpdate(t, publishView)
  assert.ok(safe)
  assert.ok(world.read(NOTE).includes('EXTERNAL WRITER'), 'the production publisher refuses and the outside bytes stay in the note')
})

test('I06 an outside writer replacing the note at the instant of the exchange is captured in recovery', needsExchange, async (t) => {
  const world = await seeded(t)
  const external = `${BASE}EXTERNAL AT EXCHANGE\n`
  const staged = path.join(world.root, 'manual', 'manual.candidate')
  fs.mkdirSync(path.dirname(staged))
  fs.writeFileSync(staged, CANDIDATE)
  const recoveryPath = path.join(world.root, 'recovery', 'manual.displaced')
  const host = createInProcessHost()
  const realRequire = host.require
  // The replacement lands after every check of the critical section and immediately before the exchange call.
  host.require = (name) => (name !== 'child_process' ? realRequire(name) : { execFileSync: (...args) => {
    fs.writeFileSync(`${world.full(NOTE)}.ext~`, external); fs.renameSync(`${world.full(NOTE)}.ext~`, world.full(NOTE))
    return realRequire('child_process').execFileSync(...args)
  } })
  const reply = runInProcess({ op: 'publish', mode: 'replace', vaultRoot: world.vault, path: NOTE, operationId: 'manual:0', baseSha256: hex(BASE), candidateSha256: hex(CANDIDATE), stagedPath: staged, recoveryPath }, host)
  assert.equal(reply.status, 'published-external-captured')
  assert.equal(world.read(NOTE), CANDIDATE)
  assert.equal(fs.readFileSync(recoveryPath, 'utf8'), external, 'whatever occupied the path at the exchange is the recovery file')
})

test('I06 a real outside process doing atomic renames while the publisher runs never loses its bytes (25 rounds)', needsExchange, async (t) => {
  const tally = {}
  for (let round = 0; round < 25; round += 1) {
    const world = await seeded(null)
    try {
      const app = new ModelApp(world.vault)
      if (round % 2 === 0) app.open(NOTE)
      const external = `${BASE}EXTERNAL${round}\n`
      // The writer is started first and released together with the publication, so its rename lands before the
      // capture, between capture and exchange, or after publication, depending on the round.
      const delay = (round * 37) % 300
      const writer = spawn(process.execPath, ['-e', `const fs=require('fs');process.stdin.once('data',()=>setTimeout(()=>{fs.writeFileSync(process.argv[1]+'.ext~',process.argv[2]);fs.renameSync(process.argv[1]+'.ext~',process.argv[1]);process.exit(0)},${delay}));console.log('ready')`, world.full(NOTE), external], { stdio: ['pipe', 'pipe', 'ignore'] })
      await new Promise((resolve) => writer.stdout.once('data', resolve))
      const exited = new Promise((resolve) => writer.on('exit', resolve))
      writer.stdin.write('go\n')
      const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), modelAdapter(app))
      await exited
      const outcome = noteResult(result).changedAfterPublication ? 'published-then-replaced' : noteResult(result).outcome
      tally[outcome] = (tally[outcome] ?? 0) + 1
      assert.ok(keptSomewhere(world, external), `round ${round}: outside bytes lost (${outcome})`)
      assert.ok([BASE, CANDIDATE, external].includes(world.read(NOTE)), `round ${round}: the note is not one coherent version`)
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true })
    }
  }
  t.diagnostic(`I06 outcomes: ${JSON.stringify(tally)}`)
})

test('I06a the app never writes the note as a result of publication; a following outside write survives the delayed save', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const view = app.open(NOTE)
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), modelAdapter(app))
  assert.equal(noteResult(result).outcome, 'published')
  const published = stamp(world.full(NOTE))
  assert.deepEqual(app.flushSaves(), [false], 'the delayed save finds nothing to write')
  assert.equal(stamp(world.full(NOTE)), published)
  assert.equal(view.diskWrites, 0)
  const external = `${CANDIDATE}OUTSIDE WRITER\n`
  fs.writeFileSync(`${world.full(NOTE)}.ext~`, external); fs.renameSync(`${world.full(NOTE)}.ext~`, world.full(NOTE))
  app.flushSaves()
  assert.equal(world.read(NOTE), external)
})

test('I07 a note removed before publication is recreated only by exclusive create; a note that vanishes before the update refuses and creates nothing', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const adapter = modelAdapter(app, { plan: { after: (payload) => { if (payload.op === 'inspect' && payload.path === NOTE) fs.rmSync(world.full(NOTE)) } } })
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(noteResult(result).outcome, 'note-missing')
  assert.equal(result.state, 'updating')
  assert.equal(world.read(NOTE), null, 'nothing created by a refused update')
  const again = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), modelAdapter(app))
  assert.equal(noteResult(again).outcome, 'created')
  assert.equal(again.state, 'committed')
  assert.equal(world.read(NOTE), CANDIDATE)
})

// I08, I09 and every other interrupted state: a real process is killed at the named point.
// `atCandidatePath` is what the journal must say the file at the unit's exchange candidate path is at that instant:
// absent, a generated candidate (ours, deletable), or displaced bytes (a person's, never deletable).
const CRASH_POINTS = [
  { crashAt: 'before-candidate-move', coordinated: true, disk: BASE, atCandidatePath: 'absent' },
  { crashAt: 'after-staging', coordinated: true, disk: BASE, atCandidatePath: 'generated-candidate' },
  { crashAt: 'after-capture', coordinated: true, disk: BASE, atCandidatePath: 'generated-candidate' },
  { crashAt: 'after-exchange', coordinated: true, disk: CANDIDATE, label: 'I08', atCandidatePath: 'displaced-bytes' },
  { crashAt: 'after-exchange', coordinated: false, disk: CANDIDATE, label: 'I08 without an app', atCandidatePath: 'displaced-bytes' },
  { crashAt: 'after-recovery-move', coordinated: true, disk: CANDIDATE, atCandidatePath: 'absent' },
  { crashAt: 'after-editor-update', coordinated: true, disk: CANDIDATE, label: 'I09', atCandidatePath: 'absent' },
  { crashAt: 'after-publish', coordinated: true, disk: CANDIDATE, label: 'I09', atCandidatePath: 'absent' },
  { crashAt: 'before-manifest-commit', coordinated: true, disk: CANDIDATE, atCandidatePath: 'absent' },
  { crashAt: 'after-manifest-pointer', coordinated: true, disk: CANDIDATE, atCandidatePath: 'absent' },
]

// The journal's verdict on the file at a note's exchange candidate path, and the text there.
function candidatePathVerdict(world, notePath) {
  for (const journal of listJournals(world.store).reverse()) {
    const named = namedCandidates(journal.document()).find((item) => item.path === notePath && item.stagedRef.startsWith('recovery/'))
    if (!named) continue
    const file = world.store.resolve(named.stagedRef)
    const verdict = classifyCandidateFile({ file, candidateDigest: named.candidateDigest })
    return { journalId: journal.document().journalId, file, verdict, text: verdict === 'absent' ? null : fs.readFileSync(file, 'utf8') }
  }
  return { verdict: 'unnamed' }
}

async function crashCase(t, publisher, point) {
  const world = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  const child = crashChild({ root: world.root, publisher, scenario: 'replace', ...point })
  assert.equal(child.signal, 'SIGKILL', `the child must die at ${point.crashAt}: ${child.stdout} ${child.stderr}`)
  const afterCrash = world.read(NOTE)
  // The base is a person's bytes: the note or recovery. The candidate is generated: the note, staging while it is
  // only being prepared, or the unit's exchange candidate path.
  const waiting = exchangeCandidateFiles(world).map((file) => fs.readFileSync(file, 'utf8'))
  return { world, afterCrash, keptBase: [afterCrash, ...keptTexts(world)].includes(BASE), keptCandidate: [afterCrash, ...stagedTexts(world), ...waiting].includes(CANDIDATE) }
}

for (const point of CRASH_POINTS) {
  test(`${point.label ?? 'interrupted'}: killed ${point.crashAt}${point.coordinated ? '' : ' (direct path)'}: coherent note, base and candidate both kept, idempotent recovery, convergence`, needsExchange, async (t) => {
    const { world, afterCrash, keptBase, keptCandidate } = await crashCase(t, 'production', point)
    assert.equal(afterCrash, point.disk, 'the note is one coherent version')
    assert.ok(keptBase, 'base bytes kept')
    assert.ok(keptCandidate, 'the candidate is at the note path, in staging, or at its exchange candidate path')
    // The staging invariant, at the instant of the crash, and the journal's verdict on the candidate path.
    assertStagingNeverHoldsDisplacedBytes(world.store, { persons: [BASE] })
    const at = candidatePathVerdict(world, NOTE)
    assert.equal(at.verdict, point.atCandidatePath, 'the journal tells a generated candidate from displaced bytes')
    if (at.verdict === 'generated-candidate') assert.equal(at.text, CANDIDATE)
    if (at.verdict === 'displaced-bytes') assert.equal(at.text, BASE, 'the displaced bytes are in the unit recovery directory, not in staging')
    if (point.crashAt === 'before-candidate-move') assert.ok(stagedTexts(world).includes(CANDIDATE), 'a candidate still being prepared is generated bytes in staging')

    const first = recoverPublications({ store: world.store, clock })
    assert.equal(world.read(NOTE), point.disk, 'recovery does not change the note')
    assert.ok([world.read(NOTE), ...keptTexts(world)].includes(BASE), 'base bytes kept through recovery')
    assert.deepEqual(exchangeCandidateFiles(world), [], 'recovery leaves nothing at an exchange candidate path')
    assertStagingNeverHoldsDisplacedBytes(world.store, { persons: [BASE] })
    const interruptedId = listJournals(world.store)[1].document().journalId
    if (point.disk === BASE) {
      // A generated candidate is never mistaken for a person's content: it is deleted, not kept, and gets no receipt.
      assert.ok(!keptTexts(world).includes(CANDIDATE))
      assert.deepEqual(world.store.listReceipts(interruptedId), [])
    } else {
      // Displaced bytes are never deleted as a candidate: they are in recovery with a receipt.
      const receipt = world.store.listReceipts(interruptedId).find((item) => item.role === 'displaced' && item.notePath === NOTE)
      assert.equal(receipt?.digestAtMove, digest(BASE))
      assert.equal(fs.readFileSync(world.store.resolve(receipt.displacedRef), 'utf8'), BASE)
    }
    const tree = snapshotTree(world)
    const second = recoverPublications({ store: world.store, clock })
    assert.deepEqual(second.journals, [], 'a second recovery finds nothing to do')
    assert.deepEqual(snapshotTree(world), tree, 'a second recovery changes nothing')
    if (['before-manifest-commit', 'after-manifest-pointer'].includes(point.crashAt)) {
      assert.equal(first.journals.at(-1).committed, true)
      assert.equal(world.store.readCurrent().generationId, 'gen-0002')
    } else {
      assert.equal(world.store.readCurrent().generationId, 'gen-0001', 'an interrupted publication is not current')
    }

    const app = new ModelApp(world.vault)
    const view = app.open(NOTE)
    const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE, [OTHER]: BASE } }), modelAdapter(app))
    assert.equal(result.state, 'committed', JSON.stringify(result))
    assert.equal(world.read(NOTE), CANDIDATE)
    assert.equal(view.data, CANDIDATE)
    assert.equal(world.store.readCurrent().generationId, 'gen-0002')
    assert.ok(keptTexts(world).includes(BASE), 'the displaced base is still in recovery after convergence')
    const documents = assertJournalsValid(world)
    const interrupted = documents[1]
    assert.ok(interrupted.restart.count >= 1 || interrupted.state === 'committed', 'the interrupted journal records its restart')
    assert.deepEqual(filesUnder(path.join(world.root, 'staging')), [], 'no staged file outlives recovery and convergence')
  })
}

// A host whose exchange helper really exchanges and is then reported as killed by a signal.
function killedAfterExchangeHost(options = {}) {
  const host = createInProcessHost(options)
  const realRequire = host.require
  host.require = (name) => (name !== 'child_process' ? realRequire(name) : { execFileSync: (...args) => {
    realRequire('child_process').execFileSync(...args)
    throw Object.assign(new Error('the helper was killed after the call returned'), { status: null, signal: 'SIGKILL' })
  } })
  return host
}

test('an exchange helper killed after the exchange took place is reported as the publication it was', needsExchange, async (t) => {
  const world = await seeded(t)
  const staged = path.join(world.root, 'manual', 'killed.candidate')
  fs.mkdirSync(path.dirname(staged))
  fs.writeFileSync(staged, CANDIDATE)
  const recoveryPath = path.join(world.root, 'recovery', 'killed.displaced')
  const reply = runInProcess({ op: 'publish', mode: 'replace', vaultRoot: world.vault, path: NOTE, operationId: 'manual:2', baseSha256: hex(BASE), candidateSha256: hex(CANDIDATE), stagedPath: staged, recoveryPath }, killedAfterExchangeHost())
  assert.equal(reply.status, 'published', 'the files say the exchange happened; the exit status does not decide')
  assert.equal(reply.wrote, true)
  assert.equal(world.read(NOTE), CANDIDATE)
  assert.equal(fs.readFileSync(recoveryPath, 'utf8'), BASE)
  assert.equal(fs.existsSync(staged), false)

  // A helper that fails without exchanging is still a failure that changed nothing.
  const failing = createInProcessHost()
  const realRequire = failing.require
  failing.require = (name) => (name !== 'child_process' ? realRequire(name) : { execFileSync: () => { throw Object.assign(new Error('no space'), { status: 28 }) } })
  fs.writeFileSync(staged, `${CANDIDATE}next\n`)
  const failed = runInProcess({ op: 'publish', mode: 'replace', vaultRoot: world.vault, path: NOTE, operationId: 'manual:3', baseSha256: hex(CANDIDATE), candidateSha256: hex(`${CANDIDATE}next\n`), stagedPath: staged, recoveryPath: `${recoveryPath}.2` }, failing)
  assert.deepEqual([failed.status, failed.wrote, failed.exitStatus], ['exchange-failed', false, 28])
  assert.equal(world.read(NOTE), CANDIDATE)

  // Through the publisher: the outside writer's bytes displaced by that exchange are in recovery, and the view commits.
  const racing = await seeded(t)
  const external = `${BASE}EXTERNAL AT A KILLED EXCHANGE\n`
  const host = killedAfterExchangeHost()
  const swapThenDie = host.require('child_process').execFileSync
  const hostRequire = host.require
  host.require = (name) => (name !== 'child_process' ? hostRequire(name) : { execFileSync: (...args) => {
    fs.writeFileSync(`${racing.full(NOTE)}.ext~`, external); fs.renameSync(`${racing.full(NOTE)}.ext~`, racing.full(NOTE))
    return swapThenDie(...args)
  } })
  const adapter = createEditorAdapter({ call: createInProcessCall(host), processProbe: () => 'running', kind: 'model' })
  const result = await racing.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(noteResult(result).outcome, 'published-external-captured', JSON.stringify(result))
  assert.equal(result.state, 'committed')
  assert.equal(racing.read(NOTE), CANDIDATE)
  assert.equal(fs.readFileSync(racing.store.resolve(noteResult(result).recoveryRef), 'utf8'), external)
  assert.deepEqual(filesUnder(path.join(racing.root, 'staging')), [])
})

const recoveryTexts = (world) => filesUnder(path.join(world.root, 'recovery')).map((file) => fs.readFileSync(file, 'utf8'))
const retiringFiles = (world) => filesUnder(path.join(world.root, 'recovery')).filter((file) => path.basename(file) === 'retiring.bin')

for (const scenario of ['retire-settled', 'retire-pending']) {
  test(`killed between the two moves of a staged file's retirement (${scenario}): the file is in recovery, never in staging, and restart finishes the judgement`, needsExchange, async (t) => {
    // Our own candidate at the retiring name is deleted.
    const own = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
    const child = crashChild({ root: own.root, publisher: 'production', scenario, crashAt: 'after-retire-move', coordinated: true })
    assert.equal(child.signal, 'SIGKILL', `${child.stdout} ${child.stderr}`)
    assert.deepEqual(filesUnder(path.join(own.root, 'staging')), [], 'the file being retired has left staging')
    assert.equal(retiringFiles(own).length, 1)
    assert.equal(fs.readFileSync(retiringFiles(own)[0], 'utf8'), CANDIDATE)
    const report = recoverPublications({ store: own.store, clock })
    assert.deepEqual(retiringFiles(own), [])
    assert.ok(!recoveryTexts(own).includes(CANDIDATE), 'a candidate is generated bytes and is not kept')
    assert.equal(report.journals.length, 1)
    const tree = snapshotTree(own)
    assert.deepEqual(recoverPublications({ store: own.store, clock }).journals, [])
    assert.deepEqual(snapshotTree(own), tree)

    // Bytes that are not the candidate (what an exchange displaced) are kept and surfaced.
    const foreign = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
    assert.equal(crashChild({ root: foreign.root, publisher: 'production', scenario, crashAt: 'after-retire-move', coordinated: true }).signal, 'SIGKILL')
    const displacedBytes = `${BASE}DISPLACED BY AN EXCHANGE NOBODY REPORTED\n`
    fs.writeFileSync(retiringFiles(foreign)[0], displacedBytes)
    if (scenario === 'retire-pending') fs.writeFileSync(foreign.full(NOTE), CANDIDATE) // the exchange that displaced them put the candidate at the note path
    const kept = recoverPublications({ store: foreign.store, clock })
    assert.deepEqual(retiringFiles(foreign), [])
    assert.ok(recoveryTexts(foreign).includes(displacedBytes), 'the displaced bytes are still in recovery, under a name of their own')
    const [journalId] = kept.journals.map((item) => item.journalId)
    const receipt = foreign.store.listReceipts(journalId).find((item) => item.role === 'displaced' && item.digestAtMove === digest(displacedBytes))
    assert.equal(receipt?.externalCaptured, true, 'and a receipt surfaces them as an outside writer\'s bytes')
    assert.equal(kept.journals[0].actions.at(-1).code, scenario === 'retire-pending' ? 'completed-after-exchange' : 'unexpected-bytes-at-staged-path-kept')
    const again = snapshotTree(foreign)
    assert.deepEqual(recoverPublications({ store: foreign.store, clock }).journals, [])
    assert.deepEqual(snapshotTree(foreign), again)
  })
}

// The late-candidate path: the policy file's candidate is merged from the bytes on disk, so the header cannot name
// it. It is exchanged, so it goes to the unit recovery directory, after a write-ahead entry that names it.
const LATE_POINTS = [
  { crashAt: 'after-late-write-ahead', published: false, atCandidatePath: 'absent' },
  { crashAt: 'after-capture', published: false, atCandidatePath: 'generated-candidate' },
  { crashAt: 'after-exchange', published: true, atCandidatePath: 'displaced-bytes' },
  { crashAt: 'after-recovery-move', published: true, atCandidatePath: 'absent' },
]

for (const point of LATE_POINTS) {
  test(`late candidate: killed ${point.crashAt}: the person's settings are never in staging, the journal tells the candidate from displaced bytes, recovery settles it`, needsExchange, async (t) => {
    const world = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
    const mine = `${JSON.stringify({ sync: true, 'invented-plugin': true })}\n`
    fs.mkdirSync(world.full('.obsidian'))
    fs.writeFileSync(world.full(POLICY), mine)
    const child = crashChild({ root: world.root, publisher: 'production', scenario: 'settings', crashAt: point.crashAt, coordinated: false })
    assert.equal(child.signal, 'SIGKILL', `the child must die at ${point.crashAt}: ${child.stdout} ${child.stderr}`)

    assertStagingNeverHoldsDisplacedBytes(world.store, { persons: [mine] })
    assert.ok(!stagedTexts(world).includes(mine))
    assert.ok([world.read(POLICY), ...keptTexts(world)].includes(mine), 'the person\'s settings are at the vault path or in recovery')
    const at = candidatePathVerdict(world, POLICY)
    assert.equal(at.verdict, point.atCandidatePath)
    assert.equal(path.basename(at.file), LATE_EXCHANGE_CANDIDATE_NAME)
    if (at.verdict === 'displaced-bytes') assert.equal(at.text, mine)
    if (at.verdict === 'generated-candidate') assert.notEqual(at.text, mine)
    if (point.crashAt === 'after-late-write-ahead') assert.equal(filesUnder(path.join(world.root, 'staging')).length, 1, 'named by the journal, still generated bytes in staging')

    const generated = point.published ? world.read(POLICY) : (at.text ?? stagedTexts(world)[0])
    recoverPublications({ store: world.store, clock })
    assert.deepEqual(exchangeCandidateFiles(world), [])
    assert.deepEqual(filesUnder(path.join(world.root, 'staging')), [])
    assert.ok([world.read(POLICY), ...keptTexts(world)].includes(mine))
    const receipts = world.store.listReceipts(at.journalId)
    if (point.published) assert.equal(receipts.find((item) => item.role === 'displaced' && item.notePath === POLICY)?.digestAtMove, digest(mine))
    else {
      assert.equal(world.read(POLICY), mine, 'nothing was exchanged')
      assert.deepEqual(receipts, [], 'a generated candidate gets no receipt')
      assert.ok(!keptTexts(world).includes(generated), 'and is not kept as if it were somebody\'s')
    }
    const tree = snapshotTree(world)
    assert.deepEqual(recoverPublications({ store: world.store, clock }).journals, [])
    assert.deepEqual(snapshotTree(world), tree)

    const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: BASE, [OTHER]: BASE }, settings: true }), absentAdapter())
    assert.equal(result.state, 'committed', JSON.stringify(result))
    assert.deepEqual(JSON.parse(world.read(POLICY)), { sync: false, 'invented-plugin': true, publish: false })
    assert.ok(keptTexts(world).includes(mine), 'the displaced settings are in recovery after convergence')
    assert.deepEqual(exchangeCandidateFiles(world), [])
    assert.deepEqual(filesUnder(path.join(world.root, 'staging')), [])
  })
}

test('mutation control: a layout that stages an exchange candidate under staging again fails the staging oracle', needsExchange, async (t) => {
  // After a run that returned: the journal names a replacement's candidate path in staging.
  const world = await seeded(t)
  const broken = exchangeInStaging(world.store)
  const result = await publishView({ preparedView: viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), protocolId: PROTOCOL_ID, expectedGeneration: 'gen-0001', recoveryStore: broken, adapter: absentAdapter(), clock, quietPeriodMs: 0 })
  assert.equal(result.state, 'committed', 'the broken layout still publishes, so only the oracle can catch it')
  assert.throws(() => assertStagingNeverHoldsDisplacedBytes(world.store), /outside its unit recovery directory/)

  // At the crash point between exchange and recovery move: the person's bytes really are in staging.
  const crashed = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  const child = crashChild({ root: crashed.root, publisher: 'production', scenario: 'replace', crashAt: 'after-exchange', coordinated: false, layout: 'exchange-in-staging' })
  assert.equal(child.signal, 'SIGKILL', `${child.stdout} ${child.stderr}`)
  assert.ok(stagedTexts(crashed).includes(BASE), 'the control must put displaced bytes in staging, or the oracle proves nothing')
  assert.throws(() => assertStagingNeverHoldsDisplacedBytes(crashed.store, { persons: [BASE] }))
  // The "now" half alone also fails: with the journal's word ignored, staging holds bytes that are no candidate.
  const physical = filesUnder(crashed.store.stagingRoot).map((file) => digest(fs.readFileSync(file)))
  assert.ok(physical.includes(digest(BASE)) && !physical.includes(digest(CANDIDATE)))

  // The production layout at the same point passes, with the same bytes in the unit recovery directory.
  const sound = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  assert.equal(crashChild({ root: sound.root, publisher: 'production', scenario: 'replace', crashAt: 'after-exchange', coordinated: false }).signal, 'SIGKILL')
  assert.ok(!stagedTexts(sound).includes(BASE))
  assert.doesNotThrow(() => assertStagingNeverHoldsDisplacedBytes(sound.store, { persons: [BASE] }))
})

test('every orphaned late candidate is swept on restart, also beside one that a capture entry names', needsExchange, async (t) => {
  const world = makeWorld(t)
  fs.mkdirSync(world.full('.obsidian'))
  fs.writeFileSync(world.full(POLICY), JSON.stringify({ sync: true }))
  fs.mkdirSync(path.dirname(world.full(OTHER)), { recursive: true })
  fs.writeFileSync(world.full(OTHER), 'mine\n')
  // The policy file is published from a late candidate that its capture entry names; the other note conflicts, so the journal stays open.
  const result = await world.publish(viewOf('gen-0001', { notes: { [OTHER]: BASE }, settings: true }), absentAdapter())
  assert.equal(result.state, 'updating', JSON.stringify(result))
  assert.equal(noteResult(result, POLICY).outcome, 'published')
  const [document] = assertJournalsValid(world)
  assert.ok(document.entries.some((entry) => entry.ext?.['mnstry.atelier.obsidian']?.stagedRef?.endsWith('.late.candidate')), 'a capture entry names a late candidate')
  const stagingDir = world.store.stagingDir(document.journalId)
  const orphans = [path.join(stagingDir, '000007.late.candidate'), path.join(stagingDir, '000008.late.candidate')]
  for (const orphan of orphans) fs.writeFileSync(orphan, 'generated bytes nobody named\n')
  const report = recoverPublications({ store: world.store, clock })
  assert.equal(report.journals.length, 1)
  assert.deepEqual(filesUnder(path.join(world.root, 'staging')), [], 'both orphans are gone')
  assert.deepEqual(recoverPublications({ store: world.store, clock }).journals, [])
})

test('interrupted conditional removal: killed after the move, the bytes are in recovery and recovery settles it', needsExchange, async (t) => {
  const world = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  const child = crashChild({ root: world.root, publisher: 'production', scenario: 'remove', crashAt: 'after-removal-move', coordinated: true })
  assert.equal(child.signal, 'SIGKILL')
  assert.equal(world.read(NOTE), null)
  assert.ok(keptTexts(world).includes(BASE))
  const report = recoverPublications({ store: world.store, clock })
  assert.equal(report.journals[0].actions[0].code, 'completed-after-removal')
  const result = await world.publish(viewOf('gen-0002', { notes: { [OTHER]: BASE } }), absentAdapter())
  assert.equal(result.state, 'committed')
  assert.ok(keptTexts(world).includes(BASE))
})

test('I10 the app going away mid-publication leaves a coherent note and a retryable state', needsExchange, async (t) => {
  for (const when of ['dropBefore', 'dropAfter']) {
    const world = await seeded(t)
    const app = new ModelApp(world.vault)
    app.open(NOTE)
    let gone = false
    const adapter = modelAdapter(app, { plan: {
      [when]: (payload) => { if (payload.op === 'publish') gone = true; return payload.op === 'publish' },
      before: (payload) => { if (gone && payload.op === 'collect') throw new Error('the app is gone') },
    } })
    const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
    assert.equal(adapter.count('publish'), 1, 'a publish is never sent twice')
    if (when === 'dropBefore') {
      assert.equal(world.read(NOTE), BASE)
      assert.equal(result.state, 'updating')
      assert.equal(noteResult(result).outcome, 'outcome-unknown-nothing-published')
    } else {
      assert.equal(world.read(NOTE), CANDIDATE)
      assert.equal(noteResult(result).outcome, 'completed-after-recovery-move', 'the files say the publication happened')
      assert.equal(result.state, 'committed')
    }
    assert.ok(keptSomewhere(world, BASE))
    const retry = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter())
    assert.equal(retry.state, 'committed')
    assert.equal(world.read(NOTE), CANDIDATE)
    assertJournalsValid(world)
  }
})

test('a lost publish reply is re-read from the app and the publish is never resent', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  app.open(NOTE)
  const adapter = modelAdapter(app, { plan: { loseReply: (payload, index) => (payload.op === 'publish' && index === 0) || (payload.op === 'collect' && index === 0) } })
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(result.state, 'committed')
  assert.equal(noteResult(result).outcome, 'published')
  assert.equal(noteResult(result).replyLost, true)
  assert.equal(adapter.count('publish'), 1, 'exactly one publish reached the app')
  assert.equal(adapter.count('collect'), 2, 'the read-only collect was retried')
  assert.deepEqual(adapter.transportRetries, ['publish-reply-lost', 'collect'])
  assert.equal(world.read(NOTE), CANDIDATE)

  // A refusal whose reply was lost is re-read the same way.
  const refusedWorld = await seeded(t)
  const refusedApp = new ModelApp(refusedWorld.vault)
  const view = refusedApp.open(NOTE)
  const lossy = modelAdapter(refusedApp, { plan: { after: (payload) => { if (payload.op === 'inspect' && payload.path === NOTE) view.type('LATE', 'brown') }, loseReply: (payload) => payload.op === 'publish' } })
  const refused = await refusedWorld.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), lossy)
  assert.equal(noteResult(refused).outcome, 'editor-edit')
  assert.equal(lossy.count('publish'), 1)
  assert.equal(refusedWorld.read(NOTE), BASE)
})

test('I11 full disk: staging refuses and touches nothing, a partial staged file is refused by digest, a pre-staged exchange is all-or-nothing, and publication converges when space returns',
  { skip: process.platform !== 'darwin' && 'the disk-full case needs a macOS disk image (hdiutil); on this platform it is not exercised' }, async (t) => {
    const root = fs.mkdtempSync(path.join(TMP, 'atelier-full-'))
    const image = path.join(root, 'full.dmg')
    const mount = path.join(root, 'vol')
    fs.mkdirSync(mount)
    let attached = false
    try {
      execFileSync('/usr/bin/hdiutil', ['create', '-size', '24m', '-fs', 'APFS', '-volname', 'AtelierRecoveryFull', image], { stdio: 'ignore' })
      execFileSync('/usr/bin/hdiutil', ['attach', image, '-nobrowse', '-mountpoint', mount], { stdio: 'ignore' })
      attached = true
      const world = await seeded(null, { [NOTE]: BASE, [OTHER]: BASE }, { root: path.join(mount, 'ws') })
      const preStaged = path.join(world.root, 'manual', 'pre-staged.candidate')
      fs.mkdirSync(path.dirname(preStaged))
      fs.writeFileSync(preStaged, CANDIDATE)
      const filler = path.join(mount, 'filler.bin')
      const fd = fs.openSync(filler, 'a')
      try { for (const size of [1 << 20, 1 << 14, 1 << 9, 1]) { const chunk = Buffer.alloc(size, 1); for (;;) { try { fs.writeSync(fd, chunk) } catch { break } } } } finally { fs.closeSync(fd) }

      const before = [world.read(NOTE), world.read(OTHER)]
      const big = `${CANDIDATE}${'x'.repeat(4 << 20)}`
      const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: big, [OTHER]: BASE } }), absentAdapter())
      assert.equal(result.state, 'refused', JSON.stringify(result))
      assert.ok(['staging-failed', 'state-unwritable', 'exchange-probe-failed'].includes(result.refusal.code), result.refusal.code)
      assert.deepEqual([world.read(NOTE), world.read(OTHER)], before, 'nothing in the vault was touched')

      const partial = path.join(world.root, 'manual', 'partial.candidate')
      let enospc = false
      try { fs.writeFileSync(partial, big) } catch (error) { enospc = error.code === 'ENOSPC' }
      assert.ok(enospc, 'the volume is full')
      const direct = createEditorAdapter({ call: createInProcessCall(), processProbe: () => 'absent' })
      if (fs.existsSync(partial)) {
        const refusedPartial = await direct.publish({ op: 'publish', mode: 'replace', vaultRoot: world.vault, path: NOTE, operationId: 'full:0', baseSha256: hex(BASE), candidateSha256: hex(big), stagedPath: partial, recoveryPath: path.join(world.root, 'recovery', 'partial.displaced') })
        assert.equal(refusedPartial.status, 'staged-mismatch')
        assert.equal(world.read(NOTE), BASE)
      }
      const reply = await direct.publish({ op: 'publish', mode: 'replace', vaultRoot: world.vault, path: NOTE, operationId: 'full:1', baseSha256: hex(BASE), candidateSha256: hex(CANDIDATE), stagedPath: preStaged, recoveryPath: path.join(world.root, 'recovery', 'pre-staged.displaced') })
      assert.equal(world.read(NOTE), reply.wrote ? CANDIDATE : BASE, `all-or-nothing (${reply.status})`)
      assert.ok(keptSomewhere(world, BASE), 'base bytes kept on a full disk')
      t.diagnostic(`I11 refusal ${result.refusal.code}; pre-staged exchange on the full volume: ${reply.status}`)

      fs.rmSync(filler)
      fs.rmSync(partial, { force: true })
      const converged = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE, [OTHER]: BASE } }), absentAdapter())
      assert.equal(converged.state, 'committed', JSON.stringify(converged))
      assert.equal(world.read(NOTE), CANDIDATE)
      assert.ok(keptSomewhere(world, BASE))
    } finally {
      if (attached) { try { execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' }) } catch { /* already detached */ } }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

test('I12 a program holding the note open writes late: the bytes land in recovery, are detected after the quiet period, and the base is still retained', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  app.open(NOTE)
  const late = `${BASE}LATE IN-PLACE WRITER\n`
  const holder = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r+');process.stdin.once('data',()=>{fs.ftruncateSync(fd,0);fs.writeSync(fd,process.argv[2],0);fs.closeSync(fd);process.exit(0)});console.log('held')", world.full(NOTE), late], { stdio: ['pipe', 'pipe', 'ignore'] })
  await new Promise((resolve) => holder.stdout.once('data', resolve))
  const adapter = modelAdapter(app, { plan: { after: async (payload) => {
    if (payload.op !== 'publish') return
    const exited = new Promise((resolve) => holder.on('exit', resolve))
    holder.stdin.write('go\n')
    await exited
  } } })
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter, { quietPeriodMs: 50 })
  assert.equal(result.state, 'committed')
  assert.equal(world.read(NOTE), CANDIDATE)
  assert.equal(result.lateWriters.length, 1)
  assert.equal(result.lateWriters[0].code, 'late-writer-captured')
  assert.equal(result.lateWriters[0].notePath, NOTE)
  assert.equal(fs.readFileSync(world.store.resolve(result.lateWriters[0].displacedRef), 'utf8'), late)
  assert.equal(world.store.readObject(result.lateWriters[0].observedDigest).toString('utf8'), late)
  assert.equal(world.store.readObject(digest(BASE)).toString('utf8'), BASE, 'the base survives the late writer truncating the displaced file')
  const committed = assertJournalsValid(world)[1]
  assert.ok(committed.entries.some((entry) => entry.step === 'verify' && entry.outcome === 'conflict' && entry.ext['mnstry.atelier.obsidian'].code === 'late-writer-captured'))

  // Later still: the same displaced file is written again, after the commit.
  const later = `${late}AND AGAIN\n`
  fs.writeFileSync(world.store.resolve(result.lateWriters[0].displacedRef), later)
  const findings = recheckDisplacedFiles({ store: world.store, clock })
  assert.deepEqual(findings.map((finding) => finding.code), ['late-writer-captured'])
  assert.equal(world.store.readObject(findings[0].observedDigest).toString('utf8'), later)
})

test('I13 an outside in-place rewrite after publication is kept, and the next generation does not overwrite it', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  app.open(NOTE)
  const adapter = modelAdapter(app)
  await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  const external = `${CANDIDATE}IN-PLACE AFTER PUBLICATION\n`
  fs.writeFileSync(world.full(NOTE), external)
  app.flushSaves()
  assert.equal(world.read(NOTE), external)
  const next = await world.publish(viewOf('gen-0003', { notes: { [NOTE]: `${CANDIDATE}Third.\n` } }), adapter)
  assert.equal(noteResult(next).outcome, 'disk-changed')
  assert.equal(world.read(NOTE), external)
  assert.ok(keptTexts(world).includes(external), 'the observed edit is preserved before anything else')
  const same = await world.publish(viewOf('gen-0004', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(noteResult(same).outcome, 'edit-kept', 'an unchanged generation leaves an edited note alone')
  assert.equal(same.state, 'committed')
  assert.equal(world.read(NOTE), external)
})

test('an outside write that lands between publication and verification is reported and kept', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const external = `${CANDIDATE}RIGHT AFTER\n`
  const adapter = modelAdapter(app, { plan: { after: (payload) => { if (payload.op === 'publish') fs.writeFileSync(world.full(NOTE), external) } } })
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
  assert.equal(noteResult(result).changedAfterPublication, true)
  assert.equal(world.read(NOTE), external)
  assert.ok(keptTexts(world).includes(external) && keptTexts(world).includes(BASE))
})

// ---------------------------------------------------------------------------
// Mutation controls: the suite fails a publisher that replaces unconditionally
// ---------------------------------------------------------------------------

test('mutation control: a renaming publisher loses the outside writer and loses the base in a crash', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const external = `${BASE}EXTERNAL WRITER\n`
  const adapter = modelAdapter(app, { plan: { after: (payload) => {
    if (payload.op !== 'inspect') return
    fs.writeFileSync(`${world.full(NOTE)}.ext~`, external); fs.renameSync(`${world.full(NOTE)}.ext~`, world.full(NOTE))
  } } })
  await renamingPublisher({ preparedView: viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), recoveryStore: world.store, adapter })
  assert.equal(keptSomewhere(world, external), false, 'the control publisher must lose the outside bytes, or the outside-writer case proves nothing')

  const crashed = await crashCase(t, 'renaming', { crashAt: 'after-publish', coordinated: true })
  assert.equal(crashed.afterCrash, CANDIDATE)
  assert.equal(crashed.keptBase, false, 'the control publisher must lose the base, or the crash cases prove nothing')
})

// ---------------------------------------------------------------------------
// Scope changes, new notes, attachments
// ---------------------------------------------------------------------------

test('a note that left the scope is removed only by a conditional move to recovery; an edited one is never deleted and stays surfaced', needsExchange, async (t) => {
  const world = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  fs.writeFileSync(world.full(OTHER), `${BASE}MY EDIT\n`)
  const app = new ModelApp(world.vault)
  const clean = app.open(NOTE)
  const result = await world.publish(viewOf('gen-0002', { notes: {} }), modelAdapter(app))
  assert.equal(result.state, 'committed', JSON.stringify(result))
  assert.equal(noteResult(result, NOTE).outcome, 'removed')
  assert.equal(world.read(NOTE), null)
  assert.equal(fs.readFileSync(world.store.resolve(noteResult(result, NOTE).recoveryRef), 'utf8'), BASE, 'removal is a move: the bytes are in recovery')
  assert.equal(clean.data, BASE, 'a clean open buffer is left to the app')
  assert.equal(noteResult(result, OTHER).outcome, 'retained-edit')
  assert.equal(world.read(OTHER), `${BASE}MY EDIT\n`)
  assert.deepEqual(result.retainedEdits.map((item) => item.path), [OTHER])
  assert.ok(keptTexts(world).includes(`${BASE}MY EDIT\n`))

  const later = await world.publish(viewOf('gen-0003', { notes: {} }), modelAdapter(app))
  assert.deepEqual(later.retainedEdits.map((item) => item.path), [OTHER], 'a retained edit stays surfaced on later runs')
  assert.equal(world.read(OTHER), `${BASE}MY EDIT\n`)
})

test('conditional removal refuses an unsaved buffer, and puts back a note replaced at the instant of the move', needsExchange, async (t) => {
  const world = await seeded(t)
  const app = new ModelApp(world.vault)
  const view = app.open(NOTE)
  view.type('UNSAVED', 'brown')
  const refused = await world.publish(viewOf('gen-0002', { notes: {} }), modelAdapter(app))
  assert.equal(noteResult(refused).outcome, 'editor-edit')
  assert.equal(refused.state, 'updating')
  assert.equal(world.read(NOTE), BASE)

  const external = `${BASE}REPLACED AT THE MOVE\n`
  const host = createInProcessHost()
  const realRequire = host.require
  const realFs = realRequire('fs')
  host.require = (name) => (name !== 'fs' ? realRequire(name) : new Proxy(realFs, { get: (target, key) => (key !== 'renameSync' ? target[key] : (from, to) => {
    if (from === world.full(NOTE)) { realFs.writeFileSync(`${from}.ext~`, external); realFs.renameSync(`${from}.ext~`, from) }
    return realFs.renameSync(from, to)
  }) }))
  const recoveryPath = path.join(world.root, 'recovery', 'manual-removal.displaced')
  const reply = runInProcess({ op: 'publish', mode: 'remove', vaultRoot: world.vault, path: NOTE, operationId: 'manual:1', baseSha256: hex(BASE), recoveryPath }, host)
  assert.equal(reply.status, 'remove-reverted')
  assert.equal(world.read(NOTE), external, 'the replacement is back at the note path')
  assert.equal(fs.existsSync(recoveryPath), false)
})

test('a put-back that cannot remove its second name still reports the note as live, and that name is never treated as displaced bytes', needsExchange, async (t) => {
  const world = await seeded(t)
  const external = `${BASE}REPLACED AT THE MOVE\n`
  // The note is replaced at the instant of the move, and the recovery name cannot be unlinked afterwards.
  const stubbornHost = () => {
    const host = createInProcessHost()
    const realRequire = host.require
    const realFs = realRequire('fs')
    host.require = (name) => (name !== 'fs' ? realRequire(name) : new Proxy(realFs, { get: (target, key) => {
      if (key === 'renameSync') return (from, to) => { if (from === world.full(NOTE)) { realFs.writeFileSync(`${from}.ext~`, external); realFs.renameSync(`${from}.ext~`, from) } return realFs.renameSync(from, to) }
      if (key === 'unlinkSync') return (file) => { if (file.includes(`${path.sep}recovery${path.sep}`)) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); return realFs.unlinkSync(file) }
      return target[key]
    } }))
    return host
  }
  const recoveryPath = path.join(world.root, 'recovery', 'manual-stubborn.displaced')
  const reply = runInProcess({ op: 'publish', mode: 'remove', vaultRoot: world.vault, path: NOTE, operationId: 'manual:4', baseSha256: hex(BASE), recoveryPath }, stubbornHost())
  assert.deepEqual([reply.status, reply.wrote, reply.recoveryNameLeft], ['remove-reverted', false, true], 'the note was put back: it is not reported as removed')
  assert.equal(world.read(NOTE), external)
  fs.rmSync(recoveryPath)

  // Through the publisher: the note stays managed and surfaced, the leftover name goes, and later edits are not a late writer's.
  fs.writeFileSync(world.full(NOTE), BASE)
  const adapter = createEditorAdapter({ call: createInProcessCall(stubbornHost()), processProbe: () => 'running', kind: 'model' })
  const result = await world.publish(viewOf('gen-0002', { notes: {} }), adapter)
  assert.equal(noteResult(result).outcome, 'retained-edit', JSON.stringify(result))
  assert.deepEqual(result.retainedEdits.map((item) => item.path), [NOTE])
  assert.equal(world.read(NOTE), external)
  assert.ok(!filesUnder(path.join(world.root, 'recovery')).some((file) => fs.statSync(file).ino === fs.statSync(world.full(NOTE)).ino), 'no recovery name is a second name of the live note')
  fs.appendFileSync(world.full(NOTE), 'the person keeps writing\n')
  assert.deepEqual(recheckDisplacedFiles({ store: world.store, clock }), [])

  // State left by an earlier build: a displaced receipt whose file is a hard link to the live note.
  const legacy = await seeded(t)
  const held = legacy.store.displacedPath('journal-legacy', 0)
  fs.linkSync(legacy.full(NOTE), held)
  legacy.store.writeReceipt('journal-legacy', 0, { role: 'displaced', notePath: NOTE, displacedRef: legacy.store.ref(held), digestAtMove: digest(BASE), baseDigest: digest(BASE), externalCaptured: false, at: clock().toISOString() })
  fs.appendFileSync(legacy.full(NOTE), 'ongoing edits to the live note\n')
  assert.deepEqual(recheckDisplacedFiles({ store: legacy.store, journalIds: ['journal-legacy'], clock }), [], 'edits to the live note are not reported as a late writer')
})

test('a new note appears by exclusive create; a file that is already there, or appears first, is never overwritten', needsExchange, async (t) => {
  const world = await seeded(t)
  fs.writeFileSync(world.full(OTHER), 'mine\n')
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: BASE, [OTHER]: CANDIDATE } }), absentAdapter())
  assert.equal(noteResult(result, OTHER).outcome, 'create-conflict')
  assert.equal(result.state, 'updating')
  assert.equal(world.read(OTHER), 'mine\n')
  assert.ok(keptTexts(world).includes('mine\n'))

  const racing = await seeded(t)
  const appeared = await racing.publish(viewOf('gen-0002', { notes: { [NOTE]: BASE, [OTHER]: CANDIDATE } }), absentAdapter(),
    { [CRASH_INJECTION_TEST_SEAM]: { at: 'after-capture', halt: () => fs.writeFileSync(racing.full(OTHER), 'appeared first\n') } })
  assert.equal(noteResult(appeared, OTHER).outcome, 'create-conflict')
  assert.equal(racing.read(OTHER), 'appeared first\n')
  assert.deepEqual(filesUnder(path.join(racing.root, 'staging')), [])
})

test('attachments follow the same conditional rules', needsExchange, async (t) => {
  const world = makeWorld(t)
  const file = 'attachments/Chart--0123456789ab.png'
  const first = await world.publish(viewOf('gen-0001', { notes: { [NOTE]: BASE }, attachments: { [file]: Buffer.from([1, 2, 3]) } }), absentAdapter())
  assert.equal(noteResult(first, file).outcome, 'created')
  fs.writeFileSync(world.full(file), Buffer.from([9, 9]))
  const second = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: BASE }, attachments: { [file]: Buffer.from([4, 5, 6]) } }), absentAdapter())
  assert.equal(noteResult(second, file).outcome, 'disk-changed')
  assert.deepEqual([...fs.readFileSync(world.full(file))], [9, 9])
  fs.writeFileSync(world.full(file), Buffer.from([1, 2, 3]))
  const third = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: BASE }, attachments: { [file]: Buffer.from([4, 5, 6]) } }), absentAdapter())
  assert.equal(noteResult(third, file).outcome, 'published')
  assert.deepEqual([...fs.readFileSync(world.full(file))], [4, 5, 6])
  assert.equal(third.state, 'committed')
})

test('a partly published view is updating, stays bound to what it published, and converges on a later run', needsExchange, async (t) => {
  const world = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  const app = new ModelApp(world.vault)
  const busy = app.open(OTHER)
  busy.type('BUSY', 'brown')
  const adapter = modelAdapter(app)
  const partial = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE, [OTHER]: CANDIDATE } }), adapter)
  assert.equal(partial.state, 'updating')
  assert.deepEqual([noteResult(partial, NOTE).outcome, noteResult(partial, OTHER).outcome], ['published', 'editor-edit'])
  assert.equal(world.store.readCurrent().generationId, 'gen-0001')
  assert.equal(assertJournalsValid(world).at(-1).state, 'updating')

  // A newer generation arrives before the first one converged: the note already published is a valid base, not an outside edit.
  busy.data = BASE; busy.dirty = false
  const newer = `${CANDIDATE}Newer.\n`
  const converged = await world.publish(viewOf('gen-0003', { notes: { [NOTE]: newer, [OTHER]: newer } }), adapter)
  assert.equal(converged.state, 'committed', JSON.stringify(converged))
  assert.deepEqual([world.read(NOTE), world.read(OTHER)], [newer, newer])
  assert.ok(keptTexts(world).includes(BASE) && keptTexts(world).includes(CANDIDATE))
})

// ---------------------------------------------------------------------------
// Settings ownership
// ---------------------------------------------------------------------------

test('policy settings are owned per key through the conditional protocol; everything else under the settings root is never touched', needsExchange, async (t) => {
  const world = makeWorld(t)
  fs.mkdirSync(world.full('.obsidian'))
  const appWritten = { 'file-explorer': true, 'global-search': true, graph: true, publish: false, sync: true, backlink: true }
  fs.writeFileSync(world.full(POLICY), JSON.stringify(appWritten, null, 2))
  fs.writeFileSync(world.full('.obsidian/workspace.json'), '{"main":{"id":"mine"}}')
  fs.writeFileSync(world.full('.obsidian/app.json'), '{"vimMode":true}')
  const userOwned = [stamp(world.full('.obsidian/workspace.json')), stamp(world.full('.obsidian/app.json'))]
  const app = new ModelApp(world.vault)

  const result = await world.publish(viewOf('gen-0001', { notes: { [NOTE]: BASE }, settings: true }), modelAdapter(app))
  assert.equal(result.state, 'committed', JSON.stringify(result))
  assert.equal(noteResult(result, POLICY).outcome, 'published')
  assert.deepEqual(JSON.parse(world.read(POLICY)), { ...appWritten, sync: false }, 'only the owned keys change; every other key is the person\'s')
  assert.deepEqual(JSON.parse(fs.readFileSync(world.store.resolve(noteResult(result, POLICY).recoveryRef), 'utf8')), appWritten, 'the file as it was is in recovery')

  // The app rewrites the file on launch, adding keys. Its digest changes; the policy still holds, so nothing is written.
  fs.writeFileSync(world.full(POLICY), JSON.stringify({ ...appWritten, sync: false, 'daily-notes': true, templates: false }))
  const rewritten = stamp(world.full(POLICY))
  const second = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE }, settings: true }), modelAdapter(app))
  assert.equal(second.state, 'committed')
  assert.equal(noteResult(second, POLICY).outcome, 'policy-satisfied')
  assert.equal(stamp(world.full(POLICY)), rewritten, 'a satisfied policy file is never republished')

  // The person turns Sync on while a run is between capture and update: refusal, their file stays.
  fs.writeFileSync(world.full(POLICY), JSON.stringify({ sync: true, publish: false }))
  // The first inspection of this path is the adapter's probe; the second is the capture.
  let policyInspections = 0
  const racing = modelAdapter(app, { plan: { after: (payload) => { if (payload.op === 'inspect' && payload.path === POLICY && (policyInspections += 1) === 2) fs.writeFileSync(world.full(POLICY), JSON.stringify({ sync: true, publish: false, graph: false })) } } })
  const third = await world.publish(viewOf('gen-0003', { notes: { [NOTE]: BASE }, settings: true }), racing)
  assert.equal(noteResult(third, POLICY).outcome, 'disk-changed')
  assert.deepEqual(JSON.parse(world.read(POLICY)), { sync: true, publish: false, graph: false })

  // Bytes that are not a JSON object or array are left alone.
  fs.writeFileSync(world.full(POLICY), '{ not json')
  const invalid = await world.publish(viewOf('gen-0003', { notes: { [NOTE]: BASE }, settings: true }), modelAdapter(app))
  assert.equal(noteResult(invalid, POLICY).outcome, 'settings-invalid')
  assert.equal(world.read(POLICY), '{ not json')
  fs.writeFileSync(world.full(POLICY), JSON.stringify(['graph', 'sync']))
  const listForm = await world.publish(viewOf('gen-0004', { notes: { [NOTE]: BASE }, settings: true }), modelAdapter(app))
  assert.equal(noteResult(listForm, POLICY).outcome, 'published')
  assert.deepEqual(JSON.parse(world.read(POLICY)), ['graph'])

  assert.deepEqual([stamp(world.full('.obsidian/workspace.json')), stamp(world.full('.obsidian/app.json'))], userOwned, 'user-owned settings were never touched')
  const forbidden = viewOf('gen-0005', { notes: { [NOTE]: BASE } })
  forbidden.files.push({ path: '.obsidian/workspace.json', kind: 'settings', bytes: Buffer.from('{}'), digest: digest('{}') })
  const refused = await world.publish(forbidden, modelAdapter(app))
  assert.equal(refused.state, 'refused')
  assert.equal(refused.refusal.code, 'invalid-prepared-view')
})

test('a vault without a policy file gets one by exclusive create', needsExchange, async (t) => {
  const world = makeWorld(t)
  const result = await world.publish(viewOf('gen-0001', { notes: { [NOTE]: BASE }, settings: true }), absentAdapter())
  assert.equal(noteResult(result, POLICY).outcome, 'created')
  assert.deepEqual(JSON.parse(world.read(POLICY)), { publish: false, sync: false })
})

// ---------------------------------------------------------------------------
// Path selection, capability floor, refusals
// ---------------------------------------------------------------------------

test('path selection: the direct path only when no Obsidian runs; a running app that cannot be coordinated with refuses everything', needsExchange, async (t) => {
  const world = await seeded(t)
  const before = snapshotTree(world)
  const silent = createEditorAdapter({ call: async () => { throw new Error('socket not found') }, processProbe: () => 'running' })
  const unknown = createEditorAdapter({ call: async () => { throw new Error('socket not found') }, processProbe: () => { throw new Error('ps failed') } })
  const otherVault = fs.mkdtempSync(path.join(TMP, 'atelier-other-vault-'))
  t.after(() => fs.rmSync(otherVault, { recursive: true, force: true }))
  const elsewhere = modelAdapter(new ModelApp(otherVault))
  for (const adapter of [silent, unknown, elsewhere]) {
    const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), adapter)
    assert.equal(result.state, 'refused')
    assert.equal(result.refusal.code, 'editor-uncoordinated')
  }
  assert.deepEqual(snapshotTree(world), before)
  assert.equal(defaultObsidianProcessProbe({ platform: 'win32' }), 'unknown')
  assert.equal(defaultObsidianProcessProbe({ platform: 'darwin', run: () => { throw new Error('denied') } }), 'unknown')
  assert.equal(defaultObsidianProcessProbe({ platform: 'darwin', run: () => '/sbin/launchd\n/usr/bin/some-editor --flag\n' }), 'absent')
  assert.equal(defaultObsidianProcessProbe({ platform: 'darwin', run: () => '/sbin/launchd\n/Applications/Obsidian.app/Contents/MacOS/Obsidian\n' }), 'running')
  assert.equal(defaultObsidianProcessProbe({ platform: 'linux', run: () => '/usr/bin/electron /opt/obsidian/app.asar\n' }), 'running')
})

test('the direct path reads the process table again immediately before the first note: an app started during staging stops it', needsExchange, async (t) => {
  const world = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  let probes = 0
  // Absent at path selection, running by the time staging is done.
  const startedMeanwhile = createEditorAdapter({ call: async () => { throw new Error('socket not found') }, processProbe: () => ((probes += 1) === 1 ? 'absent' : 'running') })
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE, [OTHER]: BASE } }), startedMeanwhile)
  assert.equal(result.mode, 'direct')
  assert.equal(probes, 2, 'one reading for path selection, one immediately before the first note')
  assert.equal(result.state, 'updating')
  assert.equal(noteResult(result).outcome, 'editor-uncoordinated')
  assert.equal(noteResult(result, OTHER).blocking, false, 'a note with nothing to write does not block')
  assert.equal(world.read(NOTE), BASE, 'nothing is exchanged without editor coordination once an app may be running')
  assert.equal(world.store.readCurrent().generationId, 'gen-0001')

  // With no app the same view publishes, and the table was still read twice.
  probes = 0
  const stillAbsent = createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => { probes += 1; return 'absent' } })
  const converged = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE, [OTHER]: BASE } }), stillAbsent)
  assert.equal(converged.state, 'committed', JSON.stringify(converged))
  assert.equal(probes, 2)
  assert.equal(world.read(NOTE), CANDIDATE)
})

test('capability floor: an open note on an app build without the saved-content field refuses; a closed note still publishes', needsExchange, async (t) => {
  const world = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  const app = new ModelApp(world.vault)
  app.open(NOTE, { savedField: false })
  const result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE, [OTHER]: CANDIDATE } }), modelAdapter(app))
  assert.equal(noteResult(result, NOTE).outcome, 'unsupported-app')
  assert.equal(world.read(NOTE), BASE)
  assert.equal(noteResult(result, OTHER).outcome, 'published')
})

test('staging that cannot be written refuses before anything is touched; a held lock refuses a second publisher', needsExchange, async (t) => {
  const world = await seeded(t)
  const before = snapshotTree(world)
  const stagingRoot = path.join(world.root, 'staging')
  fs.chmodSync(stagingRoot, 0o500)
  let result
  try { result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter()) } finally { fs.chmodSync(stagingRoot, 0o700) }
  assert.equal(result.state, 'refused')
  assert.equal(result.refusal.code, 'staging-failed')
  assert.deepEqual(snapshotTree(world), before)

  // The move into the unit recovery directory fails after the journal was opened: the candidate is removed from
  // staging, no unit directory is left behind to look like an unfinished recovery unit, and the vault is untouched.
  const recoveryRoot = path.join(world.root, 'recovery')
  const unitRoots = () => fs.readdirSync(recoveryRoot).filter((name) => name.startsWith('journal-'))
  const unitRootsBefore = unitRoots()
  fs.chmodSync(recoveryRoot, 0o500)
  try { result = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter()) } finally { fs.chmodSync(recoveryRoot, 0o700) }
  assert.equal(result.refusal?.code, 'staging-failed', JSON.stringify(result))
  assert.equal(world.read(NOTE), BASE)
  assert.deepEqual(filesUnder(path.join(world.root, 'staging')), [])
  assert.deepEqual(unitRoots(), unitRootsBefore, 'no stray unit directory')
  assert.deepEqual(exchangeCandidateFiles(world), [])
  assert.deepEqual(recoverPublications({ store: world.store, clock }).journals, [], 'and nothing for restart recovery to settle')

  const release = acquirePrivateLock(world.store.lockPath)
  try {
    const second = await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter())
    assert.equal(second.refusal.code, 'publication-in-progress')
    assert.equal(world.read(NOTE), BASE)
  } finally {
    release()
  }
  assert.equal((await world.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter())).state, 'committed')
})

test('one publisher per vault: a second view, from other workspace state, refuses while the vault is being published into', needsExchange, async (t) => {
  const first = await seeded(t)
  const otherRoot = fs.mkdtempSync(path.join(TMP, 'atelier-recovery-second-'))
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }))
  const second = createRecoveryStore({ workspaceRoot: otherRoot, workspaceId: 'ws-synthetic-0006', scopeId: 'scope-second', vaultRoot: first.vault, repositoryRoots: [] })
  assert.notEqual(second.lockPath, first.store.lockPath, 'the two views do not share a view lock')
  assert.equal(second.vaultLockPath, first.store.vaultLockPath, 'they share the vault lock, which lives under the vault\'s real path')
  const secondView = viewOf('gen-0001', { notes: { [OTHER]: BASE }, scopeId: 'scope-second' })
  const publishSecond = () => publishView({ preparedView: secondView, protocolId: PROTOCOL_ID, expectedGeneration: null, recoveryStore: second, adapter: absentAdapter(), clock, quietPeriodMs: 0 })

  // While the first view is inside a publication, the second one refuses and writes nothing.
  let during = null
  const result = await first.publish(viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } }), absentAdapter(),
    { [CRASH_INJECTION_TEST_SEAM]: { at: 'after-staging', halt: () => { during = publishSecond() } } })
  assert.equal(result.state, 'committed')
  during = await during
  assert.equal(during.state, 'refused')
  assert.equal(during.refusal.code, 'publication-in-progress')
  assert.match(during.refusal.message, /into this vault/)
  assert.equal(first.read(OTHER), null)
  assert.deepEqual(filesUnder(path.join(otherRoot, 'staging')), [])

  // Released: the second view publishes. Superseded tickets do not pile up in the vault.
  assert.equal((await publishSecond()).state, 'committed')
  assert.equal(first.read(OTHER), BASE)
  const owners = fs.readdirSync(`${first.store.vaultLockPath}.owners`)
  assert.ok(owners.length <= 2, `only the newest ticket and its release stay: ${owners}`)

  // A publisher killed while it held the vault lock does not wedge the vault: its ticket names a dead process.
  const killed = await seeded(t, { [NOTE]: BASE, [OTHER]: BASE })
  const child = crashChild({ root: killed.root, publisher: 'production', scenario: 'replace', crashAt: 'after-staging', coordinated: false })
  assert.equal(child.signal, 'SIGKILL', `${child.stdout} ${child.stderr}`)
  assert.doesNotThrow(() => acquireVaultLock(killed.store)(), 'the stale ticket is taken over, as for the view lock')
})

test('a manifest that declares one path twice, or as both a note and an attachment, is refused before anything is touched', async (t) => {
  const world = makeWorld(t)
  const file = 'attachments/Chart--0123456789ab.png'
  const publish = (preparedView) => publishView({ preparedView, protocolId: PROTOCOL_ID, expectedGeneration: null, recoveryStore: world.store, adapter: absentAdapter(), clock, quietPeriodMs: 0 })
  const before = snapshotTree(world)

  // One path as a note and as an attachment, with the same bytes so that every other check agrees.
  const both = viewOf('gen-0001', { notes: { [NOTE]: BASE }, attachments: { [file]: Buffer.from(BASE) } })
  both.manifest.attachments.push({ path: NOTE, digest: digest(BASE), byteLength: Buffer.byteLength(BASE) })
  const twiceNote = viewOf('gen-0001', { notes: { [NOTE]: BASE } })
  twiceNote.manifest.notes.push({ ...twiceNote.manifest.notes[0], nodeId: 'node-second' })
  twiceNote.manifest.completeness = { status: 'complete', expectedNotes: 2, writtenNotes: 2 }
  const twiceAttachment = viewOf('gen-0001', { attachments: { [file]: Buffer.from([1, 2, 3]) } })
  twiceAttachment.manifest.attachments.push({ ...twiceAttachment.manifest.attachments[0] })
  for (const [label, view] of Object.entries({ both, twiceNote, twiceAttachment })) {
    const result = await publish(view)
    assert.equal(result.state, 'refused', label)
    assert.equal(result.refusal.code, 'invalid-prepared-view', label)
  }
  assert.deepEqual(snapshotTree(world), before)
  assert.equal(world.read(NOTE), null)
})

test('refusals: unknown protocol, wrong expected generation, a view for another scope, a symlinked note path', needsExchange, async (t) => {
  const world = await seeded(t)
  const view = viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } })
  const call = (overrides) => publishView({ preparedView: view, protocolId: PROTOCOL_ID, expectedGeneration: 'gen-0001', recoveryStore: world.store, adapter: absentAdapter(), quietPeriodMs: 0, ...overrides })
  assert.equal((await call({ protocolId: 'obsidian-cli-critical-section/v1-prototype' })).refusal.code, 'unknown-protocol')
  assert.equal((await call({ expectedGeneration: null })).refusal.code, 'generation-mismatch')
  assert.equal((await call({ preparedView: viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE }, scopeId: 'scope-other' }) })).refusal.code, 'invalid-prepared-view')
  const tampered = viewOf('gen-0002', { notes: { [NOTE]: CANDIDATE } })
  tampered.files[0].bytes = Buffer.from('other bytes')
  assert.equal((await call({ preparedView: tampered })).refusal.code, 'invalid-prepared-view')
  await assert.rejects(() => call({ expectedGeneration: undefined }), TypeError)

  const outside = path.join(world.root, 'outside.md')
  fs.writeFileSync(outside, BASE)
  fs.rmSync(world.full(NOTE))
  fs.symlinkSync(outside, world.full(NOTE))
  const linked = await call({})
  assert.equal(noteResult(linked).outcome, 'path-unsafe')
  assert.equal(fs.readFileSync(outside, 'utf8'), BASE, 'nothing is written through a link')
  assert.equal((await call({})).state, 'updating')
  assert.equal(world.store.readCurrent().generationId, 'gen-0001')
})

// ---------------------------------------------------------------------------
// CLI transport, against a stand-in executable (never the real CLI)
// ---------------------------------------------------------------------------

test('CLI transport: explicit environment, SIGKILL on timeout, serialized calls, lost publish reply re-read through collect', needsExchange, async (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'calls.log')
  const cli = path.join(dir, 'stand-in-cli')
  // Stand-in: logs each call, never answers the first publish (and ignores SIGTERM like the real CLI), answers collect from the log.
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('fs')
process.on('SIGTERM', () => {})
const code = process.argv.find((arg) => arg.startsWith('code='))
const payload = JSON.parse(Buffer.from(/atob\\('([A-Za-z0-9+/=]+)'\\)/.exec(code)[1], 'base64').toString('utf8'))
const log = process.env.STAND_IN_LOG
const running = log + '.running'
if (fs.existsSync(running)) fs.appendFileSync(log, 'OVERLAP\\n')
fs.writeFileSync(running, '')
fs.appendFileSync(log, JSON.stringify({ op: payload.op, operationId: payload.operationId, home: process.env.HOME }) + '\\n')
const finish = (reply) => { fs.rmSync(running, { force: true }); console.log('=> ' + JSON.stringify(reply)) }
if (payload.op === 'publish') { fs.rmSync(running, { force: true }); setInterval(() => {}, 1000) }
else if (payload.op === 'collect') {
  const published = fs.readFileSync(log, 'utf8').trim().split('\\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((entry) => entry.op === 'publish')
  setTimeout(() => finish({ status: 'collected', outcome: 'published', operationId: published.operationId, wrote: true, vaultBasePath: payload.vaultRoot, views: [] }), 50)
} else setTimeout(() => finish({ status: 'inspected', vaultBasePath: payload.vaultRoot, diskSha256: null, views: [] }), 50)
`, { mode: 0o755 })
  const env = { PATH: process.env.PATH, HOME: path.join(dir, 'private-home'), STAND_IN_LOG: log }
  const adapter = createObsidianCliAdapter({ cliPath: cli, env, timeoutMs: 1500, processProbe: () => 'running' })
  assert.deepEqual(await adapter.probe({ vaultRoot: '/vault' }), { state: 'coordinated', reason: 'the app answered for this vault' })
  const started = Date.now()
  const [reply] = await Promise.all([adapter.publish(replacePayload()), adapter.inspect({ vaultRoot: '/vault', path: 'notes/Example.md' })])
  assert.equal(reply.status, 'published')
  assert.equal(reply.replyLost, true)
  assert.ok(Date.now() - started < 10000, 'the unanswered call was killed although it ignores SIGTERM')
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
  assert.ok(!lines.includes('OVERLAP'), 'calls are serialized')
  const entries = lines.map((line) => JSON.parse(line))
  assert.deepEqual(entries.map((entry) => entry.op), ['inspect', 'publish', 'collect', 'inspect'])
  assert.ok(entries.every((entry) => entry.home === env.HOME), 'the transport uses the environment it was given, not the caller\'s HOME')
  await assert.rejects(() => createObsidianCliCall({ cliPath: path.join(dir, 'absent-cli'), env, timeoutMs: 500 })({ op: 'inspect', vaultRoot: '/vault', path: NOTE }), /CLI call failed/)
})

// ---------------------------------------------------------------------------
// Opt-in: the production publisher through the real CLI against an isolated
// real app. Opens a desktop application window; never runs by default.
// ---------------------------------------------------------------------------

test('G04 real isolated Obsidian: production publisher through the CLI transport (I00, I03, I04, I05, I06, I06a, I12)',
  { skip: process.env.ATELIER_OBSIDIAN_G04 !== '1' && 'set ATELIER_OBSIDIAN_G04=1 on a desktop host with Obsidian installed; opens an application window', timeout: 1800000 }, async (t) => {
    const { createLayout, Instance } = await import('../experiments/obsidian-publication/lib/instance.mjs')
    const appDir = process.env.ATELIER_OBSIDIAN_APP_DIR || '/Applications/Obsidian.app/Contents/MacOS'
    const races = Number(process.env.ATELIER_OBSIDIAN_G04_RACES || '10')
    const layout = createLayout()
    const instance = new Instance(layout)
    const vault = fs.realpathSync(layout.vault)
    const store = createRecoveryStore({ workspaceRoot: path.join(layout.root, 'atelier-state'), workspaceId: 'ws-synthetic-0004', scopeId: 'scope-synthetic', vaultRoot: vault, repositoryRoots: [] })
    // The isolated app is reached only through its private HOME. The process probe is fixed to "running": another
    // Obsidian may be running on this desktop, and this test must never take the direct path.
    const adapter = createObsidianCliAdapter({ cliPath: path.join(appDir, 'obsidian-cli'), env: instance.env, processProbe: () => 'running' })
    const full = (notePath) => path.join(vault, notePath)
    const read = (notePath) => (fs.existsSync(full(notePath)) ? fs.readFileSync(full(notePath), 'utf8') : null)
    const notePathOf = (id) => `notes/${id}--${hex(id).slice(0, 12)}.md`
    const state = new Map() // note path -> text of the generation last handed to the publisher
    let serial = 0
    const publish = (changes, extra = {}) => {
      for (const [notePath, text] of Object.entries(changes)) state.set(notePath, text)
      serial += 1
      return publishView({ preparedView: viewOf(`gen-g04-${String(serial).padStart(4, '0')}`, { notes: Object.fromEntries(state) }), protocolId: PROTOCOL_ID,
        expectedGeneration: store.readCurrent()?.generationId ?? null, recoveryStore: store, adapter, quietPeriodMs: 1500, ...extra })
        .then((result) => { assertStagingNeverHoldsDisplacedBytes(store); return result })
    }
    const buffers = async (notePath) => (await instance.bridge({ op: 'inspect', path: notePath })).views.map((view) => Buffer.from(view.bufferBase64, 'base64').toString('utf8'))
    const openClean = async (notePath, expected, views = 1) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const inspected = await adapter.inspect({ vaultRoot: vault, path: notePath })
        if (inspected.views.length === views && inspected.views.every((view) => !view.dirty && view.bufferSha256 === hex(expected))) { await sleep(300); return }
        if (attempt % 15 === 14 && views === 1) { await instance.stimulus('closeAll', notePath); await instance.stimulus('open', notePath) }
        await sleep(250)
      }
      throw new Error(`${notePath} never became ${views} clean open view(s)`)
    }
    // Seeds a note at BASE through the production publisher itself, then opens it.
    const seed = async (id, { open = true } = {}) => {
      const notePath = notePathOf(id)
      const seededResult = await publish({ [notePath]: BASE })
      assert.ok(['created', 'already-current', 'unchanged'].includes(noteResult(seededResult, notePath).outcome), JSON.stringify(noteResult(seededResult, notePath)))
      await sleep(1200)
      await instance.stimulus('closeAll', notePath)
      if (open) { await instance.stimulus('open', notePath); await openClean(notePath, BASE) }
      return notePath
    }
    const everythingKept = () => filesUnder(path.join(store.workspaceRoot, 'recovery')).map((file) => fs.readFileSync(file, 'utf8'))

    await instance.launch()
    try {
      t.diagnostic(`Obsidian ${await instance.version()}; ${races} rounds for each racing case`)
      const probe = await adapter.probe({ vaultRoot: vault })
      assert.equal(probe.state, 'coordinated', probe.reason)

      await t.test('I00 clean open note publishes and the editor shows the candidate', async () => {
        const notePath = await seed('i00')
        const result = await publish({ [notePath]: CANDIDATE })
        assert.equal(noteResult(result, notePath).outcome, 'published', JSON.stringify(result))
        assert.equal(result.mode, 'in-app')
        assert.equal(read(notePath), CANDIDATE)
        assert.deepEqual(await buffers(notePath), [CANDIDATE])
        assert.equal(fs.readFileSync(store.resolve(noteResult(result, notePath).recoveryRef), 'utf8'), BASE)
      })

      await t.test('I03 unsaved active buffer refuses, then the delayed save keeps the edit', async () => {
        const notePath = await seed('i03')
        await instance.stimulus('focusAt', notePath, { anchor: 'brown' })
        await instance.typeText('UNSAVED', notePath)
        const result = await publish({ [notePath]: CANDIDATE })
        assert.ok(['editor-edit', 'disk-changed'].includes(noteResult(result, notePath).outcome), JSON.stringify(noteResult(result, notePath)))
        await sleep(3500)
        assert.ok(read(notePath).includes('UNSAVED'))
        assert.ok((await buffers(notePath)).every((text) => text.includes('UNSAVED')))
        state.set(notePath, BASE) // the generation is withdrawn; the edited note stays as the person left it
      })

      await t.test(`I04 real typing racing the critical section never loses the typed text (${races} rounds)`, async () => {
        const tally = {}
        for (let round = 0; round < races; round += 1) {
          const notePath = await seed(`i04r${round}`)
          const typed = `RACE${round}X`
          await instance.stimulus('focusAt', notePath, { anchor: 'brown' })
          // The publisher writes durable records before its critical section, so the stimulus is spread
          // across 0–1.4 s to land on both sides of it.
          const typing = sleep((round * 173) % 1400).then(() => instance.typeText(typed, notePath))
          const result = await publish({ [notePath]: CANDIDATE })
          await typing
          const outcome = noteResult(result, notePath).outcome
          tally[outcome] = (tally[outcome] ?? 0) + 1
          let safe = false
          for (const startedAt = Date.now(); Date.now() - startedAt < 20000 && !safe;) {
            await sleep(1000)
            safe = (read(notePath) ?? '').includes(typed) && (await buffers(notePath)).every((text) => text.includes(typed))
          }
          assert.ok(safe, `round ${round}: typed text lost (${outcome}); disk ${JSON.stringify(read(notePath))}`)
          state.set(notePath, /^published/.test(outcome) ? CANDIDATE : BASE)
        }
        t.diagnostic(`I04 outcomes: ${JSON.stringify(tally)}`)
      })

      await t.test('I05 second window: clean windows both receive the candidate; an unsaved edit in the other window refuses', async () => {
        const notePath = await seed('i05')
        await instance.stimulus('openPopout', notePath)
        await openClean(notePath, BASE, 2)
        const clean = await publish({ [notePath]: CANDIDATE })
        assert.equal(noteResult(clean, notePath).outcome, 'published', JSON.stringify(noteResult(clean, notePath)))
        assert.equal(noteResult(clean, notePath).openViews, 2)
        assert.deepEqual(await buffers(notePath), [CANDIDATE, CANDIDATE])
        await sleep(3000)
        await instance.stimulus('popoutEdit', notePath, { anchor: 'GENERATED', text: 'POPOUTEDIT' })
        const dirty = await publish({ [notePath]: `${CANDIDATE}Second generation.\n` })
        assert.equal(noteResult(dirty, notePath).outcome, 'editor-edit')
        await sleep(3500)
        assert.ok(read(notePath).includes('POPOUTEDIT'))
        await instance.stimulus('closeAll', notePath)
        state.set(notePath, CANDIDATE)
      })

      await t.test(`I06 outside atomic-rename writer racing publication never loses its bytes (${races} rounds)`, async () => {
        const tally = {}
        for (let round = 0; round < races; round += 1) {
          const notePath = await seed(`i06r${round}`, { open: round % 2 === 0 })
          const external = `${BASE}EXTERNAL${round}\n`
          const writer = spawn(process.execPath, ['-e', `const fs=require('fs');setTimeout(()=>{fs.writeFileSync(process.argv[1]+'.ext~',process.argv[2]);fs.renameSync(process.argv[1]+'.ext~',process.argv[1]);},${(round * 157) % 1200})`, full(notePath), external], { stdio: 'ignore' })
          const exited = new Promise((resolve) => writer.on('exit', resolve))
          const result = await publish({ [notePath]: CANDIDATE })
          await exited
          await sleep(2500)
          const outcome = noteResult(result, notePath).outcome
          tally[outcome] = (tally[outcome] ?? 0) + 1
          const disk = read(notePath)
          assert.ok(disk === external || everythingKept().includes(external), `round ${round}: outside bytes lost (${outcome})`)
          state.set(notePath, /^published/.test(outcome) ? CANDIDATE : BASE)
        }
        t.diagnostic(`I06 outcomes: ${JSON.stringify(tally)}`)
      })

      await t.test('I06a the app never rewrites the note after publication; a following outside write survives', async () => {
        const notePath = await seed('i06a')
        const result = await publish({ [notePath]: CANDIDATE }, { quietPeriodMs: 0 })
        assert.equal(noteResult(result, notePath).outcome, 'published')
        const published = stamp(full(notePath))
        for (const startedAt = Date.now(); Date.now() - startedAt < 4000;) { assert.equal(stamp(full(notePath)), published, 'the app wrote the note after publication'); await sleep(5) }
        const external = `${CANDIDATE}OUTSIDE WRITER\n`
        fs.writeFileSync(`${full(notePath)}.ext~`, external); fs.renameSync(`${full(notePath)}.ext~`, full(notePath))
        await sleep(4000)
        assert.equal(read(notePath), external)
        assert.deepEqual(await buffers(notePath), [external])
      })

      await t.test('I12 a program holding the note open writes late: bytes land in recovery and are detected', async () => {
        const notePath = await seed('i12')
        const late = `${BASE}LATE IN-PLACE WRITER\n`
        const holder = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r+');process.stdin.once('data',()=>{fs.ftruncateSync(fd,0);fs.writeSync(fd,process.argv[2],0);fs.closeSync(fd);process.exit(0)});console.log('held')", full(notePath), late], { stdio: ['pipe', 'pipe', 'ignore'] })
        await new Promise((resolve) => holder.stdout.once('data', resolve))
        const result = await publish({ [notePath]: CANDIDATE }, { quietPeriodMs: 0 })
        assert.equal(noteResult(result, notePath).outcome, 'published')
        const exited = new Promise((resolve) => holder.on('exit', resolve))
        holder.stdin.write('go\n')
        await exited
        await sleep(1500)
        const findings = recheckDisplacedFiles({ store })
        assert.ok(findings.some((finding) => finding.code === 'late-writer-captured' && finding.notePath === notePath))
        assert.equal(fs.readFileSync(store.resolve(noteResult(result, notePath).recoveryRef), 'utf8'), late)
        assert.equal(read(notePath), CANDIDATE)
        assert.deepEqual(await buffers(notePath), [CANDIDATE])
      })

      for (const journal of listJournals(store)) assert.deepEqual(validateObsidianContract('publication-journal', journal.document()), [])
      t.diagnostic(`transport retries: ${JSON.stringify(adapter.transportRetries)}`)
    } finally {
      await instance.quit()
      if (process.env.ATELIER_OBSIDIAN_G04_KEEP !== '1') fs.rmSync(layout.root, { recursive: true, force: true })
      else t.diagnostic(`evidence kept at ${layout.root}`)
    }
  })
