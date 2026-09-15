// Synthetic local proof of built Astro output. No listener or live site access.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const example = path.join(root, 'examples/astro-presentation')
const output = path.resolve(process.env.ATELIER_ASTRO_PROOF_OUTPUT || path.join(root, '.artifacts/astro-presentation'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function filesAt(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.astro', 'dist'].includes(entry.name)) return []
    const name = prefix + entry.name, full = path.join(directory, entry.name)
    return entry.isDirectory() ? filesAt(full, name + '/') : entry.isFile() ? [[name, fs.readFileSync(full)]] : []
  })
}
const built = new Map(filesAt(path.join(example, 'dist')).map(([name, bytes]) => ['/' + name, bytes]))
assert(built.has('/index.html') && built.has('/dark/index.html'), 'build both themes first')
const totalBytes = [...built.values()].reduce((sum, bytes) => sum + bytes.length, 0)
const externalJsBytes = [...built].filter(([name]) => name.endsWith('.js')).reduce((sum, [, bytes]) => sum + bytes.length, 0)
const inlineJsBytes = Math.max(...[...built].filter(([name]) => name.endsWith('.html')).map(([, bytes]) => [...bytes.toString().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].reduce((sum, match) => sum + Buffer.byteLength(match[1]), 0)))
const jsBytes = externalJsBytes + inlineJsBytes
assert(totalBytes < 80000, 'synthetic page build exceeds 80 KB budget')
assert(jsBytes < 10000, 'synthetic script budget exceeds 10 KB')
const sourceFiles = [...filesAt(example).map(([name, bytes]) => ['examples/astro-presentation/' + name, bytes]),
  ...filesAt(path.join(root, 'src/ui/presentation')).map(([name, bytes]) => ['src/ui/presentation/' + name, bytes]),
  ['scripts/prove-astro-presentation.mjs', fs.readFileSync(fileURLToPath(import.meta.url))],
  ...['package.json', 'package-lock.json'].map(name => [name, fs.readFileSync(path.join(root, name))])]
const receipt = {
  schema: 'atelier.astro-consumer-proof/v1',
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  sourceFiles: Object.fromEntries(sourceFiles.map(([name, bytes]) => [name, hash(bytes)])),
  buildFiles: Object.fromEntries([...built].map(([name, bytes]) => [name, hash(bytes)])),
  totalBytes, jsBytes, scope: 'synthetic-intercepted-local-output',
  environment: { node: process.version, platform: process.platform, locale: 'en-US', timezone: 'UTC', scale: 1, reducedMotion: true },
  adopterAccepted: false, visualBaselineAccepted: false, runs: [], status: 'running',
}
fs.mkdirSync(output, { recursive: true })
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true })
    const run = { browser: name, version: browser.version(), checks: [], screenshots: [] }
    receipt.runs.push(run)
    try {
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({ javaScriptEnabled, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1 })
        context.setDefaultTimeout(15000)
        context.setDefaultNavigationTimeout(15000)
        const externalRequests = [], errors = []
        await context.route('**/*', async route => {
          const url = new URL(route.request().url())
          if (url.origin !== 'http://127.0.0.1:4179' || route.request().method() !== 'GET') {
            externalRequests.push(route.request().method() + ' ' + url.origin); return route.abort()
          }
          const key = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname
          if (!built.has(key)) { errors.push('missing build path ' + key); return route.abort() }
          await route.fulfill({ body: built.get(key), contentType: key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css' : 'text/html' })
        })
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1024, 1440]) {
          await page.setViewportSize({ width, height: 960 })
          await page.goto('http://127.0.0.1:4179' + (theme === 'dark' ? '/dark/' : '/'))
          // No web fonts exist in this fixture. Firefox's fonts.ready can stay
          // unresolved with page scripts disabled; prove the empty font set.
          assert.equal(await page.evaluate(() => document.fonts.size), 0)
          if (javaScriptEnabled) await page.waitForFunction(() => !document.querySelector('[data-demo-check]').disabled)
          const metrics = await page.evaluate(() => {
            const visibleText = [...document.querySelectorAll('p,h1,h2,h3,label,a,button,summary,input')].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height && !e.closest('nav') && !e.classList.contains('skip'))
            return {
              width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
              small: visibleText.filter(e => parseFloat(getComputedStyle(e).fontSize) < 14).map(e => e.tagName),
              type: getComputedStyle(document.querySelector('input')).fontSize,
              hydration: document.querySelectorAll('astro-island').length,
              color: getComputedStyle(document.documentElement).color,
              background: getComputedStyle(document.documentElement).backgroundColor,
              motion: visibleText.some(e => parseFloat(getComputedStyle(e).transitionDuration) > 0 || getComputedStyle(e).animationName !== 'none'),
            }
          })
          assert(metrics.scrollWidth <= metrics.width, JSON.stringify(metrics))
          assert.deepEqual(metrics.small, []); assert.equal(metrics.type, '16px'); assert.equal(metrics.hydration, 0); assert.equal(metrics.motion, false)
          const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0)
          const a = luminance(metrics.color), b = luminance(metrics.background)
          assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5)
          assert.equal(await page.locator('[data-demo-check]').isDisabled(), !javaScriptEnabled)
          await page.locator('summary').click(); assert.equal(await page.locator('details').getAttribute('open'), '')
          assert(await page.getByRole('link', { name: 'Read the guide' }).isVisible())
          await page.locator('summary').click()
          if (javaScriptEnabled && [390, 1440].includes(width)) {
            const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))
            const file = `${name}-${width}-${theme}.png`, bytes = await page.screenshot({ path: path.join(output, file), fullPage: true })
            assert.equal(bytes.readUInt32BE(16), dimensions.width); assert.equal(bytes.readUInt32BE(20), dimensions.height)
            run.screenshots.push({ file, sha256: hash(bytes), dimensions })
          }
          run.checks.push(`${theme}:${width}:js-${javaScriptEnabled}`)
        }
        await page.goto('http://127.0.0.1:4179/')
        const navigations = []
        const recordNavigation = frame => { if (frame === page.mainFrame()) navigations.push(frame.url()) }
        page.on('framenavigated', recordNavigation)
        await page.locator('input').fill('Invented local topic')
        await page.locator('input').press('Enter')
        // Keep the field value as a second reload oracle; a GET to the same URL
        // would evade a pathname-only assertion.
        assert.deepEqual(navigations, [])
        assert.equal(await page.locator('input').inputValue(), 'Invented local topic')
        assert.equal(await page.locator('form').count(), 0)
        page.off('framenavigated', recordNavigation)
        run.checks.push(`enter-no-navigation:js-${javaScriptEnabled}`)
        if (javaScriptEnabled) {
          await page.goto('http://127.0.0.1:4179/')
          // macOS WebKit follows Safari's Option-Tab link-navigation convention
          // when full keyboard access is not enabled; no app focus bridge.
          const navigationTab = name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab'
          await page.keyboard.press(navigationTab); assert(await page.locator('.skip').evaluate(e => e === document.activeElement))
          assert.notEqual(await page.locator('.skip').evaluate(e => getComputedStyle(e).outlineStyle), 'none')
          await page.locator('summary').click(); await page.keyboard.press(navigationTab); await page.keyboard.press('Escape')
          assert.equal(await page.locator('details').getAttribute('open'), null)
          assert(await page.locator('summary').evaluate(e => e === document.activeElement))
          await page.locator('[data-demo-check]').click(); assert(await page.locator('[data-demo-status]').textContent().then(x => x.includes('Enter a topic')))
          await page.locator('input').fill('Invented paper shapes')
          await page.locator('[data-demo-check]').click()
          assert.equal(await page.locator('[data-demo-status]').textContent(), 'Local check passed. Nothing was sent or saved.')
          await page.locator('input').press('Enter')
          assert.equal(new URL(page.url()).pathname, '/')
          await page.setViewportSize({ width: 320, height: 960 })
          await page.evaluate(() => { document.documentElement.style.fontSize = '32px' })
          const reflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
            overflow: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right + window.scrollX > document.documentElement.clientWidth && !e.classList.contains('skip')).map(e => ({ tag: e.tagName, class: e.className, width: e.getBoundingClientRect().width })) }))
          if (reflow.scroll > reflow.width) await page.screenshot({ path: path.join(output, name + '-reflow-failure.png'), fullPage: true })
          assert(reflow.scroll <= reflow.width, JSON.stringify(reflow))
          run.checks.push('keyboard-menu-focus', 'local-form-no-submission', 'double-text-size-narrow-reflow')
        }
        assert.deepEqual(externalRequests, []); assert.deepEqual(errors, [])
        await context.close()
        console.log(`${name}: js=${javaScriptEnabled} passed`)
      }
    } finally { await browser.close() }
  }
  receipt.status = 'passed'
} catch (error) { receipt.status = 'failed'; receipt.error = error.stack; process.exitCode = 1 }
finally {
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ status: receipt.status, checks: receipt.runs.reduce((sum, run) => sum + run.checks.length, 0), totalBytes, jsBytes, error: receipt.error, output }, null, 2))
}
