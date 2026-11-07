import assert from 'node:assert/strict'
import test from 'node:test'
import { scrollbarStyles } from '../src/ui/primitives/index.mjs'

for (const engine of ['chromium', 'webkit']) {
  test(`${engine}: scroll frames contain content layers and keep thumbs below outer overlays`, { skip: process.env.ATELIER_UI_BROWSER_PROOF !== '1' }, async () => {
    const { [engine]: browserType } = await import('playwright')
    const { build } = await import('esbuild')
    const bundle = await build({ entryPoints: [new URL('../src/ui/primitives/browser.mjs', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Primitives', write: false })
    const browser = await browserType.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 720, height: 500 } })
      await page.setContent(`<!doctype html><style>${scrollbarStyles}
        html, body { margin: 0; height: 100% } body { display: flex; flex-direction: column; overflow: hidden }
        header { position: relative; z-index: 2; height: 64px; flex: none; background: white }
        .frame { position: relative; min-height: 0; flex: 1; display: flex; flex-direction: column }
        article { flex: 1; min-height: 0; overflow: auto }
        .foreground { position: relative; z-index: 2147483647; min-height: 2000px; background: silver }
        .sticky { position: sticky; top: 0; z-index: 2147483647; height: 120px; background: gray }
        .outer-overlay { position: fixed; z-index: 2; inset: 64px 0 0 auto; width: 240px; background: white }
        dialog { padding: 0; border: 0; margin: 0 0 0 auto; inset: 0; width: 280px; height: 360px }
        dialog .frame { height: 100% }
      </style><header>Example header</header>
      <div class="frame"><article data-page><div class="foreground"><div class="sticky">Example sticky content</div></div></article><div class="system-scroll-thumb" data-page-thumb hidden></div></div>
      <div class="outer-overlay" hidden>Example outer overlay</div>
      <dialog><div class="frame"><article data-panel><div class="foreground"><div class="sticky">Example panel content</div></div></article><div class="system-scroll-thumb" data-panel-thumb hidden></div></div></dialog>`)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.evaluate(() => {
        window.pageScrollbar = Primitives.enhanceOverlayScrollbar({ thumb: document.querySelector('[data-page-thumb]'), viewport: document.querySelector('[data-page]') })
        window.panelScrollbar = Primitives.enhanceOverlayScrollbar({ thumb: document.querySelector('[data-panel-thumb]'), viewport: document.querySelector('[data-panel]') })
      })
      const thumb = page.locator('[data-page-thumb]')
      await thumb.waitFor()
      const hitThumb = locator => locator.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return document.elementFromPoint(rect.right - 8, rect.top + rect.height / 2) === element
      })
      assert.equal(await hitThumb(thumb), true, 'foreground content must not cover the page thumb')
      assert.equal(await page.locator('[data-page]').evaluate(element => element.clientWidth), 720)
      for (const y of [0, 400, 1000]) {
        await page.locator('[data-page]').evaluate((element, top) => { element.scrollTop = top }, y)
        await page.waitForTimeout(50)
        assert.equal(await hitThumb(thumb), true, `page thumb must receive input at scroll position ${y}`)
      }
      const bounds = await thumb.boundingBox()
      await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2 + 50, { steps: 4 })
      await page.mouse.up()
      assert.ok(await page.locator('[data-page]').evaluate(element => element.scrollTop) > 1100, 'drag must reach the native scroll host')
      await page.locator('.outer-overlay').evaluate(element => { element.hidden = false })
      assert.equal(await hitThumb(thumb), false, 'a local scrollbar layer must not escape over outer chrome')
      await page.locator('.outer-overlay').evaluate(element => { element.hidden = true })
      await page.locator('dialog').evaluate(element => element.showModal())
      assert.equal(await hitThumb(thumb), false, 'modal must stay above the background scroll frame')
      const panelThumb = page.locator('[data-panel-thumb]')
      await panelThumb.waitFor()
      assert.equal(await hitThumb(panelThumb), true, 'panel content must not cover its own thumb')
      await page.locator('dialog').evaluate(element => element.close())
      assert.equal(await hitThumb(thumb), true)
      await page.evaluate(() => { pageScrollbar.destroy(); panelScrollbar.destroy() })
      assert.equal(await thumb.isVisible(), false)
      assert.equal(await page.locator('[data-page]').evaluate(element => getComputedStyle(element).isolation), 'auto')
      assert.equal(await page.locator('[data-page]').evaluate(element => getComputedStyle(element.parentElement).isolation), 'auto')
      assert.equal(await page.evaluate(() => {
        const supports = CSS.supports
        CSS.supports = () => false
        try {
          return Primitives.enhanceOverlayScrollbar({ thumb: document.querySelector('[data-page-thumb]'), viewport: document.querySelector('[data-page]') }) === undefined
        } finally { CSS.supports = supports }
      }), true, 'an unsupported frame must retain native scrolling')
      assert.equal(await page.locator('[data-page]').getAttribute('data-overlay-scrollbar'), null)
    } finally {
      await browser.close()
    }
  })
}
