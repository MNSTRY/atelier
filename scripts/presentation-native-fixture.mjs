// Test-only DOM bindings exercise real React commits and callback lifetimes.
// They deliberately do not establish native platform or assistive-tech proof.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createNativePresentation } from '../src/ui/presentation/native.mjs'

const h = React.createElement
const Text = ({ children, accessibilityLabel }) => h('span', { 'aria-label': accessibilityLabel }, children)
const View = ({ children }) => h('div', null, children)
const Pressable = ({ children, onPress, disabled, accessibilityLabel, accessibilityState }) => h('button', {
  disabled, 'aria-label': accessibilityLabel, 'data-busy': String(accessibilityState?.busy), onClick: onPress,
}, children)
const TextInput = ({ value, editable, onChangeText, accessibilityLabel }) => h('input', {
  value, disabled: !editable, 'aria-label': accessibilityLabel, onChange: event => onChangeText(event.target.value),
})
const Native = createNativePresentation({ React, View, Text, Pressable, TextInput, ScrollView: View, Image: View })
let root
window.nativeMount = props => {
  root ??= createRoot(document.getElementById('native'))
  flushSync(() => root.render(h(Native, props)))
}
window.nativeUnmount = () => { flushSync(() => root.unmount()); root = null }
window.nativeReactVersion = React.version
