// Optional local proof runner. Use an already installed Playwright runtime;
// this script never installs browsers, starts a service, or visits live sites.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
const imported = await import(process.env.ATELIER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATELIER_PLAYWRIGHT_MODULE).href : 'playwright')
const playwright = imported.default ?? imported
const output = path.resolve(process.env.ATELIER_PROOF_OUTPUT || path.join(root, '.artifacts/presentation-browser'))
fs.mkdirSync(output, { recursive: true })
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/ui/presentation/reference.v1.json'), 'utf8'))
const sources = ['src/ui/html-primitives.mjs', 'src/attestation/jcs.mjs', ...fs.readdirSync(path.join(root, 'src/ui/presentation')).filter(x => x.endsWith('.mjs')).map(x => 'src/ui/presentation/' + x)]
const allowed = new Map(sources.map(file => ['/' + file, fs.readFileSync(path.join(root, file))]))
const sourceDigest = createHash('sha256').update(sources.sort().map(file => file + '\0' + fs.readFileSync(path.join(root, file))).join('\0')).digest('hex')
const receipt = { schema: 'atelier.presentation-browser-proof/v1', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDigest,
  fixtureDigest: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'), environment: { platform: os.platform(), release: os.release(), architecture: os.arch(), locale: 'en-US', timezone: 'UTC', scale: 1, font: 'system sans-serif', motion: 'reduce', viewports: [320, 390, 768, 1024, 1440], themes: ['light', 'dark'], densities: ['comfortable', 'compact'] }, scope: 'synthetic-local-browser', nativeDeviceAccepted: false, adopterAccepted: false, visualBaselineAccepted: false, runs: [] }
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Presentation proof</title></head><body><script type="module">import {renderPresentation} from "/src/ui/presentation/web.mjs"; import {bindPresentation} from "/src/ui/presentation/browser.mjs"; window.requests=[]; window.mount=(model,options={})=>{window.binding?.dispose(); document.querySelectorAll("body > :not(script)").forEach(e=>e.remove()); document.body.insertAdjacentHTML("afterbegin",renderPresentation(model)); window.binding=bindPresentation(document.querySelector("[data-ap-root]"),model,{onRequest:options.readOnly?undefined:async request=>{window.requests.push(request);if(window.hold)await new Promise(resolve=>window.release=resolve);if(window.reject)throw new Error("fixture refusal");}});};window.ready=true;</script></body></html>'

try {
  for (const name of (process.env.ATELIER_PROOF_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    if (!['chromium', 'firefox', 'webkit'].includes(name)) throw new Error('unsupported proof browser')
    const browser = await playwright[name].launch({ headless: true, timeout: 20000 })
    const run = { browser: name, version: browser.version(), checks: [], screenshots: [] }; receipt.runs.push(run)
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(6000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== 'http://presentation.invalid') return route.abort('blockedbyclient')
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html })
      if (allowed.has(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: allowed.get(url.pathname) })
      if (url.pathname === '/paper.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="50" y="10" width="100" height="80" fill="#495668"/></svg>' })
      return route.fulfill({ status: 404, body: 'No fixture resource' })
    })
    try {
      await page.goto('http://presentation.invalid/', { waitUntil: 'load' })
      await page.waitForFunction(() => window.ready === true)
      for (const width of [320, 390, 768, 1024, 1440]) for (const theme of ['light', 'dark']) for (const density of ['comfortable', 'compact']) {
        await page.setViewportSize({ width, height: 960 })
        await page.evaluate(model => window.mount(model), { ...fixture, theme, density })
        const metrics = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          targets: [...document.querySelectorAll('button,input,textarea,.ap-link')].filter(e => e.getClientRects().length).map(e => ({ label: e.getAttribute('aria-label') || e.textContent, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })),
          paneRows: [...document.querySelectorAll('[data-ap-pane]')].map(e => e.getBoundingClientRect().top),
          motion: getComputedStyle(document.querySelector('.ap-link')).transitionDuration }))
        assert(metrics.overflow <= 1, `${name}/${width}/${theme}/${density}: overflow ${metrics.overflow}`)
        for (const target of metrics.targets) assert(target.width >= 43.9 && target.height >= 43.9, JSON.stringify(target))
        assert.equal(metrics.motion, '0s')
        if (width <= 768) assert(metrics.paneRows[1] > metrics.paneRows[0])
        run.checks.push(`layout:${width}:${theme}:${density}`)
        if ([390, 1440].includes(width) && density === 'comfortable') {
          const filename = `${name}-${width}-${theme}.png`
          await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled' })
          run.screenshots.push({ file: filename, sha256: createHash('sha256').update(fs.readFileSync(path.join(output, filename))).digest('hex') })
        }
      }
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.evaluate(model => window.mount(model), fixture)
      const action = page.getByRole('button', { name: 'Request publication', exact: true })
      await action.click()
      assert(await page.locator('[data-ap-cancel]').evaluate(e => document.activeElement === e))
      await page.keyboard.press('Shift+Tab')
      assert(await page.locator('[data-ap-confirm-action]').evaluate(e => document.activeElement === e))
      await page.keyboard.press('Tab')
      assert(await page.locator('[data-ap-cancel]').evaluate(e => document.activeElement === e))
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('dialog').evaluate(e => e.open), false)
      assert(await action.evaluate(e => document.activeElement === e))
      assert.equal(await page.evaluate(() => window.requests.length), 0)
      await action.click(); await page.locator('[data-ap-confirm-action]').click()
      await page.waitForFunction(() => window.requests.length === 1)
      const requested = await page.evaluate(() => window.requests[0])
      assert.equal(requested.executionAuthority, false); assert.equal(requested.presentationConfirmed, true)
      run.checks.push('modal-cancel-initial-focus-cycle-escape-return-explicit-confirmation')
      const slider = page.locator('[data-ap-resize="work"]')
      await slider.focus(); await page.keyboard.press('ArrowRight')
      await page.waitForFunction(() => window.requests.some(r => r.kind === 'resize' && r.value === 61))
      assert.equal(await slider.inputValue(), '60')
      await page.getByRole('button', { name: 'Decrease width of Working area' }).click()
      await page.waitForFunction(() => window.requests.some(r => r.kind === 'resize' && r.value === 59))
      run.checks.push('keyboard-and-single-pointer-resize-remains-host-controlled')
      await page.getByRole('button', { name: 'Move Observe later', exact: true }).click()
      await page.waitForFunction(() => window.requests.some(r => r.kind === 'move' && r.itemId === 'observe' && r.position === 1))
      assert.equal(await page.locator('[data-ap-drag="steps"]').first().getAttribute('data-ap-item'), 'observe')
      run.checks.push('non-drag-move-proposal-retains-host-order')
      await page.getByRole('button', { name: 'Square', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: 'Square', exact: true }).getAttribute('aria-pressed'), 'false')
      await page.evaluate(() => { window.hold = true; window.requests = [] })
      const editor = page.locator('[data-ap-edit="draft-body"]')
      await editor.fill('First edit'); await editor.fill('Last edit')
      assert.equal(await page.evaluate(() => window.requests.length), 1)
      await page.evaluate(() => { window.hold = false; window.release() })
      await page.waitForFunction(() => window.requests.length === 2)
      assert.equal(await page.evaluate(() => window.requests[1].value), 'Last edit')
      run.checks.push('selection-is-proposal-and-pending-edits-coalesce-without-losing-last-value')
      await page.evaluate(() => { window.reject = true })
      await editor.fill('Rejected delivery')
      await page.waitForFunction(() => document.querySelector('[data-ap-delivery]').textContent.includes('delivery failed'))
      await page.evaluate(() => { window.reject = false; window.hold = true })
      await page.getByRole('button', { name: 'Square', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: 'Square', exact: true }).isDisabled(), true)
      await page.evaluate(() => window.binding.dispose())
      assert.equal(await page.getByRole('button', { name: 'Square', exact: true }).isDisabled(), false)
      const before = await page.evaluate(() => window.requests.length)
      await page.getByRole('button', { name: 'Circle', exact: true }).click()
      assert.equal(await page.evaluate(() => window.requests.length), before)
      await page.evaluate(() => { window.hold = false; window.release() })
      run.checks.push('delivery-failure-and-pending-disposal-do-not-claim-business-success')
      await page.evaluate(model => { window.requests = []; window.mount(model) }, fixture)
      await page.evaluate(() => { const b = document.querySelector('[data-ap-action="disabled-action"]'); b.disabled = false; b.click() })
      assert.equal(await page.evaluate(() => window.requests.length), 0)
      await page.evaluate(model => window.mount(model, { readOnly: true }), fixture)
      assert.equal(await page.locator('[data-ap-action="confirm-action"]').isDisabled(), true)
      run.checks.push('model-disabled-refusal-survives-dom-flag-change-and-absent-host-is-read-only')
      await page.evaluate(model => window.mount({ ...model, direction: 'rtl' }), fixture)
      await slider.focus(); await page.keyboard.press('ArrowRight')
      await page.waitForFunction(() => window.requests.some(r => r.kind === 'resize' && r.value === 59))
      assert.equal(await page.locator('[data-ap-root]').evaluate(e => getComputedStyle(e).direction), 'rtl')
      run.checks.push('rtl-logical-layout-and-native-range-direction')
      await page.setViewportSize({ width: 640, height: 480 })
      await page.evaluate(() => document.querySelector('[data-ap-root]').style.fontSize = '32px')
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
      run.checks.push('200-percent-text-size-reflow-at-640-css-pixels')
      await page.emulateMedia({ media: 'print' })
      assert.equal(await page.locator('.ap-pane').first().evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 255, 255)')
      assert.equal(await page.locator('.ap-resize').first().isVisible(), false)
      run.checks.push('readable-print-colors-and-no-resize-controls')
      assert.deepEqual(errors, [])
      run.status = 'passed'
    } finally { await context.close(); await browser.close() }
  }
  receipt.status = 'passed'
} catch (error) { receipt.status = 'failed'; receipt.error = error.stack; process.exitCode = 1 }
fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ status: receipt.status, checks: receipt.runs.reduce((n, r) => n + r.checks.length, 0), browsers: receipt.runs.map(r => ({ name: r.browser, status: r.status ?? 'failed' })), error: receipt.error ?? null, receipt: path.join(output, 'receipt.json') }, null, 2))
