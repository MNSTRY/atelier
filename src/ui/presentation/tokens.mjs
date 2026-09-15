const freeze = value => {
  Object.values(value).forEach(v => { if (v && typeof v === 'object') freeze(v) })
  return Object.freeze(value)
}

export const tokenContract = freeze({
  color: { page: '#f5f6f8', panel: '#ffffff', text: '#18202b', muted: '#495668', accent: '#164fa3', onAccent: '#ffffff', border: '#718096', selected: '#e1ecff', danger: '#a51d32', success: '#21633d', focus: '#164fa3' },
  typography: { body: 16, small: 14, heading: 22, lineHeight: 1.5, family: 'sans-serif' },
  spacing: { small: 4, medium: 8, large: 16, section: 24 },
  layout: { content: 1280, narrow: 768, paneMin: 240 },
  density: { comfortable: 12, compact: 8, target: 44 },
  elevation: { offset: 4, blur: 16, opacity: 0.15 },
  border: { width: 1, radius: 8 },
  motion: { duration: 120 },
  state: { focusWidth: 3, focusOffset: 3, disabledOpacity: 0.7 },
})

const dark = { page: '#141a23', panel: '#202938', text: '#f3f6fb', muted: '#c0cbda', accent: '#a4c6ff', onAccent: '#12213b', border: '#8b9bb1', selected: '#304566', danger: '#ffacb9', success: '#9cdfb1', focus: '#a4c6ff' }
const range = {
  'typography.body': [16, 32], 'typography.small': [14, 32], 'typography.heading': [18, 48], 'typography.lineHeight': [1.4, 2],
  'spacing.small': [2, 16], 'spacing.medium': [4, 32], 'spacing.large': [8, 64], 'spacing.section': [16, 96],
  'layout.content': [320, 2400], 'layout.narrow': [480, 1200], 'layout.paneMin': [160, 480],
  'density.comfortable': [8, 24], 'density.compact': [4, 16], 'density.target': [44, 64],
  'elevation.offset': [0, 16], 'elevation.blur': [0, 40], 'elevation.opacity': [0, 0.4],
  'border.width': [1, 4], 'border.radius': [0, 24], 'motion.duration': [0, 250],
  'state.focusWidth': [3, 6], 'state.focusOffset': [2, 6], 'state.disabledOpacity': [0.7, 1],
}
export function contrastRatio(a, b) {
  const lum = hex => {
    const c = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722
  }
  const x = lum(a), y = lum(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}

export function resolveTokens(theme = 'light', overrides = {}) {
  if (!['light', 'dark'].includes(theme)) throw new TypeError('unknown theme')
  if (!overrides || Object.getPrototypeOf(overrides) !== Object.prototype) throw new TypeError('invalid token overrides')
  const result = structuredClone(tokenContract)
  if (theme === 'dark') result.color = { ...dark }
  for (const [group, values] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, group) || !values || Object.getPrototypeOf(values) !== Object.prototype) throw new TypeError('unknown token group')
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(result[group], key)) throw new TypeError('unknown token')
      const bounds = range[group + '.' + key]
      const valid = group === 'color' ? typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
        : key === 'family' ? ['sans-serif', 'serif', 'monospace'].includes(value)
        : bounds && typeof value === 'number' && Number.isFinite(value) && value >= bounds[0] && value <= bounds[1]
      if (!valid) throw new TypeError('invalid token value')
      result[group][key] = value
    }
  }
  for (const background of ['page', 'panel', 'selected']) {
    for (const foreground of ['text', 'muted', 'accent', 'danger', 'success']) {
      if (contrastRatio(result.color[foreground], result.color[background]) < 4.5) throw new TypeError('text token contrast floor')
    }
    for (const foreground of ['border', 'focus']) {
      if (contrastRatio(result.color[foreground], result.color[background]) < 3) throw new TypeError('boundary token contrast floor')
    }
  }
  if (contrastRatio(result.color.onAccent, result.color.accent) < 4.5) throw new TypeError('accent label contrast floor')
  return freeze(result)
}

export function tokenVariables(tokens) {
  const checked = resolveTokens('light', tokens)
  const unitless = new Set(['typography.lineHeight', 'elevation.opacity', 'state.disabledOpacity'])
  return Object.entries(checked).flatMap(([group, values]) => Object.entries(values).map(([key, value]) => {
    const name = (group + '-' + key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())
    const suffix = typeof value === 'number' ? unitless.has(group + '.' + key) ? '' : group === 'motion' ? 'ms' : 'px' : ''
    return '--ap-' + name + ':' + value + suffix
  })).join(';')
}
