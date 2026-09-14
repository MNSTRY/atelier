export const stateAxes = Object.freeze(['hovered', 'focused', 'pressed', 'selected', 'disabled', 'pending', 'dragging', 'invalid'])
export function presentationState(input = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('invalid state')
  for (const key of Object.keys(input)) if (!stateAxes.includes(key) || typeof input[key] !== 'boolean') throw new TypeError('unknown state axis')
  return Object.freeze(Object.fromEntries(stateAxes.map(key => [key, input[key] ?? false])))
}
export function resizeRequest(width, value) {
  if (!width || ![width.min, width.max, width.value, value].every(Number.isFinite) || width.min > width.max || width.value < width.min || width.value > width.max) throw new TypeError('invalid resize range')
  return Math.max(width.min, Math.min(width.max, value))
}
export function keyboardResize(width, key, direction = 'ltr') {
  if (!['ltr', 'rtl'].includes(direction)) throw new TypeError('invalid direction')
  if (key === 'Home') return resizeRequest(width, width.min)
  if (key === 'End') return resizeRequest(width, width.max)
  if (!['ArrowLeft', 'ArrowRight'].includes(key)) return null
  return resizeRequest(width, width.value + (key === 'ArrowRight' ? 1 : -1) * (direction === 'rtl' ? -1 : 1))
}
