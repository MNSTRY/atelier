// Opt-in local browser acceptance. No service, live site, or browser download.
// The producer owns the shared fixture; this test never defines another graph.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { canonicalize } from '../src/attestation/jcs.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const enabled = process.env.ATELIER_STRUCTURED_BROWSER_PROOF === '1'

test('structured graph task, semantics and lifecycle from the shared producer fixture', { skip: !enabled, timeout: 90000 }, async () => {
  const { chromium } = await import('playwright')
  const { build } = await import('esbuild')
  const fixtureFile = path.resolve(process.env.ATELIER_GRAPH_VIEW_FIXTURE ?? path.join(root, 'fixtures/graph-view/synthetic-view.v1.json'))
  const bytes = fs.readFileSync(fixtureFile)
  const fixture = JSON.parse(bytes)
  const { projectionDigest, ...payload } = fixture
  assert.equal(projectionDigest, `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`)
  const output = path.resolve(process.env.ATELIER_STRUCTURED_PROOF_OUTPUT ?? path.join(root, 'output/playwright/graph-structured'))
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({ stdin: { contents: `import {mountStructuredGraphView} from './src/graph-view/structured/browser.mjs';
    window.start=(view)=>{window.binding?.destroy();window.view=structuredClone(view);window.intents=[];
      window.binding=mountStructuredGraphView(document.querySelector('#root'),{view,onIntent:async intent=>{
        window.intents.push(intent);if(window.reject)throw new Error('fixture delivery refused');
        if(window.delay){await new Promise(resolve=>window.release=resolve);return;}
        if(intent.type!=='expand'){const {type,...selection}=intent;window.binding.update({view:window.view,selection});}
      }});};`, resolveDir: root }, bundle: true, format: 'iife', platform: 'browser', write: false })
  const browser = await chromium.launch({ headless: true, args: ['--disable-webgl'] })
  const receipt = { scope: 'synthetic-structured-consumer', fixtureSha256: createHash('sha256').update(bytes).digest('hex'), projectionDigest,
    browser: browser.version(), sourceSha256: Object.fromEntries(['src/graph-view/structured/browser.mjs', 'src/graph-view/structured/styles.mjs', 'test/graph-view-structured-browser.test.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])), checks: [], humanScreenReaderAccepted: false, unseenParticipantAccepted: false, babylonTaskParityAccepted: false }
  const check = label => receipt.checks.push(label)
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' })
    const page = await context.newPage(); page.setDefaultTimeout(5000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.request().url() === 'http://structured.invalid/' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic graph proof</title><main id="root"></main></html>' }) : route.abort())
    await page.goto('http://structured.invalid/'); await page.addScriptTag({ content: bundle.outputFiles[0].text }); await page.evaluate(f => window.start(f), fixture)
    assert.equal(await page.evaluate(() => document.createElement('canvas').getContext('webgl')), null)
    check('WebGL disabled: structured task remains operational')
    const inspector = page.getByRole('complementary', { name: 'Evidence inspector' })
    const question = fixture.questions[0]
    await page.getByRole('button', { name: `${question.title} · ${question.coverage}`, exact: true }).focus(); await page.keyboard.press('Enter')
    assert.match(await inspector.innerText(), new RegExp(question.gaps[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await inspector.getByRole('button', { name: `Inspect ${fixture.evidence.find(e => e.evidenceId === question.evidenceRefs[0]).sourceRef.path}`, exact: true }).click()
    assert((await inspector.innerText()).includes(fixture.evidence.find(e => e.evidenceId === question.evidenceRefs[0]).sourceRef.path))
    check('question to exact source evidence')
    await page.getByRole('searchbox', { name: 'Search this view' }).fill('First observation')
    const records = () => page.getByRole('list', { name: 'Record search results' }).getByRole('button')
    assert.equal(await records().count(), 1)
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
    assert((await inspector.innerText()).includes('First observation'))
    assert(await records().first().evaluate(e => e === document.activeElement))
    assert.equal(await page.getByRole('button', { name: 'Explore outgoing', exact: true }).getAttribute('aria-pressed'), null)
    await page.getByRole('button', { name: 'Explore outgoing', exact: true }).click()
    assert.equal(await page.evaluate(() => window.intents.at(-1).direction), 'out')
    check('keyboard search selection preserves focus; directed expansion')
    await page.getByRole('button', { name: 'contradicts', exact: true }).focus(); await page.keyboard.press('Enter')
    const edge = fixture.edges.find(e => e.predicate === 'contradicts')
    const origin = fixture.evidence.find(e => e.evidenceId === edge.sourceRef)
    assert((await inspector.innerText()).includes(`${edge.source.repoId} / ${edge.source.localId} → ${edge.target.repoId} / ${edge.target.localId}`))
    for (const field of [origin.sourceRef.path, origin.sourceRef.revision, origin.sourceRef.digest]) assert((await inspector.innerText()).includes(field))
    assert((await inspector.innerText()).includes('Review receipts'))
    assert((await inspector.innerText()).includes('Staleness'))
    check('contradiction direction, exact origin, support, review, currency')
    const repeated = fixture.edges.filter(e => e.predicate === 'supports')
    assert.equal(await page.getByRole('table').getByRole('button', { name: 'supports', exact: true }).count(), repeated.length)
    await page.getByRole('table').getByRole('button', { name: 'supports', exact: true }).nth(1).click()
    assert((await inspector.innerText()).includes('/kg/relations/supports/1'))
    check('repeated triple keeps distinct provenance locator')
    await page.getByRole('searchbox').fill('')
    assert.equal(await records().count(), 4)
    await records().first().focus(); const before = await page.evaluate(() => window.intents.length); await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => window.intents.length), before)
    assert(await records().last().evaluate(e => e === document.activeElement))
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.intents.at(-1).ref.repoId), 'synthetic:workshop')
    check('qualified same-local-id selection; focus is separate')
    const unknownView = structuredClone(fixture); unknownView.questions[0] = { ...question, coverage: 'abstain', evidenceRefs: [], contradictingRefs: [], gaps: [] }
    await page.evaluate(f => window.start(f), unknownView)
    await page.getByRole('button', { name: `${question.title} · abstain`, exact: true }).click()
    assert((await inspector.innerText()).includes('The sources do not establish an answer.'))
    check('abstention variant remains explicit')
    for (const width of [320, 640, 1280]) {
      await page.setViewportSize({ width, height: 960 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
    }
    await page.evaluate(() => document.documentElement.style.zoom = '2')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
    await page.screenshot({ path: path.join(output, 'zoom-200.png'), fullPage: true })
    await page.evaluate(() => document.documentElement.style.zoom = '1')
    check('320px reflow and 200% CSS layout zoom; manual browser zoom still required')
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    assert.equal(await page.getByRole('searchbox').evaluate(e => getComputedStyle(e).transitionDuration), '0s')
    const snapshot = await page.locator('#root').ariaSnapshot()
    for (const text of ['table', 'columnheader "Source"', 'complementary "Evidence inspector"', 'searchbox "Search this view"']) assert(snapshot.includes(text))
    fs.writeFileSync(path.join(output, 'ax-tree.yml'), snapshot)
    await page.screenshot({ path: path.join(output, 'forced-colors.png'), fullPage: true })
    check('forced colors, reduced motion, accessibility tree structure')
    const stale = { projectionDigest: 'sha256:' + '0'.repeat(64), ref: fixture.nodes[0].ref }
    await page.evaluate(({ view, selection }) => window.binding.update({ view, selection }), { view: fixture, selection: stale })
    assert((await inspector.innerText()).includes('Choose a question'))
    const unavailable = { projectionDigest, ref: { repoId: 'unavailable-synthetic-ref', localId: 'absent' } }
    await page.evaluate(({ view, selection }) => window.binding.update({ view, selection }), { view: fixture, selection: unavailable })
    assert(!(await page.locator('#root').innerText()).includes('unavailable-synthetic-ref'))
    check('stale and unavailable selections reveal no placeholder')
    await page.evaluate(() => window.binding.clear())
    assert.equal(await page.getByRole('button').count(), 0)
    assert(!(await page.locator('#root').innerText()).includes('synthetic:garden'))
    await page.evaluate(f => window.start(f), fixture)
    await page.evaluate(() => { window.reject = true }); await page.getByRole('button', { name: 'contradicts', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.agv-status').textContent === 'Request failed. Try again.')
    await page.evaluate(() => { window.reject = false; window.delay = true }); await page.getByRole('button', { name: 'contradicts', exact: true }).click()
    await page.evaluate(() => { window.binding.clear(); window.release() })
    assert(!(await page.locator('#root').innerText()).includes('synthetic:garden'))
    await page.evaluate(() => window.binding.destroy()); assert.equal(await page.locator('#root').innerText(), '')
    check('withdrawal, failed/pending delivery and destroy retain no prior graph')
    assert.deepEqual(errors, []); await context.close()
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const mobile = await touch.newPage(); await mobile.setContent('<main id="root"></main>'); await mobile.addScriptTag({ content: bundle.outputFiles[0].text }); await mobile.evaluate(f => window.start(f), fixture)
    await mobile.getByRole('button', { name: 'contradicts', exact: true }).tap()
    assert.equal(await mobile.evaluate(() => window.intents.at(-1).edgeId), edge.edgeId)
    const metrics = await mobile.locator('button,input').evaluateAll(elements => elements.map(e => e.getBoundingClientRect()).map(r => ({ width: r.width, height: r.height })))
    assert(metrics.every(r => r.width >= 43.9 && r.height >= 43.9))
    await touch.close(); check('touch without dragging and 44px targets')
    fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(receipt, null, 2) + '\n')
  } finally { await browser.close() }
})
