import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import nodeTest from 'node:test'
import {
  resolvePersonalWorkspace, planPersonalGeneration, materializePersonalGeneration, PersonalWorkspaceRefusal, MANIFEST_SCHEMA, OVERLAY_SCHEMA,
  selectPersonalGeneration, selectionConfirmDigest, readPersonalSelection, inventoryPersonalHome, planPersonalRestore, restorePersonalInputs,
} from '../src/personal-workspace/index.mjs'

const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' }, fn)
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Two invented source repositories and a private home, as in the core tests.
function fixture(t) {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_/i.test(k)))
  for (const k of Object.keys(ambient)) delete process.env[k]
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-selection-')))
  const personalHome = path.join(base, 'personal')
  const sources = ['source-a', 'source-b'].map((id) => path.join(base, id))
  fs.mkdirSync(personalHome, { mode: 0o700 })
  for (const root of sources) {
    fs.mkdirSync(root)
    assert.equal(spawnSync(realGit, ['init', '-q', root]).status, 0)
    const name = path.basename(root)
    fs.writeFileSync(path.join(root, 'overview.md'), `---\ntitle: Overview\nkg:\n  id: ${name}:overview\n  type: document\n  status: active\n  audience: private\n---\n\nOverview.\n`)
  }
  const manifest = { schema: MANIFEST_SCHEMA, workspaceId: 'reading', revision: 1, bindings: [sources[0]],
    repos: sources.map((root) => ({ repoId: path.basename(root), root, remote: null, enrolled: true })) }
  const overlay = { schema: OVERLAY_SCHEMA, workspaceId: 'reading',
    annotations: [{ id: 'note', target: { repoId: 'source-a', nodeId: 'source-a:overview' }, note: 'Private perspective', displayAlias: 'Start here', tags: ['reading'] }],
    connections: [{ id: 'bridge', from: { repoId: 'source-a', nodeId: 'source-a:overview' }, to: { repoId: 'source-b', nodeId: 'source-b:overview' }, label: 'My connection' }],
    collections: [], views: [{ id: 'selected', name: 'My selection', repoIds: ['source-a'] }], preferences: { theme: 'dark', defaultView: 'selected' } }
  const save = () => {
    fs.writeFileSync(path.join(personalHome, 'atelier.personal.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(personalHome, 'atelier.overlay.json'), JSON.stringify(overlay))
  }
  save()
  const materialize = () => materializePersonalGeneration(planPersonalGeneration(resolvePersonalWorkspace({ folder: sources[0], personalHome })), { personalHome }).generationId
  const select = (generationId) => selectPersonalGeneration({ personalHome, generationId,
    confirm: selectionConfirmDigest({ generationId, previous: readPersonalSelection({ personalHome }).head }) })
  // Withdraws source-b: enrollment off and every private reference to it removed.
  const withdrawB = () => { manifest.repos[1].enrolled = false; overlay.connections = []; save() }
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true })
    for (const k of Object.keys(process.env).filter((k) => /^GIT_/i.test(k))) delete process.env[k]
    Object.assign(process.env, ambient)
  })
  return { base, personalHome, sources, manifest, overlay, save, materialize, select, withdrawB }
}
function treeHash(root) {
  const all = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p); else all.push([path.relative(root, p), sha(fs.readFileSync(p))])
    }
  }
  walk(root)
  return JSON.stringify(all)
}
const refuses = (fn, code) => assert.throws(fn, (e) => e instanceof PersonalWorkspaceRefusal && e.code === code)

test('selection records an explicit, confirmed choice of the eligible generation in a hash chain', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  assert.deepEqual(readPersonalSelection({ personalHome: f.personalHome }), { selected: null, head: 'genesis', eligible: false, reason: 'nothing-selected' })
  refuses(() => selectPersonalGeneration({ personalHome: f.personalHome, generationId: g1, confirm: 'sha256:' + '0'.repeat(64) }), 'confirmation-mismatch')
  const chosen = f.select(g1)
  assert.equal(chosen.sequence, 1)
  const read = readPersonalSelection({ personalHome: f.personalHome })
  assert.deepEqual([read.selected, read.eligible, read.head], [g1, true, chosen.head])
  // A confirmation computed against an older head does not authorize a later selection.
  refuses(() => selectPersonalGeneration({ personalHome: f.personalHome, generationId: g1, confirm: selectionConfirmDigest({ generationId: g1, previous: 'genesis' }) }), 'confirmation-mismatch')
  assert.equal(f.select(g1).sequence, 2)
})

test('a generation whose inputs changed is not selectable, and a held selection reports it ineligible', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.select(g1)
  f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  refuses(() => f.select(g1), 'stale-generation')
  assert.deepEqual([readPersonalSelection({ personalHome: f.personalHome }).eligible, readPersonalSelection({ personalHome: f.personalHome }).reason], [false, 'stale-generation'])
})

test('a tampered or reordered selection history refuses', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.select(g1); f.select(g1)
  const second = path.join(f.personalHome, 'selections', '000002.json')
  const record = JSON.parse(fs.readFileSync(second, 'utf8'))
  // Canonical, correctly numbered and schema-valid: only the chain link is wrong.
  const canonicalRecord = (value) => `${JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])))}\n`
  fs.writeFileSync(second, canonicalRecord({ ...record, previous: 'e'.repeat(64) }))
  refuses(() => readPersonalSelection({ personalHome: f.personalHome }), 'selection-history-corrupt')
  fs.rmSync(second); fs.writeFileSync(path.join(f.personalHome, 'selections', '000003.json'), fs.readFileSync(path.join(f.personalHome, 'selections', '000001.json')))
  refuses(() => readPersonalSelection({ personalHome: f.personalHome }), 'selection-history-corrupt')
})

test('the inventory lists authored files, generations, selections and restores, and writes nothing', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.select(g1)
  f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  const g2 = f.materialize()
  const before = treeHash(f.personalHome)
  const inventory = inventoryPersonalHome({ personalHome: f.personalHome })
  assert.equal(treeHash(f.personalHome), before)
  assert.deepEqual(inventory.authored.map((a) => a.name), ['atelier.personal.json', 'atelier.overlay.json'])
  assert.deepEqual(new Map(inventory.generations.map((g) => [g.generationId, [g.eligible, g.reason]])), new Map([[g1, [false, 'stale-generation']], [g2, [true, null]]]))
  assert.deepEqual([inventory.selections.records.length, inventory.restores.length, inventory.staging.length, inventory.temporary.length], [1, 0, 0, 0])
  const [record] = inventory.selections.records
  assert.equal(record.digest, sha(fs.readFileSync(path.join(f.personalHome, 'selections', record.name))))
})

test('restore brings back an earlier generation\'s authored inputs, keeps the replaced bytes, and selection follows explicitly', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  const original = fs.readFileSync(path.join(f.personalHome, 'atelier.overlay.json'))
  f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  const g2 = f.materialize()
  f.select(g2)
  const revised = fs.readFileSync(path.join(f.personalHome, 'atelier.overlay.json'))
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: g1 })
  refuses(() => restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: 'sha256:' + '1'.repeat(64) }), 'confirmation-mismatch')
  const restored = restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm })
  assert.deepEqual([restored.generationId, restored.eligible], [g1, true])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.personalHome, 'atelier.overlay.json'))), JSON.parse(original))
  // The selection is not changed by a restore; it is the person's next explicit act.
  assert.deepEqual([readPersonalSelection({ personalHome: f.personalHome }).selected, readPersonalSelection({ personalHome: f.personalHome }).eligible], [g2, false])
  assert.equal(f.select(g1).generationId, g1)
  const [record] = fs.readdirSync(path.join(f.personalHome, 'restores'))
  const kept = JSON.parse(fs.readFileSync(path.join(f.personalHome, 'restores', record), 'utf8'))
  assert.deepEqual(Buffer.from(kept.replaced.overlay, 'base64'), revised)
})

test('a restore that would re-admit a withdrawn repository refuses and writes nothing; explicit re-enrollment permits it', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.withdrawB()
  f.materialize()
  const before = treeHash(f.personalHome)
  assert.throws(() => planPersonalRestore({ personalHome: f.personalHome, generationId: g1 }),
    (e) => e instanceof PersonalWorkspaceRefusal && e.code === 'rollback-readmits-repository' && e.repoIds.join() === 'source-b')
  assert.equal(treeHash(f.personalHome), before)
  // The person re-enrolls the repository; the same restore is then evaluated normally.
  f.manifest.repos[1].enrolled = true; f.save()
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: g1 })
  assert.equal(restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }).eligible, true)
})

test('a restore across a repository identity change refuses', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  assert.equal(spawnSync(realGit, ['-C', f.sources[1], 'remote', 'add', 'origin', 'https://example.invalid/b.git']).status, 0)
  f.manifest.repos[1].remote = 'https://example.invalid/b.git'; f.save()
  assert.throws(() => planPersonalRestore({ personalHome: f.personalHome, generationId: g1 }),
    (e) => e instanceof PersonalWorkspaceRefusal && e.code === 'rollback-identity-changed' && e.repoIds.join() === 'source-b')
})

test('a restore that only narrows enrollment succeeds', (t) => {
  const f = fixture(t)
  f.withdrawB()
  const narrow = f.materialize()
  f.manifest.repos[1].enrolled = true; f.save()
  f.materialize()
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: narrow })
  assert.equal(restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }).eligible, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.personalHome, 'atelier.personal.json'))).repos[1].enrolled, false)
})

test('an altered generation record, or inputs changed after planning, refuse the restore', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  f.materialize()
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: g1 })
  f.overlay.annotations[0].note = 'Another revision'; f.save()
  refuses(() => restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }), 'authored-input-changed')
  const inputs = path.join(f.personalHome, 'generations', g1, 'inputs.json')
  fs.writeFileSync(inputs, fs.readFileSync(inputs, 'utf8').replace('Private perspective', 'Altered history'))
  refuses(() => planPersonalRestore({ personalHome: f.personalHome, generationId: g1 }), 'generation-corrupt')
  refuses(() => planPersonalRestore({ personalHome: f.personalHome, generationId: 'f'.repeat(64) }), 'generation-missing')
})

test('a restore interrupted after the manifest completes on a rerun of the same plan', (t) => {
  const f = fixture(t)
  f.withdrawB()
  const narrow = f.materialize()
  f.manifest.repos[1].enrolled = true; f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  f.materialize()
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: narrow })
  const rename = fs.renameSync
  let calls = 0
  fs.renameSync = (from, to) => { if (++calls === 2) throw Object.assign(new Error('interrupted'), { code: 'EIO' }); return rename(from, to) }
  try { refuses(() => restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }), 'restore-write-failed') } finally { fs.renameSync = rename }
  // The manifest was restored, the overlay was not, and no staged file is left behind.
  assert.equal(sha(fs.readFileSync(path.join(f.personalHome, 'atelier.personal.json'))), plan.to.manifest)
  assert.equal(sha(fs.readFileSync(path.join(f.personalHome, 'atelier.overlay.json'))), plan.from.overlay)
  assert.deepEqual(inventoryPersonalHome({ personalHome: f.personalHome }).temporary, [])
  assert.equal(restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }).eligible, true)
  assert.equal(fs.readdirSync(path.join(f.personalHome, 'restores')).length, 2, 'each attempt keeps its record')
})

test('a hand-built or altered restore plan is refused, however its confirmation is computed', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.withdrawB()
  f.materialize()
  f.manifest.repos[1].enrolled = true; f.save()
  const genuine = planPersonalRestore({ personalHome: f.personalHome, generationId: g1 })
  f.withdrawB()
  // A forgery that matches the withdrawn manifest and carries a correctly recomputed
  // confirmation. Provenance rejects it first (the widening check would also reject
  // it, with another code); it must refuse as unconfirmed and write nothing.
  const sortObject = (v) => Array.isArray(v) ? v.map(sortObject) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortObject(v[k])])) : v
  const from = { ...genuine.from, manifest: sha(fs.readFileSync(path.join(f.personalHome, 'atelier.personal.json'))) }
  const confirm = `sha256:${sha(`${JSON.stringify(sortObject({ action: 'restore', generationId: genuine.generationId, from, to: genuine.to }))}\n`)}`
  const forged = { ...genuine, from, confirm }
  const before = treeHash(f.personalHome)
  refuses(() => restorePersonalInputs(forged, { personalHome: f.personalHome, confirm }), 'confirmation-mismatch')
  assert.equal(treeHash(f.personalHome), before)
})

test('a withdrawal between planning and restoring refuses the restore before any write', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  f.materialize()
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: g1 })
  f.withdrawB()
  const before = treeHash(f.personalHome)
  refuses(() => restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }), 'authored-input-changed')
  assert.equal(treeHash(f.personalHome), before)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.personalHome, 'atelier.personal.json'))).repos[1].enrolled, false)
})

test('a restore that would re-add a removed binding refuses', (t) => {
  const f = fixture(t)
  f.manifest.bindings = [f.sources[0], f.sources[1]]; f.save()
  const g1 = f.materialize()
  f.manifest.bindings = [f.sources[0]]; f.save()
  f.materialize()
  assert.throws(() => planPersonalRestore({ personalHome: f.personalHome, generationId: g1 }),
    (e) => e instanceof PersonalWorkspaceRefusal && e.code === 'rollback-readds-binding' && e.count === 1)
})

test('a restore across a moved repository root refuses as an identity change', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  const moved = path.join(f.base, 'source-b-moved')
  fs.renameSync(f.sources[1], moved)
  f.manifest.repos[1].root = moved; f.save()
  assert.throws(() => planPersonalRestore({ personalHome: f.personalHome, generationId: g1 }),
    (e) => e instanceof PersonalWorkspaceRefusal && e.code === 'rollback-identity-changed' && e.repoIds.join() === 'source-b')
})

test('a crash while publishing a selection leaves the history readable and the temporary file listed', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.select(g1)
  // The process dies after writing the complete temporary record and before publishing it.
  const module = new URL('../src/personal-workspace/index.mjs', import.meta.url).href
  const head = readPersonalSelection({ personalHome: f.personalHome }).head
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { selectPersonalGeneration, selectionConfirmDigest } from ${JSON.stringify(module)};
    fs.linkSync = () => process.exit(75);
    const [personalHome, generationId, previous] = process.argv.slice(1);
    selectPersonalGeneration({ personalHome, generationId, confirm: selectionConfirmDigest({ generationId, previous }) });
  `, f.personalHome, g1, head], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))) })
  assert.equal(child.status, 75, child.stderr)
  const read = readPersonalSelection({ personalHome: f.personalHome })
  assert.deepEqual([read.selected, read.sequence], [g1, 1])
  const [temporary] = inventoryPersonalHome({ personalHome: f.personalHome }).temporary
  assert.equal(temporary.location, 'selections')
  assert.equal(f.select(g1).sequence, 2)
})

test('removing the last selection record changes the head a host observed', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.select(g1)
  const observed = f.select(g1).head
  fs.rmSync(path.join(f.personalHome, 'selections', '000002.json'))
  assert.notEqual(readPersonalSelection({ personalHome: f.personalHome }).head, observed)
})

test('an oversized generation input record refuses with its own code', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  fs.writeFileSync(path.join(f.personalHome, 'generations', g1, 'inputs.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20))
  refuses(() => planPersonalRestore({ personalHome: f.personalHome, generationId: g1 }), 'generation-inputs-too-large')
})

nodeTest('a raw filesystem failure surfaces as a stable refusal without a path', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.select(g1)
  const selections = path.join(f.personalHome, 'selections')
  fs.chmodSync(selections, 0o000)
  try {
    assert.throws(() => readPersonalSelection({ personalHome: f.personalHome }),
      (e) => e instanceof PersonalWorkspaceRefusal && e.code === 'personal-home-unavailable' && !e.message.includes(f.base))
  } finally { fs.chmodSync(selections, 0o700) }
})

test('a writer that changes an authored file just before the swap keeps its bytes, and the restore refuses', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  f.materialize()
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: g1 })
  const manifestFile = path.join(f.personalHome, 'atelier.personal.json')
  // Another writer edits the overlay after the restore read it, just as the
  // restore moves it aside.
  const rename = fs.renameSync
  let raced = false
  fs.renameSync = (from, to) => {
    if (!raced && from.endsWith('atelier.overlay.json')) {
      raced = true
      f.overlay.annotations[0].note = 'A third, concurrent revision'
      fs.writeFileSync(from, JSON.stringify(f.overlay))
    }
    return rename(from, to)
  }
  try { refuses(() => restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }), 'authored-input-changed') } finally { fs.renameSync = rename }
  assert.equal(raced, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.personalHome, 'atelier.overlay.json'))), f.overlay, 'the late write is kept')
  assert.deepEqual(inventoryPersonalHome({ personalHome: f.personalHome }).temporary, [])
  assert.ok(fs.existsSync(manifestFile))
})

test('a schema-invalid current manifest refuses both planning and restoring', (t) => {
  const f = fixture(t)
  const g1 = f.materialize()
  f.overlay.annotations[0].note = 'Revised perspective'; f.save()
  f.materialize()
  const plan = planPersonalRestore({ personalHome: f.personalHome, generationId: g1 })
  const invalid = { ...f.manifest, repos: [f.manifest.repos[0], { ...f.manifest.repos[0] }] }
  fs.writeFileSync(path.join(f.personalHome, 'atelier.personal.json'), JSON.stringify(invalid))
  refuses(() => planPersonalRestore({ personalHome: f.personalHome, generationId: g1 }), 'malformed-input')
  refuses(() => restorePersonalInputs(plan, { personalHome: f.personalHome, confirm: plan.confirm }), 'malformed-input')
})

test('null or missing options refuse with a stable code', () => {
  for (const call of [() => selectPersonalGeneration(null), () => readPersonalSelection(null), () => inventoryPersonalHome(), () => planPersonalRestore(null), () => restorePersonalInputs(null, null), () => selectionConfirmDigest(null)]) {
    assert.throws(call, (e) => e instanceof PersonalWorkspaceRefusal && typeof e.code === 'string')
  }
})
