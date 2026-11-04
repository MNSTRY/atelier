/** HTML for the carousel controls and live status (tenant-neutral, escaped). */
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const chevron = direction => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${direction === 'previous' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}"/></svg>`
const toggleIcons = '<svg class="system-carousel__pause" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg><svg class="system-carousel__play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>'

/**
 * Controls for a carousel: optional scroll bar, optional autoplay toggle,
 * previous and next buttons, and a polite status for reader-initiated moves.
 */
export function renderCarouselControls({ label = 'Carousel', autoplay = 'off', scrollbar = true, arrows = true } = {}) {
  const name = escape(label)
  const parts = []
  if (scrollbar) parts.push('<div class="system-carousel__scrollbar" data-scrollbar aria-hidden="true"><span></span></div>')
  const buttons = []
  if (autoplay === 'discrete' || autoplay === 'smooth') buttons.push(`<button type="button" class="system-carousel__button system-carousel__toggle" data-autoplay-toggle aria-label="Pause automatic scrolling" hidden>${toggleIcons}</button>`)
  if (arrows) {
    buttons.push(`<button type="button" class="system-carousel__button" data-prev aria-label="Previous: ${name}">${chevron('previous')}</button>`)
    buttons.push(`<button type="button" class="system-carousel__button" data-next aria-label="Next: ${name}">${chevron('next')}</button>`)
  }
  if (buttons.length) parts.push(`<div class="system-carousel__buttons">${buttons.join('')}</div>`)
  return `<div class="system-carousel__controls" data-controls hidden>${parts.join('')}</div><p class="system-carousel__status" data-status aria-live="polite"></p>`
}
