import { assertPresentation } from './contract.mjs'
import { resolveTokens } from './tokens.mjs'

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
    const [delivery, setDelivery] = React.useState('')
    const active = React.useRef(true)
    const pending = React.useRef(new Set())
    const queuedEdits = React.useRef(new Map())
    const confirmations = React.useRef(new Set())
    React.useEffect(() => { active.current = true; return () => { active.current = false } }, [])
    const request = async event => {
      if (typeof onRequest !== 'function' || !active.current) return
      if (pending.current.has(event.id)) {
        if (event.kind === 'edit') queuedEdits.current.set(event.id, event)
        return
      }
      pending.current.add(event.id)
      setDelivery('Sending request. Awaiting host state.')
      try {
        await onRequest(Object.freeze({ schema: 'atelier.presentation-request/v1', version: '1.0.0', presentationId: model.id, status: 'proposed', executionAuthority: false, ...event }))
        if (active.current) setDelivery('Request delivered. Awaiting host state.')
      } catch {
        if (active.current) setDelivery('Request delivery failed. Host state has not been confirmed.')
      } finally {
        pending.current.delete(event.id)
        const latest = queuedEdits.current.get(event.id)
        queuedEdits.current.delete(event.id)
        if (latest && active.current) void request(latest)
      }
    }
    const style = { color: tokens.color.text, fontSize: tokens.typography.body, lineHeight: tokens.typography.body * tokens.typography.lineHeight }
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
          if (typeof confirm !== 'function') { setDelivery('Confirmation is unavailable in this host. No request sent.'); return }
          let accepted = false
          confirmations.current.add(node.id)
          try { accepted = await confirm(Object.freeze({ ...node.confirmation, initialFocus: 'cancel', restoreFocus: true })) === true } catch { accepted = false }
          finally { confirmations.current.delete(node.id) }
          if (!accepted || !active.current) return
        }
        await request({ kind: 'action', id: node.id, actionRef: node.actionRef, ...(node.confirmation ? { presentationConfirmed: true } : {}) })
      },
    })
    const renderNode = node => {
      let body = []
      if (node.type === 'action') return h(View, { key: node.id }, action(node), node.reason ? text(node.reason) : null)
      if (node.text !== undefined) body.push(text(node.text))
      if (node.type === 'field' || node.type === 'editor') {
        body.push(h(TextInput, { accessibilityLabel: node.label, value: node.value, editable: !node.disabled && typeof onRequest === 'function',
          multiline: node.type === 'editor', allowFontScaling: true,
          accessibilityState: { disabled: node.disabled || typeof onRequest !== 'function' },
          style: { ...style, minHeight: tokens.density.target, padding: tokens.spacing.medium, borderWidth: 1, borderColor: node.error ? tokens.color.danger : tokens.color.border },
          onChangeText: value => {
            // Editing is host-controlled; never claim persistence from this callback.
            if (!node.disabled) void request({ kind: 'edit', id: node.id, value: value.slice(0, 32768) })
          } }))
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
        ...model.panes.map(pane => h(View, { key: pane.id, accessibilityLabel: pane.label, style: { flexGrow: 1, flexShrink: 1, flexBasis: containerWidth <= tokens.layout.narrow ? 'auto' : pane.width ? pane.width.value + '%' : tokens.layout.paneMin, minWidth: 0, maxWidth: '100%', padding: tokens.density[model.density], backgroundColor: tokens.color.panel, borderWidth: tokens.border.width, borderColor: tokens.color.border, borderRadius: tokens.border.radius } },
          text(pane.label, { accessibilityRole: 'header', style: { fontSize: tokens.typography.heading } }),
          pane.width && containerWidth > tokens.layout.narrow ? h(View, { style: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.medium } },
            button('Decrease width of ' + pane.label, { disabled: typeof onRequest !== 'function' || pane.width.value <= pane.width.min, onPress: () => request({ kind: 'resize', id: pane.id, value: Math.max(pane.width.min, pane.width.value - 1) }) }),
            button('Increase width of ' + pane.label, { disabled: typeof onRequest !== 'function' || pane.width.value >= pane.width.max, onPress: () => request({ kind: 'resize', id: pane.id, value: Math.min(pane.width.max, pane.width.value + 1) }) })) : null,
          ...pane.blocks.map(id => renderNode(nodes.get(id)))))),
      text(delivery || (typeof onRequest === 'function' ? 'Host-connected presentation.' : 'Read-only presentation.'), { accessibilityLiveRegion: 'polite' }))
  }
}
