import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import nodeTest from 'node:test'
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' }, fn)
import { resolvePersonalWorkspace, planPersonalGeneration, materializePersonalGeneration, composePersonalWorkspace,
  loadPersonalManifest, loadPersonalOverlay, PersonalWorkspaceRefusal, MANIFEST_SCHEMA, OVERLAY_SCHEMA } from '../src/personal-workspace/index.mjs'

const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v))
function fixture(t) {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_/i.test(k)))
  for (const k of Object.keys(ambient)) delete process.env[k]
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-personal-')))
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
  const overlay = { schema: OVERLAY_SCHEMA, workspaceId: 'reading', annotations: [{ id: 'note', target: { repoId: 'source-a', nodeId: 'source-a:overview' }, note: 'Private perspective', displayAlias: 'Start here', tags: ['reading'] }],
    connections: [{ id: 'bridge', from: { repoId: 'source-a', nodeId: 'source-a:overview' }, to: { repoId: 'source-b', nodeId: 'source-b:overview' }, label: 'My connection' }],
    collections: [{ id: 'reading-list', name: 'Reading list', members: [{ repoId: 'source-b', nodeId: 'source-b:overview' }] }],
    views: [{ id: 'selected', name: 'My selection', repoIds: ['source-a'] }], preferences: { theme: 'dark', defaultView: 'selected' } }
  const save = () => { writeJSON(path.join(personalHome, 'atelier.personal.json'), manifest); writeJSON(path.join(personalHome, 'atelier.overlay.json'), overlay) }
  save()
  const resolve = () => resolvePersonalWorkspace({ folder: sources[0], personalHome })
  const plan = () => planPersonalGeneration(resolve())
  const materialize = () => materializePersonalGeneration(plan(), { personalHome })
  const compose = () => composePersonalWorkspace({ personalHome, generationId: plan().generationId })
  const sourceBefore = sources.map(treeHash)
  t.after(() => {
    // Each case that intentionally edits its source resets this baseline explicitly.
    try {
      assert.deepEqual(sources.map(treeHash), sourceBefore)
      for (const root of sources) { assert.equal(fs.existsSync(path.join(root, '.atelier-local')), false); assert.equal(fs.existsSync(path.join(root, 'knowledge.graph.json')), false) }
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
      for (const k of Object.keys(process.env).filter((k) => /^GIT_/i.test(k))) delete process.env[k]
      Object.assign(process.env, ambient)
    }
  })
  return { base, personalHome, sources, manifest, overlay, save, resolve, plan, materialize, compose, sourceBefore }
}
function treeHash(root) {
  const all = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else all.push([path.relative(root, p), entry.isSymbolicLink() ? fs.readlinkSync(p) : createHash('sha256').update(fs.readFileSync(p)).digest('hex')])
    }
  }
  walk(root)
  return JSON.stringify(all)
}
const refuses = (fn, code) => assert.throws(fn, (e) => e instanceof PersonalWorkspaceRefusal && e.code === code && !e.message.includes(os.homedir()))
function changeEnv(t, key, value) {
  const old = process.env[key]
  if (value === undefined) delete process.env[key]; else process.env[key] = value
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
}
function shim(t, f, behavior = '') {
  const root = path.join(f.base, 'shim'); fs.mkdirSync(root)
  const log = path.join(root, 'argv.jsonl')
  const source = `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');\nconst rest=a.slice(2); const cmd=rest[0]==='-c'?rest[2]:rest[0];if(!['rev-parse','config','remote','ls-files','check-ignore'].includes(cmd)) process.exit(93);\n${behavior}\nconst r=cp.spawnSync(${JSON.stringify(realGit)},a,{env:process.env});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status===null?92:r.status);\n`
  fs.writeFileSync(path.join(root, 'git'), source, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(root, 'gh-used'))},'used');process.exit(94)\n`, { mode: 0o755 })
  changeEnv(t, 'PATH', `${root}${path.delimiter}${process.env.PATH}`)
  return { log, root }
}

test('composes two enrolled repos plus a private overlay through one canonical graph, without source or authored writes', (t) => {
  const f = fixture(t); const { log, root } = shim(t, f)
  const authored = [treeHash(f.personalHome), ...f.sourceBefore]
  const resolved = f.resolve(); const p = f.plan()
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.coverage.enforcement, 'none')
  assert.equal(resolved.exists, false); assert.equal(fs.existsSync(path.join(f.personalHome, 'generations')), false)
  assert.deepEqual([treeHash(f.personalHome), ...f.sources.map(treeHash)], authored)
  assert.deepEqual(f.materialize(), { generationId: p.generationId, reused: false })
  const result = f.compose()
  assert.equal(result.graph.ok, true)
  assert.equal(result.graph.nodes.length, 7)
  assert.ok(result.graph.edges.some((e) => e.source === 'personal-reading:annotation-note' && e.target === 'source-a:overview'))
  assert.ok(result.graph.edges.some((e) => e.source === 'personal-reading:connection-bridge' && e.target === 'source-b:overview'))
  assert.deepEqual(result.graph.nodes.find((n) => n.id === 'personal-reading:annotation-note').tags, ['reading'])
  assert.equal(result.preferences.theme, 'dark')
  assert.equal(result.generation.sourceRevisions.length, 2)
  assert.equal(result.coverage.enforcement, 'none')
  assert.deepEqual(f.materialize(), { generationId: p.generationId, reused: true })
  assert.equal(fs.existsSync(path.join(root, 'gh-used')), false)
  const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(commands.some((a) => a.includes('ls-files')))
  assert.ok(commands.every((a) => !a.some((x) => ['fetch', 'clone', 'pull', 'ls-remote', 'credential'].includes(x))))
})

test('pure planning is deterministic and returned inputs cannot be altered', (t) => {
  const f = fixture(t); const a = f.plan(), b = f.plan()
  assert.deepEqual(a, b); assert.equal(a.generationId.length, 64)
  assert.throws(() => { a.files['escaped.md'] = 'new' }, TypeError)
  refuses(() => materializePersonalGeneration({ ...a }, { personalHome: f.personalHome }), 'malformed-input')
  assert.equal(fs.existsSync(path.join(f.personalHome, 'generations')), false)
})

test('binding none is explicit, duplicate and nested bindings refuse before writes', (t) => {
  const f = fixture(t)
  assert.equal(resolvePersonalWorkspace({ folder: f.sources[1], personalHome: f.personalHome }).status, 'none')
  f.manifest.bindings.push(f.sources[0]); f.save(); refuses(f.resolve, 'ambiguous-binding')
  f.manifest.bindings = [f.base, f.sources[0]]; f.save(); refuses(f.resolve, 'ambiguous-binding')
  assert.equal(fs.existsSync(path.join(f.personalHome, 'generations')), false)
})

for (const [field, code] of [['permissions', 'authority-field-refused'], ['audience', 'authority-field-refused'], ['classification', 'authority-field-refused'], ['rules', 'unsupported-rule'], ['unknown', 'malformed-input']]) {
  test(`closed inputs refuse ${field} without exposing values`, (t) => {
    const f = fixture(t); f.overlay.annotations[0][field] = 'private detail'; f.save(); refuses(f.resolve, code)
  })
}

test('future and unknown schema, malformed JSON, and oversized input refuse', (t) => {
  const f = fixture(t); const file = path.join(f.personalHome, 'atelier.overlay.json')
  f.overlay.schema = 'atelier-personal-workspace-overlay@v2'; f.save(); refuses(() => loadPersonalOverlay(file), 'future-schema')
  f.overlay.schema = 'unknown'; f.save(); refuses(() => loadPersonalOverlay(file), 'unknown-schema')
  fs.writeFileSync(file, '{private'); refuses(() => loadPersonalOverlay(file), 'malformed-input')
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1)); refuses(() => loadPersonalOverlay(file), 'malformed-input')
})

test('removed enrollment with retained authored references refuses before any generation', (t) => {
  const f = fixture(t); f.manifest.repos[0].enrolled = false; f.save()
  const before = treeHash(f.personalHome); refuses(f.resolve, 'retained-removed-reference')
  assert.equal(treeHash(f.personalHome), before)
})

test('changed inputs invalidate an old plan and an old generation without deleting history', (t) => {
  const f = fixture(t); const p = f.plan(); f.materialize()
  f.overlay.annotations[0].note = 'Changed preference'; f.save()
  refuses(() => materializePersonalGeneration(p, { personalHome: f.personalHome }), 'stale-generation')
  refuses(() => composePersonalWorkspace({ personalHome: f.personalHome, generationId: p.generationId }), 'stale-generation')
  assert.ok(fs.existsSync(path.join(f.personalHome, 'generations', p.generationId, 'generation.json')))
})

test('missing or misowned stable node refs never commit a generation', (t) => {
  const f = fixture(t)
  f.overlay.annotations[0].target.nodeId = 'source-b:overview'; f.save()
  refuses(f.materialize, 'stale-reference')
  assert.equal(fs.existsSync(path.join(f.personalHome, 'generations', f.plan().generationId)), false)
  assert.equal(fs.readdirSync(path.join(f.personalHome, 'generations')).length, 0)
})

test('source rename preserves stable IDs, while deletion refuses an existing generation', (t) => {
  const f = fixture(t); f.materialize()
  const old = path.join(f.sources[0], 'overview.md'), moved = path.join(f.sources[0], 'renamed.md')
  fs.renameSync(old, moved)
  assert.equal(f.compose().graph.nodes.find((n) => n.id === 'source-a:overview').path, 'renamed.md')
  const bytes = fs.readFileSync(moved); fs.unlinkSync(moved)
  refuses(f.compose, 'stale-reference')
  fs.writeFileSync(old, bytes)
})

test('ambient Git environment refuses before reads can retarget the census', (t) => {
  const f = fixture(t); changeEnv(t, 'GIT_DIR', f.sources[1]); refuses(f.resolve, 'ambient-git-environment')
})

test('fsmonitor configured in an enrolled root refuses', (t) => {
  const f = fixture(t); spawnSync(realGit, ['-C', f.sources[0], 'config', 'core.fsmonitor', 'true'])
  refuses(f.resolve, 'git-helper-configured')
  spawnSync(realGit, ['-C', f.sources[0], 'config', '--unset', 'core.fsmonitor'])
})

test('missing Git refuses rather than admitting ignored files', (t) => {
  const f = fixture(t); changeEnv(t, 'PATH', ''); refuses(f.resolve, 'git-unavailable')
})

test('changed remote identity refuses without provider lookup or rebind', (t) => {
  const f = fixture(t); shim(t, f)
  spawnSync(realGit, ['-C', f.sources[0], 'remote', 'add', 'origin', 'https://example.invalid/sample/replacement.git'])
  refuses(f.resolve, 'repo-identity-replaced')
  spawnSync(realGit, ['-C', f.sources[0], 'remote', 'remove', 'origin'])
})

test('independent ignore oracle closes the shared graph fail-open census', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.sources[0], '.gitignore'), 'ignored.md\n')
  fs.writeFileSync(path.join(f.sources[0], 'ignored.md'), '---\ntitle: Ignored\nkg:\n  id: source-a:ignored\n  type: document\n  status: active\n  audience: private\n---\nIgnored\n')
  shim(t, f, "if(rest[0]==='ls-files') process.exit(1);")
  refuses(f.materialize, 'ignored-source-in-census')
  fs.unlinkSync(path.join(f.sources[0], '.gitignore')); fs.unlinkSync(path.join(f.sources[0], 'ignored.md'))
})

test('independent ignore oracle failure refuses before commit', (t) => {
  const f = fixture(t); shim(t, f, "if(rest[0]==='-c' && rest[2]==='ls-files') process.exit(1);")
  refuses(f.materialize, 'git-unavailable')
})

for (const entry of ['directory', 'file']) test(`generation ancestor .git ${entry} refuses without writes there`, (t) => {
  const f = fixture(t)
  if (entry === 'directory') fs.mkdirSync(path.join(f.personalHome, '.git')); else fs.writeFileSync(path.join(f.personalHome, '.git'), 'gitdir: missing')
  refuses(f.materialize, 'generation-inside-work-tree')
  assert.equal(fs.existsSync(path.join(f.personalHome, 'generations')), false)
})
for (const output of ['true', 'false']) test(`generation rev-parse success ${output} refuses`, (t) => {
  const f = fixture(t)
  shim(t, f, `if(a[1].includes('generations')&&cmd==='rev-parse'){process.stdout.write('${output}');process.exit(0);}`)
  refuses(f.materialize, 'generation-inside-work-tree')
})

test('private ownership/mode, symlink roots, and authored symlink refuse', (t) => {
  const f = fixture(t)
  fs.chmodSync(f.personalHome, 0o777); refuses(f.resolve, 'not-private-location'); fs.chmodSync(f.personalHome, 0o700)
  const link = path.join(f.base, 'linked'); fs.symlinkSync(f.personalHome, link)
  refuses(() => resolvePersonalWorkspace({ folder: f.sources[0], personalHome: link }), 'root-symlinked')
  const overlay = path.join(f.personalHome, 'atelier.overlay.json'); fs.renameSync(overlay, `${overlay}.saved`); fs.symlinkSync(`${overlay}.saved`, overlay)
  refuses(f.resolve, 'malformed-input')
})

test('private root inside a shared repo and nested enrollments refuse', (t) => {
  const f = fixture(t)
  const saved = f.manifest.repos[0].root
  f.manifest.repos[0].root = f.base; f.save(); refuses(f.resolve, 'private-state-in-shared-root')
  f.manifest.repos[0].root = saved
  const nested = path.join(f.sources[0], 'nested'); fs.mkdirSync(nested); spawnSync(realGit, ['init', '-q', nested])
  f.manifest.repos[1].root = nested; f.save(); refuses(f.resolve, 'nested-enrolled-roots')
  fs.rmSync(nested, { recursive: true })
})

for (const mutation of ['extra', 'missing', 'edited', 'symlink', 'ambient']) test(`committed generation ${mutation} refuses and is never overwritten`, (t) => {
  const f = fixture(t); const p = f.plan(); f.materialize()
  const dir = path.join(f.personalHome, 'generations', p.generationId), file = path.join(dir, 'overlay/workspace.md')
  if (mutation === 'extra') fs.writeFileSync(path.join(dir, 'overlay/extra.md'), 'extra')
  if (mutation === 'missing') fs.unlinkSync(file)
  if (mutation === 'edited') fs.appendFileSync(file, 'changed')
  if (mutation === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(f.sources[0], 'overview.md'), file) }
  if (mutation === 'ambient') writeJSON(path.join(dir, 'atelier.local.json'), { repoPaths: { 'source-a': f.sources[1] } })
  refuses(f.compose, mutation === 'ambient' ? 'ambient-overlay-present' : 'generation-corrupt')
  const before = treeHash(dir)
  refuses(f.materialize, 'generation-overwrite-refused')
  assert.equal(treeHash(dir), before)
})

for (const point of ['inputs.json', 'atelier.project.json', 'workspace.md', 'generation.json', 'rename']) test(`crash at ${point} leaves no partial final; retry is safe`, (t) => {
  const f = fixture(t); const p = f.plan()
  const originalWrite = fs.writeFileSync, originalRename = fs.renameSync
  fs.writeFileSync = function(fd, ...args) {
    // Resolve descriptors on this POSIX fixture by recording each open, below.
    if (opened.get(fd)?.endsWith(point)) throw new Error('simulated interruption')
    return originalWrite.call(fs, fd, ...args)
  }
  const opened = new Map(), originalOpen = fs.openSync
  fs.openSync = function(file, ...args) { const fd = originalOpen.call(fs, file, ...args); opened.set(fd, String(file)); return fd }
  fs.renameSync = function(...args) { if (point === 'rename') throw new Error('simulated interruption'); return originalRename.call(fs, ...args) }
  try { refuses(() => materializePersonalGeneration(p, { personalHome: f.personalHome }), 'generation-write-failed') }
  finally { fs.writeFileSync = originalWrite; fs.openSync = originalOpen; fs.renameSync = originalRename }
  assert.equal(fs.existsSync(path.join(f.personalHome, 'generations', p.generationId)), false)
  assert.ok(fs.readdirSync(path.join(f.personalHome, 'generations')).some((n) => n.startsWith('.staging-')))
  assert.equal(f.materialize().reused, false)
  assert.ok(f.compose().warnings.some((w) => w.code === 'stale-staging'))
})

test('path traversal generation ids and missing generation refuse without writes', (t) => {
  const f = fixture(t)
  refuses(() => composePersonalWorkspace({ personalHome: f.personalHome, generationId: '../escape' }), 'malformed-input')
  fs.mkdirSync(path.join(f.personalHome, 'generations'), { mode: 0o700 })
  refuses(f.compose, 'generation-missing')
  assert.equal(fs.readdirSync(path.join(f.personalHome, 'generations')).length, 0)
  refuses(() => loadPersonalManifest(path.join(f.sources[0], 'overview.md'), { personalHome: f.personalHome }), 'not-private-location')
})

nodeTest('Windows explicitly refuses unqualified private roots', { skip: process.platform !== 'win32' }, () => {
  refuses(() => resolvePersonalWorkspace({ folder: process.cwd(), personalHome: process.cwd() }), 'private-root-unverifiable')
})

test('generation Git timeout is a typed refusal', (t) => {
  const f = fixture(t)
  shim(t, f, "if(a[1].includes('generations')&&cmd==='rev-parse') { setTimeout(()=>process.exit(0), 16000); return; }")
  refuses(f.materialize, 'git-unavailable')
})

test('interruption after staging and before canonical verification preserves no final', (t) => {
  const f = fixture(t), p = f.plan(), original = fs.readFileSync
  let interrupted = false
  fs.readFileSync = function(file, ...args) {
    if (!interrupted && typeof file === 'string' && file.includes('.staging-') && file.endsWith('atelier.project.json')) {
      interrupted = true; throw new Error('simulated interruption')
    }
    return original.call(fs, file, ...args)
  }
  try { refuses(() => materializePersonalGeneration(p, { personalHome: f.personalHome }), 'generation-write-failed') }
  finally { fs.readFileSync = original }
  assert.equal(fs.existsSync(path.join(f.personalHome, 'generations', p.generationId)), false)
  assert.equal(f.materialize().reused, false)
})

test('two people retain independent enrollment and interpretation over unchanged shared sources', (t) => {
  const f = fixture(t); f.materialize(); const first = f.compose()
  const secondHome = path.join(f.base, 'second-person'); fs.mkdirSync(secondHome, { mode: 0o700 })
  const manifest = { ...f.manifest, workspaceId: 'second-reading', bindings: [f.sources[1]], repos: [{ ...f.manifest.repos[1] }] }
  const overlay = { schema: OVERLAY_SCHEMA, workspaceId: 'second-reading', annotations: [{ id: 'my-note', target: { repoId: 'source-b', nodeId: 'source-b:overview' }, note: 'A different interpretation' }], connections: [], collections: [], views: [], preferences: { theme: 'light' } }
  writeJSON(path.join(secondHome, 'atelier.personal.json'), manifest); writeJSON(path.join(secondHome, 'atelier.overlay.json'), overlay)
  const resolved = resolvePersonalWorkspace({ folder: f.sources[1], personalHome: secondHome })
  const p = planPersonalGeneration(resolved); materializePersonalGeneration(p, { personalHome: secondHome })
  const second = composePersonalWorkspace({ personalHome: secondHome, generationId: p.generationId })
  assert.ok(first.graph.nodes.some((n) => n.repo === 'source-a'))
  assert.equal(second.graph.nodes.some((n) => n.repo === 'source-a'), false)
  assert.equal(second.graph.nodes.some((n) => n.repo === 'personal-reading'), false)
  assert.equal(first.graph.nodes.some((n) => n.repo === 'personal-second-reading'), false)
  assert.equal(second.preferences.theme, 'light'); assert.equal(first.preferences.theme, 'dark')
  assert.ok(second.graph.nodes.some((n) => n.id === 'personal-second-reading:annotation-my-note'))
})

test('missing roots and nonabsolute bindings refuse before writes', (t) => {
  const f = fixture(t)
  f.manifest.bindings = ['relative']; f.save(); refuses(f.resolve, 'path-not-absolute')
  f.manifest.bindings = [f.sources[0]]; f.manifest.repos[1].root = path.join(f.base, 'absent'); f.save(); refuses(f.resolve, 'root-missing')
})

test('unknown reference repo and empty enrollment refuse before planning', (t) => {
  const f = fixture(t)
  f.overlay.annotations[0].target.repoId = 'unknown-source'; f.save(); refuses(f.resolve, 'malformed-input')
  f.overlay.annotations[0].target.repoId = 'source-a'; f.manifest.repos.forEach((r) => { r.enrolled = false }); f.save(); refuses(f.resolve, 'not-enrolled')
})

test('generation root symlink refuses and never writes through it', (t) => {
  const f = fixture(t), external = path.join(f.base, 'external'); fs.mkdirSync(external, { mode: 0o700 })
  fs.symlinkSync(external, path.join(f.personalHome, 'generations'))
  refuses(f.materialize, 'root-symlinked'); assert.deepEqual(fs.readdirSync(external), [])
})

test('canonical overlay omissions refuse before generation commit', (t) => {
  const f = fixture(t)
  shim(t, f, "if(cmd==='ls-files' && a[1].endsWith('/overlay')) { process.stdout.write('workspace.md\\0'); process.exit(0); }")
  refuses(f.materialize, 'overlay-census-mismatch')
  assert.equal(fs.existsSync(path.join(f.personalHome, 'generations', f.plan().generationId)), false)
})

test('invalid source graph refuses without a committed generation', (t) => {
  const f = fixture(t), file = path.join(f.sources[0], 'extra.md')
  fs.writeFileSync(file, '---\ntitle: Extra\nkg:\n  id: source-a:overview\n  type: document\n  status: active\n  audience: private\n---\nDuplicate id\n')
  try { refuses(f.materialize, 'source-graph-invalid') } finally { fs.unlinkSync(file) }
})

test('removing a source and its dependent selections produces a smaller fresh graph without pruning history', (t) => {
  const f = fixture(t); const first = f.plan(); f.materialize()
  f.overlay.connections = []; f.overlay.collections = []; f.manifest.repos[1].enrolled = false; f.save()
  const next = f.plan(); f.materialize(); const result = f.compose()
  assert.notEqual(first.generationId, next.generationId)
  assert.equal(result.graph.nodes.some((n) => n.repo === 'source-b'), false)
  assert.ok(fs.existsSync(path.join(f.personalHome, 'generations', first.generationId, 'generation.json')))
  refuses(() => composePersonalWorkspace({ personalHome: f.personalHome, generationId: first.generationId }), 'stale-generation')
})


test('review S1: private aliases and body links cannot change shared link resolution', (t) => {
  const f = fixture(t), file = path.join(f.sources[0], 'overview.md'), bytes = fs.readFileSync(file)
  const target = path.join(f.sources[1], 'overview.md'), targetBytes = fs.readFileSync(target)
  try {
    fs.writeFileSync(target, targetBytes.toString().replace('title: Overview', 'title: Shared target'))
    fs.appendFileSync(file, '\n[[Shared target]]\n[[Private label]]\n')
    f.overlay.annotations[0].id = 'overview'; f.overlay.annotations[0].displayAlias = 'Shared target'
    f.overlay.collections[0].name = 'Private label'
    f.overlay.annotations[0].note = '[[source-b/overview]] [source](../../source-b/overview.md) ![[asset.png]]'
    f.save(); f.materialize(); const graph = f.compose().graph
    assert.ok(graph.edges.some((e) => e.source === 'source-a:overview' && e.target === 'source-b:overview' && e.origin === 'ordinary-link'))
    assert.equal(graph.edges.some((e) => e.source.startsWith('source-') && e.target.startsWith('personal-')), false)
    assert.equal(graph.links.some((e) => e.source.startsWith('personal-')), false)
    assert.equal(graph.embeds.some((e) => e.source?.startsWith('personal-')), false)
    assert.ok(graph.edges.some((e) => e.source === 'personal-reading:annotation-overview' && e.target === 'source-a:overview' && e.origin === 'declared'))
    assert.equal(graph.nodes.find((n) => n.id === 'source-b:overview').title, 'Shared target')
  } finally { fs.writeFileSync(file, bytes); fs.writeFileSync(target, targetBytes) }
})

test('review S1: global and XDG fsmonitor configuration refuses before any helper runs', (t) => {
  const f = fixture(t), home = path.join(f.base, 'global-home'), xdg = path.join(home, 'xdg'), marker = path.join(home, 'helper-used')
  fs.mkdirSync(path.join(xdg, 'git'), { recursive: true }); changeEnv(t, 'HOME', home); changeEnv(t, 'XDG_CONFIG_HOME', xdg)
  const helper = path.join(home, 'marker-helper')
  fs.writeFileSync(helper, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'used')\n`, { mode: 0o755 })
  for (const config of [path.join(home, '.gitconfig'), path.join(xdg, 'git/config')]) {
    fs.writeFileSync(config, `[core]\n fsmonitor = ${helper}\n`)
    refuses(f.resolve, 'git-helper-configured'); assert.equal(fs.existsSync(marker), false)
    assert.equal(fs.existsSync(path.join(f.personalHome, 'generations')), false); fs.unlinkSync(config)
  }
})

test('review S1: authored comma and quote tags survive and untagged nodes use a private marker', (t) => {
  const f = fixture(t); f.overlay.annotations[0].tags = ['a,b', 'quoted "tag"']; f.save(); f.materialize()
  const graph = f.compose().graph
  assert.deepEqual(graph.nodes.find((n) => n.id === 'personal-reading:annotation-note').tags, ['a,b', 'quoted "tag"'])
  assert.deepEqual(graph.nodes.find((n) => n.id === 'personal-reading:workspace').tags, ['personal-interpretation'])
})

test('review S1: ignored asset sidecars cannot enter a fail-open shared census', (t) => {
  const f = fixture(t), root = f.sources[0], asset = path.join(root, 'reference.pdf'), sidecar = `${asset}.kg.json`, ignore = path.join(root, '.gitignore')
  fs.writeFileSync(asset, 'synthetic PDF'); writeJSON(sidecar, { schema: 'atelier-source@v1', asset: 'reference.pdf', title: 'Reference', kg: { id: 'source-a:reference', type: 'document', status: 'active', audience: 'private' } })
  fs.writeFileSync(ignore, 'reference.pdf.kg.json\n')
  shim(t, f, "if(rest[0]==='ls-files') process.exit(1);")
  try { refuses(f.materialize, 'ignored-source-in-census') }
  finally { for (const file of [asset, sidecar, ignore]) fs.unlinkSync(file) }
})

test('review S1: path-derived IDs are not stable overlay targets', (t) => {
  const f = fixture(t), file = path.join(f.sources[0], 'overview.md'), bytes = fs.readFileSync(file)
  try {
    fs.writeFileSync(file, '---\ntitle: Overview\n---\nUnclassified source\n')
    refuses(f.materialize, 'stale-reference')
  } finally { fs.writeFileSync(file, bytes) }
})

test('review S1: observed remote credentials never enter authored or generated output', (t) => {
  const f = fixture(t), root = f.sources[0], canonicalRemote = 'https://example.invalid/sample/repository.git'
  spawnSync(realGit, ['-C', root, 'remote', 'add', 'origin', 'https://reader:invented-token@example.invalid/sample/repository.git?token=invented#private'])
  try {
    f.manifest.repos[0].remote = canonicalRemote; f.save(); f.materialize()
    const result = f.compose(); assert.equal(result.generation.sourceRevisions[0].remote, canonicalRemote)
    assert.equal(JSON.stringify(result).includes('invented-token'), false)
    f.manifest.repos[0].remote = 'https://reader:invented-token@example.invalid/sample/repository.git'; f.save()
    refuses(f.resolve, 'remote-credentials-refused')
  } finally { spawnSync(realGit, ['-C', root, 'remote', 'remove', 'origin']) }
})

test('review S1: relocated personal homes rebuild a distinct immutable generation', (t) => {
  const f = fixture(t), first = f.plan(); f.materialize()
  const moved = path.join(f.base, 'deeper', 'personal'); fs.mkdirSync(path.dirname(moved)); fs.renameSync(f.personalHome, moved)
  const p = planPersonalGeneration(resolvePersonalWorkspace({ folder: f.sources[0], personalHome: moved }))
  assert.notEqual(p.generationId, first.generationId)
  refuses(() => composePersonalWorkspace({ personalHome: moved, generationId: first.generationId }), 'stale-generation')
  materializePersonalGeneration(p, { personalHome: moved })
  assert.equal(composePersonalWorkspace({ personalHome: moved, generationId: p.generationId }).graph.ok, true)
  assert.ok(fs.existsSync(path.join(moved, 'generations', first.generationId, 'generation.json')))
})
