// Graph-workspace themes: resolved token data, never stylesheets.
// Atelier ships two neutral defaults, `night` (the default) and `paper`. A distribution or
// owner theme overrides values by name; the result is validated, including text
// contrast, before any room applies it as CSS custom properties.

const CSS_VARS = ['--canvas', '--surface', '--surface-2', '--surface-glass', '--ink', '--ink-2', '--ink-3', '--line', '--line-strong', '--accent', '--accent-ink', '--focus', '--warn', '--danger', '--ok', '--font-sans', '--font-display', '--radius', '--radius-lg', '--shadow', '--motion', '--ease']
const GRAPH = ['canvas', 'edge', 'edgeStructural', 'dim', 'label', 'labelHalo', 'selection']

const night = {
  vars: {
    '--canvas': '#0b0e14', '--surface': '#131823', '--surface-2': '#1a2030', '--surface-glass': 'rgba(19,24,35,0.82)',
    '--ink': '#eef1f7', '--ink-2': '#b9c1d3', '--ink-3': '#8d97ad', '--line': 'rgba(238,241,247,0.12)', '--line-strong': 'rgba(238,241,247,0.26)',
    '--accent': '#9cc4ff', '--accent-ink': '#08101d', '--focus': '#ffd479', '--warn': '#ffc46b', '--danger': '#ff9a8a', '--ok': '#8fe0b0',
    '--font-sans': 'Inter, "SF Pro Text", -apple-system, system-ui, sans-serif', '--font-display': '"SF Pro Display", Inter, -apple-system, system-ui, sans-serif',
    '--radius': '10px', '--radius-lg': '16px', '--shadow': '0 12px 40px rgba(0,0,0,0.45)', '--motion': '240ms', '--ease': 'cubic-bezier(0.2, 0, 0, 1)',
  },
  graph: { canvas: '#0b0e14', edge: '#7d88a3', edgeStructural: '#c9d2e6', dim: '#283044', label: '#e6eaf2', labelHalo: '#0b0e14', selection: '#ffd479',
    zones: ['#7aa7ff', '#5fd1b0', '#f2a65a', '#c792ea', '#ff8fa3', '#e6d36a', '#6fd3f2', '#a4e07a', '#f28fd2', '#b0b8c8'] },
}
const paper = {
  vars: {
    ...night.vars,
    '--canvas': '#f5f3ee', '--surface': '#ffffff', '--surface-2': '#f0ede6', '--surface-glass': 'rgba(255,255,255,0.86)',
    '--ink': '#1a1d24', '--ink-2': '#454b58', '--ink-3': '#5f6676', '--line': 'rgba(26,29,36,0.12)', '--line-strong': 'rgba(26,29,36,0.28)',
    '--accent': '#2c55a8', '--accent-ink': '#ffffff', '--focus': '#a05a00', '--warn': '#8a4a00', '--danger': '#a32121', '--ok': '#1f6b3c', '--shadow': '0 12px 36px rgba(20,22,30,0.14)',
  },
  graph: { canvas: '#f5f3ee', edge: '#9aa1ae', edgeStructural: '#4a5162', dim: '#dcd8cf', label: '#1a1d24', labelHalo: '#f5f3ee', selection: '#a05a00',
    zones: ['#2f62c9', '#0f7259', '#9a4f0c', '#7a45a8', '#b83255', '#6f5d00', '#0f6a85', '#3f6c14', '#a3337f', '#5d6577'] },
}

export const DEFAULT_THEME = Object.freeze({
  schema: 'atelier.graph-workspace-theme@v1', id: 'atelier-night', version: '1', defaultScheme: 'dark',
  schemes: Object.freeze({ dark: night, light: paper }),
})

// Every token has one type. Only colours, lengths, durations, an easing and font
// family names are accepted, so no theme value can load a resource or inject CSS.
const HEX = /^#[0-9a-f]{6}$/i
const RGBA = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,3})\s*\)$/i
const COLOR = v => HEX.test(v)
const SOFT_COLOR = v => HEX.test(v) || RGBA.test(v)
const FONT = v => /^[A-Za-z0-9 "',.-]{1,160}$/.test(v) && !/["']{2}/.test(v)
const LENGTH = v => /^\d{1,2}(?:\.\d{1,2})?px$/.test(v)
const SHADOW = v => v === 'none' || v.split(/,(?![^()]*\))/).every(part => /^\s*(?:(?:0|-?\d{1,3}(?:\.\d{1,2})?px)\s+){2,4}(?:rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,3})\s*\)|#[0-9a-f]{6})\s*$/i.test(part))
const DURATION = v => /^\d{1,4}ms$/.test(v)
const EASE = v => /^(?:ease|linear|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?\d(?:\.\d{1,3})?\s*,\s*-?\d(?:\.\d{1,3})?\s*,\s*-?\d(?:\.\d{1,3})?\s*,\s*-?\d(?:\.\d{1,3})?\s*\))$/.test(v)
export const TOKEN_TYPES = Object.freeze({
  '--canvas': COLOR, '--surface': COLOR, '--surface-2': COLOR, '--surface-glass': SOFT_COLOR,
  '--ink': COLOR, '--ink-2': COLOR, '--ink-3': COLOR, '--line': SOFT_COLOR, '--line-strong': SOFT_COLOR,
  '--accent': COLOR, '--accent-ink': COLOR, '--focus': COLOR, '--warn': COLOR, '--danger': COLOR, '--ok': COLOR,
  '--font-sans': FONT, '--font-display': FONT, '--radius': LENGTH, '--radius-lg': LENGTH, '--shadow': SHADOW, '--motion': DURATION, '--ease': EASE,
})
const LAYER_FIELDS = ['id', 'version', 'defaultScheme', 'schemes']
const SCHEME_FIELDS = ['vars', 'graph']
// Text and the surfaces it is drawn on in the rooms, with the minimum ratio for its size.
const TEXT_PAIRS = [
  ['--ink', '--canvas', 7], ['--ink', '--surface', 7], ['--ink', '--surface-2', 7],
  ['--ink-2', '--canvas', 4.5], ['--ink-2', '--surface', 4.5], ['--ink-2', '--surface-2', 4.5],
  ['--ink-3', '--canvas', 4.5], ['--ink-3', '--surface', 4.5], ['--ink-3', '--surface-2', 4.5],
  ['--accent-ink', '--accent', 4.5], ['--accent', '--canvas', 4.5], ['--accent', '--surface', 4.5],
  ['--warn', '--surface', 4.5], ['--danger', '--surface', 4.5], ['--ok', '--surface', 4.5],
]
// Text on the translucent chrome (pills, command bar, selection card), composited
// over each backdrop it floats on.
const GLASS_TEXT = [['--ink', 4.5], ['--ink-2', 4.5], ['--ink-3', 4.5]]
const GLASS_BACKDROPS = ['--canvas', '--surface-2']
function composite(over, under) {
  const rgb = h => { const n = parseInt(h.slice(1, 7), 16); return [n >> 16, (n >> 8) & 255, n & 255] }
  const m = RGBA.test(over) ? over.match(/[\d.]+/g).map(Number) : [...rgb(over), 1]
  const [r, g, b, a] = [Math.min(255, m[0]), Math.min(255, m[1]), Math.min(255, m[2]), Math.min(1, m[3])]
  const base = rgb(under)
  return '#' + [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')
}

function layerProblems(layer, { partial }) {
  const problems = []
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return ['theme layer must be an object']
  for (const key of Object.keys(layer)) if (!LAYER_FIELDS.includes(key) && !(key === 'schema' && !partial)) problems.push(`unknown theme field ${key}`)
  if ('id' in layer && !/^[a-z][a-z0-9-]{0,47}$/.test(layer.id ?? '')) problems.push('id must be a short lowercase slug')
  if ('version' in layer && !/^[\w.-]{1,32}$/.test(layer.version ?? '')) problems.push('version must be a short label')
  if ('defaultScheme' in layer && !['dark', 'light'].includes(layer.defaultScheme)) problems.push('defaultScheme must be dark or light')
  if ('schemes' in layer) {
    if (!layer.schemes || typeof layer.schemes !== 'object' || Array.isArray(layer.schemes)) problems.push('schemes must be an object')
    else for (const [scheme, value] of Object.entries(layer.schemes)) {
      if (!['dark', 'light'].includes(scheme)) { problems.push(`unknown scheme ${scheme}`); continue }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${scheme}: must be an object`); continue }
      for (const key of Object.keys(value)) if (!SCHEME_FIELDS.includes(key)) problems.push(`${scheme}: unknown field ${key}`)
      for (const [k, v] of Object.entries(value.vars ?? {})) {
        if (!Object.hasOwn(TOKEN_TYPES, k)) problems.push(`${scheme}: unknown token ${k}`)
        else if (typeof v !== 'string' || !TOKEN_TYPES[k](v)) problems.push(`${scheme}: rejected ${k}`)
      }
      for (const [k, v] of Object.entries(value.graph ?? {})) {
        if (k === 'zones') { if (!Array.isArray(v) || v.length < 4 || v.length > 16 || !v.every(z => typeof z === 'string' && HEX.test(z))) problems.push(`${scheme}: graph.zones needs 4–16 #rrggbb colours`) }
        else if (!GRAPH.includes(k)) problems.push(`${scheme}: unknown graph key ${k}`)
        else if (typeof v !== 'string' || !HEX.test(v)) problems.push(`${scheme}: graph.${k} must be #rrggbb`)
      }
    }
  }
  return problems
}

export function validateTheme(theme) {
  const problems = []
  if (theme?.schema !== 'atelier.graph-workspace-theme@v1') problems.push('schema must be atelier.graph-workspace-theme@v1')
  problems.push(...layerProblems(theme, { partial: false }))
  if (!['dark', 'light'].includes(theme?.defaultScheme)) problems.push('defaultScheme must be dark or light')
  for (const scheme of ['dark', 'light']) {
    const s = theme?.schemes?.[scheme]
    if (!s) { problems.push(`missing ${scheme} scheme`); continue }
    for (const k of Object.keys(TOKEN_TYPES)) if (!(k in (s.vars ?? {}))) problems.push(`${scheme}: missing ${k}`)
    for (const k of GRAPH) if (!(k in (s.graph ?? {}))) problems.push(`${scheme}: missing graph.${k}`)
    if (!Array.isArray(s.graph?.zones)) problems.push(`${scheme}: missing graph.zones`)
  }
  if (problems.length) return [...new Set(problems)]
  for (const scheme of ['dark', 'light']) {
    const { vars, graph } = theme.schemes[scheme]
    if (vars['--canvas'].toLowerCase() !== graph.canvas.toLowerCase()) problems.push(`${scheme}: --canvas and graph.canvas must be the same colour`)
    for (const [fg, bg, min] of TEXT_PAIRS) if (contrastRatio(vars[fg], vars[bg]) < min) problems.push(`${scheme}: ${fg} on ${bg} is below ${min}:1`)
    for (const backdrop of GLASS_BACKDROPS) {
      const glass = composite(vars['--surface-glass'], vars[backdrop])
      for (const [fg, min] of GLASS_TEXT) if (contrastRatio(vars[fg], glass) < min) problems.push(`${scheme}: ${fg} on --surface-glass over ${backdrop} is below ${min}:1`)
    }
    if (contrastRatio(graph.label, graph.canvas) < 7) problems.push(`${scheme}: label contrast on the canvas is below 7:1`)
    if (Math.min(...graph.zones.map(z => contrastRatio(z, graph.canvas))) < 3) problems.push(`${scheme}: a zone colour is below 3:1 on the canvas (zone names are large text)`)
  }
  return problems
}

/** Override a base theme by layer (distribution, then owner). Each layer is validated before it is applied. */
export function composeTheme(base = DEFAULT_THEME, ...layers) {
  const baseProblems = validateTheme(base)
  if (baseProblems.length) throw new TypeError('Base theme refused: ' + baseProblems.join('; '))
  const out = structuredClone(base)
  layers.filter(Boolean).forEach((layer, index) => {
    const problems = layerProblems(layer, { partial: true })
    if (problems.length) throw new TypeError(`Theme layer ${index + 1} refused: ${problems.join('; ')}`)
    if (layer.id) out.id = layer.id
    if (layer.version) out.version = layer.version
    if (layer.defaultScheme) out.defaultScheme = layer.defaultScheme
    for (const scheme of ['dark', 'light']) {
      const s = layer.schemes?.[scheme]
      if (!s) continue
      Object.assign(out.schemes[scheme].vars, s.vars ?? {})
      Object.assign(out.schemes[scheme].graph, s.graph ?? {})
    }
  })
  const problems = validateTheme(out)
  if (problems.length) throw new TypeError('Theme refused: ' + problems.join('; '))
  return out
}

export function contrastRatio(a, b) {
  const lum = h => { const n = parseInt(h.slice(1, 7), 16); return [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0) }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
