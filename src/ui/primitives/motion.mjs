/**
 * One owner for motion (browser): the reduced-motion preference and hidden tabs
 * stop every effect started through these helpers.
 */
import { motionAllowed } from './state.mjs'

const listeners = new Set()
const running = new Set()
let reduced = null
let started = false

function preference() {
  if (!reduced && typeof matchMedia === 'function') reduced = matchMedia('(prefers-reduced-motion: reduce)')
  return reduced
}

/** True when animation may run now. */
export function animationAllowed() {
  return motionAllowed(Boolean(preference()?.matches), false, typeof document !== 'undefined' && document.hidden)
}

/** Call `listener` whenever the motion preference or tab visibility changes. */
export function onMotionChange(listener) {
  listeners.add(listener)
  startMotionWatch()
  return () => listeners.delete(listener)
}

/** A Web Animation owned by the motion layer: skipped when motion is off, finished when it turns off. */
export function animate(element, frames, options) {
  if (!animationAllowed() || !element.animate) return null
  const animation = element.animate(frames, options)
  running.add(animation)
  animation.finished.catch(() => {}).finally(() => running.delete(animation))
  return animation
}

function sync() {
  document.documentElement.classList.toggle('motion-paused', Boolean(preference()?.matches))
  if (!animationAllowed()) running.forEach(animation => animation.finish())
  listeners.forEach(listener => listener())
}

export function startMotionWatch() {
  if (started || typeof document === 'undefined') return
  started = true
  preference()?.addEventListener('change', sync)
  document.addEventListener('visibilitychange', sync)
  sync()
}
