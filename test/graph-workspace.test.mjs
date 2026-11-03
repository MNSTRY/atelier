import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWorkspaceModel, zoneOf, validateZoneRule, edgeClass, neighbours,
  seedPositions, layoutWorkspace, normalizePositions, zoneGeometry,
  planConstellation, aggregateZones, zoneSlice, rankRecords,
  placeLabels, labelBudget, overlaps,
  DEFAULT_RECIPES, composeRecipes, validateRecipe, availableRecipes,
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
  assert.equal(zoneOf('README.md', { prefix: 'notes/' }).id, '_root')
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
  const plan = planConstellation(m)
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
  assert.equal(planConstellation(model()).mode, 'records')
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

test('recipes: Atelier defaults, coach adjustments and owner choices compose with provenance', () => {
  const { recipes, hidden } = composeRecipes({
    coach: [{ id: 'explore', label: 'Wander' }, { id: 'compare', label: 'Compare two areas', room: 'constellation', lens: 'zone', primary: 'pick-zones', description: 'Two areas side by side.' }],
    owner: [{ id: 'inspect', hidden: true }, { id: 'compare', description: 'My two folders, side by side.' }],
  })
  assert.deepEqual(hidden, ['inspect'])
  const explore = recipes.find(r => r.id === 'explore'), compare = recipes.find(r => r.id === 'compare')
  assert.equal(explore.label, 'Wander'); assert.equal(explore.setBy.label, 'coach'); assert.equal(explore.setBy.room, 'atelier')
  assert.equal(compare.setBy.room, 'coach'); assert.equal(compare.setBy.description, 'owner')
  assert.throws(() => composeRecipes({ owner: [{ id: 'new-one', label: 'Incomplete' }] }), /owner recipe new-one/)
  assert.throws(() => composeRecipes({ coach: [{ id: 'explore', room: 'garden' }] }), /room must be/)
  assert.throws(() => composeRecipes({ coach: [{ id: 'bench', label: 'B', room: 'workbench', primary: 'x', description: 'd' }] }), /needs a subject/)
  assert.deepEqual(validateRecipe(DEFAULT_RECIPES[0]), [])
  const noPlan = { plan: null }
  assert.deepEqual(availableRecipes(composeRecipes().recipes, noPlan).map(r => r.id), ['explore', 'inspect'])
})

test('theme: night is the default, overrides validate, unsafe or low-contrast values are refused', () => {
  assert.deepEqual(validateTheme(DEFAULT_THEME), [])
  assert.equal(DEFAULT_THEME.defaultScheme, 'dark')
  const coach = composeTheme(DEFAULT_THEME, { id: 'coach-theme', schemes: { dark: { vars: { '--accent': '#a0e0c0' } } } })
  assert.equal(coach.schemes.dark.vars['--accent'], '#a0e0c0')
  assert.equal(DEFAULT_THEME.schemes.dark.vars['--accent'], '#9cc4ff', 'base untouched')
  assert.throws(() => composeTheme(DEFAULT_THEME, { schemes: { dark: { vars: { '--canvas': 'url(x)' } } } }), /rejected --canvas/)
  assert.throws(() => composeTheme(DEFAULT_THEME, { schemes: { dark: { graph: { label: '#1a1d24' } } } }), /label contrast/)
  assert.ok(contrastRatio('#000000', '#ffffff') > 20)
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
  const store = createDraftStore({ storage, key: 'k', delayMs: 0 })
  assert.equal(readiness(m.plan, store).status, 'nothing-drafted')
  const d = store.concept(concept)
  Object.assign(d, { definition: 'A recorded claim we can test, distinct from a decision.', identityRule: 'One id per claim; rewording is a revision.', example: 'A dated claim.', nearMiss: 'A decision citing it.', disconfirming: 'Two claims under one id.', evidence: [{ id: m.nodes[0].id }] })
  store.changed()
  assert.equal(store.status, 'saved')
  const again = createDraftStore({ storage, key: 'k' })
  assert.equal(again.status, 'restored')
  assert.equal(readiness(m.plan, again, new Set(m.nodes.map(n => n.id))).status, 'ready-for-human-review')
  assert.equal(readiness(m.plan, again, new Set()).items[0].guide.warnings > 0, true)
  assert.throws(() => createDraftStore({ storage }), /draft key/)
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
