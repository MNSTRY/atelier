/**
 * Native <details> disclosures with interruptible open and close motion
 * (browser). Keyboard and no-script behaviour stay native. data-state follows
 * the reader's intent at once, so icons turn with the click while the panel
 * is still moving. Reduced motion opens and closes instantly.
 */
import { animationAllowed } from './motion.mjs'

const PROPERTIES = ['height', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'opacity']

export function enhanceDisclosures(root = document, { openMs = 360, closeMs = 280 } = {}) {
  root.querySelectorAll('details').forEach(details => {
    const summary = details.querySelector(':scope > summary')
    const content = summary?.nextElementSibling
    if (!summary || !content || details.dataset.disclosureReady !== undefined) return
    details.dataset.disclosureReady = ''
    details.dataset.state = details.open ? 'open' : 'closed'
    if (!content.animate) return
    let animation = null
    let opening = details.open
    const values = () => {
      const style = getComputedStyle(content)
      return Object.fromEntries(PROPERTIES.map(property => [property, style[property]]))
    }
    const clear = () => { content.style.overflow = ''; content.style.boxSizing = '' }
    summary.addEventListener('click', event => {
      event.preventDefault()
      if (!animation) opening = details.open
      opening = !opening
      details.dataset.state = opening ? 'open' : 'closed'
      if (!opening && content.contains(document.activeElement)) summary.focus()
      const current = animation ? values() : null
      animation?.cancel()
      animation = null
      if (!animationAllowed()) { details.open = opening; clear(); return }
      details.open = true
      content.style.overflow = 'hidden'
      content.style.boxSizing = 'border-box'
      const expanded = values()
      const collapsed = Object.fromEntries(PROPERTIES.map(property => [property, property === 'opacity' ? '0' : '0px']))
      animation = content.animate([current || (opening ? collapsed : expanded), opening ? expanded : collapsed], {
        duration: opening ? openMs : closeMs,
        easing: opening ? 'cubic-bezier(.22, 1, .36, 1)' : 'cubic-bezier(.4, 0, 1, 1)',
        fill: 'both',
      })
      animation.onfinish = () => { details.open = opening; animation.cancel(); animation = null; clear() }
    })
    details.addEventListener('toggle', () => { if (!animation) details.dataset.state = details.open ? 'open' : 'closed' })
  })
}
