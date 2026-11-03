// Default graph workspace shell: one graph, three rooms (constellation, workbench,
// review), chosen by a work recipe. Coaches can use it as is, restyle it through a
// theme, change its recipes, or build their own shell from the same rooms.
//
//   const workspace = mountGraphWorkspace(element, {
//     model,                    // buildWorkspaceModel(...) with positions (layoutWorkspace)
//     deps,                     // { Sigma, Graph, EdgeArrowProgram, FA2Layout? }
//     recipes, theme, profile, storage, draftKey,
//   })
//
// One workspace per document (it uses fixed element ids). The host decides what
// the model contains; nothing here fetches, grants or saves to a source.
import { createConstellation } from './constellation.mjs'
import { createWorkbench } from './workbench.mjs'
import { renderReview } from './review.mjs'
import { injectGraphWorkspaceStyles } from './styles.mjs'
import { h, clear } from './dom.mjs'
import { createDraftStore, readiness, memoryStorage } from '../authoring.mjs'
import { composeRecipes, availableRecipes } from '../recipes.mjs'
import { DEFAULT_THEME, validateTheme } from '../theme.mjs'

const fmt = n => n.toLocaleString('en-US')
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const hasWebGL = () => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')) } catch { return false } }

export function applyTheme(theme, scheme, target) {
  const problems = validateTheme(theme)
  if (problems.length) throw new TypeError('Theme refused: ' + problems.join('; '))
  const s = theme.schemes[scheme]
  for (const [k, v] of Object.entries(s.vars)) target.style.setProperty(k, v)
  target.dataset.colorScheme = scheme
  return { ...s.graph, zones: [...s.graph.zones], mode: scheme }
}

export function mountGraphWorkspace(root, options) {
  const {
    model, deps = null, theme = DEFAULT_THEME, profile = {}, initialRecipe = null, intro = true,
    storage = (() => { try { return window.localStorage } catch { return memoryStorage() } })(),
    draftKey = `atelier-graph-workspace:draft:${profile.id ?? 'workspace'}:${model.plan?.concepts.length ?? 0}-${model.nodes.length}`,
    webgl = hasWebGL() && !!deps,
  } = options
  const recipesAll = options.recipes ?? composeRecipes().recipes
  const recipes = availableRecipes(recipesAll, model)
  const byRecipe = new Map(recipes.map(r => [r.id, r]))
  const vocab = { record: 'record', records: 'records', zone: 'zone', concept: 'concept', model: 'Concepts', ...(profile.vocabulary ?? {}) }
  injectGraphWorkspaceStyles(root.ownerDocument)

  const state = { recipe: null, room: 'constellation', selected: null, questionId: null, textView: !webgl, scheme: options.scheme ?? theme.defaultScheme, zonesOn: true, linksOn: true, labelBoost: 1, savedCamera: null }
  const counters = { dives: 0 }
  let palette = null, constellation = null

  // ── DOM ──
  const el = {}
  const make = (key, tag, props, ...children) => (el[key] = h(tag, props, ...children))
  clear(root)
  root.classList.add('atelier-gw')
  const stage = h('div', { class: 'stage' })
  stage.append(
    make('constellation', 'div', { class: 'constellation', role: 'img', 'aria-label': 'Constellation of every record you can read. Use search, the selection card or Text view to move through it by keyboard.' }),
    h('header', { class: 'top' },
      h('div', { class: 'menu-wrap', 'data-graph-reserve': '' },
        make('recipeBtn', 'button', { class: 'pill', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, h('span', { class: 'emblem', 'aria-hidden': 'true', text: profile.emblem ?? '◌' }), make('recipeLabel', 'span', { text: '' }), h('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' })),
        make('recipeMenu', 'div', { class: 'menu', role: 'menu', 'aria-label': 'What are you doing?', hidden: true })),
      make('commandWrap', 'div', { class: 'command-wrap', role: 'search', 'data-graph-reserve': '' },
        h('label', { class: 'sr-only', for: 'gw-command', text: 'Search or type a command' }),
        make('command', 'input', { id: 'gw-command', type: 'search', placeholder: 'Search or type a command', autocomplete: 'off', 'aria-autocomplete': 'list' }),
        h('kbd', { 'aria-hidden': 'true', text: '⌘K' }),
        make('results', 'ul', { class: 'command-results', role: 'listbox', 'aria-label': 'Results', hidden: true })),
      h('div', { class: 'top-right', 'data-graph-reserve': '' },
        make('textToggle', 'button', { class: 'pill', type: 'button', 'aria-pressed': 'false', disabled: !webgl }, 'Text view'),
        h('div', { class: 'menu-wrap' },
          make('displayBtn', 'button', { class: 'pill icon', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Display' }, '◐'),
          make('display', 'div', { class: 'menu display', hidden: true },
            h('p', { class: 'menu-label', text: 'Display' }),
            make('schemeBtn', 'button', { class: 'menu-item', type: 'button' }, ''),
            h('label', { class: 'row' }, make('zonesToggle', 'input', { type: 'checkbox', checked: true }), ' Zones'),
            h('label', { class: 'row' }, make('linksToggle', 'input', { type: 'checkbox', checked: true }), ' Link-only edges'),
            h('label', { class: 'row col' }, 'Label density ', make('labelsRange', 'input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: '1' })),
            h('label', { class: 'row' }, make('physicsToggle', 'input', { type: 'checkbox', disabled: reduced() || !deps?.FA2Layout }), ' Let it move'))))),
    h('footer', { class: 'corner', 'data-graph-reserve': '' }, h('strong', { text: profile.name ?? 'Workspace' }), make('coverage', 'span', {}), make('provenance', 'span', { class: 'provenance', text: profile.provenance ?? '' })),
    h('div', { class: 'zoom', role: 'group', 'aria-label': 'Zoom', 'data-graph-reserve': '' },
      make('zoomIn', 'button', { type: 'button', 'aria-label': 'Zoom in' }, '+'), make('zoomOut', 'button', { type: 'button', 'aria-label': 'Zoom out' }, '−'), make('fit', 'button', { type: 'button', 'aria-label': 'Fit the whole graph' }, '⤢')),
    make('card', 'section', { class: 'card', 'aria-labelledby': 'card-title', hidden: true, 'data-graph-reserve': '' }),
    make('questionCard', 'section', { class: 'question-card', hidden: true, 'data-graph-reserve': '' }),
    make('textView', 'section', { class: 'text-view', 'aria-label': 'Text view' }),
    make('workbench', 'section', { class: 'workbench', 'aria-label': 'Workbench', hidden: true }),
    make('review', 'section', { class: 'review-room', 'aria-label': 'Review', hidden: true }),
    make('toast', 'div', { class: 'toast', role: 'status', hidden: true }),
    make('live', 'p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }))
  root.append(stage)
  if (!webgl) root.classList.add('text-mode', 'no-webgl')

  const store = createDraftStore({ storage, key: draftKey })
  const announce = text => { el.live.textContent = text }
  let toastTimer = null
  const toast = text => { el.toast.textContent = text; el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true }, 3200) }

  function applyAppearance() {
    palette = applyTheme(theme, state.scheme, root)
    constellation?.setPalette(palette)
    el.schemeBtn.textContent = state.scheme === 'dark' ? 'Light appearance' : 'Dark appearance'
  }
  applyAppearance()

  const declared = model.edges.filter(e => e.kind === 'relation').length
  el.coverage.textContent = `${fmt(model.nodes.length)} ${vocab.records} · ${model.zones.length} ${vocab.zone}s · ${fmt(model.edges.length)} links (${fmt(declared)} declared)${model.coverage.linksOutsideReadableSet ? ` · ${fmt(model.coverage.linksOutsideReadableSet)} point outside what you can read` : ''}`

  const font = getComputedStyle(root).getPropertyValue('--font-sans').trim() || 'system-ui'
  if (webgl) {
    constellation = createConstellation({ container: el.constellation, model, palette, font, deps, onSelect: id => select(id), onOpen: id => openWorkbench({ kind: 'record', id }) })
    if (intro) constellation.intro()
  }
  const workbench = createWorkbench({ root: el.workbench, model, palette, store, vocab, onBack: backToConstellation, onReview: openReview, onShowOnMap: id => backToConstellation().then(() => { select(id); constellation?.showNode(id) }) })
  el.workbench.hidden = true

  // ── Recipes ──
  function setRecipe(id) {
    const recipe = byRecipe.get(id) ?? recipes[0]
    if (!recipe) return
    state.recipe = recipe.id
    el.recipeLabel.textContent = recipe.label
    root.dataset.recipe = recipe.id
    closeMenus()
    el.questionCard.hidden = recipe.lens !== 'question'
    if (recipe.lens === 'question') { state.questionId = state.questionId ?? model.plan.questions[0].id; renderQuestionCard() } else constellation?.setLens(null)
    if (recipe.room === 'workbench') {
      if (recipe.subject === 'concept') openWorkbench({ kind: 'concept', id: model.plan.concepts[0].id })
      else openWorkbench({ kind: 'record', id: state.selected ?? [...model.nodes].sort((a, b) => b.relationDegree - a.relationDegree || b.degree - a.degree)[0].id })
    } else if (state.room !== 'constellation') backToConstellation()
    announce(`${recipe.label}. ${recipe.description}`)
  }
  function renderQuestionCard() {
    clear(el.questionCard)
    const plan = model.plan
    const q = plan.questions.find(x => x.id === state.questionId) ?? plan.questions[0]
    const ids = new Set(q.concepts.flatMap(cid => plan.concepts.find(c => c.id === cid)?.declaredBy ?? []))
    constellation?.setLens([...ids])
    const zones = new Set([...ids].map(id => model.nodes.find(n => n.id === id)?.zoneLabel))
    el.questionCard.append(h('p', { class: 'eyebrow', text: 'The question on the table' }),
      h('select', { 'aria-label': 'Question', onchange: e => { state.questionId = e.target.value; renderQuestionCard() } }, plan.questions.map(x => h('option', { value: x.id, selected: x.id === q.id, text: x.question }))),
      h('p', { class: 'q-lit', 'data-gw': 'question-lit', text: ids.size ? `${fmt(ids.size)} ${ids.size === 1 ? vocab.record : vocab.records} declare its concepts, across ${zones.size} ${vocab.zone}${zones.size === 1 ? '' : 's'}.` : 'No record declares its concepts yet. That is an honest unknown, not an empty answer.' }),
      h('p', { class: 'q-note', text: `Concepts: ${q.concepts.map(cid => plan.concepts.find(c => c.id === cid)?.title).join(', ') || 'none named'}. Lit records carry the concept tag themselves.` }),
      ids.size && q.concepts[0] ? h('button', { class: 'secondary small', type: 'button', onclick: () => openWorkbench({ kind: 'concept', id: q.concepts[0] }) }, `Refine “${plan.concepts.find(c => c.id === q.concepts[0]).title}”`) : null)
  }

  // ── Selection and rooms ──
  function select(id) {
    state.selected = id
    constellation?.select(id)
    renderCard()
    if (id) announce(`Selected ${model.nodes.find(n => n.id === id)?.title}.`)
  }
  function renderCard() {
    clear(el.card)
    const n = state.selected && model.nodes.find(x => x.id === state.selected)
    el.card.hidden = !n
    if (!n) return
    const color = palette.zones[(model.zones.find(z => z.id === n.zone)?.index ?? 0) % palette.zones.length]
    const near = []
    const seen = new Set()
    for (const e of model.edges) { const other = e.source === n.id ? e.target : e.target === n.id ? e.source : null; if (other && !seen.has(other)) { seen.add(other); near.push({ id: other, relation: e.kind === 'relation' }) } }
    near.sort((a, b) => Number(b.relation) - Number(a.relation))
    el.card.append(
      h('button', { class: 'card-close', type: 'button', 'aria-label': 'Clear selection', onclick: () => select(null) }, '×'),
      h('p', { class: 'eyebrow' }, h('i', { class: 'dot', style: `background:${color}` }), `${n.zoneLabel} · ${n.type}`),
      h('h2', { id: 'card-title', text: n.title }),
      n.summary ? h('p', { class: 'card-summary', text: n.summary }) : null,
      h('p', { class: 'card-meta', text: `${n.degree} links · ${n.relationDegree} declared${n.concepts.length ? ' · declares ' + n.concepts.join(', ') : ''}` }),
      h('div', { class: 'card-actions' },
        h('button', { class: 'primary', type: 'button', 'data-gw': 'open-selected', onclick: () => openWorkbench({ kind: 'record', id: n.id }) }, 'Open in the workbench'),
        constellation ? h('button', { class: 'quiet', type: 'button', onclick: () => constellation.showNode(n.id) }, 'Show on map') : null),
      near.length ? h('details', { class: 'card-neighbours' }, h('summary', { text: `Walk to a neighbour (${near.length})` }),
        h('ul', {}, near.slice(0, 12).map(x => h('li', {}, h('button', { class: 'link-row', type: 'button', onclick: () => { select(x.id); root.querySelector('#card-title')?.focus() } }, model.nodes.find(m => m.id === x.id).title))))) : null)
  }
  async function openWorkbench(subject) {
    closeMenus()
    let from = null
    if (state.room === 'constellation' && constellation) {
      state.savedCamera = constellation.camera.getState()
      if (subject.kind === 'record') {
        const p = constellation.nodeViewport(subject.id), r = el.constellation.getBoundingClientRect()
        from = p ? { x: r.left + p.x, y: r.top + p.y } : null
        root.classList.add('diving')
        await constellation.dive(subject.id)
      }
    }
    counters.dives++
    state.room = 'workbench'
    root.dataset.room = 'workbench'
    root.classList.remove('diving')
    el.review.hidden = true
    workbench.open(subject, { from })
  }
  async function backToConstellation() {
    workbench.close()
    el.review.hidden = true
    state.room = 'constellation'
    root.dataset.room = 'constellation'
    if (constellation && state.savedCamera) await constellation.restore(state.savedCamera)
    constellation?.refresh()
  }
  function openReview() {
    state.room = 'review'
    root.dataset.room = 'review'
    const back = () => { el.review.hidden = true; state.room = 'workbench'; root.dataset.room = 'workbench' }
    renderReview(el.review, { model: { ...model, systemId: profile.id ?? 'workspace' }, store, onBack: () => { back(); workbench.refresh() }, onOpen: s => { back(); workbench.open(s) } })
  }

  // ── Command bar ──
  function commandResults(query) {
    const q = query.trim().toLowerCase()
    const commands = [
      ...recipes.map(r => ({ kind: 'recipe', id: r.id, label: r.label, hint: r.description })),
      ...(webgl ? [{ kind: 'command', id: 'text', label: state.textView ? 'Show the constellation' : 'Text view', hint: 'Every record as a structured list' }] : []),
      { kind: 'command', id: 'scheme', label: state.scheme === 'dark' ? 'Light appearance' : 'Dark appearance', hint: 'Switch appearance' },
      ...(constellation ? [{ kind: 'command', id: 'fit', label: 'Fit the whole graph', hint: 'Zoom out to everything' }] : []),
    ]
    if (!q) return commands.slice(0, 6)
    const out = commands.filter(c => c.label.toLowerCase().includes(q))
    for (const c of model.plan?.concepts ?? []) if (c.title.toLowerCase().includes(q)) out.push({ kind: 'concept', id: c.id, label: c.title, hint: 'Concept · refine in the workbench' })
    for (const x of model.plan?.questions ?? []) if (x.question.toLowerCase().includes(q)) out.push({ kind: 'question', id: x.id, label: x.question, hint: 'Question · light its evidence' })
    const scored = []
    for (const n of model.nodes) { const t = n.title.toLowerCase(), at = t.indexOf(q); if (at >= 0) scored.push({ n, score: (at === 0 ? 0 : t[at - 1] === ' ' ? 1 : 2) * 1e6 - n.degree }) }
    scored.sort((a, b) => a.score - b.score)
    for (const { n } of scored.slice(0, 8)) out.push({ kind: 'record', id: n.id, label: n.title, hint: n.zoneLabel })
    return out.slice(0, 10)
  }
  function renderCommand() {
    clear(el.results)
    const results = commandResults(el.command.value)
    el.results.hidden = !results.length
    results.forEach((r, i) => el.results.append(h('li', { role: 'option', 'aria-selected': String(i === 0) }, h('button', { type: 'button', class: 'cmd', dataset: { kind: r.kind, id: r.id }, onclick: () => runCommand(r) },
      h('span', { class: 'cmd-label', text: r.label }), h('span', { class: 'cmd-hint', text: r.hint })))))
  }
  function runCommand(r) {
    el.command.value = ''
    el.results.hidden = true
    if (r.kind === 'recipe') setRecipe(r.id)
    else if (r.kind === 'concept') openWorkbench({ kind: 'concept', id: r.id })
    else if (r.kind === 'question') { state.questionId = r.id; const q = recipes.find(x => x.lens === 'question'); if (q) setRecipe(q.id) }
    else if (r.kind === 'record') { if (state.room !== 'constellation') backToConstellation().then(() => select(r.id)); else select(r.id); root.querySelector('#card-title')?.focus() }
    else if (r.id === 'text') toggleText()
    else if (r.id === 'scheme') toggleScheme()
    else if (r.id === 'fit') constellation?.fit()
  }

  // ── Text view ──
  function renderTextView() {
    clear(el.textView)
    const filter = h('input', { type: 'search', 'data-gw': 'text-filter', placeholder: `Filter ${fmt(model.nodes.length)} ${vocab.records}…`, 'aria-label': `Filter ${vocab.records}` })
    const lists = h('div', { class: 'tv-lists' })
    const draw = () => {
      clear(lists)
      const q = filter.value.trim().toLowerCase()
      if (model.plan?.concepts.length) {
        lists.append(h('h3', { text: vocab.model }), h('ul', { class: 'tv-list' }, model.plan.concepts.filter(c => !q || c.title.toLowerCase().includes(q)).map(c => h('li', {}, h('button', { type: 'button', class: 'tv-item', onclick: () => openWorkbench({ kind: 'concept', id: c.id }) }, h('i', { class: 'dot-concept' }), c.title, h('small', { text: `${c.declaredBy.length} declaring` }))))))
      }
      for (const z of model.zones) {
        const members = model.nodes.filter(n => n.zone === z.id && (!q || n.title.toLowerCase().includes(q)))
        if (!members.length) continue
        const d = h('details', { class: 'tv-zone', open: !!q || members.length <= 40 || z.index === 0 })
        d.append(h('summary', {}, h('i', { class: 'dot', style: `background:${palette.zones[z.index % palette.zones.length]}` }), `${z.label} · ${fmt(members.length)}`))
        d.append(h('ul', { class: 'tv-list' }, members.map(n => h('li', {}, h('button', { type: 'button', class: 'tv-item', dataset: { id: n.id }, onclick: () => select(n.id) }, n.title, h('small', { text: `${n.type} · ${n.degree} links` }))))))
        lists.append(d)
      }
    }
    filter.addEventListener('input', draw)
    el.textView.append(h('h2', { class: 'tv-title', text: 'Text view' }), filter, lists)
    draw()
  }
  function toggleText() {
    if (!webgl) return
    state.textView = !state.textView
    root.classList.toggle('text-mode', state.textView)
    el.textToggle.setAttribute('aria-pressed', String(state.textView))
    if (state.textView) el.textView.querySelector('input')?.focus(); else constellation?.refresh()
  }
  function toggleScheme() { state.scheme = state.scheme === 'dark' ? 'light' : 'dark'; applyAppearance(); renderTextView(); renderCard(); if (state.room === 'workbench') workbench.refresh() }

  // ── Menus and keys ──
  function closeMenus() { el.recipeMenu.hidden = true; el.display.hidden = true; el.recipeBtn.setAttribute('aria-expanded', 'false'); el.displayBtn.setAttribute('aria-expanded', 'false') }
  function toggle(menu, button) { const open = menu.hidden; closeMenus(); menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button, input')?.focus() }
  function renderRecipeMenu() {
    clear(el.recipeMenu)
    for (const r of recipes) el.recipeMenu.append(h('button', { type: 'button', class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(state.recipe === r.id), dataset: { recipe: r.id }, onclick: () => setRecipe(r.id) }, h('span', { text: r.label }), h('small', { text: r.description })))
  }
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)) }
  const cleanups = []
  on(el.recipeBtn, 'click', () => { renderRecipeMenu(); toggle(el.recipeMenu, el.recipeBtn) })
  on(el.displayBtn, 'click', () => toggle(el.display, el.displayBtn))
  on(el.textToggle, 'click', toggleText)
  on(el.schemeBtn, 'click', toggleScheme)
  on(el.zonesToggle, 'change', e => { state.zonesOn = e.target.checked; constellation?.setOption('zonesOn', state.zonesOn) })
  on(el.linksToggle, 'change', e => { state.linksOn = e.target.checked; constellation?.setOption('linksOn', state.linksOn) })
  on(el.labelsRange, 'input', e => { state.labelBoost = +e.target.value; constellation?.setOption('labelBoost', state.labelBoost) })
  on(el.physicsToggle, 'change', e => { e.target.checked = !!constellation?.setPhysics(e.target.checked) })
  on(el.fit, 'click', () => constellation?.fit())
  on(el.zoomIn, 'click', () => constellation?.zoom(1.5))
  on(el.zoomOut, 'click', () => constellation?.zoom(1 / 1.5))
  on(el.command, 'focus', renderCommand)
  on(el.command, 'input', renderCommand)
  on(el.command, 'keydown', e => {
    const buttons = [...el.results.querySelectorAll('button')]
    if (e.key === 'Enter') { e.preventDefault(); buttons[0]?.click() }
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[0]?.focus() }
    if (e.key === 'Escape') { el.command.value = ''; el.results.hidden = true; el.command.blur() }
  })
  on(el.results, 'keydown', e => {
    const buttons = [...el.results.querySelectorAll('button')], i = buttons.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[Math.min(buttons.length - 1, i + 1)]?.focus() }
    if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? el.command : buttons[i - 1]).focus() }
    if (e.key === 'Escape') { el.results.hidden = true; el.command.focus() }
  })
  on(root.ownerDocument, 'click', e => { if (!el.commandWrap.contains(e.target)) el.results.hidden = true; if (!e.target.closest('.atelier-gw .menu-wrap')) closeMenus() })
  on(root.ownerDocument, 'keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); el.command.focus(); return }
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '/') { e.preventDefault(); el.command.focus() }
    else if (e.key === 'Escape') { if (!el.recipeMenu.hidden || !el.display.hidden) closeMenus(); else if (state.room === 'review') root.querySelector('#review-back')?.click(); else if (state.room === 'workbench') backToConstellation(); else select(null) }
    else if (e.key === 't') { e.preventDefault(); toggleText() }
    else if (e.key === 'o' && state.selected && state.room === 'constellation') openWorkbench({ kind: 'record', id: state.selected })
  })

  renderTextView()
  setRecipe(byRecipe.has(initialRecipe) ? initialRecipe : recipes[0]?.id)

  return {
    get state() { return { ...state, savedCamera: undefined, counters: { ...counters }, webgl, records: model.nodes.length, links: model.edges.length, workbench: workbench.subject, camera: constellation ? constellation.camera.getState() : null, draftStatus: store.status } },
    recipes, store, constellation, workbench,
    select, openWorkbench, setRecipe, backToConstellation, toggleText,
    setScheme(scheme) { state.scheme = scheme; applyAppearance() },
    readiness: () => readiness(model.plan, store, new Set(model.nodes.map(n => n.id))).status,
    destroy() { for (const fn of cleanups.splice(0)) fn(); constellation?.kill(); clear(root); root.classList.remove('atelier-gw') },
  }
}
