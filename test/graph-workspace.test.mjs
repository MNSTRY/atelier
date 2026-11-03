import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWorkspaceModel, zoneOf, validateZoneRule, edgeClass, neighbours,
  seedPositions, layoutWorkspace, normalizePositions, zoneGeometry,
  planMap, planConstellation, aggregateZones, zoneSlice, rankRecords, DEPRECATED_ROOMS,
  placeLabels, labelBudget, overlaps,
  DEFAULT_RECIPES, composeRecipes, validateRecipe, availableRecipes, primaryActionsFor, LAYERS, ROOMS,
  DEFAULT_THEME, composeTheme, validateTheme, contrastRatio,
  conceptSteps, relationSteps, guideConcept, guideRelation, stepState, createDraftStore, memoryStorage, readiness,
  fingerprintsFrom, scanForFingerprints,
} from '../src/graph-workspace/index.mjs'
import { generateCommons } from './helpers/graph-workspace-commons.mjs'

const fixture = generateCommons({ size: 400, seed: 11 })
const model = () => buildWorkspaceModel(fixture)

test('model: zones come from folders, edges keep direction in three classes, concepts only from own tags', () => {
  const m = model()
  assert.equal(m.schema, 'atelier.graph-workspace-model@v1')
  assert.equal(m.nodes.length, 400)
  assert.equal(m.zones.reduce((s, z) => s + z.count, 0), 400)
  assert.deepEqual(new Set(m.edges.map(e => e.kind)), new Set(['link', 'containment', 'relation']))
  assert.equal(edgeClass('related'), 'link'); assert.equal(edgeClass('belongs_to'), 'containment'); assert.equal(edgeClass('supports'), 'relation')
  const declared = new Set(fixture.graph.nodes.filter(n => n.tags.includes('concept:program')).map(n => n.id))
  assert.deepEqual(new Set(m.plan.concepts.find(c => c.id === 'program').declaredBy), declared)
  const e = m.edges.find(x => x.kind === 'relation')
  const original = fixture.graph.edges.find(x => x.source === e.source && x.target === e.target && x.type === e.type)
  assert.ok(original, 'direction preserved')
  assert.ok(neighbours(m, e.source).includes(e.target))
})

test('model: links to records outside the readable set are counted, never drawn', () => {
  const graph = { ...fixture.graph, edges: [...fixture.graph.edges, { source: fixture.graph.nodes[0].id, target: 'elsewhere:hidden', type: 'related' }] }
  const m = buildWorkspaceModel({ ...fixture, graph })
  assert.equal(m.coverage.linksOutsideReadableSet, 1)
  assert.ok(!m.edges.some(x => x.target === 'elsewhere:hidden'))
})

test('model: refuses duplicate ids, a wrong schema and unsafe zone rules', () => {
  assert.throws(() => buildWorkspaceModel({ graph: { ...fixture.graph, nodes: [fixture.graph.nodes[0], fixture.graph.nodes[0]] } }), /unique/)
  assert.throws(() => buildWorkspaceModel({ graph: { schema: 'other', nodes: [], edges: [] } }), /knowledge graph v1/)
  assert.throws(() => validateZoneRule({ prefix: '../x' }), /prefix/)
  assert.throws(() => validateZoneRule({ depth: 9 }), /depth/)
  assert.deepEqual(zoneOf('notes/field-studies/a.md', { prefix: 'notes/', labels: { 'field-studies': 'Field' } }), { id: 'field-studies', label: 'Field' })
  assert.equal(zoneOf('README.md', { prefix: 'notes/' }).id, '/')
  assert.equal(zoneOf('notes/_root/a.md', { prefix: 'notes/' }).id, '_root', 'a folder named _root is its own zone')
})

test('geometry: layout is injected, normalised and zone-seeded', () => {
  const m = model()
  assert.throws(() => layoutWorkspace(m, {}), /Inject/)
  const start = seedPositions(m, { seed: 3 })
  assert.deepEqual(seedPositions(m, { seed: 3 }).get(m.nodes[0].id), start.get(m.nodes[0].id))
  class FakeGraph {
    constructor() { this.nodes = new Map(); this.order = 0 }
    addNode(id, a) { this.nodes.set(id, { ...a }); this.order++ }
    addEdge() {}
    forEachNode(fn) { for (const [id, a] of this.nodes) fn(id, a) }
  }
  const fa2 = { inferSettings: () => ({}), assign: () => {} }
  const info = layoutWorkspace(m, { Graph: FakeGraph, forceAtlas2: fa2 })
  assert.equal(info.algorithm, 'forceatlas2-linlog')
  const xs = m.nodes.map(n => n.x), ys = m.nodes.map(n => n.y)
  assert.ok(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) <= 1000.5)
  const zones = zoneGeometry(m)
  assert.equal(zones.length, m.zones.length)
  for (const z of zones) assert.ok(z.blobs.reduce((s, b) => s + b.weight, 0) === z.count && Number.isFinite(z.anchor.x))
  assert.equal(normalizePositions({ nodes: [{ id: 'a' }] }, new Map([['a', { x: 5, y: 5 }]])).nodes[0].x, 0)
})

test('scale: tens of thousands of records aggregate into zones with honest counts and bounded slices', () => {
  const big = generateCommons({ size: 30000, seed: 5 })
  const started = Date.now()
  const m = buildWorkspaceModel(big)
  const plan = planMap(m)
  assert.equal(plan.mode, 'zones')
  assert.equal(plan.reason, 'records-over-budget')
  const z = aggregateZones(m)
  assert.equal(z.zones.reduce((s, x) => s + x.count, 0), 30000)
  assert.equal(z.coverage.linksInsideZones + z.coverage.linksBetweenZones, m.edges.length)
  assert.equal(z.bundles.reduce((s, b) => s + b.total, 0), z.coverage.linksBetweenZones)
  for (const b of z.bundles) assert.equal(b.link + b.containment + b.relation, b.total)
  const zone = z.zones[0]
  const slice = zoneSlice(m, zone.id, { limit: 2000 })
  assert.equal(slice.nodes.length, Math.min(2000, zone.count))
  assert.equal(slice.slice.omittedRecords, zone.count - slice.nodes.length)
  const keep = new Set(slice.nodes.map(n => n.id))
  assert.ok(slice.edges.every(e => keep.has(e.source) && keep.has(e.target)))
  assert.ok(slice.slice.linksToOtherZones.every(b => b.zone !== zone.id && b.count > 0))
  assert.equal(rankRecords(m)[0].degree, Math.max(...m.nodes.map(n => n.degree)))
  assert.ok(Date.now() - started < 15000, 'aggregation stays interactive-scale')
  assert.equal(planMap(model()).mode, 'records')
})

test('labels: no overlap, reserved space respected, budget honoured, edges fall back to other slots', () => {
  const measure = text => text.length * 7
  const candidates = Array.from({ length: 120 }, (_, i) => ({ id: 'n' + i, x: 40 + (i % 12) * 60, y: 40 + Math.floor(i / 12) * 30, r: 4, priority: 1 - i / 120, text: 'Record number ' + i, size: 12 }))
  const reserved = [{ left: 0, top: 0, right: 300, bottom: 60 }]
  const placed = placeLabels({ candidates, measure, width: 800, height: 400, reserved, budget: 30 })
  assert.ok(placed.length > 5 && placed.length <= 30)
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!overlaps(placed[i], placed[j]), 'labels overlap')
  assert.ok(placed.every(p => !overlaps(p, reserved[0]) && p.left >= 4 && p.right <= 796))
  const edge = placeLabels({ candidates: [{ id: 'edge', x: 790, y: 200, r: 4, priority: 1, text: 'Near the right edge', size: 12 }], measure, width: 800, height: 400 })
  assert.equal(edge.length, 1)
  assert.ok(edge[0].right <= 796 && edge[0].x < 790, 'placed to the left')
  assert.ok(placeLabels({ candidates, measure, width: 800, height: 400, budget: 50 }).every(p => p.size >= 11))
  assert.ok(labelBudget(1440, 900, 1) >= 20 && labelBudget(1440, 900, 1) <= 30)
})

test('recipes: Atelier defaults, distribution adjustments and owner choices compose with provenance', () => {
  const { recipes, hidden } = composeRecipes({
    distribution: [{ id: 'explore', label: 'Wander' }, { id: 'compare', label: 'Compare two areas', room: 'map', lens: 'zone', primary: 'pick', description: 'Two areas side by side.' }],
    owner: [{ id: 'inspect', hidden: true }, { id: 'compare', description: 'My two folders, side by side.' }],
  })
  assert.deepEqual(hidden, ['inspect'])
  const explore = recipes.find(r => r.id === 'explore'), compare = recipes.find(r => r.id === 'compare')
  assert.equal(explore.label, 'Wander'); assert.equal(explore.setBy.label, 'distribution'); assert.equal(explore.setBy.room, 'atelier')
  assert.equal(compare.setBy.room, 'distribution'); assert.equal(compare.setBy.description, 'owner')
  assert.throws(() => composeRecipes({ owner: [{ id: 'new-one', label: 'Incomplete' }] }), /owner recipe new-one/)
  assert.throws(() => composeRecipes({ distribution: [{ id: 'explore', room: 'garden' }] }), /room must be/)
  assert.throws(() => composeRecipes({ distribution: [{ id: 'bench', label: 'B', room: 'workbench', primary: 'walk', description: 'd' }] }), /needs a subject/)
  assert.deepEqual(validateRecipe(DEFAULT_RECIPES[0]), [])
  const noPlan = { plan: null, nodes: [{ id: 'a' }] }
  assert.deepEqual(availableRecipes(composeRecipes().recipes, noPlan).map(r => r.id), ['explore', 'inspect'])
})

test('recipes: only combinations the shell honours are accepted or offered', () => {
  const add = recipe => composeRecipes({ distribution: [{ label: 'L', description: 'D', ...recipe }] })
  assert.throws(() => add({ id: 'odd', room: 'map', primary: 'teleport' }), /primary must be one of/)
  assert.throws(() => add({ id: 'odd', room: 'workbench', subject: 'record', lens: 'zone', primary: 'walk' }), /only a map recipe takes a lens/)
  assert.throws(() => add({ id: 'odd', room: 'review', lens: 'concept', primary: 'review' }), /only a map recipe takes a lens/)
  assert.throws(() => add({ id: 'odd', room: 'map', subject: 'record', primary: 'search' }), /only a workbench recipe takes a subject/)
  assert.throws(() => composeRecipes({ owner: [{ id: 'refine', room: 'map' }] }), /only a workbench recipe takes a subject/)
  // Every accepted action has a target in its room.
  assert.throws(() => composeRecipes({ owner: [{ id: 'explore', primary: 'pick' }] }), /primary pick is not available here; use search/)
  assert.throws(() => composeRecipes({ owner: [{ id: 'refine', primary: 'review' }] }), /primary review is not available here; use next-step/)
  assert.throws(() => composeRecipes({ owner: [{ id: 'inspect', primary: 'next-step' }] }), /use walk/)
  assert.throws(() => add({ id: 'odd', room: 'review', primary: 'search' }), /use review/)
  assert.throws(() => add({ id: 'odd', room: 'map', lens: 'zone', primary: 'open-evidence' }), /use pick or search/)
  for (const r of DEFAULT_RECIPES) assert.ok(primaryActionsFor(r).includes(r.primary), r.id)
  const { recipes } = composeRecipes({ distribution: [
    { id: 'check', label: 'Check', description: 'D', room: 'review', primary: 'review' },
    { id: 'bind', label: 'Bind', description: 'D', room: 'workbench', subject: 'relation', primary: 'next-step' },
    { id: 'by-concept', label: 'By concept', description: 'D', room: 'map', lens: 'concept', primary: 'open-evidence' },
    { id: 'by-zone', label: 'By area', description: 'D', room: 'map', lens: 'zone', primary: 'pick' },
  ] })
  const m = model()
  assert.deepEqual(availableRecipes(recipes, m).map(r => r.id), recipes.map(r => r.id), 'a full plan runs every recipe')
  const noRelations = { ...m, plan: { ...m.plan, relations: [] } }
  assert.ok(!availableRecipes(recipes, noRelations).some(r => r.id === 'bind'))
  const noConcepts = { ...m, plan: { concepts: [], relations: [], questions: [] } }
  assert.deepEqual(availableRecipes(recipes, noConcepts).map(r => r.id), ['explore', 'inspect', 'by-zone'])
  assert.deepEqual(availableRecipes(recipes, { plan: null, nodes: [], zones: [] }).map(r => r.id), ['explore'], 'no zones, no zone recipe')
  const empty = buildWorkspaceModel({ graph: { ...fixture.graph, nodes: [], edges: [] } })
  assert.deepEqual(availableRecipes(recipes, empty).map(r => r.id), ['explore'])
})

test('theme: night is the default, overrides validate, unsafe or low-contrast values are refused', () => {
  assert.deepEqual(validateTheme(DEFAULT_THEME), [])
  assert.equal(DEFAULT_THEME.defaultScheme, 'dark')
  const distribution = composeTheme(DEFAULT_THEME, { id: 'distribution-theme', schemes: { dark: { vars: { '--accent': '#a0e0c0' } } } })
  assert.equal(distribution.schemes.dark.vars['--accent'], '#a0e0c0')
  assert.equal(DEFAULT_THEME.schemes.dark.vars['--accent'], '#9cc4ff', 'base untouched')
  assert.throws(() => composeTheme(DEFAULT_THEME, { schemes: { dark: { vars: { '--canvas': 'url(x)' } } } }), /rejected --canvas/)
  assert.throws(() => composeTheme(DEFAULT_THEME, { schemes: { dark: { graph: { label: '#1a1d24' } } } }), /label contrast/)
  assert.ok(contrastRatio('#000000', '#ffffff') > 20)
})

test('theme: every layer is typed and checked; resource loading and unreadable chrome are refused', () => {
  const layer = vars => ({ id: 'l', schemes: { dark: { vars } } })
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--font-sans': 'image-set("https://x.test/a.png" 1x)' })), /--font-sans/)
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--shadow': '0 0 0 url(x)' })), /--shadow/)
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--unknown': '#fff' })), /--unknown/)
  assert.throws(() => composeTheme(DEFAULT_THEME, { id: 'l', extra: 1 }), /extra/)
  assert.throws(() => composeTheme(DEFAULT_THEME, { id: 'l', schemes: { sepia: { vars: {} } } }), /sepia/)
  assert.throws(() => composeTheme(DEFAULT_THEME, { id: 'l', schemes: { dark: { graph: { glow: '#fff' } } } }), /glow/)
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--ink-3': '#20232b' })), /--ink-3 on --canvas is below/)
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--canvas': '#123456' })), /canvas/)
  // A later valid layer cannot launder an earlier invalid one.
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--accent': 'url(x)' }), layer({ '--accent': '#a0e0c0' })), /--accent/)
  assert.ok(composeTheme(DEFAULT_THEME, layer({ '--shadow': '0 8px 24px rgba(0, 0, 0, 0.4)' })))
  // Chrome text sits on translucent glass; a glass that hides it is refused.
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--surface-glass': '#eef1f7' })), /--ink on --surface-glass over --canvas/)
  assert.throws(() => composeTheme(DEFAULT_THEME, layer({ '--surface-glass': 'rgba(238, 241, 247, 0.9)' })), /--surface-glass/)
  assert.ok(composeTheme(DEFAULT_THEME, layer({ '--surface-glass': 'rgba(20, 24, 32, 0.8)' })))
})

test('scale: a zone slice conserves every link and projects plan declarations onto kept records', () => {
  const m = buildWorkspaceModel(generateCommons({ size: 3000, seed: 9 }))
  for (const zone of m.zones.slice(0, 3)) {
    const slice = zoneSlice(m, zone.id, { limit: Math.max(1, Math.floor(zone.count / 3)) })
    const x = slice.slice
    assert.equal(slice.edges.length + x.omittedLinksInsideZone + x.linksToOtherZonesCount + x.omittedLinksToOtherZones, x.linksTouchingZone)
    const members = new Set(m.nodes.filter(n => n.zone === zone.id).map(n => n.id))
    assert.equal(x.linksTouchingZone, m.edges.filter(e => members.has(e.source) || members.has(e.target)).length)
    assert.equal(x.linksToOtherZones.reduce((a, b) => a + b.count, 0), x.linksToOtherZonesCount)
    assert.equal(Object.values(slice.coverage.byClass).reduce((a, b) => a + b, 0), slice.edges.length)
    const keep = new Set(slice.nodes.map(n => n.id))
    for (const c of slice.plan.concepts) {
      assert.ok(c.declaredBy.every(id => keep.has(id)), 'no dangling declarations')
      assert.equal(c.declaredBy.length + c.omittedDeclarations, m.plan.concepts.find(o => o.id === c.id).declaredBy.length)
    }
  }
})

test('authoring: steps, structural guidance, plan wording state, storage-port drafts and readiness', () => {
  const m = model()
  const concept = m.plan.concepts.find(c => c.id === 'hypothesis')
  assert.equal(conceptSteps(concept).length, 6)
  assert.match(relationSteps(m.plan.relations[0], id => id)[2].help, /no inverse relation/)
  const g = guideConcept(concept, { definition: 'Short.', identityRule: 'Same title.', example: 'A', nearMiss: 'a', evidence: [], disconfirming: '' })
  assert.ok(g.fields.definition.some(x => /boundary/.test(x.text)))
  assert.ok(g.fields.identityRule.some(x => /Names alone/.test(x.text)))
  assert.ok(g.fields.nearMiss.some(x => /must differ/.test(x.text)))
  assert.ok(guideRelation({ meaning: 'This proves it', forward: 'a', reverse: 'a' }).fields.reverse.length)
  assert.equal(stepState(concept.definition, [], false, concept.definition), 'plan')
  assert.equal(stepState('', [], true), 'deferred')
  const storage = memoryStorage()
  const identity = { workspace: 'commons' }
  const store = createDraftStore({ storage, key: 'k', identity, delayMs: 0 })
  assert.equal(readiness(m.plan, store, new Set()).status, 'nothing-drafted')
  assert.throws(() => readiness(m.plan, store), /readable record ids/)
  const d = store.concept(concept)
  Object.assign(d, { definition: 'A recorded claim we can test, distinct from a decision.', identityRule: 'One id per claim; rewording is a revision.', example: 'A dated claim.', nearMiss: 'A decision citing it.', disconfirming: 'Two claims under one id.', evidence: [{ id: m.nodes[0].id }] })
  store.changed()
  assert.equal(store.status, 'saved')
  const again = createDraftStore({ storage, key: 'k', identity })
  assert.equal(again.status, 'restored')
  assert.equal(readiness(m.plan, again, new Set(m.nodes.map(n => n.id))).status, 'ready-for-human-review')
  const unreadable = readiness(m.plan, again, new Set())
  assert.equal(unreadable.status, 'needs-attention', 'a citation the reader cannot open blocks readiness')
  assert.ok(unreadable.errors > 0)
  assert.throws(() => createDraftStore({ storage, identity }), /draft key/)
  assert.throws(() => createDraftStore({ storage, key: 'k' }), /identity/)
  assert.throws(() => createDraftStore({ storage, key: 'k', identity, persistence: 'cloud' }), /persistence/)
})

test('authoring: relation drafts need readable evidence before they are ready', () => {
  const m = model()
  const rel = m.plan.relations[0]
  const steps = relationSteps(rel)
  assert.deepEqual(steps.map(x => x.id), ['meaning', 'forward', 'reverse', 'evidence', 'disconfirming'])
  const store = createDraftStore({ storage: memoryStorage(), key: 'r', identity: { workspace: 'w' }, delayMs: 0 })
  Object.assign(store.relation(rel), { meaning: 'Lets you check which program a study informs.', forward: 'The study informs the program.', reverse: 'The program draws on the study.', disconfirming: 'A program that ignores every study.' })
  store.changed()
  const readable = new Set(m.nodes.map(n => n.id))
  let r = readiness({ ...m.plan, concepts: [] }, store, readable)
  assert.equal(r.status, 'needs-attention', 'no evidence, not ready')
  assert.ok(r.items[0].guide.fields.evidence.some(x => /Cite at least one/.test(x.text)))
  store.relationDraft(rel.id).evidence.push({ id: m.nodes[0].id })
  r = readiness({ ...m.plan, concepts: [] }, store, readable)
  assert.equal(r.status, 'ready-for-human-review')
  r = readiness({ ...m.plan, concepts: [] }, store, new Set())
  assert.equal(r.status, 'needs-attention', 'unreadable relation evidence blocks readiness')
  assert.ok(r.items[0].guide.fields.evidence.some(x => /not readable here/.test(x.text)))
  const storage = memoryStorage()
  const a = createDraftStore({ storage, key: 'k', identity: { workspace: 'w' }, delayMs: 0 })
  a.relation(rel).evidence.push({ id: m.nodes[1].id, title: 'T' }); a.changed()
  assert.equal(createDraftStore({ storage, key: 'k', identity: { workspace: 'w' } }).relationDraft(rel.id).evidence[0].id, m.nodes[1].id, 'relation evidence persists')
})

test('model: the synthetic root zone never merges with a folder named _root', () => {
  const node = (id, path) => ({ id, title: id, summary: '', repo: 'r', path, type: 'note', status: 'active', audience: 'team', tags: [], relations: {} })
  const nodes = [node('readme', 'README.md'), node('a', 'notes/_root/a.md'), node('b', 'notes/_root/b.md')]
  const edges = [{ source: 'readme', target: 'a', type: 'related' }, { source: 'a', target: 'b', type: 'related' }]
  const m = buildWorkspaceModel({ graph: { ...fixture.graph, nodes, edges }, zoneRule: { prefix: 'notes/' } })
  assert.deepEqual(m.zones.map(z => [z.id, z.count]).sort(), [['/', 1], ['_root', 2]])
  const agg = aggregateZones(m)
  assert.equal(agg.coverage.linksBetweenZones, 1); assert.equal(agg.coverage.linksInsideZones, 1)
  const slice = zoneSlice(m, '_root')
  assert.deepEqual(slice.nodes.map(n => n.id).sort(), ['a', 'b'])
  assert.equal(slice.slice.linksToOtherZonesCount, 1)
  assert.deepEqual(zoneSlice(m, '/').nodes.map(n => n.id), ['readme'])
})

test('model: folders named like inherited properties are ordinary zones', () => {
  const nodes = ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((folder, i) => ({ id: 'n' + i, title: 'Note ' + i, summary: '', repo: 'r', path: `notes/${folder}/note-${i}.md`, type: 'constructor', status: 'active', audience: 'team', tags: [], relations: {} }))
  const m = buildWorkspaceModel({ graph: { ...fixture.graph, nodes, edges: [] }, zoneRule: { prefix: 'notes/', depth: 1 } })
  assert.equal(m.zones.length, 4)
  for (const z of m.zones) assert.equal(typeof z.label, 'string', z.id)
  assert.equal(zoneOf('notes/constructor/a.md', { prefix: 'notes/' }).label, 'Constructor')
  const agg = aggregateZones(m)
  for (const z of agg.zones) assert.equal(z.types.constructor, 1)
})

test('authoring: drafts are bound to one workspace identity and survive hostile ids', () => {
  const storage = memoryStorage()
  const a = createDraftStore({ storage, key: 'shared', identity: { workspace: 'one' }, delayMs: 0, persistence: 'browser' })
  a.concept({ id: 'program' }).definition = 'Owned by workspace one.'
  a.changed()
  const b = createDraftStore({ storage, key: 'shared', identity: { workspace: 'two' }, delayMs: 0 })
  assert.equal(b.status, 'empty', 'another workspace with the same key never sees the draft')
  assert.equal(b.conceptDraft('program'), undefined)
  assert.equal(a.persistence, 'browser'); assert.equal(b.persistence, 'tab')
  const scoped = createDraftStore({ storage, key: 'shared', identity: { workspace: 'one', reader: 'r2' } })
  assert.equal(scoped.status, 'empty', 'reader scope is part of the identity')
  assert.equal(createDraftStore({ storage, key: 'shared', identity: { workspace: 'one' } }).status, 'restored')

  const s2 = memoryStorage()
  const hostile = createDraftStore({ storage: s2, key: 'h', identity: { workspace: 'w' }, delayMs: 0 })
  for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(hostile.conceptDraft(id), undefined)
    const d = hostile.concept({ id, definition: 'x' })
    assert.equal(d.definition, 'x')
    assert.equal(hostile.relationDraft(id), undefined)
  }
  assert.equal(hostile.deferred('concept', 'constructor', 'definition'), false)
  s2.setItem('h', JSON.stringify({ schema: 'atelier.graph-workspace-draft@v1', identity: JSON.stringify([['workspace', 'w']]), data: JSON.parse('{"concepts":{"__proto__":{"definition":"p"},"ok":{"definition":"fine","evidence":[{"id":"x"},{"nope":1}]}},"deferred":{"a":"yes"}}') }))
  const restored = createDraftStore({ storage: s2, key: 'h', identity: { workspace: 'w' } })
  assert.equal(restored.status, 'restored')
  assert.equal(Object.getPrototypeOf(restored.data.concepts), null, 'drafts are plain dictionaries')
  assert.equal(restored.conceptDraft('ok').evidence.length, 1)
  assert.equal(({}).definition, undefined, 'no prototype pollution')
  const plan = { concepts: [{ id: 'constructor', title: 'C', definition: '' }], relations: [{ id: 'toString', from: 'a', to: 'b', predicate: 'p' }] }
  assert.equal(readiness(plan, createDraftStore({ storage: memoryStorage(), key: 'z', identity: { workspace: 'w' } }), new Set()).status, 'nothing-drafted')
})

test('disclosure: fingerprints from a private graph are found in shareable text and masked', () => {
  const fps = fingerprintsFrom({ graph: fixture.graph, plan: fixture.plan, names: ['Example owner workspace'], extra: ['#123456'] })
  assert.ok(fps.includes(fixture.graph.nodes[0].id))
  assert.ok(!fps.includes('Archive'), 'short common words are not fingerprints')
  const clean = scanForFingerprints([{ path: 'a.js', text: 'export const x = 1' }], fps)
  assert.equal(clean.ok, true)
  const leak = scanForFingerprints([{ path: 'b.md', text: `see ${fixture.graph.nodes[3].id} here` }], fps)
  assert.equal(leak.ok, false)
  assert.equal(leak.findings[0].path, 'b.md')
  assert.ok(!leak.findings[0].sample.includes(fixture.graph.nodes[3].id), 'sample is masked')
})

test('alpha.15 names keep working for one release: coach layer, constellation room, planConstellation', () => {
  assert.equal(planConstellation, planMap)
  assert.deepEqual(DEPRECATED_ROOMS, { constellation: 'map' })
  const old = composeRecipes({ coach: [{ id: 'explore', label: 'Wander' }, { id: 'by-zone', label: 'By area', description: 'D', room: 'constellation', lens: 'zone', primary: 'pick' }] }).recipes
  const explore = old.find(r => r.id === 'explore'), zone = old.find(r => r.id === 'by-zone')
  assert.equal(explore.setBy.label, 'distribution', 'the coach layer is read as the distribution layer')
  assert.equal(zone.room, 'map', 'a constellation recipe is read as a map recipe')
  assert.deepEqual(validateRecipe({ id: 'x', label: 'X', description: 'D', room: 'constellation', primary: 'search' }), [])
  assert.throws(() => composeRecipes({ coach: [], distribution: [] }), /deprecated name/)
  assert.deepEqual(LAYERS, ['atelier', 'distribution', 'owner'])
  assert.deepEqual(ROOMS, ['map', 'workbench', 'review'])
})
