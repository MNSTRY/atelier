/**
 * Layout-stable page scroll lock (browser), the contract documented in
 * portable-presentation.md: measure the scrollbar a lock hides, pay it back as
 * body end padding, expose it as --scroll-lock-gap for fixed and sticky
 * elements, and restore both when the last lock is released. Locks are
 * counted, so one closing overlay cannot release another's.
 */
import { scrollLockGap } from './state.mjs'

const holders = new Set()
let saved = null

/** Lock page scrolling for `owner` (any value). Returns a release function. */
export function lockScroll(owner = Symbol('scroll-lock')) {
  holders.add(owner)
  if (!saved) {
    const html = document.documentElement
    const body = document.body
    // Measure the body's laid-out width, not the root's clientWidth: with a stable
    // scrollbar gutter some engines report the root inconsistently during the change.
    const before = body.getBoundingClientRect().width
    saved = { padding: body.style.paddingInlineEnd, overflow: html.style.overflow, overscroll: html.style.overscrollBehavior }
    html.style.overflow = 'hidden'
    html.style.overscrollBehavior = 'none'
    const gap = scrollLockGap(before, body.getBoundingClientRect().width)
    const existing = parseFloat(getComputedStyle(body).paddingInlineEnd) || 0
    if (gap) body.style.paddingInlineEnd = `${existing + gap}px`
    html.style.setProperty('--scroll-lock-gap', `${gap}px`)
    html.dataset.scrollLocked = ''
  }
  return () => unlockScroll(owner)
}

/** Release `owner`'s lock; the page unlocks when no holder remains. */
export function unlockScroll(owner) {
  holders.delete(owner)
  if (holders.size || !saved) return
  const html = document.documentElement
  document.body.style.paddingInlineEnd = saved.padding
  html.style.overflow = saved.overflow
  html.style.overscrollBehavior = saved.overscroll
  html.style.removeProperty('--scroll-lock-gap')
  delete html.dataset.scrollLocked
  saved = null
}

export const scrollLocked = () => holders.size > 0
