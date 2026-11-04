/**
 * Carousel enhancer (browser). Progressive enhancement over plain HTML: without
 * script every slide is a native horizontal scroller (track) or a stacked list
 * (fade). See docs/reference/ui-primitives.md for the markup contract.
 *
 * Track carousels scroll natively (CSS scroll snap), so touch, trackpad, wheel
 * and keyboard keep the platform's physics. Script adds seamless loops over
 * inert clones, mouse drag (with momentum for multi-card strips), a draggable
 * scroll bar, arrows, pages or thumbnails, a live status, height that follows
 * the current slide, receding neighbours, a still row when every card fits,
 * and discrete or smooth autoplay with a pause control.
 */
import {
  arrowStep, autoplayConfig, dragIntent, driftStep, glideStep, homeIndex, loopSets, loopThumbGeometry, nearestCopy, rampFactor, releaseVelocity, resumeDelay,
  pageSize, recede, rowFit, scrubPosition, slideWindow, swipeStep, thumbGeometry, wrap,
} from './state.mjs'
import { animationAllowed, onMotionChange } from './motion.mjs'

const q = (root, selectors) => root.querySelector(selectors)
const qa = (root, selectors) => [...root.querySelectorAll(selectors)]

// Move keyboard focus before its slide becomes inert or hidden.
function focusAvailable(candidates, reveal = false) {
  const target = candidates.find(element => element && !element.matches(':disabled') && !element.closest('[inert], [hidden]') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
  target?.focus({ preventScroll: !reveal })
  return !!target && document.activeElement === target
}
function revealControlFocus(controls) {
  const focused = document.activeElement
  if (focused instanceof HTMLElement && controls?.contains(focused) && focused.getClientRects().length) focused.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
}
function preserveSlideFocus(slides, shown, control) {
  if (!slides.some(slide => slide !== shown && slide.contains(document.activeElement))) return
  const controls = control?.closest('[data-controls]')
  focusAvailable([control, ...(controls ? controls.querySelectorAll('button') : [])])
}

/** Enhance every `[data-carousel]` under `root`. Safe to call more than once. */
export function enhanceCarousels(root = document) {
  return qa(root, '[data-carousel]').map(enhanceCarousel).filter(Boolean)
}

export function enhanceCarousel(root) {
  if (root.dataset.ready !== undefined) return null
  const track = q(root, '[data-carousel-track], .carousel__track')
  if (!track) return null
  // Slides are the track's children; `data-slide` narrows that when a track holds other elements.
  const children = [...track.children].filter(element => !element.hasAttribute('data-clone'))
  const slides = children.some(element => element.hasAttribute('data-slide')) ? children.filter(element => element.hasAttribute('data-slide')) : children
  const parts = {
    root, track, slides, n: slides.length,
    label: root.getAttribute('aria-label') ?? 'Carousel',
    viewport: q(root, '[data-carousel-viewport], .carousel__viewport') || track,
    controls: q(root, '[data-controls]'),
    back: q(root, '[data-prev]'),
    next: q(root, '[data-next]'),
    pages: qa(root, '[data-page]'),
    status: q(root, '[data-status]'),
    count: q(root, '[data-count]'),
    scrollbar: q(root, '[data-scrollbar]'),
    toggle: q(root, '[data-autoplay-toggle]'),
    autoplay: autoplayConfig({ mode: root.dataset.autoplay, interval: root.dataset.interval, speed: root.dataset.speed }),
  }
  if (parts.n < 2) { if (parts.controls) parts.controls.hidden = true; root.dataset.ready = ''; return null }
  slides.forEach((slide, i) => {
    slide.setAttribute('role', 'group')
    slide.setAttribute('aria-roledescription', 'slide')
    if (!slide.hasAttribute('aria-label')) slide.setAttribute('aria-label', `${i + 1} of ${parts.n}`)
  })
  root.querySelectorAll('img, a').forEach(element => element.setAttribute('draggable', 'false'))
  // Thumbnail pages without their own image show the slide's image.
  parts.pages.forEach((page, i) => {
    if (!page.hasAttribute('data-thumb') || page.querySelector('img')) return
    const img = slides[i]?.querySelector('img')
    const set = () => img?.currentSrc && page.style.setProperty('--thumb', `url("${img.currentSrc}")`)
    img?.complete ? set() : img?.addEventListener('load', set, { once: true })
  })
  return root.dataset.carousel === 'fade' ? initFade(parts) : initTrack(parts)
}

/* ------------------------------------------------------------------ autoplay */

function createAutoplay({ root, toggle, autoplay }, { advance, startDrift, stopDrift, canRun }) {
  const reasons = new Set()
  const pause = resumeDelay(root.dataset.resume)
  const timers = new Map()
  let userPaused = root.dataset.autoplayPaused !== undefined
  let onScreen = true
  let timer = 0
  const enabled = () => autoplay.mode !== 'off' && animationAllowed() && canRun()
  const running = () => enabled() && !userPaused && !reasons.size && onScreen
  const stop = () => { clearTimeout(timer); timer = 0; stopDrift() }
  const start = () => {
    stop()
    if (!running()) return
    if (autoplay.mode === 'discrete') timer = setTimeout(() => { advance(); start() }, autoplay.interval)
    else startDrift()
  }
  const sync = () => {
    root.dataset.autoplayState = enabled() ? (userPaused ? 'paused' : reasons.size ? 'held' : 'playing') : 'off'
    if (!toggle) return
    toggle.hidden = !enabled()
    toggle.setAttribute('aria-label', userPaused ? 'Play automatic scrolling' : 'Pause automatic scrolling')
    toggle.dataset.state = userPaused ? 'paused' : 'playing'
  }
  // A later hold for the same reason cancels a pending release.
  const hold = reason => { clearTimeout(timers.get(reason)); timers.delete(reason); reasons.add(reason); stop(); sync() }
  const release = (reason, delay = 0) => {
    clearTimeout(timers.get(reason))
    const go = () => { timers.delete(reason); reasons.delete(reason); start(); sync() }
    if (delay) timers.set(reason, setTimeout(go, delay)); else go()
  }
  if (autoplay.mode !== 'off') {
    // Autoplay keeps running under the pointer. It holds for a press (any click,
    // tap or drag), keyboard focus, a wheel, an expanded slide, a hidden tab or
    // off screen, and resumes gently `data-resume` ms (default 2000) after the
    // reader lets go.
    toggle?.addEventListener('click', () => { userPaused = !userPaused; start(); sync() })
    root.addEventListener('pointerdown', event => { if (!toggle?.contains(event.target)) hold('press') })
    const lift = () => release('press', pause)
    root.addEventListener('pointerup', lift)
    root.addEventListener('pointercancel', lift)
    root.addEventListener('focusin', event => { if (!toggle?.contains(event.target) && event.target.matches?.(':focus-visible')) hold('focus') })
    root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) release('focus', pause) })
    let wheelTimer = 0
    root.addEventListener('wheel', () => { hold('wheel'); clearTimeout(wheelTimer); wheelTimer = setTimeout(() => release('wheel'), pause) }, { passive: true })
    onMotionChange(() => { start(); sync() })
    if ('IntersectionObserver' in window) new IntersectionObserver(entries => { onScreen = entries.some(entry => entry.isIntersecting); start(); sync() }, { threshold: 0.25 }).observe(root)
  }
  return { start, stop, hold, release, sync, pause, restart: () => { if (autoplay.mode === 'discrete') start() }, smooth: autoplay.mode === 'smooth', active: running }
}

/* ------------------------------------------------------------- scroll bar */

function bindScrollbar({ root, scrollbar }, { geometry, scrubTo, begin, end }) {
  if (!scrollbar) return () => {}
  // Two thumb segments: in a loop, the part of the window past the end is drawn
  // again from the start, so the thumb leaves on the right and re-enters on the left.
  const thumbs = [...scrollbar.querySelectorAll(':scope > span, [data-scrollbar-thumb]')]
  if (!thumbs.length) return () => {}
  while (thumbs.length < 2) { const extra = document.createElement('span'); scrollbar.append(extra); thumbs.push(extra) }
  scrollbar.addEventListener('pointerdown', event => {
    if (event.button > 0) return
    event.preventDefault()
    const rail = scrollbar.getBoundingClientRect()
    const box = thumbs[0].getBoundingClientRect()
    const width = Math.min(box.width, rail.width)
    const onThumb = event.clientX >= box.left && event.clientX <= Math.min(box.right, rail.right)
    const grab = onThumb ? event.clientX - box.left : width / 2
    scrollbar.setPointerCapture(event.pointerId)
    root.dataset.scrubbing = ''
    begin()
    const move = x => scrubTo(scrubPosition(x, rail.left, rail.width, width, grab, geometry().range))
    move(event.clientX)
    const onMove = moveEvent => move(moveEvent.clientX)
    const onUp = () => { scrollbar.removeEventListener('pointermove', onMove); delete root.dataset.scrubbing; end() }
    scrollbar.addEventListener('pointermove', onMove)
    scrollbar.addEventListener('pointerup', onUp, { once: true })
    scrollbar.addEventListener('pointercancel', onUp, { once: true })
  })
  return () => {
    const { position, range, viewport, period } = geometry()
    // In a loop the thumb spans the part of the period not covered by the scroll range, so it
    // reaches the right end exactly when the last slide does, and wraps only beyond that.
    const { width, left } = period ? loopThumbGeometry(position, period, period - range) : thumbGeometry(position, range, viewport)
    thumbs[0].style.width = thumbs[1].style.width = `${width * 100}%`
    thumbs[0].style.left = `${left * 100}%`
    thumbs[1].style.left = `${(left - 1) * 100}%`
    thumbs[1].hidden = !period
    scrollbar.hidden = range <= 1
  }
}

/* ------------------------------------------------------------------ track */

function initTrack(parts) {
  const { root, viewport, track, slides, n, label, controls, back, next, pages, status, count } = parts
  const loop = root.hasAttribute('data-loop')
  const peek = root.hasAttribute('data-peek') || root.classList.contains('carousel--peek')
  // select="current": one slide is current and the rest are inert (slideshows).
  // select="visible": every card on screen stays interactive (product strips).
  const visibleMode = root.dataset.select === 'visible'
  const pageStep = (root.dataset.step || (visibleMode ? 'page' : 'item')) === 'page'
  // fit="current": the strip is as tall as the slide in view, blending between heights as they pass.
  const fitCurrent = root.dataset.fit === 'current'
  const rowMin = Number(root.dataset.rowMin) || 400
  let sets = 0
  let items = slides
  let step = 0, current = -1, target = null, announce = false, row = false, timer = 0, realigned = false
  let home = 0, intent = false, drifting = false, gliding = 0, scrubbing = false
  // free: the reader left the strip between cards (a scrub, a throw, a centred slide); nothing pulls it back.
  let free = false
  let heights = [], padY = 0, padTop = 0
  let drag = null, suppressClick = false

  const buildClones = perSide => {
    track.querySelectorAll('[data-clone]').forEach(clone => clone.remove())
    sets = loop ? loopSets(n, perSide) : 0
    if (sets) {
      const clone = slide => {
        const copy = slide.cloneNode(true)
        copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
        copy.dataset.clone = ''; copy.inert = true; copy.setAttribute('aria-hidden', 'true')
        return copy
      }
      const copies = () => Array.from({ length: sets }, () => slides.map(clone)).flat()
      track.prepend(...copies()); track.append(...copies())
    }
    items = [...track.children]
  }
  const first = () => sets * n
  const position = () => (step ? viewport.scrollLeft / step : 0)
  const scrollToIndex = (index, smooth) => viewport.scrollTo({ left: index * step, behavior: smooth && animationAllowed() ? 'smooth' : 'instant' })
  const perPage = () => (pageStep ? arrowStep(pageSize(viewport.clientWidth, step), n, loop) : 1)
  const lastIndex = () => (step ? Math.max(0, Math.round((viewport.scrollWidth - viewport.clientWidth) / step)) : 0)

  const fitHeight = pos => {
    if (!fitCurrent || row || !heights.length) return
    const a = Math.floor(pos), h = i => heights[((i % n) + n) % n]
    viewport.style.height = `${h(a) + (h(a + 1) - h(a)) * (pos - a) + padY}px`
  }
  const placeArrows = () => {
    const middle = fitCurrent && heights.length ? padTop + Math.min(...heights) / 2 : viewport.offsetHeight / 2
    root.style.setProperty('--mid', `${viewport.offsetTop + middle}px`)
  }
  const measureHeights = () => {
    if (!fitCurrent) return
    const style = getComputedStyle(viewport)
    padTop = parseFloat(style.paddingTop); padY = padTop + parseFloat(style.paddingBottom)
    heights = slides.map(slide => slide.offsetHeight)
  }

  // The scroll position at which the last real slide sits at the viewport's inner end edge
  // (measured, so side insets and gaps are respected), relative to the start of the loop.
  const loopEnd = () => {
    const last = slides.at(-1)
    const box = viewport.getBoundingClientRect(), edge = parseFloat(getComputedStyle(viewport).scrollPaddingRight) || 0
    const end = viewport.scrollLeft + last.getBoundingClientRect().right - (box.right - edge)
    return Math.max(0, wrap(end - first() * step, n * step) || 0)
  }
  const geometry = () => {
    if (sets) {
      const period = n * step
      return { position: wrap(viewport.scrollLeft - first() * step, period), range: loopEnd(), viewport: viewport.clientWidth, period }
    }
    return { position: viewport.scrollLeft, range: Math.max(0, viewport.scrollWidth - viewport.clientWidth), viewport: viewport.clientWidth }
  }
  const paintScrollbar = bindScrollbar(parts, {
    geometry,
    scrubTo: offset => { viewport.scrollLeft = (sets ? first() * step : 0) + offset },
    begin: () => { stopGlide(); scrubbing = true; intent = true; viewport.style.scrollSnapType = 'none'; player.hold('scrub') },
    end: () => { scrubbing = false; free = true; settleSoon(); player.release('scrub', player.pause) },
  })

  const paint = () => {
    if (row || !step) return
    const pos = position(), c = Math.max(0, Math.min(items.length - 1, Math.round(pos)))
    if (peek) items.forEach((item, i) => item.style.setProperty('--d', recede(pos, i).toFixed(3)))
    fitHeight(pos)
    paintScrollbar()
    if (c === current) return
    current = c
    if (!loop && back && next) { back.disabled = c <= 0; next.disabled = c >= lastIndex() }
    if (!visibleMode) preserveSlideFocus(items, items[c], pages[c % n])
    items.forEach((item, i) => {
      const shown = i === c
      item.classList.toggle('is-current', shown)
      if (!visibleMode && !item.hasAttribute('data-clone')) { item.inert = !shown; item.toggleAttribute('aria-hidden', !shown) }
    })
    pages.forEach((page, i) => page.setAttribute('aria-current', String(i === c % n)))
    if (count) count.textContent = `${(c % n) + 1} / ${n}`
  }

  // Keep a looping strip inside the real slides by moving whole periods over identical clones (invisible).
  const loopBase = () => first() * step
  const normalizeTo = position => (sets && step ? loopBase() + wrap(position - loopBase(), n * step) : position)
  const normalize = () => {
    const position = viewport.scrollLeft, wrapped = normalizeTo(position)
    if (Math.abs(wrapped - position) > 0.5) viewport.scrollTo({ left: wrapped, behavior: 'instant' })
  }

  // Once still: step back onto the real slide showing the same content (identical, so invisible).
  const settle = () => {
    if (row || !step || drag || gliding || scrubbing) return
    if (drifting) return
    // Drifting strips and free positions stay exactly where the reader left them.
    if (player.smooth || free) {
      normalize()
      home = sets ? wrap(Math.round(position()) - first(), n) : Math.round(position())
      intent = false; target = null; realigned = false
      paint()
      return
    }
    if (!intent) {
      if (!player.smooth) viewport.style.removeProperty('scroll-snap-type')
      const goal = (first() + home) * step
      if (Math.abs(viewport.scrollLeft - Math.min(goal, viewport.scrollWidth - viewport.clientWidth)) > 1) scrollToIndex(first() + home, false)
      paint(); return
    }
    const c = Math.round(position())
    if (!player.smooth && !realigned && Math.abs(viewport.scrollLeft - c * step) > 2 && c < lastIndex()) {
      realigned = true; viewport.style.removeProperty('scroll-snap-type'); scrollToIndex(c, true)
      if (!animationAllowed()) settle()
      return
    }
    realigned = false
    if (sets && (c < first() || c >= first() + n)) viewport.scrollTo({ left: viewport.scrollLeft + (homeIndex(c, n, sets) - c) * step, behavior: 'instant' })
    home = ((Math.round(position()) % n) + n) % n
    if (!sets) home = Math.round(position())
    intent = false; target = null
    if (!player.smooth) viewport.style.removeProperty('scroll-snap-type')
    paint()
    if (announce && status) { status.textContent = `${label}: ${(current % n) + 1} of ${n}`; announce = false }
  }
  const settleSoon = () => { if (!('onscrollend' in window)) { clearTimeout(timer); timer = setTimeout(settle, 140) } else requestAnimationFrame(() => settle()) }

  const go = (delta, { user = true } = {}) => {
    if (row || !step) return
    stopGlide()
    intent = true
    free = false
    let base = target ?? Math.round(position())
    if (sets) {
      const equivalent = homeIndex(base, n, sets)
      if (equivalent !== base) { viewport.scrollTo({ left: viewport.scrollLeft + (equivalent - base) * step, behavior: 'instant' }); base = equivalent }
    } else if (loop && delta > 0 && base >= lastIndex()) {
      delta = -base // a loop too short for clones still wraps
    } else if (loop && delta < 0 && base <= 0) {
      delta = lastIndex()
    }
    const to = sets ? base + delta : Math.max(0, Math.min(lastIndex(), base + delta))
    target = to; announce = user
    scrollToIndex(to, true)
  }
  const goTo = index => go(sets ? nearestCopy(target ?? Math.round(position()), index, n) : index - (target ?? Math.round(position())))

  const measure = () => {
    const focusedSlide = slides.findIndex(slide => slide.contains(document.activeElement))
    const keep = row && focusedSlide >= 0 ? focusedSlide : home
    home = keep
    const controlFocused = controls?.contains(document.activeElement)
    const focusedPage = pages.findIndex(page => page.contains(document.activeElement))
    root.style.removeProperty('--slide-fit'); delete root.dataset.row
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0
    const fit = peek ? rowFit(n, slides[0].offsetWidth, gap, root.clientWidth, rowMin) : 0
    row = fit > 0
    viewport.style.removeProperty('height')
    if (row) {
      root.dataset.row = ''; root.style.setProperty('--slide-fit', `${fit}px`)
      slides.forEach(slide => { slide.inert = false; slide.removeAttribute('aria-hidden'); slide.classList.remove('is-current'); slide.style.removeProperty('--d') })
      if (controlFocused) {
        const shown = slides[focusedPage >= 0 ? focusedPage : keep]
        if (!focusAvailable([...shown.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')], true)) { root.tabIndex = -1; root.focus() }
      }
      if (controls) controls.hidden = true
      current = -1
      return
    }
    // Fractional widths matter: offsetLeft rounds, and the error grows per card.
    const width = parseFloat(getComputedStyle(slides[0]).width)
    step = width + gap
    root.style.setProperty('--slide-px', `${width}px`)
    const fitsAll = !sets && viewport.scrollWidth - viewport.clientWidth <= 1
    if (loop) {
      const needed = pageSize(viewport.clientWidth, step) + (peek ? 4 : 1)
      if (!sets || loopSets(n, needed) !== sets) buildClones(needed)
      // A loop that cannot fill the screen with one set falls back to plain wrapping arrows.
      if (n * step < viewport.clientWidth) { track.querySelectorAll('[data-clone]').forEach(clone => clone.remove()); sets = 0; items = slides }
    }
    root.dataset.overflow = String(!(fitsAll || (!sets && viewport.scrollWidth - viewport.clientWidth <= 1)))
    if (controls) controls.hidden = root.dataset.overflow === 'false'
    measureHeights()
    current = -1; target = null
    scrollToIndex(first() + keep, false)
    paint()
    placeArrows()
    revealControlFocus(controls)
    player.sync()
  }

  // Momentum for multi-card strips; slideshows step one slide per swipe instead.
  // A drifting strip coasts longer and stops where it stops; others settle on a card.
  function stopGlide() { if (gliding) { cancelAnimationFrame(gliding); gliding = 0; player.release('glide', player.pause) } }
  const glide = velocity => {
    const coast = player.smooth
    if (!animationAllowed() || Math.abs(velocity) < 0.05) { if (coast) free = true; settle(); return }
    player.hold('glide')
    let last = performance.now(), pos = viewport.scrollLeft
    const frame = now => {
      const next = glideStep(pos, velocity, now - last, coast ? 0.975 : 0.94)
      last = now; velocity = next.velocity
      pos = normalizeTo(next.position)
      viewport.scrollLeft = pos
      const atEdge = !sets && (pos <= 0 || pos >= viewport.scrollWidth - viewport.clientWidth)
      if (Math.abs(velocity) > (coast ? 0.01 : 0.03) && !atEdge) { gliding = requestAnimationFrame(frame); return }
      gliding = 0
      if (coast) free = true
      settle()
      player.release('glide', player.pause)
    }
    gliding = requestAnimationFrame(frame)
  }

  // Smooth autoplay keeps its own sub-pixel position so slow speeds never stall on rounding.
  let driftFrame = 0
  const player = createAutoplay(parts, {
    advance: () => go(perPage(), { user: false }),
    canRun: () => !row && root.dataset.overflow !== 'false',
    startDrift: () => {
      drifting = true
      viewport.style.scrollSnapType = 'none'
      let pos = viewport.scrollLeft, last = 0, began = 0
      const frame = now => {
        if (!began) began = now
        if (last) {
          // Ease back in after a pause instead of jumping to full speed.
          const speed = parts.autoplay.speed * rampFactor(now - began, 1200)
          if (sets) pos = first() * step + driftStep(pos - first() * step, speed, now - last, n * step)
          else pos = driftStep(pos, speed, now - last, 0, viewport.scrollWidth - viewport.clientWidth)
          viewport.scrollLeft = pos
        }
        last = now
        driftFrame = requestAnimationFrame(frame)
      }
      driftFrame = requestAnimationFrame(frame)
    },
    stopDrift: () => {
      if (!driftFrame) return
      cancelAnimationFrame(driftFrame); driftFrame = 0; drifting = false
      free = true
      home = ((Math.round(position()) - first()) % n + n) % n
    },
  })
  if (player.smooth) root.dataset.drift = ''

  // Something expanded inside a slide (a quick view, a details panel): centre that slide and hold
  // autoplay until everything inside the strip is closed again.
  const expanded = () => slides.some(slide => slide.querySelector('details[open]'))
  root.addEventListener('toggle', event => {
    const details = event.target
    if (!(details instanceof HTMLDetailsElement) || !track.contains(details) || details.closest('[data-clone]')) return
    if (details.open) {
      player.hold('expanded')
      stopGlide()
      const slide = slides.find(item => item.contains(details))
      if (!slide || row || !step) return
      free = true
      viewport.style.scrollSnapType = 'none'
      const box = viewport.getBoundingClientRect(), card = slide.getBoundingClientRect()
      viewport.scrollBy({ left: card.left + card.width / 2 - (box.left + box.width / 2), behavior: animationAllowed() ? 'smooth' : 'instant' })
    } else if (!expanded()) {
      player.release('expanded', player.pause)
    }
  }, true)

  viewport.addEventListener('scroll', () => {
    requestAnimationFrame(paint)
    if (!('onscrollend' in window)) { clearTimeout(timer); timer = setTimeout(settle, 140) }
  }, { passive: true })
  viewport.addEventListener('scrollend', settle)
  const user = () => { intent = true; stopGlide() }
  for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) viewport.addEventListener(type, user, { passive: true })

  back?.addEventListener('click', () => { go(-perPage()); player.restart() })
  next?.addEventListener('click', () => { go(perPage()); player.restart() })
  pages.forEach((page, i) => page.addEventListener('click', () => { goTo(i); player.restart() }))
  root.addEventListener('keydown', event => {
    if (row || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target.closest?.('input, select, textarea, [contenteditable]')) return
    const keys = { ArrowLeft: () => go(-1), ArrowRight: () => go(1), Home: () => goTo(0), End: () => goTo(n - 1) }
    if (!keys[event.key]) return
    event.preventDefault(); keys[event.key]()
  })

  // Mouse drag (touch and trackpads already scroll natively): follow the pointer, then settle.
  root.addEventListener('pointerdown', event => {
    if (row || event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('button, [data-scrollbar], input, select, textarea')) return
    if (!viewport.contains(event.target)) return
    stopGlide()
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, left: viewport.scrollLeft, state: 'pending', samples: [{ x: event.clientX, t: event.timeStamp }] }
    suppressClick = false
  })
  root.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (drag.state === 'pending') {
      drag.state = dragIntent(dx, dy)
      if (drag.state === 'vertical') { drag = null; return }
      if (drag.state === 'horizontal') {
        root.setPointerCapture(event.pointerId); root.dataset.dragging = ''
        viewport.style.scrollSnapType = 'none'; intent = true; player.hold('drag')
      }
    }
    if (drag.state === 'horizontal') {
      let to = drag.left - dx
      const wrapped = normalizeTo(to)
      drag.left += wrapped - to; to = wrapped
      viewport.scrollLeft = to
      drag.samples.push({ x: event.clientX, t: event.timeStamp })
      if (drag.samples.length > 6) drag.samples.shift()
    }
  })
  const release = (event, cancelled) => {
    if (!drag || event.pointerId !== drag.id) return
    const { x, y, t, left, state, samples } = drag
    drag = null; delete root.dataset.dragging
    if (state !== 'horizontal') return
    suppressClick = true
    free = false
    if (visibleMode || player.smooth) {
      const a = samples[0], b = samples.at(-1)
      glide(cancelled ? 0 : releaseVelocity(b.x - a.x, b.t - a.t))
      player.release('drag', player.pause)
      return
    }
    player.release('drag', player.pause)
    const start = Math.round(left / step), near = Math.round(position())
    const flick = cancelled ? 0 : swipeStep(event.clientX - x, event.clientY - y, event.timeStamp - t)
    let to = near === start ? start + flick : near
    if (!sets) to = Math.max(0, Math.min(lastIndex(), to))
    announce = to !== start; target = to
    scrollToIndex(to, true)
    if (Math.abs(viewport.scrollLeft - to * step) < 1) settle()
  }
  root.addEventListener('pointerup', event => release(event, false))
  root.addEventListener('pointercancel', event => release(event, true))
  root.addEventListener('dragstart', event => event.preventDefault())
  root.addEventListener('click', event => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; return }
    // A click on a receding neighbour brings it to the centre instead of following its link.
    if (visibleMode || !peek || row || !step || event.detail === 0 || !viewport.contains(event.target)) return
    const box = viewport.getBoundingClientRect()
    const offset = Math.round((event.clientX - (box.left + box.width / 2)) / step)
    if (offset) { event.preventDefault(); event.stopPropagation(); go(offset) }
  }, true)

  let lastWidth = 0
  new ResizeObserver(() => requestAnimationFrame(() => { const w = root.clientWidth; if (Math.abs(w - lastWidth) > 0.5) { lastWidth = w; measure() } })).observe(root)
  if (fitCurrent) {
    const watch = new ResizeObserver(() => requestAnimationFrame(() => { if (row || !step) return; measureHeights(); fitHeight(position()); placeArrows() }))
    slides.forEach(slide => watch.observe(slide))
  }
  root.dataset.ready = ''
  measure()
  player.start()
  player.sync()
  return { root, go, goTo, pause: () => player.hold('api'), play: () => player.release('api') }
}

/* ------------------------------------------------------------------- fade */

function initFade(parts) {
  const { root, viewport, slides, n, label, controls, back, next, pages, status, count } = parts
  const loop = root.hasAttribute('data-loop')
  const fit = root.dataset.fit === 'current'
  let active = 0
  const fitHeight = () => { if (fit) viewport.style.height = `${slides[active].offsetHeight}px` }
  const placeArrows = () => {
    const height = fit ? Math.min(...slides.map(slide => slide.offsetHeight)) : viewport.offsetHeight
    root.style.setProperty('--mid', `${viewport.offsetTop + height / 2}px`)
  }
  let lastWidth = root.clientWidth
  const watch = new ResizeObserver(() => requestAnimationFrame(() => {
    const width = root.clientWidth, resized = Math.abs(width - lastWidth) > 0.5
    lastWidth = width
    fitHeight(); placeArrows()
    if (resized) revealControlFocus(controls)
  }))
  watch.observe(root); slides.forEach(slide => watch.observe(slide))
  const render = announce => {
    const state = slideWindow(active, n, 1, loop)
    active = state.start
    if (back) back.disabled = state.previousDisabled
    if (next) next.disabled = state.nextDisabled
    preserveSlideFocus(slides, slides[active], pages[active])
    slides.forEach((slide, i) => { const shown = i === active; slide.classList.toggle('is-current', shown); slide.inert = !shown })
    pages.forEach((page, i) => page.setAttribute('aria-current', String(i === active)))
    if (count) count.textContent = `${active + 1} / ${n}`
    fitHeight()
    if (announce && status) status.textContent = `${label}: ${active + 1} of ${n}`
    root.dispatchEvent(new CustomEvent('carousel:change', { detail: { index: active } }))
  }
  const go = (targetIndex, announce = true) => { active = loop ? ((targetIndex % n) + n) % n : Math.max(0, Math.min(n - 1, targetIndex)); render(announce) }
  const player = createAutoplay(parts, { advance: () => go(active + 1, false), canRun: () => true, startDrift: () => {}, stopDrift: () => {} })

  back?.addEventListener('click', () => { go(active - 1); player.restart() })
  next?.addEventListener('click', () => { go(active + 1); player.restart() })
  pages.forEach((page, i) => page.addEventListener('click', () => { go(i); player.restart() }))
  root.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const keys = { ArrowLeft: () => go(active - 1), ArrowRight: () => go(active + 1), Home: () => go(0), End: () => go(n - 1) }
    if (!keys[event.key]) return
    event.preventDefault(); keys[event.key]()
  })

  // Swipes: a horizontal gesture changes slide; a vertical one stays a page scroll.
  let drag = null, suppressClick = false
  root.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button > 0 || event.target.closest('button')) return
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, state: 'pending' }
    suppressClick = false
  })
  root.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id || drag.state !== 'pending') return
    drag.state = dragIntent(event.clientX - drag.x, event.clientY - drag.y)
    if (drag.state === 'vertical') drag = null
    else if (drag.state === 'horizontal') { root.setPointerCapture(event.pointerId); root.dataset.dragging = '' }
  })
  const release = (event, cancelled) => {
    if (!drag || event.pointerId !== drag.id) return
    const horizontal = drag.state === 'horizontal', delta = cancelled ? 0 : swipeStep(event.clientX - drag.x, event.clientY - drag.y, event.timeStamp - drag.t)
    drag = null; delete root.dataset.dragging
    if (!horizontal) return
    suppressClick = true
    if (delta) { go(active + delta); player.restart() }
  }
  root.addEventListener('pointerup', event => release(event, false))
  root.addEventListener('pointercancel', event => release(event, true))
  root.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false } }, true)

  if (controls) controls.hidden = false
  root.dataset.ready = ''
  render(false)
  placeArrows()
  player.start(); player.sync()
  return { root, go, pause: () => player.hold('api'), play: () => player.release('api') }
}
