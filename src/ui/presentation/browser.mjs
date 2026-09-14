import { resizeRequest, keyboardResize } from './state.mjs'
import { assertPresentation } from './contract.mjs'

const bindings = new WeakMap()

// Scoped widget behavior only. No document/global keyboard listener, transport,
// storage, command catalog or business transition is installed.
export function bindPresentation(root, model, { onRequest } = {}) {
  assertPresentation(model)
  if (!root || root.dataset.apRoot !== model.id || model.schema !== 'atelier.presentation/v1' || model.version !== '1.0.0') throw new TypeError('root/model binding mismatch')
  if (bindings.has(root)) throw new TypeError('presentation already bound')
  const snapshot = structuredClone(model)
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
  const panes = new Map(snapshot.panes.map(pane => [pane.id, pane]))
  const output = root.querySelector('[data-ap-delivery]')
  const dialog = root.querySelector('[data-ap-confirm]')
  const pending = new Set()
  const latestEdits = new Map()
  const alteredControls = new Map()
  const listeners = []
  let disposed = false, confirmation = null, opener = null, drag = null
  const listen = (target, event, handler) => {
    if (!target) return
    target.addEventListener(event, handler)
    listeners.push(() => target.removeEventListener(event, handler))
  }
  const say = text => { if (!disposed && output) output.textContent = text }
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
    if (pending.has(request.id)) {
      if (request.kind === 'edit') latestEdits.set(request.id, request)
      return
    }
    pending.add(request.id)
    control?.setAttribute('aria-busy', 'true')
    const wasDisabled = control?.disabled
    if (control) alteredControls.set(control, wasDisabled)
    if (control && 'disabled' in control) control.disabled = true
    say('Sending request. Awaiting host state.')
    try {
      await onRequest(Object.freeze({ schema: 'atelier.presentation-request/v1', version: '1.0.0', presentationId: snapshot.id, status: 'proposed', executionAuthority: false, ...request }))
      say('Request delivered. Awaiting host state.')
    } catch {
      say('Request delivery failed. Host state has not been confirmed.')
    } finally {
      pending.delete(request.id)
      if (!disposed && control?.isConnected) {
        control.removeAttribute('aria-busy')
        if ('disabled' in control) control.disabled = wasDisabled
      }
      alteredControls.delete(control)
      const latest = latestEdits.get(request.id)
      latestEdits.delete(request.id)
      if (latest && !disposed) void send(latest)
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
  listen(root, 'input', event => {
    const control = event.target, node = nodes.get(control.dataset.apEdit)
    if (node && ['field', 'editor'].includes(node.type) && !node.disabled) {
      // Host owns draft persistence, validation errors, and accepted state.
      void send({ kind: 'edit', id: node.id, value: control.value.slice(0, 32768) })
    }
  })
  listen(dialog, 'cancel', event => { event.preventDefault(); close() })
  // This dialog contains exactly two controls. Keep Tab inside its local scope;
  // no command shortcuts or document-level focus bridge are registered.
  listen(dialog, 'keydown', event => {
    if (event.key !== 'Tab' || !dialog.open) return
    const first = dialog.querySelector('[data-ap-cancel]')
    const last = dialog.querySelector('[data-ap-confirm-action]')
    if (event.shiftKey && root.ownerDocument.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && root.ownerDocument.activeElement === last) { event.preventDefault(); first.focus() }
  })
  listen(dialog, 'close', () => { confirmation = null; if (opener) restoreFocus() })
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
    latestEdits.clear()
    for (const [control, previous] of alteredControls) {
      control.removeAttribute('aria-busy')
      if ('disabled' in control) control.disabled = previous
    }
    alteredControls.clear()
    for (const remove of listeners.reverse()) remove()
    bindings.delete(root)
  }
  bindings.set(root, dispose)
  return Object.freeze({ dispose })
}
