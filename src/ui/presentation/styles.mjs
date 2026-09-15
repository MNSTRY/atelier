import { resolveTokens, tokenVariables } from './tokens.mjs'

export function presentationStyles(theme = 'light', overrides = {}, rootId) {
  if (rootId !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(rootId)) throw new TypeError('invalid style root')
  const tokens = resolveTokens(theme, overrides)
  const scope = rootId === undefined ? '[data-ap-root]' : '[data-ap-root="' + rootId + '"]'
  return scope + '{' + tokenVariables(tokens) + '}\n' + structuralStyles.replaceAll('[data-ap-root]', scope).replaceAll('NARROW_WIDTH', String(tokens.layout.narrow)).replaceAll('HEADING_SCALE', String(tokens.typography.heading / tokens.typography.body)).replaceAll('SMALL_SCALE', String(tokens.typography.small / tokens.typography.body))
}
const structuralStyles = String.raw`
[data-ap-root] { box-sizing:border-box; container-type:inline-size; color:var(--ap-color-text); background:var(--ap-color-page); font-family:var(--ap-typography-family); font-size:var(--ap-typography-body); line-height:var(--ap-typography-line-height); padding:var(--ap-spacing-large); --ap-pad:var(--ap-density-comfortable); }
[data-ap-root][data-density="compact"] { --ap-pad:var(--ap-density-compact); }
[data-ap-root] *,[data-ap-root] *::before,[data-ap-root] *::after { box-sizing:border-box; }
[data-ap-root] [hidden] { display:none !important; }
[data-ap-root] :is(h1,h2,h3,p,figure,dl) { margin:0 0 var(--ap-spacing-medium); }
[data-ap-root] h1 { font-size:calc(HEADING_SCALE * 1.3em); }
[data-ap-root] h2,[data-ap-root] h3 { font-size:calc(HEADING_SCALE * 1em); }
[data-ap-root] :is(p,li,dd,dt,a,button,label,output) { overflow-wrap:anywhere; }
[data-ap-root] :is(input,textarea,button) { font:inherit; }
[data-ap-root] a { color:var(--ap-color-accent); text-underline-offset:.18em; }
[data-ap-root] :is(button,input,textarea,select,.ap-link) { min-block-size:var(--ap-density-target); min-inline-size:var(--ap-density-target); }
[data-ap-root] :is(button,.ap-link) { display:inline-flex; align-items:center; justify-content:center; gap:var(--ap-spacing-medium); padding:var(--ap-spacing-medium) var(--ap-spacing-large); color:var(--ap-color-accent); background:var(--ap-color-panel); border:var(--ap-border-width) solid var(--ap-color-border); border-radius:var(--ap-border-radius); cursor:pointer; transition:background-color var(--ap-motion-duration),color var(--ap-motion-duration); }
[data-ap-root] .ap-link { justify-content:flex-start; text-decoration:underline; border-color:transparent; border-radius:0; background:transparent; }
[data-ap-root] .ap-skip:not(:focus) { position:absolute; inline-size:1px; block-size:1px; min-inline-size:0; min-block-size:0; padding:0; border:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
[data-ap-root] .ap-skip:focus { position:fixed; inset-block-start:var(--ap-spacing-large); inset-inline-start:var(--ap-spacing-large); z-index:1; background:var(--ap-color-panel); }
[data-ap-root] .ap-header { max-inline-size:var(--ap-layout-content); margin-inline:auto; }
@media (hover:hover) { [data-ap-root] :is(button,.ap-link):not(:disabled):hover { background:var(--ap-color-selected); } }
[data-ap-root] :is(button,.ap-link):not(:disabled):active { background:var(--ap-color-accent); color:var(--ap-color-on-accent); }
[data-ap-root] :focus-visible { outline:var(--ap-state-focus-width) solid var(--ap-color-focus); outline-offset:var(--ap-state-focus-offset); }
[data-ap-root] :disabled { opacity:var(--ap-state-disabled-opacity); cursor:not-allowed; }
[data-ap-root] [aria-pressed="true"] { background:var(--ap-color-selected); border-width:2px; }
[data-ap-root] [aria-invalid="true"] { border:2px solid var(--ap-color-danger); }
[data-ap-root] [data-ap-dragging="true"] { outline:var(--ap-state-focus-width) dashed var(--ap-color-focus); outline-offset:var(--ap-state-focus-offset); }
[data-ap-root] .ap-error { color:var(--ap-color-danger); }
[data-ap-root] .ap-muted { color:var(--ap-color-muted); font-size:calc(SMALL_SCALE * 1em); }
[data-ap-root] .ap-workspace { display:flex; flex-wrap:wrap; gap:var(--ap-spacing-large); max-inline-size:var(--ap-layout-content); margin-inline:auto; align-items:flex-start; }
[data-ap-root] .ap-pane { flex:var(--ap-pane-weight,1) 1 var(--ap-pane-basis,320px); min-inline-size:min(100%,var(--ap-layout-pane-min)); max-inline-size:100%; padding:var(--ap-pad); background:var(--ap-color-panel); border:var(--ap-border-width) solid var(--ap-color-border); border-radius:var(--ap-border-radius); }
[data-ap-root] .ap-pane-body { display:grid; gap:var(--ap-spacing-section); }
[data-ap-root] .ap-pane-header { border-block-end:var(--ap-border-width) solid var(--ap-color-border); margin-block-end:var(--ap-spacing-large); padding-block-end:var(--ap-spacing-medium); }
[data-ap-root] .ap-block { min-inline-size:0; }
[data-ap-root] :is(.ap-nav,.ap-actions,.ap-resize) { display:flex; gap:var(--ap-spacing-medium); flex-wrap:wrap; align-items:center; margin-block:var(--ap-spacing-medium); }
[data-ap-root] .ap-resize input { flex:1; max-inline-size:100%; }
[data-ap-root] input:not([type=range]),[data-ap-root] textarea { display:block; inline-size:100%; padding:var(--ap-spacing-medium); color:var(--ap-color-text); background:var(--ap-color-panel); border:var(--ap-border-width) solid var(--ap-color-border); border-radius:var(--ap-border-radius); }
[data-ap-root] input[aria-invalid="true"],[data-ap-root] textarea[aria-invalid="true"] { border:2px solid var(--ap-color-danger); }
[data-ap-root] textarea { min-block-size:10rem; resize:vertical; }
[data-ap-root] label { display:block; }
[data-ap-root] :is(ul,ol) { padding-inline-start:var(--ap-spacing-section); }
[data-ap-root] li { margin-block:var(--ap-spacing-medium); }
[data-ap-root] dt { font-weight:600; }
[data-ap-root] dd { margin-inline-start:0; }
[data-ap-root] table { border-collapse:collapse; inline-size:100%; table-layout:fixed; }
[data-ap-root] :is(th,td) { text-align:start; border-block-end:var(--ap-border-width) solid var(--ap-color-border); padding:var(--ap-spacing-medium); overflow-wrap:anywhere; }
[data-ap-root] pre { white-space:pre-wrap; overflow-wrap:anywhere; font-family:monospace; padding:var(--ap-spacing-medium); border:var(--ap-border-width) solid var(--ap-color-border); }
[data-ap-root] .ap-diff { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--ap-spacing-large); }
[data-ap-root] img { max-inline-size:100%; block-size:auto; }
[data-ap-root] .ap-notice { border-inline-start:4px solid var(--ap-color-border); padding-inline-start:var(--ap-spacing-large); }
[data-ap-root] .ap-tone { font-weight:600; }
[data-ap-root] [data-tone=info],[data-ap-root] [data-tone=warning] { border-color:var(--ap-color-accent); }
[data-ap-root] [data-tone=warning] { border-inline-start-style:dashed; }
[data-ap-root] [data-tone=danger] { border-color:var(--ap-color-danger); }
[data-ap-root] [data-tone=success] { border-color:var(--ap-color-success); }
[data-ap-root] dialog { max-inline-size:min(36rem,calc(100vw - 2rem)); max-block-size:calc(100dvh - 2rem); overflow:auto; color:var(--ap-color-text); background:var(--ap-color-panel); padding:var(--ap-spacing-section); border:var(--ap-border-width) solid var(--ap-color-border); border-radius:var(--ap-border-radius); box-shadow:0 var(--ap-elevation-offset) var(--ap-elevation-blur) rgb(0 0 0 / var(--ap-elevation-opacity)); }
[data-ap-root] dialog::backdrop { background:rgb(0 0 0 / .6); }
@container (max-width:NARROW_WIDTHpx) { [data-ap-root] .ap-workspace { flex-direction:column; } [data-ap-root] .ap-pane { flex:none; inline-size:100%; } [data-ap-root] .ap-resize { display:none; } [data-ap-root] .ap-diff { grid-template-columns:1fr; } }
@media (prefers-reduced-motion:reduce) { [data-ap-root] *,[data-ap-root] *::before,[data-ap-root] *::after { transition:none !important; animation:none !important; scroll-behavior:auto !important; } }
@media (forced-colors:active) { [data-ap-root] :focus-visible { outline-color:Highlight; } [data-ap-root] [aria-pressed=true] { border-color:Highlight; } }
@media print { [data-ap-root] { --ap-color-text:#000;--ap-color-page:#fff;--ap-color-panel:#fff;--ap-color-muted:#333;--ap-color-selected:#fff;--ap-color-accent:#000;--ap-color-danger:#000;--ap-color-success:#000; color:#000;background:#fff;padding:0; } [data-ap-root] :is(.ap-skip,.ap-nav,.ap-resize,button,dialog) { display:none !important; } [data-ap-root] .ap-workspace { display:block; } [data-ap-root] .ap-pane { border:0;break-inside:auto; } [data-ap-root] a { color:#000; } }
`
