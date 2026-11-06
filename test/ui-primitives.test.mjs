import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  arrowStep,
  autoplayConfig,
  carouselStyles,
  dragIntent,
  driftStep,
  glideStep,
  loopThumbGeometry,
  rampFactor,
  resumeDelay,
  releaseVelocity,
  homeIndex,
  loopSets,
  motionAllowed,
  nearestCopy,
  pageSize,
  recede,
  renderCarouselControls,
  rowFit,
  scrollLockGap,
  scrubPosition,
  slideWindow,
  swipeStep,
  thumbGeometry,
  wrap,
} from '../src/ui/primitives/index.mjs'

test('slide windows clamp at the ends unless the carousel loops', () => {
  assert.deepEqual(slideWindow(0, 5, 2), { start: 0, end: 2, previousDisabled: true, nextDisabled: false })
  assert.deepEqual(slideWindow(9, 5, 2), { start: 3, end: 5, previousDisabled: false, nextDisabled: true })
  assert.deepEqual(slideWindow(-1, 5, 1, true), { start: 4, end: 5, previousDisabled: false, nextDisabled: false })
})

test('a drag becomes horizontal only when it clearly dominates, and release picks a step', () => {
  assert.equal(dragIntent(4, 3), 'pending')
  assert.equal(dragIntent(30, 10), 'horizontal')
  assert.equal(dragIntent(12, 11), 'vertical')
  assert.equal(swipeStep(-60, 5), 1)
  assert.equal(swipeStep(60, 5), -1)
  assert.equal(swipeStep(-30, 2, 120), 1, 'a quick flick steps')
  assert.equal(swipeStep(-30, 2, 800), 0, 'a slow short drag stays')
  assert.equal(swipeStep(-40, 60), 0, 'a vertical gesture never steps')
})

test('loops keep a clone runway and map any copy back to its real slide', () => {
  assert.equal(loopSets(4, 1), 1)
  assert.equal(loopSets(4, 9), 3)
  assert.equal(homeIndex(1, 4, 2), 9)
  assert.equal(homeIndex(14, 4, 2), 10)
  assert.equal(nearestCopy(9, 0, 4), -1)
  assert.equal(nearestCopy(9, 2, 4), 1)
  assert.equal(nearestCopy(9, 0, 4), -1)
  assert.equal(wrap(-1, 10), 9)
  assert.equal(wrap(25, 10), 5)
})

test('pages, receding neighbours and still rows follow the measured geometry', () => {
  assert.equal(pageSize(1300, 336), 3)
  assert.equal(pageSize(1343, 336), 4, 'a page that fits to the pixel counts')
  assert.equal(pageSize(200, 336), 1)
  assert.equal(arrowStep(4, 8, true), 4)
  assert.equal(arrowStep(4, 5, true), 1, 'a loop one card longer than a page steps one card')
  assert.equal(arrowStep(4, 5, false), 4)
  assert.equal(recede(2.25, 2), 0.25)
  assert.equal(recede(5, 2), 1)
  assert.equal(rowFit(3, 420, 20, 1300, 400), 420)
  assert.equal(rowFit(3, 420, 20, 1000, 400), 0)
})

test('the scroll bar maps pointer travel to the scroll range and reflects position', () => {
  assert.equal(scrubPosition(100, 0, 300, 100, 0, 2000), 1000)
  assert.equal(scrubPosition(-50, 0, 300, 100, 0, 2000), 0)
  assert.equal(scrubPosition(900, 0, 300, 100, 0, 2000), 2000)
  assert.equal(scrubPosition(150, 0, 300, 100, 50, 2000), 1000)
  assert.deepEqual(thumbGeometry(0, 1000, 1000), { width: 0.5, left: 0 })
  assert.deepEqual(thumbGeometry(5000, 1000, 1000), { width: 0.5, left: 0.5 })
})

test('a looping thumb wraps past the end, and a resumed drift eases in', () => {
  assert.deepEqual(loopThumbGeometry(0, 2000, 500), { width: 0.25, left: 0 })
  assert.deepEqual(loopThumbGeometry(1800, 2000, 500), { width: 0.25, left: 0.9 }, 'left + width > 1 re-enters from the start')
  assert.deepEqual(loopThumbGeometry(2100, 2000, 500), { width: 0.25, left: 0.05 })
  assert.equal(rampFactor(0), 0)
  assert.equal(rampFactor(600, 1200), 0.5)
  assert.equal(rampFactor(5000, 1200), 1)
  assert.equal(resumeDelay(undefined), 2000)
  assert.equal(resumeDelay('500'), 500)
  assert.equal(resumeDelay(99999), 10000)
})

test('momentum decays and drift loops or restarts', () => {
  const step = glideStep(100, 2, 16)
  assert.equal(step.position, 132)
  assert.ok(step.velocity < 2 && step.velocity > 1.8)
  assert.equal(glideStep(0, 1, 500).position, 32, 'a long frame is capped')
  assert.equal(releaseVelocity(-300, 100), 2.5, 'a fast fling is capped')
  assert.equal(releaseVelocity(100, 100), -1)
  assert.equal(driftStep(999, 30, 50, 1000), 0.5, 'a loop wraps')
  assert.equal(driftStep(999, 30, 50, 0, 1000), 0, 'a strip restarts')
  assert.equal(driftStep(0, 30, 5000), 1.92, 'a long frame is capped')
})

test('autoplay is opt-in, bounded and stopped by reduced motion or a hidden tab', () => {
  assert.deepEqual(autoplayConfig(), { mode: 'off', interval: 6000, speed: 28 })
  assert.deepEqual(autoplayConfig({ mode: 'smooth', speed: 9999 }), { mode: 'smooth', interval: 6000, speed: 400 })
  assert.equal(autoplayConfig({ mode: 'discrete', interval: 100 }).interval, 2500)
  assert.equal(autoplayConfig({ mode: 'spin' }).mode, 'off')
  assert.equal(motionAllowed(false, false, false), true)
  assert.equal(motionAllowed(true, false, false), false)
  assert.equal(motionAllowed(false, false, true), false)
})

test('scroll locks pay back only the scrollbar they hide', () => {
  assert.equal(scrollLockGap(1425, 1440), 15)
  assert.equal(scrollLockGap(1440, 1440), 0, 'overlay scrollbars and kept gutters need nothing')
  assert.equal(scrollLockGap(1440, 1425), 0)
})

test('controls are escaped, labelled and hidden until the enhancer measures overflow', () => {
  const html = renderCarouselControls({ label: 'Box <sets>', autoplay: 'discrete' })
  assert.match(html, /data-controls hidden/)
  assert.match(html, /aria-label="Previous: Box &lt;sets&gt;"/)
  assert.match(html, /data-autoplay-toggle aria-label="Pause automatic scrolling" hidden/)
  assert.match(html, /data-scrollbar aria-hidden="true"/)
  assert.match(html, /data-status aria-live="polite"/)
  assert.doesNotMatch(renderCarouselControls({ label: 'x' }), /data-autoplay-toggle/)
  assert.doesNotMatch(renderCarouselControls({ label: 'x', scrollbar: false }), /data-scrollbar/)
})

test('carousel styles are tenant-neutral and themed only through custom properties', () => {
  assert.match(carouselStyles, /--system-carousel-gap, 1\.25rem/)
  assert.match(carouselStyles, /--system-carousel-scrollbar-thumb, var\(--system-scrollbar-thumb, currentColor\)/)
  assert.match(carouselStyles, /\[data-drift\] \[data-carousel-viewport\] \{ scroll-snap-type: none; \}/)
  assert.match(carouselStyles, /prefers-reduced-motion: reduce/)
  assert.doesNotMatch(carouselStyles, /#[0-9a-f]{6}/i, 'no hard-coded colours')
})

test('browser modules are exported separately', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./ui/primitives'], './src/ui/primitives/index.mjs')
  assert.equal(pkg.exports['./ui/primitives/browser'], './src/ui/primitives/browser.mjs')
})
