import { assertPresentation } from './contract.mjs'
import { resolveTokens } from './tokens.mjs'
import { editValueError } from './state.mjs'

// Inject the consumer's existing React/native (or Tamagui native) primitives.
// The root imports no framework and installs no host/window/global driver.
export function createNativePresentation({ React, View, Text, Pressable, TextInput, ScrollView, Image }) {
  if (![React?.createElement, React?.useState, React?.useRef, React?.useEffect].every(x => typeof x === 'function') ||
      [View, Text, Pressable, TextInput, ScrollView, Image].some(x => !x)) throw new TypeError('native primitive bindings required')
  const h = React.createElement
  return function NativePresentation({ model, onRequest, confirm, resolveAsset, tokenOverrides = {}, containerWidth = 320 }) {
    assertPresentation(model)
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) throw new TypeError('container width required')
    const tokens = resolveTokens(model.theme, tokenOverrides)
    const totalWeight = model.panes.reduce((sum, pane) => sum + (pane.width?.value ?? 50), 0)
    const paneSpace = containerWidth - tokens.spacing.large * (model.panes.length + 1)
    const [delivery, setDelivery] = React.useState('')
    const [, refreshPending] = React.useState(0)
    const active = React.useRef(true)
    const pending = React.useRef(new Map())
    const failures = React.useRef(new Set())
    const attempts = React.useRef(new Map())
    const drafts = React.useRef(new Map())
    const current = React.useRef({ model, onRequest, confirm })
    const generation = React.useRef(0)
    const signature = JSON.stringify(model)
    // Only committed model changes revoke pending confirmation. Inline callback
    // identities routinely change when a host opens its confirmation dialog.
    const useCommitEffect = React.useLayoutEffect ?? React.useEffect
    useCommitEffect(() => {
      if (current.current.signature !== signature) generation.current++
      current.current = { signature, model, onRequest, confirm }
    }, [signature, onRequest, confirm])
    for (const [id, value] of drafts.current) if (!model.nodes.some(node => node.id === id && node.value !== value)) drafts.current.delete(id)
    const confirmations = React.useRef(new Set())
    React.useEffect(() => { active.current = true; return () => { active.current = false } }, [])
    const request = async event => {
      const host = current.current
      if (typeof host.onRequest !== 'function' || !active.current) return
      if (pending.current.has(event.id) && event.kind !== 'edit') return
      const attempt = (attempts.current.get(event.id) ?? 0) + 1
      attempts.current.set(event.id, attempt)
      failures.current.delete(event.id)
      const reportDelivery = () => setDelivery(failures.current.size
        ? 'Request delivery failed. Host state has not been confirmed.'
        : pending.current.size ? 'Sending request. Awaiting host state.' : 'Request delivered. Awaiting host state.')
      pending.current.set(event.id, (pending.current.get(event.id) ?? 0) + 1)
      refreshPending(value => value + 1)
      reportDelivery()
      try {
        await host.onRequest(Object.freeze({ schema: 'atelier.presentation-request/v1', version: '1.0.0', presentationId: host.model.id, status: 'proposed', executionAuthority: false, ...event }))
      } catch {
        // Settlement belongs to the request, not the confirmation/model generation.
        if (active.current && attempts.current.get(event.id) === attempt) failures.current.add(event.id)
      } finally {
        const remaining = pending.current.get(event.id) - 1
        if (remaining) pending.current.set(event.id, remaining)
        else pending.current.delete(event.id)
        if (active.current) { refreshPending(value => value + 1); reportDelivery() }
      }
    }
    const style = { color: tokens.color.text, fontFamily: tokens.typography.family, fontSize: tokens.typography.body, lineHeight: tokens.typography.body * tokens.typography.lineHeight }
    const text = (value, props = {}) => h(Text, { ...props, allowFontScaling: true, style: [style, props.style] }, value)
    const button = (label, props = {}) => h(Pressable, {
      accessibilityRole: 'button', accessibilityLabel: label,
      ...props,
      style: ({ pressed }) => [ { minHeight: tokens.density.target, minWidth: tokens.density.target, padding: tokens.spacing.medium, borderWidth: tokens.border.width, borderColor: tokens.color.border, borderRadius: tokens.border.radius, backgroundColor: pressed && !props.disabled ? tokens.color.selected : tokens.color.panel, opacity: props.disabled ? tokens.state.disabledOpacity : 1 }, props.style ],
    }, text(label))
    const nodes = new Map(model.nodes.map(node => [node.id, node]))
    const action = node => button(node.label, {
      key: node.id, disabled: node.disabled || typeof onRequest !== 'function' || pending.current.has(node.id),
      accessibilityState: { disabled: node.disabled || typeof onRequest !== 'function' || pending.current.has(node.id), busy: pending.current.has(node.id) },
      accessibilityHint: node.reason,
      onPress: async () => {
        if (node.disabled || typeof onRequest !== 'function' || confirmations.current.has(node.id) || pending.current.has(node.id)) return
        if (node.confirmation) {
          const confirmCurrent = current.current.confirm
          if (typeof confirmCurrent !== 'function') { setDelivery('Confirmation is unavailable in this host. No request sent.'); return }
          let accepted = false
          const started = generation.current
          confirmations.current.add(node.id)
          try { accepted = await confirmCurrent(Object.freeze({ ...node.confirmation, initialFocus: 'cancel', restoreFocus: true })) === true } catch { accepted = false }
          finally { confirmations.current.delete(node.id) }
          if (!active.current) return
          if (started !== generation.current || typeof current.current.onRequest !== 'function' || typeof current.current.confirm !== 'function') {
            setDelivery('Confirmation is no longer current. No request sent.'); return
          }
          if (!accepted) { setDelivery('Confirmation cancelled. No request sent.'); return }
        }
        await request({ kind: 'action', id: node.id, actionRef: node.actionRef, ...(node.confirmation ? { presentationConfirmed: true } : {}) })
      },
    })
    const renderNode = node => {
      let body = []
      if (node.type === 'action') return h(View, { key: node.id }, action(node), node.reason ? text(node.reason) : null)
      if (node.text !== undefined) body.push(text(node.text))
      if (node.type === 'field' || node.type === 'editor') {
        const draft = drafts.current.get(node.id) ?? node.value
        const draftError = editValueError(draft)
        body.push(h(TextInput, { accessibilityLabel: node.label + (node.required ? ' (required)' : ''), value: draft, editable: !node.disabled && typeof onRequest === 'function',
          multiline: node.type === 'editor', allowFontScaling: true,
          inputMode: node.input === 'email' ? 'email' : node.input === 'number' ? 'decimal' : 'text',
          returnKeyType: node.input === 'search' ? 'search' : 'default',
          accessibilityState: { disabled: node.disabled || typeof onRequest !== 'function' },
          style: { ...style, minHeight: tokens.density.target, padding: tokens.spacing.medium, borderWidth: node.error || draftError ? 2 : 1, borderColor: node.error || draftError ? tokens.color.danger : tokens.color.border },
          onChangeText: value => {
            // Editing is host-controlled; never claim persistence from this callback.
            if (node.disabled || typeof onRequest !== 'function') return
            drafts.current.set(node.id, value)
            refreshPending(version => version + 1)
            const error = editValueError(value)
            if (error) { setDelivery(error); return }
            void request({ kind: 'edit', id: node.id, value })
          } }))
        if (draftError) body.push(text(draftError, { accessibilityLiveRegion: 'polite' }))
        if (node.error) body.push(text(node.error, { accessibilityLiveRegion: 'polite' }))
      }
      if (node.type === 'diff') body.push(text(node.beforeLabel), text(node.before), text(node.afterLabel), text(node.after))
      if (node.type === 'media') {
        const source = resolveAsset?.(node.src)
        body.push(source ? h(Image, { source, accessible: true, accessibilityLabel: node.alt, style: { width: '100%', height: 180, resizeMode: 'contain' } }) : text('Media unavailable in this host: ' + node.alt))
        if (node.caption) body.push(text(node.caption))
      }
      for (const [index, item] of (node.items ?? []).entries()) {
        body.push(button(item.label, { key: item.id, disabled: typeof onRequest !== 'function',
          accessibilityState: { selected: item.selected, disabled: typeof onRequest !== 'function' },
          onPress: () => request(item.href ? { kind: 'navigation', id: node.id, itemId: item.id, href: item.href } : { kind: 'selection', id: node.id, itemId: item.id }),
          style: item.selected ? { backgroundColor: tokens.color.selected } : {},
        }))
        if (item.detail) body.push(text(item.detail))
        if (node.reorderable) body.push(h(View, { key: item.id + ':move', style: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.medium } },
          ...[-1, 1].map(delta => button('Move ' + item.label + (delta === -1 ? ' earlier' : ' later'), {
            key: String(delta), disabled: typeof onRequest !== 'function' || index + delta < 0 || index + delta >= node.items.length,
            onPress: () => { if (index + delta >= 0 && index + delta < node.items.length) return request({ kind: 'move', id: node.id, itemId: item.id, position: index + delta }) },
          }))))
      }
      const labels = new Map((node.items ?? []).map(item => [item.id, item.label]))
      for (const edge of node.edges ?? []) body.push(text(labels.get(edge.from) + ' — ' + edge.label + ' — ' + labels.get(edge.to)))
      for (const detail of node.details ?? []) body.push(text(detail.label + ': ' + detail.value))
      for (const ref of node.actions ?? []) {
        body.push(action(nodes.get(ref)))
        if (nodes.get(ref).reason) body.push(text(nodes.get(ref).reason))
      }
      return h(View, { key: node.id, style: { gap: tokens.spacing.medium, marginBottom: tokens.spacing.section } },
        text(node.label, { accessibilityRole: 'header', style: { fontSize: tokens.typography.heading } }), ...body)
    }
    return h(ScrollView, { style: { backgroundColor: tokens.color.page, direction: model.direction }, contentContainerStyle: { padding: tokens.spacing.large, gap: tokens.spacing.large }, keyboardShouldPersistTaps: 'handled' },
      text(model.title, { accessibilityRole: 'header', style: { fontSize: tokens.typography.heading } }),
      h(View, { style: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.medium } }, ...model.navigation.map(item => button(item.label, { key: item.id, disabled: typeof onRequest !== 'function', onPress: () => request({ kind: 'navigation', id: item.id, paneId: item.target }) }))),
      h(View, { style: { flexDirection: containerWidth <= tokens.layout.narrow ? 'column' : 'row', flexWrap: 'wrap', gap: tokens.spacing.large } },
        ...model.panes.map(pane => h(View, { key: pane.id, accessibilityLabel: pane.label, style: { flexGrow: containerWidth <= tokens.layout.narrow ? 0 : pane.width?.value ?? 50, flexShrink: 1, flexBasis: containerWidth <= tokens.layout.narrow ? 'auto' : Math.max(tokens.layout.paneMin, paneSpace * (pane.width?.value ?? 50) / totalWeight), minWidth: 0, maxWidth: '100%', padding: tokens.density[model.density], backgroundColor: tokens.color.panel, borderWidth: tokens.border.width, borderColor: tokens.color.border, borderRadius: tokens.border.radius } },
          text(pane.label, { accessibilityRole: 'header', style: { fontSize: tokens.typography.heading } }),
          pane.width && containerWidth > tokens.layout.narrow ? h(View, { style: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.medium } },
            button('Decrease width of ' + pane.label, { disabled: typeof onRequest !== 'function' || pane.width.value <= pane.width.min, onPress: () => request({ kind: 'resize', id: pane.id, value: Math.max(pane.width.min, pane.width.value - 1) }) }),
            button('Increase width of ' + pane.label, { disabled: typeof onRequest !== 'function' || pane.width.value >= pane.width.max, onPress: () => request({ kind: 'resize', id: pane.id, value: Math.min(pane.width.max, pane.width.value + 1) }) })) : null,
          ...pane.blocks.map(id => renderNode(nodes.get(id)))))),
      text(delivery || (typeof onRequest === 'function' ? 'Host-connected presentation.' : 'Read-only presentation.'), { accessibilityLiveRegion: 'polite' }))
  }
}
