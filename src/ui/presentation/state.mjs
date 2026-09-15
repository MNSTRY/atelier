export const stateAxes = Object.freeze(['hovered', 'focused', 'pressed', 'selected', 'disabled', 'pending', 'dragging', 'invalid'])
export const EDIT_CODE_POINT_LIMIT = 32768
const toneLabels = Object.freeze({ neutral: '', info: 'Information', warning: 'Warning', danger: 'Attention', success: 'Success' })
export function toneLabel(tone) {
  if (!Object.hasOwn(toneLabels, tone)) throw new TypeError('invalid presentation tone')
  return toneLabels[tone]
}
// Delivery is not business success. Describe the settling request's outcome,
// independently of unrelated failures, and do not hide concurrent deliveries.
export function deliveryMessage(outcome, pendingCount = 0) {
  if (!['sending', 'delivered', 'failed', 'suppressed'].includes(outcome) || !Number.isSafeInteger(pendingCount) || pendingCount < 0) throw new TypeError('invalid delivery state')
  if (outcome === 'sending') return 'Sending request. Awaiting host state.'
  if (outcome === 'suppressed') return 'Request already pending. No additional request sent.'
  const message = outcome === 'failed' ? 'Request delivery failed. Host state has not been confirmed.' : 'Request delivered. Awaiting host state.'
  return message + (pendingCount ? ' Other requests are still pending.' : '')
}
// Match the schema's Unicode code-point limit; never truncate a host draft.
export function editValueError(value) {
  if (typeof value !== 'string') return 'Draft must be text.'
  let count = 0
  for (const point of value) {
    const code = point.codePointAt(0)
    if (code >= 0xd800 && code <= 0xdfff) return 'Draft contains an incomplete Unicode character.'
    if (++count > EDIT_CODE_POINT_LIMIT) return 'Draft exceeds 32768 characters. It remains in the editor; no request was sent.'
  }
  return null
}
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
