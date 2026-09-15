import { htmlEscape as escape } from '../html-primitives.mjs'
import { assertPresentation } from './contract.mjs'
import { presentationStyles } from './styles.mjs'
import { toneLabel } from './state.mjs'

const domId = (model, kind, id) => escape(model.id + ':' + kind + ':' + id)
const noticeTypes = new Set(['status', 'refusal', 'decision', 'receipt', 'offer', 'review', 'publication'])

export function renderPresentation(model, { tokenOverrides = {}, interactive = true } = {}) {
  assertPresentation(model)
  const nodes = new Map(model.nodes.map(node => [node.id, node]))
  const renderAction = node => {
    if (!interactive) return '<p>' + escape(node.label) + ' (host action; unavailable in document)' + (node.reason ? ': ' + escape(node.reason) : '') + '</p>'
    const name = domId(model, 'node', node.id)
    const reason = node.reason ? '<p class="ap-muted" id="' + name + ':reason">' + escape(node.reason) + '</p>' : ''
    return '<div class="ap-action"><button type="button" id="' + name + '" data-ap-action="' + escape(node.id) + '"' +
      (node.disabled ? ' disabled' : '') + (node.reason ? ' aria-describedby="' + name + ':reason"' : '') +
      (node.shortcut ? ' aria-keyshortcuts="' + escape(node.shortcut.aria) + '"' : '') + '>' +
      escape(node.label) + (node.shortcut ? ' <kbd aria-hidden="true">' + escape(node.shortcut.display) + '</kbd>' : '') +
      '</button>' + reason + '</div>'
  }
  const renderNode = node => {
    const name = domId(model, 'node', node.id), labelId = name + ':label'
    const heading = '<h3 id="' + labelId + '">' + escape(node.label) + '</h3>'
    let body
    if (node.type === 'action') return renderAction(node)
    if (node.type === 'text') body = '<p>' + escape(node.text) + '</p>'
    if (node.type === 'preview') body = '<pre>' + escape(node.text) + '</pre>'
    if (node.type === 'diff') body = '<div class="ap-diff"><div><h4>' + escape(node.beforeLabel) + '</h4><pre>' + escape(node.before) + '</pre></div><div><h4>' + escape(node.afterLabel) + '</h4><pre>' + escape(node.after) + '</pre></div></div>'
    if (node.type === 'media') body = '<figure><img src="' + escape(node.src) + '" alt="' + escape(node.alt) + '" loading="lazy">' + (node.caption ? '<figcaption>' + escape(node.caption) + '</figcaption>' : '') + '</figure>'
    if (node.items) {
      const tag = node.type === 'sequence' ? 'ol' : 'ul'
      body = '<' + tag + '>' + node.items.map((item, index) => '<li' + (interactive && node.reorderable ? ' draggable="true" data-ap-drag="' + escape(node.id) + '" data-ap-item="' + escape(item.id) + '"' : '') + '>' +
        (!interactive ? '<span>' + escape(item.label) + (item.selected ? ' (selected)' : '') + '</span>' : item.href ? '<a class="ap-link" href="' + escape(item.href) + '">' + escape(item.label) + '</a>' :
          '<button type="button" data-ap-select="' + escape(node.id) + '" data-ap-item="' + escape(item.id) + '"' +
          (typeof item.selected === 'boolean' ? ' aria-pressed="' + item.selected + '"' : '') + '>' + escape(item.label) + '</button>') +
        (item.detail ? '<p class="ap-muted">' + escape(item.detail) + '</p>' : '') +
        (interactive && node.reorderable ? '<div class="ap-actions"><button type="button" data-ap-move="' + escape(node.id) + '" data-ap-item="' + escape(item.id) + '" data-ap-position="' + (index - 1) + '"' + (index === 0 ? ' disabled' : '') + ' aria-label="Move ' + escape(item.label) + ' earlier">Move earlier</button><button type="button" data-ap-move="' + escape(node.id) + '" data-ap-item="' + escape(item.id) + '" data-ap-position="' + (index + 1) + '"' + (index === node.items.length - 1 ? ' disabled' : '') + ' aria-label="Move ' + escape(item.label) + ' later">Move later</button></div>' : '') + '</li>').join('') + '</' + tag + '>'
      if (node.type === 'graph') {
        const labels = new Map(node.items.map(item => [item.id, item.label]))
        body += '<table><caption>' + escape(node.label) + ' relationships</caption><thead><tr><th scope="col">From</th><th scope="col">Relationship</th><th scope="col">To</th></tr></thead><tbody>' +
          node.edges.map(edge => '<tr><td>' + escape(labels.get(edge.from)) + '</td><td>' + escape(edge.label) + '</td><td>' + escape(labels.get(edge.to)) + '</td></tr>').join('') + '</tbody></table>'
      }
    }
    if (noticeTypes.has(node.type)) body = '<div class="ap-notice" data-tone="' + escape(node.tone) + '">' + (toneLabel(node.tone) ? '<p class="ap-tone">' + toneLabel(node.tone) + '</p>' : '') + '<p' + (node.type === 'status' ? ' role="status"' : '') + '>' + escape(node.text) + '</p><dl>' +
      node.details.map(entry => '<dt>' + escape(entry.label) + '</dt><dd>' + escape(entry.value) + '</dd>').join('') + '</dl><div class="ap-actions">' + node.actions.map(ref => renderAction(nodes.get(ref))).join('') + '</div></div>'
    if (node.type === 'field' || node.type === 'editor') {
      if (!interactive) return '<section class="ap-block" id="' + name + '">' + heading + '<pre>' + escape(node.value) + '</pre>' + (node.error ? '<p>' + escape(node.error) + '</p>' : '') + '</section>'
      const fieldId = name + ':input'
      const attrs = ' id="' + fieldId + '" data-ap-edit="' + escape(node.id) + '"' +
        (node.disabled ? ' disabled' : '') + (node.required ? ' required' : '') +
        (node.error ? ' aria-invalid="true" aria-describedby="' + name + ':error"' : '')
      const field = node.type === 'editor' ? '<textarea' + attrs + '>' + escape(node.value) + '</textarea>'
        : '<input type="' + escape(node.input) + '"' + attrs + ' value="' + escape(node.value) + '">'
      return '<div class="ap-block" id="' + name + '"><label for="' + fieldId + '">' + escape(node.label) + (node.required ? ' (required)' : '') + '</label>' + field +
        (node.error ? '<p class="ap-error" id="' + name + ':error">' + escape(node.error) + '</p>' : '') +
        '<p class="ap-error" data-ap-edit-error="' + escape(node.id) + '" id="' + fieldId + ':limit" aria-live="polite" hidden></p></div>'
    }
    return '<section class="ap-block" id="' + name + '" aria-labelledby="' + labelId + '">' + heading + body + '</section>'
  }
  const primary = model.panes.find(pane => pane.role === 'primary')
  const totalWeight = model.panes.reduce((sum, pane) => sum + (pane.width?.value ?? 50), 0)
  const nav = model.navigation.map(item => '<a class="ap-link" href="#' + domId(model, 'pane', item.target) + '">' + escape(item.label) + '</a>').join('')
  const panes = model.panes.map(pane => {
    const weight = pane.width?.value ?? 50, share = weight / totalWeight
    const name = domId(model, 'pane', pane.id), heading = name + ':label'
    const resize = interactive && pane.width ? '<div class="ap-resize"><label for="' + name + ':resize">Width of ' + escape(pane.label) + '</label><input id="' + name + ':resize" type="range" data-ap-resize="' + escape(pane.id) + '" min="' + pane.width.min + '" max="' + pane.width.max + '" value="' + pane.width.value + '" aria-controls="' + name + '"><button type="button" data-ap-step="' + escape(pane.id) + '" data-ap-delta="-1" aria-label="Decrease width of ' + escape(pane.label) + '">−</button><button type="button" data-ap-step="' + escape(pane.id) + '" data-ap-delta="1" aria-label="Increase width of ' + escape(pane.label) + '">+</button></div>' : ''
    return '<section class="ap-pane" id="' + name + '" tabindex="-1" aria-labelledby="' + heading + '" data-ap-pane="' + escape(pane.id) + '"' +
      ' style="--ap-pane-weight:' + weight + ';--ap-pane-basis:calc(' + (share * 100) + '% - var(--ap-spacing-large) * ' + ((model.panes.length - 1) * share) + ')"' + '><header class="ap-pane-header"><h2 id="' + heading + '">' + escape(pane.label) + '</h2>' + resize + '</header><div class="ap-pane-body">' +
      pane.blocks.map(ref => renderNode(nodes.get(ref))).join('') + '</div></section>'
  }).join('')
  return '<div data-ap-root="' + escape(model.id) + '" data-density="' + escape(model.density) + '" dir="' + escape(model.direction) + '" lang="' + escape(model.lang) + '"><style>' + presentationStyles(model.theme, tokenOverrides, model.id) + '</style>' +
    '<a class="ap-link ap-skip" href="#' + domId(model, 'pane', primary.id) + '">Skip to ' + escape(primary.label) + '</a><header class="ap-header"><h1>' + escape(model.title) + '</h1><nav class="ap-nav" aria-label="Workspace">' + nav + '</nav></header>' +
    '<main class="ap-workspace">' + panes + '</main><output data-ap-delivery aria-live="polite"></output>' +
    (interactive ? '<dialog data-ap-confirm aria-labelledby="' + escape(model.id) + ':confirm:title" aria-describedby="' + escape(model.id) + ':confirm:description"><h2 id="' + escape(model.id) + ':confirm:title" data-ap-confirm-title></h2><p id="' + escape(model.id) + ':confirm:description" data-ap-confirm-description></p><div class="ap-actions"><button type="button" data-ap-cancel autofocus>Cancel</button><button type="button" data-ap-confirm-action>Continue</button></div></dialog>' : '') + '</div>'
}

export function renderPresentationDocument(model, options = {}) {
  assertPresentation(model)
  return '<!doctype html><html lang="' + escape(model.lang) + '" dir="' + escape(model.direction) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(model.title) + '</title></head><body>' + renderPresentation(model, options) + '</body></html>'
}

export function renderReadOnlyDocument(model, options = {}) {
  return renderPresentationDocument(model, { ...options, interactive: false })
}
