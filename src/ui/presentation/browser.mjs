import { resizeRequest, keyboardResize, editValueError, deliveryMessage } from './state.mjs'
import { assertPresentation } from './contract.mjs'
import { renderPresentation } from './web.mjs'

const bindings = new WeakMap()

// Scoped widget behavior only. No document/global keyboard listener, transport,
// storage, command catalog or business transition is installed.
export function bindPresentation(root, model, { onRequest } = {}) {
  assertPresentation(model)
  if (!root || root.dataset.apRoot !== model.id || model.schema !== 'atelier.presentation/v1' || model.version !== '1.0.0') throw new TypeError('root/model binding mismatch')
  if (bindings.has(root)) throw new TypeError('presentation already bound')
  let snapshot = structuredClone(model)
  let nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
  let panes = new Map(snapshot.panes.map(pane => [pane.id, pane]))
  let output = root.querySelector('[data-ap-delivery]')
  let dialog = root.querySelector('[data-ap-confirm]')
  const pending = new Map()
  const drafts = new Map()
  const listeners = []
  let disposed = false, confirmation = null, opener = null, drag = null, composing = false
  const listen = (target, event, handler, capture = false) => {
    if (!target) return
    target.addEventListener(event, handler, capture)
    listeners.push(() => target.removeEventListener(event, handler, capture))
  }
  const say = text => { if (!disposed && output) output.textContent = text }
  const validateDraft = (control, node) => {
    const error = editValueError(control.value)
    control.setCustomValidity(error ?? '')
    const message = root.querySelector('[data-ap-edit-error="' + node.id + '"]')
    if (message) { message.textContent = error ?? ''; message.hidden = !error }
    if (error || node.error) control.setAttribute('aria-invalid', 'true')
    else control.removeAttribute('aria-invalid')
    const descriptions = [node.error ? snapshot.id + ':node:' + node.id + ':error' : '', error ? control.id + ':limit' : ''].filter(Boolean)
    if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' '))
    else control.removeAttribute('aria-describedby')
    return error
  }
  const syncBusy = () => {
    for (const control of root.querySelectorAll('button,input,textarea')) {
      const id = control.dataset.apAction ?? control.dataset.apSelect ?? control.dataset.apMove ?? control.dataset.apStep ?? control.dataset.apResize ?? control.dataset.apEdit
      if (!disposed && pending.has(id)) control.setAttribute('aria-busy', 'true')
      else control.removeAttribute('aria-busy')
    }
  }
  const restoreFocus = () => {
    if (opener?.isConnected) opener.focus()
    else root.querySelector('[data-ap-pane]')?.focus()
    opener = null
  }
  const close = () => {
    confirmation = null
    if (dialog?.open) dialog.close()
    restoreFocus()
  }
  const send = async (request, control) => {
    if (disposed || typeof onRequest !== 'function') return
    if (pending.has(request.id) && request.kind !== 'edit') { say(deliveryMessage('suppressed')); return }
    // Edits reach the host synchronously, including while earlier delivery is
    // pending. A re-render/unmount cannot erase an undelivered coalesced draft.
    pending.set(request.id, (pending.get(request.id) ?? 0) + 1)
    syncBusy()
    // Native disabled would eject keyboard focus. Pending is guarded above.
    say(deliveryMessage('sending'))
    let outcome = 'delivered'
    try {
      await onRequest(Object.freeze({ schema: 'atelier.presentation-request/v1', version: '1.0.0', presentationId: snapshot.id, status: 'proposed', executionAuthority: false, ...request }))
    } catch {
      outcome = 'failed'
    } finally {
      const remaining = pending.get(request.id) - 1
      if (remaining) pending.set(request.id, remaining)
      else pending.delete(request.id)
      if (!disposed) { syncBusy(); say(deliveryMessage(outcome, [...pending.values()].reduce((sum, count) => sum + count, 0))) }
    }
  }
  const requestResize = (paneId, value, control) => {
    const pane = panes.get(paneId)
    if (!pane?.width) return
    const next = resizeRequest(pane.width, value)
    // Geometry remains host-owned. The slider is a request, not optimistic state.
    const slider = root.querySelector('[data-ap-resize="' + paneId + '"]')
    if (slider) slider.value = pane.width.value
    if (next !== pane.width.value) void send({ kind: 'resize', id: paneId, value: next }, control)
  }
  const move = (nodeId, itemId, position, control) => {
    const node = nodes.get(nodeId), from = node?.items?.findIndex(item => item.id === itemId)
    if (node?.type !== 'sequence' || !node.reorderable || from < 0 || !Number.isInteger(position) || position < 0 || position >= node.items.length || position === from) return
    void send({ kind: 'move', id: nodeId, itemId, position }, control)
  }
  listen(root, 'click', event => {
    const control = event.target.closest?.('button')
    if (!control || !root.contains(control) || control.disabled) return
    const actionId = control.dataset.apAction
    if (actionId) {
      const node = nodes.get(actionId)
      if (node?.type !== 'action' || node.disabled || pending.has(node.id)) return
      if (node.confirmation) {
        if (!dialog || typeof dialog.showModal !== 'function') { say('Confirmation is unavailable in this host. No request sent.'); return }
        confirmation = node
        opener = control
        root.querySelector('[data-ap-confirm-title]').textContent = node.confirmation.title
        root.querySelector('[data-ap-confirm-description]').textContent = node.confirmation.description
        root.querySelector('[data-ap-cancel]').textContent = node.confirmation.cancelLabel
        root.querySelector('[data-ap-confirm-action]').textContent = node.confirmation.confirmLabel
        dialog.showModal()
        root.querySelector('[data-ap-cancel]').focus()
      } else void send({ kind: 'action', id: node.id, actionRef: node.actionRef }, control)
    } else if (control.hasAttribute('data-ap-cancel')) close()
    else if (control.hasAttribute('data-ap-confirm-action') && confirmation) {
      const node = confirmation, source = opener
      close()
      void send({ kind: 'action', id: node.id, actionRef: node.actionRef, presentationConfirmed: true }, source)
    } else if (control.dataset.apSelect) {
      const node = nodes.get(control.dataset.apSelect), item = node?.items?.find(item => item.id === control.dataset.apItem)
      if (item) void send({ kind: 'selection', id: node.id, itemId: item.id }, control)
    } else if (control.dataset.apMove) {
      move(control.dataset.apMove, control.dataset.apItem, Number(control.dataset.apPosition), control)
    } else if (control.dataset.apStep) {
      const pane = panes.get(control.dataset.apStep), delta = Number(control.dataset.apDelta)
      if (pane?.width && [-1, 1].includes(delta)) requestResize(pane.id, pane.width.value + delta, control)
    }
  })
  listen(root, 'dragstart', event => {
    const item = event.target.closest?.('[data-ap-drag]'), node = nodes.get(item?.dataset.apDrag)
    if (!item || !root.contains(item) || !node?.reorderable || typeof onRequest !== 'function') { event.preventDefault(); return }
    drag = { id: node.id, itemId: item.dataset.apItem }
    item.dataset.apDragging = 'true'
    event.dataTransfer?.setData('text/plain', item.dataset.apItem)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  })
  const endDrag = () => { drag = null; root.querySelectorAll('[data-ap-dragging]').forEach(item => item.removeAttribute('data-ap-dragging')) }
  listen(root, 'dragover', event => { if (drag && event.target.closest?.('[data-ap-drag]')?.dataset.apDrag === drag.id) event.preventDefault() })
  listen(root, 'drop', event => {
    const item = event.target.closest?.('[data-ap-drag]')
    if (drag && item?.dataset.apDrag === drag.id) {
      event.preventDefault()
      move(drag.id, drag.itemId, nodes.get(drag.id).items.findIndex(x => x.id === item.dataset.apItem))
    }
    endDrag()
  })
  listen(root, 'dragend', endDrag)
  listen(root, 'change', event => {
    const control = event.target
    if (control.dataset.apResize) {
      const value = Number(control.value)
      if (Number.isFinite(value)) requestResize(control.dataset.apResize, value, control)
    }
  })
  listen(root, 'keydown', event => {
    const control = event.target, pane = panes.get(control.dataset.apResize)
    if (!pane?.width || control.disabled || event.altKey || event.ctrlKey || event.metaKey) return
    const next = keyboardResize(pane.width, event.key, snapshot.direction)
    if (next !== null) { event.preventDefault(); requestResize(pane.id, next, control) }
  })
  const edit = event => {
    const control = event.target, node = nodes.get(control.dataset.apEdit)
    if (node && ['field', 'editor'].includes(node.type) && !node.disabled) {
      drafts.set(node.id, control.value)
      if (event.isComposing || composing) return
      const error = validateDraft(control, node)
      if (error) { say(error); return }
      void send({ kind: 'edit', id: node.id, value: control.value })
    }
  }
  listen(root, 'input', edit)
  listen(root, 'compositionstart', () => { composing = true })
  listen(root, 'compositionend', event => { composing = false; edit(event) })
  listen(root, 'cancel', event => { if (event.target === dialog) { event.preventDefault(); close() } }, true)
  // This dialog contains exactly two controls. Keep Tab inside its local scope;
  // no command shortcuts or document-level focus bridge are registered.
  listen(root, 'keydown', event => {
    if (event.key !== 'Tab' || !dialog?.open || !dialog.contains(event.target)) return
    const first = dialog.querySelector('[data-ap-cancel]')
    const last = dialog.querySelector('[data-ap-confirm-action]')
    if (event.shiftKey && root.ownerDocument.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && root.ownerDocument.activeElement === last) { event.preventDefault(); first.focus() }
  })
  listen(root, 'close', event => { if (event.target === dialog) { confirmation = null; if (opener) restoreFocus() } }, true)
  if (typeof onRequest !== 'function') {
    for (const control of root.querySelectorAll('button,input,textarea')) {
      const previous = control.disabled
      control.disabled = true
      listeners.push(() => { control.disabled = previous })
    }
    say('Read-only view. No host request handler is connected.')
  }
  const dispose = () => {
    if (disposed) return
    if (dialog?.open) close()
    disposed = true
    endDrag()
    drafts.clear()
    syncBusy()
    for (const remove of listeners.reverse()) remove()
    bindings.delete(root)
  }
  const update = (nextModel, { discardDrafts = false, tokenOverrides = {} } = {}) => {
    assertPresentation(nextModel)
    if (disposed || nextModel.id !== snapshot.id) throw new TypeError('update requires the same live presentation identity')
    if (composing) throw new TypeError('defer presentation update until compositionend')
    const template = root.ownerDocument.createElement('template')
    template.innerHTML = renderPresentation(nextModel, { tokenOverrides })
    const next = template.content.querySelector('[data-ap-root]')
    if (dialog?.open) close()
    endDrag()
    const focused = root.ownerDocument.activeElement
    const keys = ['id', 'data-ap-select', 'data-ap-item', 'data-ap-move', 'data-ap-position', 'data-ap-step', 'data-ap-delta', 'href']
    const identity = focused && root.contains(focused) ? keys.map(key => [key, focused.getAttribute(key)]) : null
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null
    if (discardDrafts) drafts.clear()
    snapshot = structuredClone(nextModel)
    nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
    panes = new Map(snapshot.panes.map(pane => [pane.id, pane]))
    for (const [id, value] of drafts) if (!nodes.has(id) || nodes.get(id).value === value) drafts.delete(id)
    root.replaceChildren(...next.childNodes)
    for (const attr of next.attributes) root.setAttribute(attr.name, attr.value)
    output = root.querySelector('[data-ap-delivery]')
    dialog = root.querySelector('[data-ap-confirm]')
    for (const control of root.querySelectorAll('[data-ap-edit]')) {
      if (drafts.has(control.dataset.apEdit)) control.value = drafts.get(control.dataset.apEdit)
      const error = validateDraft(control, nodes.get(control.dataset.apEdit))
      if (error) say(error)
    }
    if (typeof onRequest !== 'function') for (const control of root.querySelectorAll('button,input,textarea')) control.disabled = true
    syncBusy()
    if (identity) {
      const target = [...root.querySelectorAll('button,input,textarea,a,[tabindex]')].find(element => identity.every(([key, value]) => element.getAttribute(key) === value))
      if (target && !target.disabled) {
        target.focus({ preventScroll: true })
        if (selection && selection[0] !== null && typeof target.setSelectionRange === 'function' && ['text', 'search', 'textarea'].includes(target.type)) target.setSelectionRange(...selection)
      } else root.querySelector('[data-ap-pane]')?.focus({ preventScroll: true })
    }
    return api
  }
  bindings.set(root, dispose)
  const api = Object.freeze({ dispose, update })
  return api
}
