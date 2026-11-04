/**
 * Pure state for Atelier UI primitives. No DOM access, so every rule
 * here is testable in Node and shared by the browser enhancers.
 */

/** Visible window of a carousel at `index`, with arrow availability. */
export function slideWindow(index, length, visible, loop = false) {
  const count = Math.max(1, Math.min(visible, length))
  const max = Math.max(0, length - count)
  const start = loop ? ((index % length) + length) % length : Math.min(max, Math.max(0, index))
  return { start, end: Math.min(length, start + count), previousDisabled: !loop && start === 0, nextDisabled: !loop && start === max }
}

/** A horizontal intent must clearly dominate before the page scroll is taken over. */
export function dragIntent(dx, dy) {
  if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return 'pending'
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'horizontal' : 'vertical'
}

/** Release decides the step: enough distance, or a quick flick. */
export function swipeStep(dx, dy, elapsed = Infinity) {
  if (Math.abs(dx) <= Math.abs(dy) * 1.2) return 0
  const flick = elapsed < 300 && Math.abs(dx) >= 24
  return Math.abs(dx) >= 50 || flick ? (dx < 0 ? 1 : -1) : 0
}

/** Motion runs only when the reader allows it, nothing paused it and the tab is visible. */
export function motionAllowed(reduced, paused, hidden = false) {
  return !reduced && !paused && !hidden
}

/** Clone sets needed on each side of a looping track to cover `perSide` slides. */
export function loopSets(length, perSide) {
  return Math.max(1, Math.ceil(perSide / Math.max(1, length)))
}

/** The index of the real slide showing the same content as item `index` of a looping track. */
export function homeIndex(index, length, sets) {
  return sets * length + ((index % length) + length) % length
}

/** Shortest signed distance from item `from` to any copy of real slide `to` in a loop. */
export function nearestCopy(from, to, length) {
  let delta = ((to - from) % length + length) % length
  if (delta > length / 2) delta -= length
  return delta
}

/** How far a slide has receded: 0 when it is the current slide, 1 from a full step away. */
export function recede(position, index) {
  return Math.min(1, Math.abs(position - index))
}

/** Few cards: when every card fits side by side (no narrower than `min`), show a still row. */
export function rowFit(length, natural, gap, room, min) {
  const width = Math.min(natural, (room - gap * (length - 1)) / length)
  return width >= min ? Math.floor(width) : 0
}

/** Whole items that fit in the viewport: the size of one page for page-stepping carousels. */
export function pageSize(viewport, step) {
  return step > 0 ? Math.max(1, Math.floor((viewport + 1) / step)) : 1
}

/** Arrow step for page-stepping carousels. A loop only slightly longer than a page steps by the hidden remainder, so Next never reads as going backwards. */
export function arrowStep(page, length, loop) {
  if (!loop) return Math.max(1, page)
  return Math.max(1, Math.min(page, length - page))
}

/** Wrap a position into [0, period). */
export function wrap(position, period) {
  if (!(period > 0)) return position
  return ((position % period) + period) % period
}

/** Scroll position for a pointer on a scroll bar; `grab` is where the thumb was taken hold of. */
export function scrubPosition(pointerX, railLeft, railWidth, thumbWidth, grab, range) {
  const travel = railWidth - thumbWidth
  if (travel <= 0 || range <= 0) return 0
  const ratio = Math.min(1, Math.max(0, (pointerX - railLeft - grab) / travel))
  return ratio * range
}

/** Scroll bar thumb geometry, as fractions of the rail, for a viewport over a content range. */
export function thumbGeometry(position, range, viewport) {
  const total = range + viewport
  if (total <= 0) return { width: 1, left: 0 }
  const width = Math.min(1, viewport / total)
  const left = Math.min(Math.max(0, position), range) / total
  return { width, left }
}

/**
 * Thumb for a looping strip: one window over a repeating period. `left` can run
 * past 1; the part beyond the end is drawn again from the start, so the thumb
 * leaves the right end and re-enters on the left as the loop continues.
 */
export function loopThumbGeometry(position, period, viewport) {
  if (!(period > 0)) return { width: 1, left: 0 }
  return { width: Math.min(1, viewport / period), left: wrap(position, period) / period }
}

/** Speed factor for a drift easing back in after a pause: 0 to 1 over `duration` ms (smoothstep). */
export function rampFactor(elapsed, duration = 1200) {
  if (!(duration > 0)) return 1
  const t = Math.min(1, Math.max(0, elapsed / duration))
  return t * t * (3 - 2 * t)
}

/** Delay before autoplay resumes after a reader's interaction. */
export function resumeDelay(value) {
  const ms = Number(value)
  return Number.isFinite(ms) ? Math.min(10000, Math.max(0, ms)) : 2000
}

/** Momentum after a mouse drag: velocity in px/ms, decaying per 16ms frame. */
export const MAX_GLIDE_VELOCITY = 2.5
/** Release velocity in px/ms, capped so a fast fling travels a few cards, not the whole strip. */
export function releaseVelocity(dx, dt) {
  const velocity = -dx / Math.max(1, dt)
  return Math.max(-MAX_GLIDE_VELOCITY, Math.min(MAX_GLIDE_VELOCITY, velocity))
}
export function glideStep(position, velocity, elapsed, friction = 0.94) {
  const dt = Math.min(32, Math.max(0, elapsed))
  return { position: position + velocity * dt, velocity: velocity * Math.pow(friction, dt / 16) }
}

/** Autoplay modes: a discrete step every interval, or a smooth drift in px/s. */
export const AUTOPLAY_MODES = Object.freeze(['off', 'discrete', 'smooth'])
export function autoplayConfig({ mode = 'off', interval = 6000, speed = 28 } = {}) {
  return {
    mode: AUTOPLAY_MODES.includes(mode) ? mode : 'off',
    interval: Math.max(2500, Number(interval) || 6000),
    speed: Math.min(400, Math.max(4, Number(speed) || 28)),
  }
}

/** Advance a smooth drift; loops within `period` when one is given. */
export function driftStep(position, speed, elapsed, period = 0, max = Infinity) {
  const next = position + speed * Math.min(64, Math.max(0, elapsed)) / 1000
  if (period > 0) return wrap(next, period)
  return next >= max ? 0 : next
}

/**
 * Scroll lock (portable-presentation contract): the width a lock must pay back
 * is the scrollbar it hides, measured as the growth of the body's laid-out width.
 * It is zero for overlay scrollbars and for gutters the browser keeps.
 */
export function scrollLockGap(widthBefore, widthAfter) {
  return Math.max(0, Math.round((widthAfter - widthBefore) * 100) / 100)
}
