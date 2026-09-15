// Local proof gate. Use the lockfile-pinned test runtime;
// this script never installs browsers, starts a service, or visits live sites.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import { build } from 'esbuild'
import { comparePresentationProofs } from '../src/ui/presentation/proof.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const imported = await import(process.env.ATELIER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATELIER_PLAYWRIGHT_MODULE).href : 'playwright')
const playwright = imported.default ?? imported
const output = path.resolve(process.env.ATELIER_PROOF_OUTPUT || path.join(root, '.artifacts/presentation-browser'))
fs.mkdirSync(output, { recursive: true })
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/ui/presentation/reference.v1.json'), 'utf8'))
const sources = ['src/ui/html-primitives.mjs', 'src/attestation/jcs.mjs', ...fs.readdirSync(path.join(root, 'src/ui/presentation')).filter(x => x.endsWith('.mjs')).map(x => 'src/ui/presentation/' + x)]
const allowed = new Map(sources.map(file => ['/' + file, fs.readFileSync(path.join(root, file))]))
const sourceDigest = createHash('sha256').update(sources.sort().map(file => file + '\0' + fs.readFileSync(path.join(root, file))).join('\0')).digest('hex')
const runnerFiles = ['scripts/prove-presentation-browser.mjs', 'scripts/presentation-native-fixture.mjs', 'package-lock.json']
const runnerDigest = createHash('sha256').update(runnerFiles.map(file => file + '\0' + fs.readFileSync(path.join(root, file))).join('\0')).digest('hex')
const nativeBundle = await build({ entryPoints: [path.join(root, 'scripts/presentation-native-fixture.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const receipt = { schema: 'atelier.presentation-browser-proof/v2', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDigest, runnerDigest,
  fixtureDigest: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'), environment: { platform: os.platform(), release: os.release(), architecture: os.arch(), locale: 'en-US', timezone: 'UTC', scale: 1, font: 'system sans-serif', motion: 'reduce', viewports: [320, 390, 768, 1024, 1440], themes: ['light', 'dark'], densities: ['comfortable', 'compact'] }, scope: 'synthetic-local-browser', nativeDeviceAccepted: false, adopterAccepted: false, visualBaselineAccepted: false, runs: [] }
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Presentation proof</title></head><body><script type="module">
import {renderPresentation,renderReadOnlyDocument} from "/src/ui/presentation/web.mjs";
import {bindPresentation} from "/src/ui/presentation/browser.mjs";
window.readOnlyDocument=renderReadOnlyDocument;
window.requests=[];window.releases=[];
window.mount=(model,options={})=>{
  window.binding?.dispose();window.model=structuredClone(model);
  document.querySelectorAll("body > :not(script)").forEach(e=>e.remove());
  document.body.insertAdjacentHTML("afterbegin",renderPresentation(model));
  window.binding=bindPresentation(document.querySelector("[data-ap-root]"),model,{onRequest:options.readOnly?undefined:async request=>{
    window.requests.push(request);
    if(window.hold)await new Promise(resolve=>window.releases.push(resolve));
    if(window.reject)throw new Error("fixture refusal");
    if(options.controlled&&request.kind==='edit'){
      window.model.nodes.find(n=>n.id===request.id).value=request.value;
      window.binding.update(window.model);
    }
  }});
};
window.release=()=>window.releases.splice(0).forEach(resolve=>resolve());
window.ready=true;</script></body></html>`

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
        // Offscreen lazy images must resolve before full-page geometry is measured.
        await page.evaluate(async () => {
          const images = [...document.images];
          images.forEach(image => { image.loading = 'eager' });
          await Promise.all(images.map(image => image.decode()));
          if (images.some(image => !image.complete || !image.naturalWidth)) throw new Error('Incomplete fixture image');
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
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
          const geometry = () => page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))
          const beforeCapture = await geometry()
          const png = await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled' })
          const afterCapture = await geometry()
          assert.deepEqual(afterCapture, beforeCapture, 'Document geometry changed during capture')
          const capture = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), scrollWidth: afterCapture.width, scrollHeight: afterCapture.height }
          assert.equal(capture.width, capture.scrollWidth, 'Captured PNG width differs from document')
          assert.equal(capture.height, capture.scrollHeight, 'Captured PNG height differs from document')
          run.screenshots.push({ file: filename, sha256: createHash('sha256').update(png).digest('hex'), capture, conditions: { width, height: 960, theme, density, motion: 'reduce', font: 'system sans-serif', locale: 'en-US', scale: 1 } })
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
      assert(await action.evaluate(e => document.activeElement === e))
      run.checks.push('modal-cancel-initial-focus-cycle-escape-return-explicit-confirmation')
      const slider = page.locator('[data-ap-resize="work"]')
      await slider.focus(); await page.keyboard.press('ArrowRight')
      await page.waitForFunction(() => window.requests.some(r => r.kind === 'resize' && r.value === 61))
      assert.equal(await slider.inputValue(), '60')
      assert(await slider.evaluate(e => document.activeElement === e))
      const resizeCount = await page.evaluate(() => window.requests.filter(r => r.kind === 'resize').length)
      await page.keyboard.press('ArrowRight')
      assert.equal(await page.evaluate(() => window.requests.filter(r => r.kind === 'resize').length), resizeCount + 1)
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
      // Engines may emit an intermediate deletion while replacing text. Every
      // input must reach the host; do not mistake those real edits for loss.
      assert(await page.evaluate(() => window.requests.some(r => r.value === 'First edit') && window.requests.at(-1).value === 'Last edit'))
      await page.evaluate(() => { window.hold = false; window.release() })
      assert.equal(await page.evaluate(() => window.requests.at(-1).value), 'Last edit')
      run.checks.push('selection-is-proposal-and-pending-edits-reach-host-immediately')
      await page.evaluate(() => { window.reject = true })
      await editor.fill('Rejected delivery')
      await page.waitForFunction(() => document.querySelector('[data-ap-delivery]').textContent.includes('delivery failed'))
      await page.evaluate(() => { window.reject = false; window.hold = true })
      await page.getByRole('button', { name: 'Square', exact: true }).focus()
      await page.keyboard.press('Space')
      assert.equal(await page.getByRole('button', { name: 'Square', exact: true }).getAttribute('aria-busy'), 'true')
      assert(await page.getByRole('button', { name: 'Square', exact: true }).evaluate(e => document.activeElement === e))
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
      const textSizes = await page.locator('h1,h2,h3,h4,p,button,input,textarea,.ap-muted').evaluateAll(elements => elements.filter(e => e.getClientRects().length && getComputedStyle(e).visibility === 'visible').map(e => parseFloat(getComputedStyle(e).fontSize)))
      await page.evaluate(() => document.querySelector('[data-ap-root]').style.fontSize = '32px')
      const enlarged = await page.locator('h1,h2,h3,h4,p,button,input,textarea,.ap-muted').evaluateAll(elements => elements.filter(e => e.getClientRects().length && getComputedStyle(e).visibility === 'visible').map(e => parseFloat(getComputedStyle(e).fontSize)))
      assert.equal(enlarged.length, textSizes.length)
      enlarged.forEach((size, index) => assert(Math.abs(size - textSizes[index] * 2) < .1, `${name}: text ${index} scaled from ${textSizes[index]} to ${size}`))
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
      run.checks.push('200-percent-text-size-reflow-at-640-css-pixels')
      await page.emulateMedia({ media: 'print' })
      assert.equal(await page.locator('.ap-pane').first().evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 255, 255)')
      assert.equal(await page.locator('.ap-resize').first().isVisible(), false)
      run.checks.push('readable-print-colors-and-no-resize-controls')
      await page.emulateMedia({ media: 'screen' })
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.evaluate(model => { model.panes[1].width.value = 40; window.mount(model) }, fixture)
      const rows = await page.locator('.ap-pane').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().top))
      assert.equal(rows[0], rows[1])
      await page.locator('[data-ap-root]').evaluate(e => { e.style.width = '500px' })
      assert.equal(await page.locator('.ap-resize').first().isVisible(), false)
      assert.equal(await page.locator('.ap-diff').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length), 1)
      await page.locator('[data-ap-root]').evaluate(e => { const host = document.createElement('div'); host.style.width = '320px'; e.before(host); host.append(e); e.style.width = '100%' })
      assert.equal(await page.locator('[data-ap-root]').evaluate(e => e.getBoundingClientRect().width), 320)
      run.checks.push('full-weight-panes-and-container-responsive-border-box')
      await page.evaluate(model => {
        model.panes[0].width = { min: 10, max: 90, value: 10 };
        for (let index = 0; index < 6; index++) model.panes.push({ id: 'extra-' + index, label: 'Extra pane', role: 'utility', blocks: [], width: { min: 10, max: 90, value: 90 } });
        window.mount(model)
      }, fixture)
      assert(await page.locator('.ap-pane').evaluateAll(elements => elements.every(e => e.getBoundingClientRect().width >= 239.9)))
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
      run.checks.push('extreme-pane-weights-retain-minimum-width-without-overflow')
      await page.evaluate(model => { window.requests = []; window.hold = true; window.mount(model, { controlled: true }) }, fixture)
      // A deterministic single paste event isolates the controlled refresh
      // schedule from each automation engine's fill/delete implementation.
      const paste = value => editor.evaluate((e, value) => { e.focus(); e.value = value; e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })) }, value)
      await paste('First draft'); await paste('Latest draft')
      await editor.evaluate(e => e.setSelectionRange(2, 5))
      await page.evaluate(() => window.releases.shift()())
      await page.waitForFunction(() => window.model.nodes.find(n => n.id === 'draft-body').value === 'First draft')
      assert.equal(await editor.inputValue(), 'Latest draft')
      assert.deepEqual(await editor.evaluate(e => [document.activeElement === e, e.selectionStart, e.selectionEnd]), [true, 2, 5])
      assert.equal(await page.evaluate(() => window.requests.length), 2)
      await page.evaluate(() => { window.hold = false; window.release() })
      await page.waitForFunction(() => window.model.nodes.find(n => n.id === 'draft-body').value === 'Latest draft')
      await paste('a'.repeat(32767) + '😀')
      await page.waitForFunction(() => window.requests.at(-1).value.endsWith('😀'))
      const count = await page.evaluate(() => window.requests.length)
      await paste('a'.repeat(32768) + '😀')
      assert.equal(await editor.inputValue(), 'a'.repeat(32768) + '😀')
      assert.equal(await page.evaluate(() => window.requests.length), count)
      assert.equal(await editor.getAttribute('aria-invalid'), 'true')
      assert.equal(await editor.evaluate(e => getComputedStyle(e).borderTopWidth), '2px')
      assert(await page.locator('[data-ap-edit-error="draft-body"]').isVisible())
      assert.match(await editor.getAttribute('aria-describedby'), /:limit/)
      await page.evaluate(() => window.binding.update(window.model))
      assert.equal(await editor.inputValue(), 'a'.repeat(32768) + '😀')
      await editor.evaluate(e => { e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); e.value = 'Composed'; e.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })) })
      assert.equal(await page.evaluate(() => window.requests.length), count)
      await editor.evaluate(e => e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
      assert.equal(await page.evaluate(() => window.requests.at(-1).value), 'Composed')
      run.checks.push('controlled-refresh-preserves-latest-draft-focus-selection-and-unicode-ime-limits')
      await page.evaluate(model => { window.binding.dispose(); document.body.innerHTML = window.readOnlyDocument(model) }, fixture)
      await page.emulateMedia({ media: 'print' })
      const explanation = page.locator('.ap-actions p').filter({ hasText: 'unavailable in document' }).first()
      assert(await explanation.isVisible())
      await page.emulateMedia({ media: 'screen' })
      run.checks.push('read-only-print-retains-action-explanations')
      await page.evaluate(() => { document.body.innerHTML = '<div id="native"></div>' })
      await page.addScriptTag({ content: nativeBundle.outputFiles[0].text })
      assert.equal(await page.evaluate(() => window.nativeReactVersion), '19.1.0')
      // Equivalent parent rerenders commonly create new inline callbacks while
      // a host-controlled confirmation dialog is open. That is not revocation.
      await page.evaluate(model => {
        window.nativeRequests = [];
        window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r), confirm: () => new Promise(resolve => window.confirmNative = resolve) })
      }, fixture)
      await page.getByRole('button', { name: 'Request publication', exact: true }).click()
      await page.evaluate(model => {
        window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r), confirm: async () => true });
        window.confirmNative(true)
      }, fixture)
      await page.evaluate(() => Promise.resolve())
      assert.equal(await page.evaluate(() => window.nativeRequests.length), 1, 'equivalent rerender must preserve confirmation')
      assert.equal(await page.evaluate(() => window.nativeRequests[0].presentationConfirmed), true)
      await page.evaluate(() => window.nativeUnmount())
      await page.evaluate(model => {
        window.nativeRequests = [];
        window.nativeMount({ model, onRequest: r => { window.nativeRequests.push(r); return new Promise((_, reject) => window.rejectNative = reject) } })
      }, fixture)
      await page.getByRole('textbox', { name: 'Draft text', exact: true }).fill('Host-applied draft')
      await page.evaluate(model => {
        model.nodes.find(n => n.type === 'editor').value = 'Host-applied draft';
        window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r) });
        window.rejectNative(new Error('fixture delivery refusal'))
      }, fixture)
      await page.getByText('Request delivery failed. Host state has not been confirmed.', { exact: true }).waitFor()
      await page.evaluate(() => window.nativeUnmount())
      run.checks.push('real-react-native-inline-callback-confirmation-and-post-update-delivery-failure')
      await page.evaluate(model => {
        window.nativeRequests = [];
        window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r), confirm: () => new Promise(resolve => window.confirmNative = resolve) })
      }, fixture)
      await page.getByRole('button', { name: 'Request publication', exact: true }).click()
      await page.evaluate(model => {
        model.nodes.find(n => n.id === 'confirm-action').disabled = true;
        model.nodes.find(n => n.id === 'confirm-action').reason = 'Host eligibility changed';
        window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r), confirm: async () => true });
        window.confirmNative(true)
      }, fixture)
      await page.evaluate(() => Promise.resolve())
      assert.equal(await page.evaluate(() => window.nativeRequests.length), 0)
      await page.evaluate(() => window.nativeUnmount())
      await page.evaluate(model => {
        window.nativeResolvers = {};
        model.nodes.find(n => n.id === 'disabled-action').disabled = false;
        window.nativeMount({ model, onRequest: r => { window.nativeRequests.push(r); return new Promise(resolve => window.nativeResolvers[r.id] = resolve) }, confirm: async () => true })
      }, fixture)
      const nativeAction = page.getByRole('button', { name: 'Request publication', exact: true })
      await nativeAction.click()
      const otherAction = page.locator('#native button').filter({ hasText: fixture.nodes.find(n => n.id === 'disabled-action').label })
      await otherAction.click()
      assert.equal(await nativeAction.getAttribute('data-busy'), 'true')
      assert.equal(await otherAction.getAttribute('data-busy'), 'true')
      await page.evaluate(() => window.nativeResolvers['disabled-action']())
      await page.waitForFunction(() => !document.querySelector('#native button[data-busy="false"][disabled]'))
      assert.equal(await nativeAction.getAttribute('data-busy'), 'true')
      await page.evaluate(() => window.nativeResolvers['confirm-action']())
      await page.waitForFunction(() => document.querySelector('[aria-label="Request publication"]').dataset.busy === 'false')
      await page.evaluate(() => window.nativeUnmount())
      run.checks.push('real-react-native-stale-confirmation-and-overlapping-pending-state')
      await page.evaluate(model => {
        window.nativeRequests = [];
        window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r), confirm: () => new Promise(resolve => window.confirmNative = resolve) })
      }, fixture)
      await page.getByRole('button', { name: 'Request publication', exact: true }).click()
      await page.evaluate(() => { window.nativeUnmount(); window.confirmNative(true) })
      await page.evaluate(() => Promise.resolve())
      assert.equal(await page.evaluate(() => window.nativeRequests.length), 0)
      await page.evaluate(model => window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r) }), fixture)
      const nativeEditor = page.getByRole('textbox', { name: 'Draft text', exact: true })
      await nativeEditor.fill('Local native draft')
      await page.evaluate(model => window.nativeMount({ model, onRequest: r => window.nativeRequests.push(r) }), fixture)
      assert.equal(await nativeEditor.inputValue(), 'Local native draft')
      await nativeEditor.fill('a'.repeat(32768) + '😀')
      assert.equal(await nativeEditor.inputValue(), 'a'.repeat(32768) + '😀')
      assert(await page.evaluate(() => window.nativeRequests.every(r => !r.value || [...r.value].length <= 32768)))
      assert(await page.getByText('Draft exceeds 32768 characters. It remains in the editor; no request was sent.', { exact: true }).first().isVisible())
      await page.evaluate(() => window.nativeUnmount())
      run.checks.push('real-react-native-unmount-refusal-and-visible-retained-draft')
      assert.deepEqual(errors, [])
      run.status = 'passed'
    } finally { await context.close(); await browser.close() }
  }
  receipt.status = 'passed'
  assert.equal(comparePresentationProofs(receipt, receipt).status, 'unchanged')
} catch (error) { receipt.status = 'failed'; receipt.error = error.stack; process.exitCode = 1 }
fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ status: receipt.status, checks: receipt.runs.reduce((n, r) => n + r.checks.length, 0), browsers: receipt.runs.map(r => ({ name: r.browser, status: r.status ?? 'failed' })), error: receipt.error ?? null, receipt: path.join(output, 'receipt.json') }, null, 2))
