import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createTemplateProjectView } from '../src/template-bindings/project.mjs'
import { createSourceApply } from '../src/projection/obsidian/edits/index.mjs'
import { validateTemplateBinding } from '../src/templates/profile.mjs'
import { makeApplyWorld, noteText, treeListing } from './support/obsidian-edits/apply-world.mjs'

const profile = JSON.parse(fs.readFileSync(new URL('../fixtures/templates/local-library.v1.json', import.meta.url), 'utf8'))
const first = 'library/notes/paper.md', second = 'library/notes/thread.md'
function worldFor(t, options = {}) {
  return makeApplyWorld(t, { repositories: ['library'], files: {
    [first]: noteText({ id: 'library:paper', title: 'Paper shapes', body: 'Three paper shapes share a table.' }),
    [second]: noteText({ id: 'library:thread', title: 'Thread colors', body: 'Two colors remain independent.' }),
  }, ...options })
}
const request = extra => JSON.stringify({ profile, projectRef: 'sample.project', roleNodeIds: { items: ['library:paper', 'library:thread'] }, target: 'local', ...extra })
const view = (world, extra) => createTemplateProjectView(world.loadProject(), request(extra))

test('canonical graph binds exact source bytes and uses the existing read-only presentation without writes', t => {
  const world = worldFor(t), before = treeListing(world.projectDir)
  const result = view(world)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(treeListing(world.projectDir), before)
  assert.equal(validateTemplateBinding(profile, result.binding, result.records).ok, true)
  assert.equal(result.records.length, 2)
  assert.match(result.html, /Three paper shapes/)
  assert.match(result.textPreview, /Three paper shapes/)
  assert.match(result.html, /Runtime actions require a separately qualified host/)
  assert.equal(result.artifacts.web, result.artifacts.documents)
  assert.doesNotMatch(result.html, /<button|<script|<textarea/)
  assert.equal(result.executionAuthority, false)
  assert.equal(result.publicationAuthority, false)
  assert.equal(result.conformanceClaim, 'none')
  assert.deepEqual(result.optionalDecisions, [{ id: 'reading-priority', status: 'absent', fallback: 'deterministic-or-manual', invocationAuthorized: false }])
  assert.ok(result.capabilityDiagnostics.some(item => item.id === 'shelf' && item.bindingAllowed === false))
})

for (const [name, patch] of [
  ['unknown target', { target: 'publc' }],
  ['public widening of team sources', { target: 'public' }],
  ['unknown role', { roleNodeIds: { unknown: ['library:paper'] } }],
  ['unknown source', { roleNodeIds: { items: ['library:missing'] } }],
  ['document coerced into collection', { roleNodeIds: { items: ['library:paper'], shelf: ['library:thread'] } }],
  ['required collection without canonical mapping', { profile: { ...profile, semanticRoles: profile.semanticRoles.map(role => ({ ...role, required: true })) } }],
  ['duplicate source', { roleNodeIds: { items: ['library:paper', 'library:paper'] } }],
  ['missing required role', { roleNodeIds: {} }],
  ['unknown request field', { execute: true }],
  ['unsupported presentation role', { profile: { ...profile, surfaceRoles: [{ id: 'graph', primitive: 'GraphExplorer', semanticRoleRefs: ['items'] }] } }],
  ['unknown theme', { theme: 'custom' }],
]) test(`local composition refuses ${name} without writes`, t => {
  const world = worldFor(t), before = treeListing(world.projectDir)
  assert.equal(view(world, patch).ok, false)
  assert.deepEqual(treeListing(world.projectDir), before)
})

test('source title and summary are escaped, never interpreted as markup', t => {
  const world = worldFor(t, { files: { [first]: noteText({ id: 'library:paper', title: '<script>invented</script>', body: '<script>invented</script>' }) } })
  const result = view(world, { roleNodeIds: { items: ['library:paper'] } })
  assert.equal(result.ok, true)
  assert.doesNotMatch(result.html, /<script>/)
  assert.match(result.html, /&lt;script&gt;/)
})

test('draft and archived sources are withheld; unrelated active source survives', t => {
  for (const status of ['draft', 'archived']) {
    const world = worldFor(t, { files: {
      [first]: noteText({ id: 'library:paper', title: 'Withheld paper', body: 'Withheld text.' }).replace('status: "active"', `status: "${status}"`),
      [second]: noteText({ id: 'library:thread', title: 'Thread colors', body: 'Unrelated text remains.' }),
    } })
    assert.equal(view(world).ok, false)
    const survivor = view(world, { roleNodeIds: { items: ['library:thread'] } })
    assert.equal(survivor.ok, true)
    assert.match(survivor.html, /Unrelated text remains/)
    assert.doesNotMatch(survivor.html, /Withheld/)
  }
})

test('real source apply changes canonical bytes, rebinds preview and preserves an unrelated resource', { skip: !['darwin', 'linux'].includes(process.platform) && 'production atomic exchange unavailable' }, async t => {
  const world = worldFor(t), engine = world.engine()
  assert.equal((await engine.tick()).scopes[0].state, 'current')
  const before = view(world), untouched = fs.readFileSync(world.source(second))
  assert.equal(before.ok, true)
  world.editNote('library:paper', 'Three paper shapes', 'Four paper shapes')
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'held-for-your-edit')
  const edit = world.editOf('library:paper')
  assert.ok(edit)
  const apply = createSourceApply({ loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, clock: world.clock, quietPeriodMs: 0 })
  const applied = await apply.apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
  assert.equal(applied.status, 'applied', JSON.stringify(applied))
  assert.match(fs.readFileSync(world.source(first), 'utf8'), /Four paper shapes/)
  assert.deepEqual(fs.readFileSync(world.source(second)), untouched)
  const after = view(world)
  assert.equal(after.ok, true)
  assert.notDeepEqual(before.bindingRef, after.bindingRef)
  assert.notDeepEqual(before.records[0].ref, after.records[0].ref)
  assert.deepEqual(before.records[1].ref, after.records[1].ref)
  assert.match(after.html, /Four paper shapes/)
  assert.match(after.textPreview, /Four paper shapes/)
  assert.doesNotMatch(after.html, /Three paper shapes/)
  const stale = validateTemplateBinding(profile, before.binding, after.records)
  assert.equal(stale.ok, false)
  assert.ok(stale.errors.includes('dangling exact reference'))
  assert.equal((await apply.apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })).code, 'already-applied')
  world.advance(1000); await engine.tick()
  world.advance(1000); assert.equal((await engine.tick()).scopes[0].state, 'current')
  assert.match(fs.readFileSync(world.noteFile('library:paper'), 'utf8'), /Four paper shapes/)
})
