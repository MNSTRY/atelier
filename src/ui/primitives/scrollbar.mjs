/**
 * Add a pointer thumb to a native vertical scroll host. For an element, place
 * the thumb beside the viewport in a positioned wrapper with the same top and
 * right edges. Pass a content element or call refresh after content changes.
 */
export function enhanceOverlayScrollbar({ thumb, viewport = document, header, content }) {
  if (!thumb || !('ResizeObserver' in window)) return
  const page = viewport === document
  const scroller = page ? document.documentElement : viewport
  const media = matchMedia('(pointer: fine) and (forced-colors: none)')
  const events = new AbortController()
  const options = { signal: events.signal }
  let frame
  let scrollRange
  let travel
  let drag

  function update() {
    frame = undefined
    if (!media.matches) return
    const height = scroller.clientHeight
    const top = (header ? Math.max(0, header.getBoundingClientRect().bottom) : 0) + 4
    const track = height - top - 4
    scrollRange = Math.max(0, scroller.scrollHeight - height)
    thumb.hidden = !scrollRange || track <= 32
    if (thumb.hidden) return
    const size = Math.max(32, track * height / scroller.scrollHeight)
    travel = track - size
    const progress = Math.max(0, Math.min(1, scroller.scrollTop / scrollRange))
    thumb.style.top = `${top}px`
    thumb.style.height = `${size}px`
    thumb.style.transform = `translateY(${progress * travel}px)`
  }

  function refresh() {
    frame ??= requestAnimationFrame(update)
  }

  function setMode() {
    scroller.toggleAttribute('data-overlay-scrollbar', media.matches)
    refresh()
  }

  thumb.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !travel) return
    event.preventDefault()
    thumb.setPointerCapture(event.pointerId)
    drag = { y: event.clientY, scroll: scroller.scrollTop, scale: scrollRange / travel }
  }, options)
  thumb.addEventListener('pointermove', event => {
    if (!drag || !thumb.hasPointerCapture(event.pointerId)) return
    scroller.scrollTo({ top: drag.scroll + (event.clientY - drag.y) * drag.scale, behavior: 'instant' })
  }, options)
  thumb.addEventListener('lostpointercapture', () => { drag = undefined }, options)
  viewport.addEventListener('scroll', refresh, { ...options, passive: true })
  window.addEventListener('resize', refresh, options)
  media.addEventListener('change', setMode, options)
  const observer = new ResizeObserver(refresh)
  observer.observe(page ? document.body : viewport)
  if (header) observer.observe(header)
  if (content) observer.observe(content)
  setMode()

  return {
    refresh,
    destroy() {
      events.abort()
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      scroller.removeAttribute('data-overlay-scrollbar')
      thumb.hidden = true
    },
  }
}
