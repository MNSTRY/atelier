import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import Ajv2020 from 'ajv/dist/2020.js'
import { validatePanePresentation, validatePresentation, serializePresentation, parsePresentation, safeReference } from '../src/ui/presentation/contract.mjs'
import { presentationSchema } from '../src/ui/presentation/schema.generated.mjs'
import { matchesPresentationSchema } from '../src/ui/presentation/schema-check.mjs'
import { resolveTokens, contrastRatio, tokenVariables, tokenContract } from '../src/ui/presentation/tokens.mjs'
import { presentationStyles } from '../src/ui/presentation/styles.mjs'
import { presentationState, keyboardResize, resizeRequest, editValueError } from '../src/ui/presentation/state.mjs'
import { renderPresentationDocument, renderReadOnlyDocument } from '../src/ui/presentation/web.mjs'
import { createNativePresentation } from '../src/ui/presentation/native.mjs'
import { comparePresentationProofs } from '../src/ui/presentation/proof.mjs'
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/ui/presentation/reference.v1.json', import.meta.url), 'utf8'))
const fresh = () => structuredClone(fixture)
const validateAjv = new Ajv2020({ strict: true }).compile(presentationSchema)

test('reference has every implemented family and remains unchanged by rendering', () => {
  const before = serializePresentation(fixture)
  assert.deepEqual(validatePresentation(fixture), [])
  assert.deepEqual(parsePresentation(before), fixture)
  const html = renderPresentationDocument(fixture)
  assert.match(html, /Working area/)
  assert.equal(serializePresentation(fixture), before)
  for (const node of fixture.nodes) assert(html.includes(node.label))
})
test('schema projections match canonical JSON exactly', () => {
  execFileSync(process.execPath, ['scripts/generate-presentation-schema.mjs', '--check'], { cwd: new URL('../', import.meta.url) })
  assert.deepEqual(presentationSchema, JSON.parse(fs.readFileSync(new URL('../contracts/atelier-presentation.v1.schema.json', import.meta.url), 'utf8')))
})
test('portable validator agrees with AJV on fixture and structural mutations', () => {
  const cases = [fixture, null, [], {}, 3, 'invalid']
  for (const key of Object.keys(fixture)) {
    const missing = fresh(); delete missing[key]; cases.push(missing)
    for (const value of [null, {}, [], '', false, 0, 'unknown']) { const changed = fresh(); changed[key] = value; cases.push(changed) }
  }
  for (let i = 0; i < fixture.nodes.length; i++) for (const key of Object.keys(fixture.nodes[i])) {
    const missing = fresh(); delete missing.nodes[i][key]; cases.push(missing)
    for (const value of [null, [], {}, 0, false, '']) { const changed = fresh(); changed.nodes[i][key] = value; cases.push(changed) }
  }
  for (const value of cases) assert.equal(matchesPresentationSchema(presentationSchema, value), validateAjv(value))
  assert(cases.length > 600)
})
const mutations = {
  version: x => { x.version = '2.0.0' },
  commandRegistration: x => { x.commands = [] },
  duplicateIdentity: x => { x.nodes[0].id = x.panes[0].id },
  missingBlock: x => { x.panes[0].blocks.push('absent') },
  repeatedBlock: x => { x.panes[0].blocks.push(x.panes[0].blocks[0]) },
  missingNavigation: x => { x.navigation[0].target = 'absent' },
  noPrimary: x => { x.panes[0].role = 'context' },
  twoPrimary: x => { x.panes[1].role = 'primary' },
  invalidBounds: x => { x.panes[0].width.min = 80 },
  outOfRange: x => { x.panes[0].width.value = 90 },
  duplicateItems: x => { x.nodes.find(n => n.type === 'collection').items[1].id = 'circle' },
  unknownEndpoint: x => { x.nodes.find(n => n.type === 'graph').edges[0].to = 'unknown' },
  absentReason: x => { delete x.nodes.find(n => n.disabled && n.type === 'action').reason },
  missingAction: x => { x.nodes.find(n => n.type === 'publication').actions = ['missing'] },
  repeatedAction: x => { x.nodes.find(n => n.type === 'review').actions = ['confirm-action'] },
  unmountedNode: x => { x.nodes.push({ id: 'unmounted', type: 'text', label: 'Extra', text: 'Extra' }) },
  javascriptLink: x => { x.nodes.find(n => n.type === 'collection').items[0].href = 'javascript:void(0)' },
  networkLink: x => { x.nodes.find(n => n.type === 'collection').items[0].href = 'https://example.test' },
}
for (const [name, mutate] of Object.entries(mutations)) test('refuses ' + name, () => {
  const value = fresh(); mutate(value)
  assert(validatePresentation(value).length > 0)
  assert.throws(() => renderPresentationDocument(value))
})
test('refuses cycles, accessors, oversized data and unsupported schema keys', () => {
  const cyclic = fresh(); cyclic.extra = cyclic
  assert(validatePresentation(cyclic).length)
  const accessor = fresh(); Object.defineProperty(accessor, 'title', { get() { throw new Error('must not execute') } })
  assert(validatePresentation(accessor).length)
  assert.throws(() => parsePresentation(' '.repeat(1048577)))
  assert.throws(() => matchesPresentationSchema({ format: 'unknown' }, 'value'))
})
test('pane schema checks geometry and required labels', () => {
  assert.deepEqual(validatePanePresentation(fixture.panes[0]), [])
  assert(validatePanePresentation({ ...fixture.panes[0], label: '' }).length)
  assert(validatePanePresentation({ ...fixture.panes[0], width: { min: 70, value: 60, max: 80 } }).length)
})
test('text and attribute content is escaped, raw markup is never interpreted', () => {
  const model = fresh()
  model.title = '<script>not executable</script>'
  model.nodes.find(n => n.type === 'text').text = '<img src=x onerror=example>'
  model.nodes.find(n => n.type === 'field').value = '" autofocus data-example="'
  const html = renderPresentationDocument(model)
  assert(!html.includes('<script>not executable'))
  assert(html.includes('&lt;img'))
  assert(html.includes('&quot; autofocus'))
})
test('local resource allowlist refuses authority-changing URLs', () => {
  for (const url of ['javascript:example', '//example.test', '/\\example.test', '/%2fexample', 'data:text/plain,test', '/path\nbad']) assert.equal(safeReference(url), false)
  for (const url of ['/asset.svg', '#local', '/view?query=one']) assert.equal(safeReference(url), true)
  assert.equal(safeReference('#local', { asset: true }), false)
})
for (const theme of ['light', 'dark']) test(theme + ' neutral token envelope meets declared contrast and target floors', () => {
  const tokens = resolveTokens(theme)
  assert(Object.isFrozen(tokens.color))
  assert(tokens.density.target >= 44)
  for (const surface of ['page', 'panel', 'selected']) for (const text of ['text', 'muted', 'accent', 'danger', 'success']) assert(contrastRatio(tokens.color[text], tokens.color[surface]) >= 4.5)
  const css = presentationStyles(theme)
  assert(css.includes('prefers-reduced-motion'))
  assert(css.includes('forced-colors'))
  assert(css.includes(':focus-visible'))
  assert(css.includes(':active'))
  assert(css.includes('@media print'))
  assert(!css.includes('NARROW_WIDTH'))
  assert(tokenVariables(tokens).includes('--ap-density-target:44px'))
})
test('token overrides reject unknown keys, unsafe CSS, low contrast and undersized targets', () => {
  for (const overrides of [{ unknown: {} }, { color: { text: 'url(example)' } }, { color: { text: '#ffffff' } }, { density: { target: 10 } }, { typography: { body: 10 } }, { state: { focusWidth: 0 } }]) assert.throws(() => resolveTokens('light', overrides))
  assert.equal(resolveTokens('light', { typography: { family: 'serif' } }).typography.family, 'serif')
  assert.equal(tokenContract.typography.family, 'sans-serif')
})
test('state axes stay independent and widget resize is bounded', () => {
  const state = presentationState({ selected: true, focused: true, invalid: true, pending: true })
  assert(state.selected && state.focused && state.invalid && state.pending)
  assert.equal(state.pressed, false)
  assert.throws(() => presentationState({ granted: true }))
  const width = { min: 25, value: 50, max: 75 }
  assert.equal(keyboardResize(width, 'ArrowRight'), 51)
  assert.equal(keyboardResize(width, 'ArrowRight', 'rtl'), 49)
  assert.equal(keyboardResize(width, 'Home'), 25)
  assert.equal(keyboardResize(width, 'End'), 75)
  assert.equal(keyboardResize(width, 'F6'), null)
  assert.equal(resizeRequest(width, 99), 75)
})
test('rendered themes are isolated by root and style scopes reject selectors', () => {
  assert(presentationStyles('light', {}, 'one').includes('[data-ap-root="one"]'))
  assert(!presentationStyles('dark', {}, 'two').includes('[data-ap-root]{'))
  assert.throws(() => presentationStyles('light', {}, 'x"]body{'))
})
test('read-only document has no edit, resize or confirmation controls and retains host-state text', () => {
  const html = renderReadOnlyDocument(fixture)
  assert(!/<(?:input|textarea|button|dialog)\b/.test(html))
  assert(html.includes('unavailable in document'))
  for (const node of fixture.nodes) if (node.text) assert(html.includes(node.text))
})
test('native adapter is framework-injected and consumes host state without web imports', async () => {
  const state = [], requests = []
  const React = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, next => state.push(next)], useRef: value => ({ current: value }), useEffect: fn => fn() }
  const bindings = { React, View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView', Image: 'Image' }
  const Component = createNativePresentation(bindings)
  const tree = Component({ model: fixture, onRequest: r => requests.push(r), confirm: async () => true })
  const all = []
  const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); for (const child of node.children ?? []) walk(child) }
  walk(tree)
  const action = all.find(n => n.props?.accessibilityLabel === 'Request publication')
  assert(action)
  await action.props.onPress()
  assert.equal(requests[0].status, 'proposed')
  assert.equal(requests[0].executionAuthority, false)
  assert.equal(requests[0].presentationConfirmed, true)
  assert.equal(serializePresentation(fixture), serializePresentation(fresh()))
  assert.throws(() => createNativePresentation({}))
})
test('presentation imports do not install a transport or native dependency', () => {
  for (const file of ['contract.mjs', 'browser.mjs', 'native.mjs', 'state.mjs', 'tokens.mjs']) {
    const source = fs.readFileSync(new URL('../src/ui/presentation/' + file, import.meta.url), 'utf8')
    assert(!/from ['"](?:node:|react|@tamagui|@my\/|@mnstry\/sdk)/.test(source))
    assert(!/\b(?:fetch|localStorage|sessionStorage|WebSocket)\s*[.(]/.test(source))
  }
})
test('extension containers are inert metadata rather than interpreted authority', () => {
  const model = fresh()
  model.ext = { executionAuthority: true, command: 'invented-uninterpreted-value' }
  assert.deepEqual(validatePresentation(model), [])
  assert(!renderPresentationDocument(model).includes('invented-uninterpreted-value'))
  assert.deepEqual(parsePresentation(serializePresentation(model)).ext, model.ext)
})
test('visual comparison refuses missing, failed or drifted coverage and never accepts a baseline', () => {
  const proof = { schema: 'atelier.presentation-browser-proof/v1', status: 'passed', sourceHead: 'a'.repeat(40), sourceDigest: 'a'.repeat(64), runnerDigest: 'e'.repeat(64), fixtureDigest: 'b'.repeat(64),
    scope: 'synthetic-local-browser', nativeDeviceAccepted: false, adopterAccepted: false, visualBaselineAccepted: false,
    environment: { platform: 'fixture', release: 'fixture', architecture: 'fixture', locale: 'en-US', timezone: 'UTC', scale: 1, font: 'pinned-font', motion: 'reduce', viewports: [390], themes: ['light'], densities: ['comfortable'] },
    runs: [{ browser: 'chromium', version: 'fixture-version', status: 'passed', checks: ['fixture-check'], screenshots: [{ file: 'frame.png', sha256: 'c'.repeat(64), conditions: { width: 390, height: 960, theme: 'light', density: 'comfortable', font: 'pinned-font', motion: 'reduce', locale: 'en-US', scale: 1 } }] }] }
  assert.equal(comparePresentationProofs(null, proof).status, 'incomparable')
  assert.equal(comparePresentationProofs(proof, { ...proof, status: 'failed' }).status, 'incomparable')
  assert.equal(comparePresentationProofs(proof, { ...proof, environment: { font: 'other-font' } }).status, 'incomparable')
  assert.equal(comparePresentationProofs(proof, { ...proof, runs: [] }).status, 'incomparable')
  const changed = structuredClone(proof); changed.runs[0].screenshots[0].sha256 = 'd'.repeat(64)
  assert.deepEqual(comparePresentationProofs(proof, changed).changedFrames, ['chromium:frame.png'])
  const same = comparePresentationProofs(proof, proof)
  assert.equal(same.status, 'unchanged'); assert.equal(same.baselineApprovalVerified, false); assert.equal(same.executionAuthority, false)
  for (const mutate of [p => { p.environment = {} }, p => { p.runs = [null] }, p => { p.runs[0].checks = [null] }, p => { p.runs[0].screenshots = [null] }, p => { delete p.runs[0].screenshots[0].conditions }, p => { p.extra = true }, p => { p.runs[0].screenshots[0].conditions.width = 1440 }]) {
    const bad = structuredClone(proof); mutate(bad)
    assert.equal(comparePresentationProofs(bad, bad).status, 'incomparable')
  }
  const changedRunner = structuredClone(proof); changedRunner.runnerDigest = 'f'.repeat(64)
  assert.equal(comparePresentationProofs(proof, changedRunner).status, 'incomparable')
  assert.equal(comparePresentationProofs({ get schema() { throw new Error('must not execute') } }, proof).status, 'incomparable')
})
test('edit limits count complete Unicode points without truncating', () => {
  assert.equal(editValueError('a'.repeat(32767) + '😀'), null)
  assert.equal(editValueError('😀'.repeat(32768)), null)
  assert(editValueError('a'.repeat(32768) + '😀'))
  assert(editValueError('\ud83d'))
})
test('accepted serialization always fits its own parser including extension bytes', () => {
  for (const text of ['a'.repeat(1000000), '😀'.repeat(245000)]) {
    const model = fresh(); model.ext = { text }
    assert.deepEqual(validatePresentation(model), [])
    assert.deepEqual(parsePresentation(serializePresentation(model)), model)
  }
  const large = fresh(); large.ext = { text: '😀'.repeat(262144) }
  assert(validatePresentation(large).length)
  assert.throws(() => serializePresentation(large))
  const many = fresh()
  for (let i = 0; i < 40; i++) { const id = 'large-' + i; many.nodes.push({ id, type: 'text', label: 'Text', text: 'a'.repeat(32768) }); many.panes[0].blocks.push(id) }
  assert(validatePresentation(many).length)
  assert.throws(() => serializePresentation(many))
})
test('standalone pane metadata embeds without shape conversion', () => {
  const model = fresh(); model.panes[0].contractVersion = '1.0.0'
  assert.deepEqual(validatePanePresentation(model.panes[0]), [])
  assert.deepEqual(validatePresentation(model), [])
})
