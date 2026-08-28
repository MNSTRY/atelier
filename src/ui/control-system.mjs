const CONTROL_VARIANTS = new Set(['primary', 'secondary', 'quiet'])
const CONTROL_SIZES = new Set(['default', 'compact'])
const GROUP_LAYOUTS = new Set(['inline', 'grid'])

function enumValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback
}

function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function htmlAttr(name, value) {
  if (value == null || value === false) return ''
  if (value === true) return ` ${name}`
  return ` ${name}="${htmlEscape(value)}"`
}

function htmlAttrs(attrs = {}) {
  return Object.entries(attrs).map(([name, value]) => htmlAttr(name, value)).join('')
}

function controlAttrs(attrs = {}) {
  return Object.fromEntries(Object.entries(attrs).filter(([name]) => (
    /^(?:id|name|value|title|aria-[a-z0-9-]+|data-[a-z0-9-]+)$/.test(name)
  )))
}

/**
 * Tenant-neutral control geometry and interaction behavior shared by Atelier
 * tooling and compatible publication surfaces. Consumers theme the primitive
 * exclusively through the --system-control-* custom properties below.
 * Generated markup carries no upstream project or package identity.
 */
export const atelierControlStyles = `
.system-control {
  display: inline-flex;
  min-height: var(--system-control-height, 44px);
  align-items: center;
  justify-content: center;
  gap: var(--system-control-gap, 0.5rem);
  padding: 0 var(--system-control-pad-inline, 1.5rem);
  border: 0;
  border-radius: var(--system-control-radius, 0.875rem);
  font: inherit;
  font-size: var(--system-control-font-size, 1rem);
  font-weight: var(--system-control-font-weight, 650);
  line-height: 1.1;
  letter-spacing: 0;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  user-select: none;
  transition:
    background-color 0.2s var(--system-control-ease, ease),
    color 0.2s var(--system-control-ease, ease),
    box-shadow 0.2s var(--system-control-ease, ease),
    transform 0.25s var(--system-control-ease, ease);
}

.system-control[data-variant="primary"] {
  background: var(--system-control-primary-background, #c89d50);
  color: var(--system-control-primary-foreground, #17110a);
}

.system-control[data-variant="secondary"] {
  background: var(--system-control-secondary-background, transparent);
  color: var(--system-control-secondary-foreground, #c89d50);
  box-shadow: inset 0 0 0 1px var(--system-control-secondary-border, currentColor);
}

.system-control[data-variant="quiet"] {
  background: var(--system-control-quiet-background, transparent);
  color: var(--system-control-quiet-foreground, #c89d50);
}

.system-control[data-size="compact"] {
  padding-inline: var(--system-control-compact-pad-inline, 1.125rem);
  border-radius: var(--system-control-compact-radius, 0.6875rem);
  font-size: var(--system-control-compact-font-size, 0.9375rem);
}

@media (hover: hover) and (pointer: fine) {
  .system-control[data-variant="primary"]:hover {
    background: var(--system-control-primary-hover-background, #b88d43);
    color: var(--system-control-primary-hover-foreground, #17110a);
    box-shadow: inset 0 0 0 1px var(--system-control-primary-hover-border, rgba(255, 255, 255, 0.25));
  }

  .system-control[data-variant="secondary"]:hover {
    background: var(--system-control-secondary-hover-background, transparent);
    color: var(--system-control-secondary-hover-foreground, #f4eee5);
    box-shadow: inset 0 0 0 1px var(--system-control-secondary-hover-border, currentColor);
  }

  .system-control[data-variant="quiet"]:hover {
    background: var(--system-control-quiet-hover-background, rgba(255, 255, 255, 0.04));
    color: var(--system-control-quiet-hover-foreground, #f4eee5);
  }
}

.system-control:active {
  transform: translateY(1px);
  transition-duration: 0.06s;
}

.system-control:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--system-control-focus, rgba(200, 157, 80, 0.3));
}

.system-control:disabled,
.system-control[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
}

.system-action-group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--system-action-group-gap, 0.75rem);
  margin: 0;
  padding: 0;
  list-style: none;
}

.system-action-group[data-layout="grid"] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.system-action-group[data-layout="grid"] .system-control {
  width: 100%;
  justify-content: space-between;
}

@media (max-width: 40rem) {
  .system-action-group[data-layout="grid"] {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .system-control,
  .system-control:active {
    transform: none;
    transition: none;
  }
}
`.trim()

export function renderControl({
  label,
  href,
  type = 'button',
  variant = 'secondary',
  size = 'default',
  external = false,
  arrow = false,
  attrs = {},
} = {}) {
  const resolvedVariant = enumValue(variant, CONTROL_VARIANTS, 'secondary')
  const resolvedSize = enumValue(size, CONTROL_SIZES, 'default')
  const content = `${htmlEscape(label)}${arrow ? '<span aria-hidden="true">→</span>' : ''}`
  const shared = {
    class: 'system-control',
    'data-variant': resolvedVariant,
    'data-size': resolvedSize,
    ...controlAttrs(attrs),
  }

  if (typeof href === 'string' && href.length > 0) {
    return `<a${htmlAttr('href', href)}${htmlAttrs({
      ...shared,
      ...(external ? { target: '_blank', rel: 'noreferrer' } : {}),
    })}>${content}</a>`
  }

  return `<button${htmlAttrs({ type, ...shared })}>${content}</button>`
}

export function renderActionGroup(actions = [], {
  label = 'Actions',
  layout = 'inline',
  variant = 'secondary',
  size = 'default',
} = {}) {
  const resolvedLayout = enumValue(layout, GROUP_LAYOUTS, 'inline')
  const items = actions.map((action) => `<li>${renderControl({
    ...action,
    variant: action.variant ?? variant,
    size: action.size ?? size,
  })}</li>`).join('')

  return `<nav aria-label="${htmlEscape(label)}"><ul class="system-action-group" data-layout="${resolvedLayout}">${items}</ul></nav>`
}
