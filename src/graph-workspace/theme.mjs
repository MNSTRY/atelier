// Graph-workspace themes: resolved token data, never stylesheets.
// Atelier ships two neutral defaults, `night` (the default) and `paper`. A coach or
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

const unsafe = v => typeof v !== 'string' || v.length > 240 || /[;{}<>\\@]|url\(|expression|javascript:/i.test(v)
const hex = v => /^#[0-9a-f]{6}$/i.test(v)

export function validateTheme(theme) {
  const problems = []
  if (theme?.schema !== 'atelier.graph-workspace-theme@v1') problems.push('schema must be atelier.graph-workspace-theme@v1')
  if (!['dark', 'light'].includes(theme?.defaultScheme)) problems.push('defaultScheme must be dark or light')
  for (const scheme of ['dark', 'light']) {
    const s = theme?.schemes?.[scheme]
    if (!s) { problems.push(`missing ${scheme} scheme`); continue }
    for (const k of CSS_VARS) if (!(k in (s.vars ?? {}))) problems.push(`${scheme}: missing ${k}`)
    for (const [k, v] of Object.entries(s.vars ?? {})) if (!/^--[\w-]+$/.test(k) || unsafe(v)) problems.push(`${scheme}: rejected ${k}`)
    for (const k of GRAPH) if (!hex(s.graph?.[k] ?? '')) problems.push(`${scheme}: graph.${k} must be #rrggbb`)
    if (!Array.isArray(s.graph?.zones) || s.graph.zones.length < 4 || !s.graph.zones.every(hex)) problems.push(`${scheme}: graph.zones needs at least four #rrggbb colours`)
  }
  if (!problems.length) for (const scheme of ['dark', 'light']) {
    const g = theme.schemes[scheme].graph
    if (contrastRatio(g.label, g.canvas) < 7) problems.push(`${scheme}: label contrast on the canvas is below 7:1`)
    const weakest = Math.min(...g.zones.map(z => contrastRatio(z, g.canvas)))
    if (weakest < 3) problems.push(`${scheme}: a zone colour is below 3:1 on the canvas (zone names are large text)`)
  }
  return problems
}

/** Override a base theme by layer (coach, then owner). Unknown keys are refused by validation. */
export function composeTheme(base = DEFAULT_THEME, ...layers) {
  const out = structuredClone(base)
  for (const layer of layers.filter(Boolean)) {
    if (layer.id) out.id = layer.id
    if (layer.version) out.version = layer.version
    if (layer.defaultScheme) out.defaultScheme = layer.defaultScheme
    for (const scheme of ['dark', 'light']) {
      const s = layer.schemes?.[scheme]
      if (!s) continue
      Object.assign(out.schemes[scheme].vars, s.vars ?? {})
      Object.assign(out.schemes[scheme].graph, s.graph ?? {})
    }
  }
  const problems = validateTheme(out)
  if (problems.length) throw new TypeError('Theme refused: ' + problems.join('; '))
  return out
}

export function contrastRatio(a, b) {
  const lum = h => { const n = parseInt(h.slice(1, 7), 16); return [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0) }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
