import assert from 'node:assert/strict'
import test from 'node:test'

import {
  atelierControlStyles,
  renderActionGroup,
  renderControl,
} from '../src/ui/control-system.mjs'

test('control system exports one tenant-neutral geometry and interaction grammar', () => {
  assert.match(atelierControlStyles, /--system-control-height, 44px/)
  assert.match(atelierControlStyles, /\.system-control\[data-variant="secondary"\]:hover/)
  assert.match(
    atelierControlStyles,
    /--system-control-quiet-hover-background, rgba\(255, 255, 255, 0\.02\)/,
  )
  assert.match(atelierControlStyles, /\.system-action-group\[data-layout="grid"\]/)
  assert.match(atelierControlStyles, /prefers-reduced-motion: reduce/)
})

test('renderControl escapes content and preserves safe internal and external link semantics', () => {
  assert.equal(
    renderControl({ label: 'Read <now>', href: '/read/', arrow: true }),
    '<a href="/read/" class="system-control" data-variant="secondary" data-size="default">Read &lt;now&gt;<span aria-hidden="true">→</span></a>',
  )
  assert.match(
    renderControl({ label: 'Reference', href: 'https://example.test', external: true }),
    /target="_blank" rel="noreferrer"/,
  )
  const button = renderControl({
    label: 'Copy',
    attrs: { 'data-copy': 'safe', onclick: 'unsafe()', class: 'override' },
  })
  assert.match(button, /data-copy="safe"/)
  assert.doesNotMatch(button, /onclick|override/)
})

test('renderActionGroup provides named inline and grid affordance groups', () => {
  const html = renderActionGroup([
    { label: 'First', href: '/first/' },
    { label: 'Second', href: '/second/' },
  ], { label: 'Browse structure', layout: 'grid', size: 'compact' })

  assert.match(html, /aria-label="Browse structure"/)
  assert.match(html, /class="system-action-group" data-layout="grid"/)
  assert.equal((html.match(/class="system-control"/g) || []).length, 2)
  assert.equal((html.match(/data-size="compact"/g) || []).length, 2)
})
