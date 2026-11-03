// Opt-in local browser acceptance for the graph workspace rooms. No service, live
// site or browser download. Invented fixture only.
//   ATELIER_GRAPH_WORKSPACE_BROWSER_PROOF=1 node --test test/graph-workspace-browser.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const enabled = process.env.ATELIER_GRAPH_WORKSPACE_BROWSER_PROOF === '1'
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

test('graph workspace rooms: constellation, workbench, review, recipes, themes and fallbacks', { skip: !enabled, timeout: 240000 }, async () => {
  const { chromium } = await import('playwright')
  const { build } = await import('esbuild')
  const output = path.resolve(process.env.ATELIER_GRAPH_WORKSPACE_PROOF_OUTPUT ?? path.join(os.tmpdir(), 'atelier-graph-workspace-proof'))
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: { resolveDir: root, contents: `
      import Graph from 'graphology'
      import Sigma from 'sigma'
      import { EdgeArrowProgram } from 'sigma/rendering'
      import forceAtlas2 from 'graphology-layout-forceatlas2'
      import FA2Layout from 'graphology-layout-forceatlas2/worker'
      import { buildWorkspaceModel, layoutWorkspace, composeRecipes, composeTheme, DEFAULT_THEME } from './src/graph-workspace/index.mjs'
      import { mountGraphWorkspace } from './src/graph-workspace/browser/index.mjs'
      import { generateCommons } from './test/helpers/graph-workspace-commons.mjs'
      const params = new URLSearchParams(location.search)
      const fixture = generateCommons({ size: Number(params.get('size') ?? 900), seed: 11 })
      const model = buildWorkspaceModel(fixture)
      layoutWorkspace(model, { Graph, forceAtlas2, iterations: 300 })
      const coach = params.get('coach') === '1'
      window.model = model
      window.gw = mountGraphWorkspace(document.getElementById('root'), {
        model, deps: { Sigma, Graph, EdgeArrowProgram, FA2Layout }, intro: false,
        webgl: params.get('webgl') === 'off' ? false : undefined,
        profile: { id: 'commons', name: 'Invented commons', vocabulary: { record: 'note', records: 'notes', zone: 'folder' } },
        recipes: coach ? composeRecipes({ coach: [{ id: 'explore', label: 'Wander the shore' }], owner: [{ id: 'inspect', hidden: true }] }).recipes : undefined,
        theme: coach ? composeTheme(DEFAULT_THEME, { id: 'coach', schemes: { dark: { vars: { '--accent': '#a0e0c0' } } } }) : DEFAULT_THEME,
      })
      document.body.dataset.ready = 'true'
    ` },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  })
  const page = path.join(output, 'index.html')
  fs.writeFileSync(path.join(output, 'bundle.js'), bundle.outputFiles[0].text)
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}#root{width:100vw;height:100vh}</style><div id="root"></div><script src="bundle.js"></script>')
  const browser = await chromium.launch()
  const errors = []
  const open = async (query = '', options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
    const p = await context.newPage()
    p.on('pageerror', e => errors.push(e.message))
    await p.goto(pathToFileURL(page).href + query)
    await p.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 60000 })
    await p.waitForTimeout(800)
    return { p, context }
  }
  const labelsOk = async p => p.evaluate(() => {
    const c = window.gw.constellation, host = document.querySelector('.constellation').getBoundingClientRect()
    const labels = c.labels(), zones = c.zoneLabels()
    const chrome = [...document.querySelectorAll('[data-graph-reserve]')].filter(e => !e.hidden).map(e => { const r = e.getBoundingClientRect(); return { left: r.left - host.left, top: r.top - host.top, right: r.right - host.left, bottom: r.bottom - host.top } }).filter(r => r.right > r.left)
    return { labels, zones, chrome }
  })
  try {
    // Constellation: every record drawn, labels and zone names never collide or sit under chrome.
    let { p, context } = await open()
    const counts = await p.evaluate(() => ({ drawn: window.gw.constellation.graph.order, records: window.model.nodes.length }))
    assert.equal(counts.drawn, counts.records)
    const l = await labelsOk(p)
    const all = [...l.labels, ...l.zones]
    assert.ok(l.labels.length >= 6, 'labels at fit')
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(all[i], all[j]), 'label overlap')
    assert.ok(l.labels.every(x => !l.chrome.some(c => overlaps(c, x))), 'label under chrome')
    await p.screenshot({ path: path.join(output, 'constellation.png') })
    // Selection does not move the camera; the workbench opens and returns to the same view.
    const id = await p.evaluate(() => [...window.model.nodes].sort((a, b) => b.degree - a.degree)[20].id)
    const before = await p.evaluate(() => window.gw.state.camera)
    await p.evaluate(i => window.gw.select(i), id)
    assert.deepEqual(await p.evaluate(() => window.gw.state.camera), before)
    await p.click('[data-gw="open-selected"]')
    await p.waitForTimeout(1100)
    assert.equal(await p.evaluate(() => window.gw.state.room), 'workbench')
    const cards = await p.evaluate(() => window.gw.workbench.layout.cards)
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j]
      assert.ok(!overlaps({ left: a.x, top: a.y, right: a.x + a.w, bottom: a.y + a.h }, { left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h }), 'workbench cards overlap')
    }
    await p.screenshot({ path: path.join(output, 'workbench.png') })
    await p.click('#wb-back')
    await p.waitForTimeout(900)
    const after = await p.evaluate(() => window.gw.state.camera)
    assert.ok(Math.abs(after.ratio - before.ratio) < 1e-3 && Math.abs(after.x - before.x) < 1e-3, 'camera restored')
    // Refine a concept to a review; the draft survives a reload in this browser.
    await p.evaluate(() => window.gw.setRecipe('refine'))
    await p.waitForTimeout(600)
    await p.fill('#step-input', 'A recorded claim we can test, distinct from a decision.')
    await p.click('#next-step'); await p.fill('#step-input', 'One id per claim; rewording is a revision.')
    await p.click('#next-step'); await p.fill('#step-input', 'A dated claim from our notes.')
    await p.click('#next-step'); await p.fill('#step-input', 'A decision that cites the claim.')
    await p.click('#next-step'); await p.fill('.evidence .find', 'notes'); await p.click('.evidence .cite >> nth=0')
    await p.click('#next-step'); await p.fill('#step-input', 'Two different claims filed under one id.')
    await p.waitForTimeout(900)
    assert.match(await p.textContent('#save-status'), /Saved in this browser only/)
    await p.click('#review-proposal')
    await p.waitForTimeout(300)
    assert.equal(await p.evaluate(() => document.getElementById('review-status').dataset.status), 'ready-for-human-review')
    assert.match(await p.textContent('.review-room'), /A person decides/)
    await p.screenshot({ path: path.join(output, 'review.png') })
    await p.reload()
    await p.waitForFunction(() => document.body.dataset.ready === 'true')
    await p.evaluate(() => window.gw.setRecipe('refine'))
    await p.waitForTimeout(500)
    assert.match(await p.inputValue('#step-input'), /distinct from a decision/)
    // Text view lists every record.
    await p.evaluate(() => window.gw.backToConstellation())
    await p.keyboard.press('t')
    await p.waitForTimeout(300)
    assert.equal(await p.evaluate(() => document.querySelectorAll('.text-view .tv-item[data-id]').length), counts.records)
    await context.close()
    // Coach and owner layers change words and theme without code.
    ;({ p, context } = await open('?coach=1'))
    const layered = await p.evaluate(() => ({ label: document.querySelector('.top .pill span:nth-child(2)').textContent, accent: getComputedStyle(document.getElementById('root')).getPropertyValue('--accent').trim(), recipes: window.gw.recipes.map(r => r.id) }))
    assert.equal(layered.label, 'Wander the shore')
    assert.equal(layered.accent, '#a0e0c0')
    assert.ok(!layered.recipes.includes('inspect'))
    await context.close()
    // Without WebGL the same tasks remain through Text view and the workbench.
    ;({ p, context } = await open('?webgl=off'))
    assert.equal(await p.evaluate(() => window.gw.state.webgl), false)
    await p.click('.text-view .tv-zone[open] .tv-item[data-id] >> nth=0')
    await p.click('[data-gw="open-selected"]')
    await p.waitForTimeout(500)
    assert.equal(await p.evaluate(() => window.gw.state.room), 'workbench')
    await context.close()
    // Reduced motion: no animated camera.
    ;({ p, context } = await open('', { reducedMotion: 'reduce' }))
    assert.equal(await p.evaluate(() => window.gw.state.camera.ratio), 1)
    await context.close()
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
