import assert from 'node:assert/strict'
import test from 'node:test'
import { scrollbarStyles } from '../src/ui/primitives/index.mjs'

test('overlay scrollbars leave page and panel geometry intact', { skip: process.env.ATELIER_UI_BROWSER_PROOF !== '1' }, async () => {
  const { chromium } = await import('playwright')
  const { build } = await import('esbuild')
  const bundle = await build({ entryPoints: [new URL('../src/ui/primitives/browser.mjs', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Primitives', write: false })
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 500 } })
    await page.setContent(`<!doctype html><style>${scrollbarStyles}
      body { margin: 0; min-height: 2000px } header { position: sticky; top: 0; height: 80px; background: white }
      dialog { margin: 0 0 0 auto; inset: 0; padding: 0; border: 0; height: 360px; width: 280px }
      section { position: relative } article { height: 260px; overflow: auto } article div { height: 1200px }
      </style><header>Sample</header><div class="system-scroll-thumb" data-document-thumb hidden></div>
      <dialog><section><article><div>Panel content</div></article><div class="system-scroll-thumb" data-panel-thumb hidden></div></section></dialog>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.evaluate(() => {
      Primitives.enhanceOverlayScrollbar({ thumb: document.querySelector('[data-document-thumb]'), header: document.querySelector('header') })
      Primitives.enhanceOverlayScrollbar({ thumb: document.querySelector('[data-panel-thumb]'), viewport: document.querySelector('article') })
    })
    const thumb = page.locator('[data-document-thumb]')
    await thumb.waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.clientWidth), 720)
    const bounds = await thumb.boundingBox()
    assert.ok(bounds.y >= 80)
    await page.mouse.move(bounds.x + 8, bounds.y + 8)
    await page.mouse.down()
    await page.mouse.move(bounds.x + 8, bounds.y + 70)
    await page.mouse.up()
    const offset = await page.evaluate(() => scrollY)
    assert.ok(offset > 100)
    await page.evaluate(() => {
      document.querySelector('dialog').showModal()
      Primitives.lockScroll('sample')
    })
    assert.ok(!await thumb.isVisible())
    await page.locator('[data-panel-thumb]').waitFor()
    assert.equal(await page.locator('dialog').evaluate(element => element.getBoundingClientRect().right), 720)
    await page.evaluate(() => {
      document.querySelector('article').scrollTop = 400
      document.querySelector('dialog').close()
      Primitives.unlockScroll('sample')
    })
    assert.ok(await thumb.isVisible())
    assert.equal(await page.evaluate(() => scrollY), offset)
    await page.emulateMedia({ forcedColors: 'active' })
    await thumb.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-overlay-scrollbar'))
  } finally {
    await browser.close()
  }
})
