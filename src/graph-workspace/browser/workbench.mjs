// The workbench: a sparse graph of rich cards beside a focused authoring sheet.
// One subject at a time (record, concept or plan relation). The sheet follows the
// focused authoring register: quiet header, step rail with counts, one step in view,
// one primary action, deferral, and an honest "saved in this browser" status.
import { h, clear } from './dom.mjs'
import { conceptSteps, relationSteps, guideConcept, guideRelation, stepState } from '../authoring.mjs'

const VERB = { depends_on: 'depends on', supports: 'supports', contradicts: 'challenges', evidences: 'is evidence about', related: 'links to', supersedes: 'replaces', belongs_to: 'belongs to', implements: 'puts into practice', declares: 'declares' }
const verb = p => Object.hasOwn(VERB, p) ? VERB[p] : p.replaceAll('_', ' ')
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function createWorkbench({ root, model, palette, store, vocab, onBack, onReview, onShowOnMap }) {
  const byId = new Map(model.nodes.map(n => [n.id, n]))
  const zoneIndex = new Map(model.zones.map(z => [z.id, z.index]))
  const zoneColor = id => palette.zones[(zoneIndex.get(id) ?? 0) % palette.zones.length]
  const plan = model.plan ?? { concepts: [], relations: [], questions: [] }
  const conceptById = new Map(plan.concepts.map(c => [c.id, c]))
  const visible = new Set(model.nodes.map(n => n.id))
  let subject = null
  let trail = []
  let step = 0
  let lastLayout = null
  let unsubscribe = null
  const adjacency = new Map()
  for (const e of model.edges) {
    for (const [k, other, dir] of [[e.source, e.target, 'out'], [e.target, e.source, 'in']]) {
      if (!adjacency.has(k)) adjacency.set(k, [])
      adjacency.get(k).push({ edge: e, other, dir })
    }
  }

  const head = h('header', { class: 'wb-head' })
  const graphHost = h('div', { class: 'wb-graph', role: 'group', 'aria-label': 'Subject and its closest connections' })
  const edgeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  edgeSvg.setAttribute('class', 'wb-edges'); edgeSvg.setAttribute('aria-hidden', 'true')
  const cardLayer = h('div', { class: 'wb-cards' })
  graphHost.append(edgeSvg, cardLayer)
  const sheet = h('aside', { class: 'wb-sheet', 'aria-labelledby': 'wb-title' })
  root.replaceChildren(head, h('div', { class: 'wb-body' }, graphHost, sheet))
  new ResizeObserver(() => { if (subject && !root.hidden) layoutGraph(false) }).observe(graphHost)

  // ── Subject neighbourhoods ──
  function neighboursOf(s) {
    if (s.kind === 'record') {
      const list = (adjacency.get(s.id) ?? []).map(a => ({ kind: 'record', id: a.other, predicate: a.edge.type, dir: a.dir, structural: (a.edge.kind === 'relation') }))
      const unique = []
      const seen = new Set()
      list.sort((a, b) => Number(b.structural) - Number(a.structural) || (byId.get(b.id).degree - byId.get(a.id).degree))
      for (const n of list) if (!seen.has(n.id)) { seen.add(n.id); unique.push(n) }
      const node = byId.get(s.id)
      const concepts = node.concepts.filter(id => conceptById.has(id)).map(id => ({ kind: 'concept', id, predicate: 'declares', dir: 'out', structural: true }))
      return { shown: [...concepts, ...unique].slice(0, 10), total: unique.length + concepts.length }
    }
    if (s.kind === 'concept') {
      const rel = plan.relations.filter(r => r.from === s.id || r.to === s.id).map(r => ({ kind: 'concept', id: r.from === s.id ? r.to : r.from, predicate: r.predicate, dir: r.from === s.id ? 'out' : 'in', structural: true, relation: r.id }))
      const declared = (conceptById.get(s.id)?.declaredBy ?? []).filter(id => byId.has(id)).map(id => ({ kind: 'record', id, predicate: 'declares', dir: 'in', structural: true }))
      return { shown: [...rel, ...declared].slice(0, 10), total: rel.length + declared.length }
    }
    const r = plan.relations.find(x => x.id === s.id)
    return { shown: r ? [{ kind: 'concept', id: r.to, predicate: r.predicate, dir: 'out', structural: true, relation: r.id }] : [], total: 1, relation: r }
  }

  function card(item, role) {
    const isConcept = item.kind === 'concept'
    const n = isConcept ? null : byId.get(item.id)
    const c = isConcept ? conceptById.get(item.id) : null
    const cited = !isConcept && Object.values(store.data.concepts).some(d => d.evidence.some(b => b.id === item.id))
    const draft = isConcept ? store.conceptDraft(item.id) : undefined
    const proposed = isConcept && draft && (draft.definition !== c.definition || draft.identityRule !== c.identityRule)
    const el = h('button', { class: `wb-card wb-${role} ${isConcept ? 'is-concept' : 'is-record'}`, type: 'button', dataset: { kind: item.kind, id: item.id },
      'aria-label': isConcept ? `${c.title}, concept` : `${n.title}, ${vocab.record} in ${n.zoneLabel}` },
      h('span', { class: 'wb-kind' }, h('i', { class: isConcept ? 'dot-concept' : 'dot', style: isConcept ? '' : `background:${zoneColor(n.zone)}` }), isConcept ? 'Concept' : n.zoneLabel),
      h('span', { class: 'wb-title', text: isConcept ? c.title : n.title }),
      h('span', { class: 'wb-summary', text: isConcept ? (draft?.definition || c.definition || '') : n.summary }),
      h('span', { class: 'wb-meta' }, isConcept ? `${c.declaredBy.length} declaring ${c.declaredBy.length === 1 ? vocab.record : vocab.records}` : `${n.type}${n.status ? ' · ' + n.status : ''} · ${n.degree} links`,
        cited ? h('b', { class: 'tag tag-cited', text: 'Cited' }) : null, proposed ? h('b', { class: 'tag tag-proposed', text: 'Proposed' }) : null))
    if (role === 'neighbour') el.addEventListener('click', () => walk({ kind: item.kind, id: item.id }, el))
    return el
  }

  function layoutGraph(animate) {
    const w = graphHost.clientWidth, hgt = graphHost.clientHeight
    const { shown, total, relation } = neighboursOf(subject)
    // A relayout (resize, citation) rebuilds the cards; keep keyboard focus where it was.
    const active = cardLayer.contains(document.activeElement) ? document.activeElement : null
    const refocus = active && { kind: active.dataset.kind, id: active.dataset.id, role: active.classList.contains('wb-center') ? 'center' : 'neighbour' }
    clear(cardLayer)
    while (edgeSvg.firstChild) edgeSvg.firstChild.remove()
    const center = card({ kind: subject.kind === 'relation' ? 'concept' : subject.kind, id: subject.kind === 'relation' ? relation.from : subject.id }, 'center')
    cardLayer.append(center)
    const cards = shown.map(item => ({ item, el: card(item, 'neighbour') }))
    for (const c of cards) cardLayer.append(c.el)
    const narrow = w < 760
    graphHost.classList.toggle('is-list', narrow)
    const positions = []
    const cw = center.offsetWidth, ch = center.offsetHeight
    const cx = narrow ? w / 2 : w / 2, cy = narrow ? ch / 2 + 12 : hgt / 2
    place(center, cx - cw / 2, cy - ch / 2)
    const rects = new Map([['center', { x: cx - cw / 2, y: cy - ch / 2, w: cw, h: ch }]])
    if (narrow) {
      let y = cy + ch / 2 + 22
      for (const c of cards) { const cw2 = Math.min(w - 24, 340); c.el.style.width = cw2 + 'px'; place(c.el, (w - cw2) / 2, y); rects.set(c.item.id, { x: (w - cw2) / 2, y, w: cw2, h: c.el.offsetHeight }); y += c.el.offsetHeight + 10 }
      graphHost.style.minHeight = y + 'px'
    } else {
      graphHost.style.minHeight = ''
      // Incoming connections on the left, outgoing on the right: the page reads as a flow.
      const columns = { in: cards.filter(c => c.item.dir === 'in'), out: cards.filter(c => c.item.dir !== 'in') }
      const gap = 12, room = hgt - 64
      for (const [side, list] of Object.entries(columns)) {
        let used = 0
        const fits = []
        for (const c of list) { const eh = c.el.offsetHeight; if (used + eh > room) { c.el.remove(); continue } fits.push(c); used += eh + gap }
        columns[side] = fits
        let y = Math.max(18, cy - (used - gap) / 2)
        for (const c of fits) {
          const ew = c.el.offsetWidth, eh = c.el.offsetHeight
          const lane = Math.max(84, Math.min(150, (w - cw - 2 * ew - 28) / 2))
          const x = side === 'in' ? Math.max(14, cx - cw / 2 - lane - ew) : Math.min(w - ew - 14, cx + cw / 2 + lane)
          place(c.el, x, y)
          rects.set(c.item.id, { x, y, w: ew, h: eh })
          y += eh + gap
        }
      }
      cards.splice(0, cards.length, ...columns.in, ...columns.out)
      const a = rects.get('center')
      for (const c of cards) {
        const b = rects.get(c.item.id)
        const from = c.item.dir === 'out' ? a : b, to = c.item.dir === 'out' ? b : a
        drawEdge(from, to, c.item, c.item.relation)
      }
    }
    if (total > rects.size - 1) cardLayer.append(h('p', { class: 'wb-more', text: `${total - (rects.size - 1)} more connections are listed in the sheet and in Text view.` }))
    lastLayout = { cards: [...rects.entries()].map(([id, r]) => ({ id, ...r })), shown: rects.size - 1, total, narrow }
    if (refocus) [...cardLayer.querySelectorAll(`.wb-${refocus.role}`)].find(x => x.dataset.kind === refocus.kind && x.dataset.id === refocus.id)?.focus({ preventScroll: true })
    if (animate && subject.from && !reduced()) {
      const r = rects.get('center')
      const dx = subject.from.x - (r.x + r.w / 2) - graphHost.getBoundingClientRect().left, dy = subject.from.y - (r.y + r.h / 2) - graphHost.getBoundingClientRect().top
      center.animate([{ transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(0.2,0,0,1)' })
      for (const c of cards) c.el.animate([{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: 140, easing: 'ease-out', fill: 'backwards' })
    }
  }
  function place(el, x, y) { el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)` }

  function drawEdge(a, b, item, relationId) {
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    const clip = (r, from, to) => {
      const dx = to.x - from.x, dy = to.y - from.y
      const tx = dx ? (r.w / 2 + 6) / Math.abs(dx) : Infinity, ty = dy ? (r.h / 2 + 6) / Math.abs(dy) : Infinity
      const t = Math.min(tx, ty)
      return { x: from.x + dx * t, y: from.y + dy * t }
    }
    const start = clip(a, ac, bc), end = clip(b, bc, ac)
    const ns = 'http://www.w3.org/2000/svg'
    const g = document.createElementNS(ns, 'g')
    g.setAttribute('class', `wb-edge ${item.structural ? 'is-declared' : 'is-link'} ${item.predicate === 'contradicts' ? 'is-challenge' : ''} ${item.predicate === 'declares' ? 'is-declares' : ''}`)
    const line = document.createElementNS(ns, 'line')
    for (const [k, v] of Object.entries({ x1: start.x, y1: start.y, x2: end.x, y2: end.y })) line.setAttribute(k, v.toFixed(1))
    const angle = Math.atan2(end.y - start.y, end.x - start.x)
    const head = document.createElementNS(ns, 'path')
    const s = 8
    head.setAttribute('d', `M${end.x},${end.y} L${end.x - Math.cos(angle - 0.42) * s},${end.y - Math.sin(angle - 0.42) * s} L${end.x - Math.cos(angle + 0.42) * s},${end.y - Math.sin(angle + 0.42) * s}Z`)
    g.append(line, head)
    edgeSvg.append(g)
    if (item.structural) {
      const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      const pill = h('button', { class: 'wb-pill', type: 'button', style: `transform:translate(${Math.round(mid.x)}px, ${Math.round(mid.y)}px) translate(-50%,-50%)` }, verb(item.predicate), h('span', { 'aria-hidden': 'true', class: 'wb-pill-arrow', style: `transform:rotate(${angle}rad)`, text: '→' }))
      pill.setAttribute('aria-label', `${verb(item.predicate)}, direction from ${item.dir === 'out' ? 'this subject' : 'the other card'}`)
      if (relationId) pill.addEventListener('click', () => walk({ kind: 'relation', id: relationId }))
      else pill.tabIndex = -1
      cardLayer.append(pill)
    }
  }

  // ── Sheet ──
  function renderSheet() {
    clear(sheet)
    if (subject.kind === 'record') return recordSheet()
    const isConcept = subject.kind === 'concept'
    const item = isConcept ? conceptById.get(subject.id) : plan.relations.find(r => r.id === subject.id)
    const titleOf = id => conceptById.get(id)?.title ?? id
    const steps = isConcept ? conceptSteps(item) : relationSteps(item, titleOf)
    const d = isConcept ? store.concept(item) : store.relation(item)
    const guide = isConcept ? guideConcept(item, d, visible) : guideRelation(d, visible)
    const originals = isConcept ? { definition: item.definition, identityRule: item.identityRule } : { meaning: item.meaning }
    const states = steps.map(s => stepState(d[s.id], guide.fields[s.id], store.deferred(subject.kind, subject.id, s.id), originals[s.id]))
    const countText = list => `${list.filter(x => x === 'answered').length} of ${steps.length} drafted · ${list.filter(x => x === 'plan').length} use the plan wording · ${list.filter(x => x === 'deferred').length} deferred`
    step = Math.min(step, steps.length - 1)
    sheet.append(h('p', { class: 'eyebrow', text: isConcept ? `${vocab.concept} · in your plan` : 'Relation · in your plan' }),
      h('h2', { id: 'wb-title', tabindex: '-1', text: isConcept ? item.title : `${titleOf(item.from)} ${verb(item.predicate)} ${titleOf(item.to)}` }),
      h('p', { class: 'sheet-count', id: 'step-count', text: countText(states) }))
    const rail = h('ol', { class: 'step-rail', 'aria-label': 'Steps' })
    steps.forEach((s, i) => rail.append(h('li', {}, h('button', { class: `step step-${states[i]}`, type: 'button', 'aria-current': i === step ? 'step' : null, dataset: { step: s.id },
      onclick: () => { step = i; renderSheet(); sheet.querySelector('.step-body textarea, .step-body input, .step-body button')?.focus() } },
      h('span', { class: 'step-n', text: states[i] === 'answered' ? '✓' : states[i] === 'plan' ? '•' : String(i + 1) }), h('span', { text: s.label })))))
    sheet.append(rail)
    const s = steps[step]
    const body = h('section', { class: 'step-body', 'aria-labelledby': 'step-prompt' })
    body.append(h('h3', { id: 'step-prompt', text: s.prompt }), h('p', { class: 'step-help', text: s.help }))
    const original = isConcept ? { definition: item.definition, identityRule: item.identityRule }[s.id] : s.id === 'meaning' ? item.meaning : undefined
    if (s.kind === 'evidence') body.append(evidenceStep(item, d))
    else {
      const ta = h('textarea', { id: 'step-input', rows: 5, 'aria-describedby': 'step-guide', oninput: e => { d[s.id] = e.target.value; store.changed(); updateGuide() } }, d[s.id])
      body.append(ta)
      if (original !== undefined && original !== d[s.id]) body.append(h('details', { class: 'plan-wording' }, h('summary', { text: 'Current plan wording' }), h('p', { text: original })))
    }
    const guideList = h('ul', { class: 'guide', id: 'step-guide', 'aria-live': 'polite' })
    const updateGuide = () => {
      const g = isConcept ? guideConcept(item, d, visible) : guideRelation(d, visible)
      clear(guideList)
      for (const m of g.fields[s.id] ?? []) guideList.append(h('li', { class: 'guide-' + m.tone, text: m.text }))
      const now = steps.map(x => stepState(d[x.id], g.fields[x.id], store.deferred(subject.kind, subject.id, x.id), originals[x.id]))
      sheet.querySelector('#step-count').textContent = countText(now)
      const button = rail.querySelectorAll('.step')[step]
      const st = now[step]
      button.className = `step step-${st}`
      button.querySelector('.step-n').textContent = st === 'answered' ? '✓' : st === 'plan' ? '•' : String(step + 1)
      layoutCardsText()
    }
    body.append(guideList)
    body.append(h('label', { class: 'defer' }, h('input', { type: 'checkbox', checked: store.deferred(subject.kind, subject.id, s.id), onchange: e => { store.defer(subject.kind, subject.id, s.id, e.target.checked); renderSheet() } }), ' Defer this step'))
    sheet.append(body)
    updateGuide()
    const last = step === steps.length - 1
    sheet.append(h('div', { class: 'sheet-actions' },
      h('button', { class: 'quiet', type: 'button', disabled: step === 0, onclick: () => { step--; renderSheet(); focusStep() } }, 'Back'),
      last ? h('button', { class: 'primary', type: 'button', id: 'review-proposal', onclick: () => onReview() }, 'Review the proposal')
        : h('button', { class: 'primary', type: 'button', id: 'next-step', onclick: () => { step++; renderSheet(); focusStep() } }, 'Next')))
    sheet.append(h('p', { class: 'sheet-note', text: 'Guidance here is a simulation; Atelier’s ontology guide runs on the host. Completeness is not a verdict on truth.' }))
  }
  function focusStep() { sheet.querySelector('#step-input, .step-body .cite')?.focus() }
  function layoutCardsText() {
    const c = cardLayer.querySelector('.wb-center.is-concept .wb-summary')
    if (c && subject.kind === 'concept') c.textContent = store.conceptDraft(subject.id)?.definition ?? ''
  }

  function evidenceStep(item, d) {
    const isConcept = !Object.hasOwn(item, 'predicate')
    const wrap = h('div', { class: 'evidence' })
    const cited = h('ul', { class: 'cited' })
    for (const b of d.evidence) cited.append(h('li', {}, h('span', { text: visible.has(b.id) ? byId.get(b.id).title : 'A record outside what you can read' }),
      h('button', { class: 'link', type: 'button', onclick: () => { d.evidence = d.evidence.filter(x => x.id !== b.id); store.changed(); renderSheet() } }, 'Remove')))
    wrap.append(h('p', { class: 'label', text: d.evidence.length ? 'Cited' : 'Nothing cited yet' }), cited)
    const cite = id => { if (!byId.has(id)) return; if (!d.evidence.some(b => b.id === id)) { d.evidence.push({ id, title: byId.get(id).title, citedAt: new Date().toISOString() }); store.changed(); renderSheet(); layoutGraph(false) } }
    const suggest = (title, ids, note) => {
      const list = ids.filter(id => byId.has(id) && !d.evidence.some(b => b.id === id)).slice(0, 6)
      if (!list.length) return
      wrap.append(h('p', { class: 'label', text: title }), note ? h('p', { class: 'step-help', text: note }) : null)
      const ul = h('ul', { class: 'suggest' })
      for (const id of list) ul.append(h('li', {}, h('span', { class: 'dot', style: `background:${zoneColor(byId.get(id).zone)}` }), h('span', { class: 'suggest-title', text: byId.get(id).title }), h('button', { class: 'cite secondary small', type: 'button', onclick: () => cite(id) }, 'Cite')))
      wrap.append(ul)
    }
    const Records = vocab.records[0].toUpperCase() + vocab.records.slice(1)
    if (isConcept) {
      suggest(`${Records} that declare this concept`, item.declaredBy, 'The record itself carries this concept’s tag.')
      const term = item.title.toLowerCase()
      const matches = model.nodes.filter(n => !item.declaredBy.includes(n.id) && (n.title + ' ' + n.summary).toLowerCase().includes(term)).map(n => n.id)
      suggest('Text matches', matches, 'These mention the word. That alone does not make them members.')
    } else {
      const ends = [item.from, item.to].map(id => new Set(conceptById.get(id)?.declaredBy ?? []))
      suggest(`${Records} that declare both concepts`, [...ends[0]].filter(id => ends[1].has(id)), 'Each carries both concept tags.')
      suggest(`${Records} that declare either concept`, [...new Set([...ends[0], ...ends[1]])].filter(id => !(ends[0].has(id) && ends[1].has(id))), 'One end only. That alone does not show the relation.')
    }
    const find = h('input', { type: 'search', class: 'find', placeholder: `Find any ${vocab.record}…`, 'aria-label': `Find a ${vocab.record} to cite` })
    const results = h('ul', { class: 'suggest' })
    find.addEventListener('input', () => {
      clear(results)
      const q = find.value.trim().toLowerCase()
      if (q.length < 2) return
      for (const n of model.nodes.filter(n => n.title.toLowerCase().includes(q)).slice(0, 6)) results.append(h('li', {}, h('span', { class: 'dot', style: `background:${zoneColor(n.zone)}` }), h('span', { class: 'suggest-title', text: n.title }), h('button', { class: 'cite secondary small', type: 'button', onclick: () => cite(n.id) }, 'Cite')))
    })
    wrap.append(find, results)
    return wrap
  }

  function recordSheet() {
    const n = byId.get(subject.id)
    const links = adjacency.get(n.id) ?? []
    sheet.append(h('p', { class: 'eyebrow' }, h('i', { class: 'dot', style: `background:${zoneColor(n.zone)}` }), n.zoneLabel),
      h('h2', { id: 'wb-title', tabindex: '-1', text: n.title }),
      h('p', { class: 'lede', text: n.summary }))
    const facts = h('dl', { class: 'facts' })
    for (const [k, v] of [['Kind', n.type], ['Status', n.status], ['Location', n.path], ['Links', `${n.degree} (${n.relationDegree} declared relations)`], ['Declares', n.concepts.length ? n.concepts.map(id => conceptById.get(id)?.title ?? id).join(', ') : 'No concept tags']]) if (v) facts.append(h('dt', { text: k }), h('dd', { text: v }))
    sheet.append(facts)
    if (plan.concepts.length) {
      const select = h('select', { 'aria-label': 'Concept draft to cite into' }, plan.concepts.map(c => h('option', { value: c.id, text: c.title })))
      sheet.append(h('div', { class: 'sheet-actions left' }, select, h('button', { class: 'secondary', type: 'button', id: 'cite-record', onclick: () => {
        const c = conceptById.get(select.value), d = store.concept(c)
        if (!d.evidence.some(b => b.id === n.id)) { d.evidence.push({ id: n.id, title: n.title, citedAt: new Date().toISOString() }); store.changed() }
        walk({ kind: 'concept', id: c.id }); step = conceptSteps(c).findIndex(s => s.kind === 'evidence'); renderSheet()
      } }, 'Cite in this concept’s draft')))
    }
    const list = h('ul', { class: 'link-list' })
    for (const a of links.sort((x, y) => Number((y.edge.kind === 'relation')) - Number((x.edge.kind === 'relation'))).slice(0, 40)) {
      const other = byId.get(a.other)
      list.append(h('li', {}, h('button', { class: 'link-row', type: 'button', onclick: () => walk({ kind: 'record', id: other.id }) },
        h('span', { class: 'dir', 'aria-hidden': 'true', text: a.dir === 'out' ? '→' : '←' }),
        h('span', { text: a.dir === 'out' ? `${verb(a.edge.type)} ${other.title}` : `${other.title} ${verb(a.edge.type)} this` }))))
    }
    sheet.append(h('h3', { class: 'sheet-h', text: `Connections · ${links.length}` }), list)
    if (links.length > 40) sheet.append(h('p', { class: 'step-help', text: `${links.length - 40} more in Text view.` }))
    sheet.append(h('div', { class: 'sheet-actions left' }, h('button', { class: 'quiet', type: 'button', onclick: () => onShowOnMap(n.id) }, 'Show on the map')))
  }

  function renderHead() {
    clear(head)
    head.append(h('button', { class: 'back', type: 'button', id: 'wb-back', onclick: onBack }, '← Map'))
    const crumbs = h('nav', { class: 'trail', 'aria-label': 'Walked so far' })
    trail.forEach((t, i) => {
      if (i) crumbs.append(h('span', { class: 'sep', 'aria-hidden': 'true', text: '›' }))
      const label = t.kind === 'record' ? byId.get(t.id).title : t.kind === 'concept' ? conceptById.get(t.id).title : 'Relation'
      crumbs.append(i === trail.length - 1 ? h('span', { class: 'crumb current', 'aria-current': 'page', text: label }) : h('button', { class: 'crumb', type: 'button', onclick: () => { trail = trail.slice(0, i + 1); subject = { ...t }; step = 0; render(false) } }, label))
    })
    const status = h('span', { class: 'save-status', id: 'save-status', role: 'status' })
    const where = { tab: 'in this tab only', browser: 'in this browser only', host: 'to the workspace host' }[store.persistence] ?? 'in this tab only'
    const paint = st => { status.dataset.state = st; status.textContent = { saving: `Saving ${where}\u2026`, saved: `Saved ${where}`, restored: `Draft restored, saved ${where}`, empty: 'Nothing drafted yet', unavailable: 'Storage unavailable \u2014 the draft lives in this tab' }[st] ?? st }
    paint(store.status)
    unsubscribe?.()
    unsubscribe = store.onStatus(paint)
    head.append(crumbs, status)
  }

  function walk(next, fromEl) {
    const r = fromEl?.getBoundingClientRect()
    subject = { ...next, from: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null }
    trail = [...trail.filter(t => !(t.kind === next.kind && t.id === next.id)), { kind: next.kind, id: next.id }].slice(-6)
    step = 0
    render(true)
  }

  function render(animate) {
    renderHead()
    layoutGraph(animate)
    renderSheet()
  }

  return {
    open(next, { from = null } = {}) {
      root.hidden = false
      subject = { ...next, from }
      trail = [{ kind: next.kind, id: next.id }]
      step = 0
      render(true)
      root.querySelector('#wb-title')?.focus()
    },
    close() { root.hidden = true },
    get subject() { return subject && { kind: subject.kind, id: subject.id } },
    get layout() { return lastLayout },
    goToStep(id) { const steps = subject.kind === 'concept' ? conceptSteps(conceptById.get(subject.id)) : relationSteps(plan.relations.find(r => r.id === subject.id), x => x); step = Math.max(0, steps.findIndex(s => s.id === id)); renderSheet() },
    refresh() { if (subject) render(false) },
  }
}
