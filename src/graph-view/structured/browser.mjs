import { structuredStyles } from './styles.mjs'
import { refKey } from '../refs.mjs'
import { assertGraphViewIntent } from '../intents.mjs'

const sameRef = (a, b) => Boolean(a && b && a.repoId === b.repoId && a.localId === b.localId)
const identity = ref => ({ repoId: ref.repoId, localId: ref.localId })
const refText = ref => `${ref.repoId} / ${ref.localId}`
const locatorText = locator => Object.entries(locator).map(([key, value]) => `${key}: ${typeof value === 'object' ? Object.entries(value).map(([name, number]) => `${name}=${number}`).join(', ') : value}`).join('; ')
const mounts = new WeakSet()
let nextMountId = 1

// A presentation consumer, never an authorization boundary. The host must deliver
// a validated reader-specific slice and remove it immediately on grant loss.
export function mountStructuredGraphView(root, { view = null, selection = null, refreshStatus = null, onIntent, onPage } = {}) {
  if (!root?.ownerDocument || mounts.has(root)) throw new TypeError('structured graph root unavailable')
  if (typeof onIntent !== 'function') throw new TypeError('structured graph requires an intent host')
  mounts.add(root)
  const doc = root.ownerDocument
  const prefix = `agv-${nextMountId++}`
  let current = null, selected = null, currentRefreshStatus = null, query = '', disposed = false, epoch = 0, request = 0
  let ui, roving = null
  const make = (tag, text, attrs = {}) => {
    const element = doc.createElement(tag)
    if (text !== null) element.textContent = text
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value))
    return element
  }
  const append = (parent, ...children) => { parent.append(...children); return parent }
  const paragraph = (parent, text, className) => parent.append(make('p', text, className ? { class: className } : {}))
  const heading = (parent, text) => parent.append(make('h3', text))
  const fields = (parent, values) => {
    const list = make('dl', null)
    for (const [label, value] of values) append(list, make('dt', label), make('dd', value === undefined || value === null ? 'Not supplied' : String(value)))
    parent.append(list)
  }
  const source = (parent, sourceRef, title = 'Exact source') => {
    parent.append(make('h4', title))
    if (!sourceRef) { paragraph(parent, 'Source pin not supplied.'); return }
    fields(parent, [['Repository', sourceRef.repoId], ['Path', sourceRef.path], ['Revision', sourceRef.revision], ['Content digest', sourceRef.digest], ['Locator', sourceRef.locator ? locatorText(sourceRef.locator) : 'Whole source; no narrower locator supplied']])
  }
  const explicit = value => value === undefined || value === null ? 'Not supplied' : typeof value === 'string' ? value : JSON.stringify(value)
  const button = (text, key, intent, pressed) => {
    const control = make('button', text, { type: 'button', 'data-agv-key': key })
    if (typeof pressed === 'boolean') control.setAttribute('aria-pressed', String(pressed))
    control.addEventListener('click', () => emit(intent))
    return control
  }
  const emit = async intent => {
    if (disposed || !current) return
    const digest = current.projectionDigest, revision = epoch, id = ++request
    ui.status.textContent = 'Selection request sent. Awaiting host.'
    try {
      await onIntent(assertGraphViewIntent(current, { ...intent, projectionDigest: digest }))
      if (!disposed && epoch === revision && id === request) ui.status.textContent = 'Request delivered.'
    } catch {
      if (!disposed && epoch === revision && id === request) ui.status.textContent = 'Request failed. Try again.'
    }
  }
  const nodeFor = ref => current.nodes.find(node => sameRef(node.ref, ref))
  const edgeFor = edgeId => current.edges.find(edge => edge.edgeId === edgeId)
  const evidenceFor = id => current.evidence.find(item => item.evidenceId === id)
  const evidencePin = (parent, evidenceId, title) => {
    const item = evidenceFor(evidenceId)
    if (!item) throw new TypeError('evidence pin unavailable')
    source(parent, item.sourceRef, title)
    fields(parent, [['Evidence identity', item.evidenceId], ['Support verification', item.verification]])
    parent.append(button('Inspect evidence', `open:${title}:${evidenceId}`, { type: 'openEvidence', evidenceId }))
  }
  const labelFor = ref => nodeFor(ref)?.title ?? refText(ref)
  const nodeButton = (ref, suffix) => button(labelFor(ref), `ref:${refKey(ref)}:${suffix}`, { type: 'select', ref: identity(ref) }, sameRef(selected?.ref, ref))
  const shell = () => {
    root.replaceChildren()
    const style = make('style', structuredStyles)
    ui = { host: make('div', null, { class: 'agv' }) }
    append(root, style, ui.host)
    append(ui.host, make('h2', 'Knowledge explorer'), make('a', 'Skip to evidence inspector', { class: 'agv-skip', href: `#${prefix}-inspector` }))
    paragraph(ui.host, 'Search records, follow directed relationships, and inspect the exact evidence.')
    ui.status = make('p', '', { class: 'agv-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
    ui.host.append(ui.status)
    ui.content = make('div', null)
    ui.host.append(ui.content)
  }
  const inspect = panel => {
    if (!selected) { paragraph(panel, 'Choose a question, record, relationship, or evidence item.'); return }
    if (selected.questionId) {
      const question = current.questions.find(q => q.questionId === selected.questionId)
      if (!question) return
      panel.append(make('h4', question.title))
      fields(panel, [['Decision', question.decision], ['Coverage', question.coverage], ['Omissions', question.omissionState]])
      for (const gap of question.gaps ?? []) paragraph(panel, explicit(gap), 'agv-note')
      if (question.coverage === 'abstain') paragraph(panel, 'The sources do not establish an answer.', 'agv-note')
      if (question.nodeRefs?.length) { panel.append(make('h4', 'Related records')); for (const ref of question.nodeRefs) panel.append(nodeButton(ref, 'question')) }
      for (const [label, refs] of [['Supporting evidence', question.evidenceRefs], ['Contradicting evidence', question.contradictingRefs]]) {
        panel.append(make('h4', label))
        if (!refs?.length) paragraph(panel, 'None supplied in this view.')
        else for (const evidenceId of refs) panel.append(button(`Inspect ${evidenceFor(evidenceId)?.sourceRef.path ?? 'evidence'}`, `evidence:${evidenceId}`, { type: 'openEvidence', evidenceId }))
      }
    } else if (selected.edgeId) {
      const edge = edgeFor(selected.edgeId)
      if (!edge) return
      panel.append(make('h4', `${labelFor(edge.source)} → ${edge.predicate} → ${labelFor(edge.target)}`))
      fields(panel, [['Relationship identity', edge.edgeId], ['Direction', `${refText(edge.source)} → ${refText(edge.target)}`], ['Predicate', edge.predicate], ['Family', edge.family], ['Acceptance', edge.acceptanceState], ['Assurance', edge.assurance], ['Review receipts', edge.reviewRefs?.join(', ') || 'None supplied in this view'], ['Staleness', edge.staleness ?? (currentRefreshStatus?.stale ? 'Displayed source view is stale; edge currency not supplied' : 'Not supplied; do not assume current')], ['Verification checked at', edge.verification?.checkedAt], ['Record digest', edge.recordDigest], ['Policy digest', edge.policyDigest], ['Qualifications', edge.qualifications?.join('; ') || 'None supplied in this view']])
      evidencePin(panel, edge.sourceRef, 'Relationship origin')
      panel.append(make('h4', 'Support'))
      if (!edge.supportRefs?.length) paragraph(panel, 'No support pins supplied.')
      for (const id of edge.supportRefs ?? []) evidencePin(panel, id, 'Supporting source')
      append(panel, nodeButton(edge.source, 'from'), nodeButton(edge.target, 'to'))
    } else if (selected.evidenceId) {
      const evidence = current.evidence.find(e => e.evidenceId === selected.evidenceId)
      if (!evidence) return
      panel.append(make('h4', evidence.title ?? evidence.evidenceId))
      fields(panel, [['Evidence identity', evidence.evidenceId], ['Verification', explicit(evidence.verification)]])
      source(panel, evidence.sourceRef)
    } else if (selected.ref) {
      const node = nodeFor(selected.ref)
      if (!node) return
      panel.append(make('h4', node.title))
      if (node.summary) paragraph(panel, node.summary)
      fields(panel, [['Record identity', refText(node.ref)], ['Source kind', node.sourceKind], ['Classification', node.classification], ['Lifecycle', node.lifecycle], ['Tags', node.tags?.join(', ') || 'None']])
      source(panel, node.sourceRef)
      const tools = make('div', null, { class: 'agv-tools' })
      for (const [direction, label] of current.capabilities?.queries.includes('neighborhood') ? [['out', 'outgoing'], ['in', 'incoming'], ['both', 'both directions']] : []) tools.append(button(`Explore ${label}`, `expand:${direction}`, { type: 'expand', ref: identity(node.ref), direction }))
      panel.append(tools)
      const related = current.edges.filter(edge => sameRef(edge.source, node.ref) || sameRef(edge.target, node.ref))
      panel.append(make('h4', 'Relationships in this view'))
      if (!related.length) paragraph(panel, 'No relationships in this view.')
      for (const edge of related) panel.append(button(`${labelFor(edge.source)} → ${edge.predicate} → ${labelFor(edge.target)}`, `inspect:${edge.edgeId}`, { type: 'select', edgeId: edge.edgeId }))
    }
  }
  const render = ({ restore = true } = {}) => {
    const active = root.contains(doc.activeElement) ? doc.activeElement : null
    const focusKey = active?.getAttribute('data-agv-key')
    const textRange = active?.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null
    ui.content.replaceChildren()
    if (!current) { paragraph(ui.content, 'No graph view available.'); return }
    const info = make('p', `Projection ${current.projectionDigest}`, { class: 'agv-ref' })
    ui.content.append(info)
    if (currentRefreshStatus?.stale) paragraph(ui.content, 'The displayed source view is stale. Rebuild the view before relying on it.', 'agv-note')
    if (currentRefreshStatus?.failure) paragraph(ui.content, 'The view could not be refreshed. Inspect the source and retry through the host.', 'agv-note')
    if (current.page?.truncated) {
      const omitted = Object.entries(current.page.omitted ?? {}).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`).join(', ')
      paragraph(ui.content, `This is a bounded view.${omitted ? ` Omitted from this view: ${omitted}.` : ''}`, 'agv-note')
      if (current.page.nextCursor && typeof onPage === 'function') {
        const more = make('button', 'Load next page', { type: 'button', 'data-agv-key': 'next-page' })
        const pageRequest = Object.freeze({ projectionDigest: current.projectionDigest, cursor: current.page.nextCursor })
        more.addEventListener('click', async () => {
          if (disposed || !current || current.projectionDigest !== pageRequest.projectionDigest) return
          const revision = epoch
          try { await onPage(pageRequest) } catch { if (!disposed && epoch === revision) ui.status.textContent = 'Next page unavailable. Try again.' }
        })
        ui.content.append(more)
      } else paragraph(ui.content, 'Ask the host for a broader view to inspect omitted results.')
    }
    const questions = make('section', null, { 'aria-label': 'Questions' })
    heading(questions, 'Questions')
    const qlist = make('ul', null, { class: 'agv-questions' })
    for (const q of current.questions) qlist.append(append(make('li', null), button(`${q.title} · ${q.coverage}`, `question:${q.questionId}`, { type: 'setQuestion', questionId: q.questionId }, selected?.questionId === q.questionId)))
    if (!current.questions.length) paragraph(questions, 'No questions in this view.')
    questions.append(qlist); ui.content.append(questions)
    const grid = make('div', null, { class: 'agv-grid' })
    const records = make('section', null, { 'aria-label': 'Records' })
    heading(records, 'Records')
    const inputId = `${prefix}-search`, label = make('label', 'Search this view', { for: inputId })
    const input = make('input', null, { id: inputId, type: 'search', 'data-agv-key': 'search', 'aria-describedby': `${prefix}-search-hint` })
    input.value = query
    const search = () => { query = input.value; const matches = render(); ui.status.textContent = `${matches} records in this view match.` }
    input.addEventListener('input', event => { if (!event.isComposing) search() })
    input.addEventListener('compositionend', search)
    append(records, label, input, make('p', 'Search is limited to the records delivered in this view. Arrow keys move focus through the record list; Enter or Space selects.', { id: `${prefix}-search-hint` }))
    const normalized = query.trim().toLocaleLowerCase()
    const visible = current.nodes.filter(node => [node.title, node.summary, node.ref.repoId, node.ref.localId, ...(node.tags ?? [])].join(' ').toLocaleLowerCase().includes(normalized))
    const count = make('p', `${visible.length} records in this view match.`)
    records.append(count)
    const list = make('ul', null, { class: 'agv-records', 'aria-label': 'Record search results' })
    const buttons = []
    if (!visible.some(node => refKey(node.ref) === roving)) roving = visible[0] ? refKey(visible[0].ref) : null
    for (const node of visible) {
      const control = nodeButton(node.ref, 'list')
      control.tabIndex = refKey(node.ref) === roving ? 0 : -1
      control.addEventListener('focus', () => { roving = refKey(node.ref); for (const b of buttons) b.tabIndex = b === control ? 0 : -1 })
      control.append(make('small', `${node.sourceKind} · ${refText(node.ref)}`))
      buttons.push(control); list.append(append(make('li', null), control))
    }
    list.addEventListener('keydown', event => {
      const index = buttons.indexOf(doc.activeElement)
      if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
      buttons[next]?.focus()
    })
    records.append(list)
    if (!visible.length) paragraph(records, 'No matching records in this view.')
    const panel = make('aside', null, { id: `${prefix}-inspector`, tabindex: '-1', 'aria-label': 'Evidence inspector' })
    heading(panel, 'Evidence inspector'); inspect(panel)
    append(grid, records, panel); ui.content.append(grid)
    const relationships = make('section', null, { 'aria-label': 'Directed relationships' })
    heading(relationships, 'Directed relationships')
    const scroll = make('div', null, { class: 'agv-table', tabindex: '0', role: 'region', 'aria-label': 'Directed relationship table, scroll horizontally if needed' })
    const table = make('table', null), head = make('thead', null), tr = make('tr', null), body = make('tbody', null)
    table.append(make('caption', 'Direction runs from source, through predicate, to target.'))
    for (const name of ['Source', 'Predicate', 'Target', 'Review and support']) tr.append(make('th', name, { scope: 'col' }))
    head.append(tr); table.append(head)
    for (const edge of current.edges) {
      const row = make('tr', null)
      append(row, append(make('td', null), nodeButton(edge.source, `table-source:${edge.edgeId}`)), append(make('td', null), button(edge.predicate, `edge:${edge.edgeId}`, { type: 'select', edgeId: edge.edgeId }, selected?.edgeId === edge.edgeId)), append(make('td', null), nodeButton(edge.target, `table-target:${edge.edgeId}`)), make('td', `${edge.assurance} · ${edge.acceptanceState} · ${edge.supportRefs?.length ?? 0} support pins · ${edge.reviewRefs?.length ?? 0} review receipts`))
      body.append(row)
    }
    table.append(body); scroll.append(table); relationships.append(scroll)
    if (!current.edges.length) paragraph(relationships, 'No directed relationships in this view.')
    ui.content.append(relationships)
    const diagnostics = make('section', null, { 'aria-label': 'Diagnostics' })
    heading(diagnostics, 'Diagnostics')
    for (const item of current.diagnostics ?? []) {
      paragraph(diagnostics, `${item.severity}: ${item.code}. ${item.action}`, 'agv-note')
      for (const ref of item.nodeRefs) diagnostics.append(nodeButton(ref, `diagnostic:${item.diagnosticId}`))
      for (const evidenceId of item.evidenceRefs) diagnostics.append(button('Inspect diagnostic evidence', `diagnostic:${item.diagnosticId}:${evidenceId}`, { type: 'openEvidence', evidenceId }))
    }
    if (!current.diagnostics?.length) paragraph(diagnostics, 'No diagnostics supplied in this view.')
    ui.content.append(diagnostics)
    if (restore && focusKey) {
      const replacement = [...root.querySelectorAll('[data-agv-key]')].find(element => element.getAttribute('data-agv-key') === focusKey)
      if (replacement) { replacement.focus({ preventScroll: true }); if (textRange) replacement.setSelectionRange(...textRange) }
      else panel.focus({ preventScroll: true })
    }
    return visible.length
  }
  const update = ({ view: nextView = null, selection: nextSelection = null, refreshStatus: nextRefreshStatus } = {}) => {
    if (disposed) throw new TypeError('structured graph disposed')
    ++epoch; ++request
    const previousDigest = current?.projectionDigest, previousRefreshStatus = currentRefreshStatus
    currentRefreshStatus = null
    // Clear the prior bytes before accepting a replacement; never keep a stale
    // authorized snapshot after the host withdraws or rejects delivery.
    current = null; selected = null
    if (nextView === null) { query = ''; roving = null; render(); ui.status.textContent = 'Graph view cleared.'; return }
    try {
      if (nextView.schema !== 'atelier.graph-view@v1' || !/^sha256:[a-f0-9]{64}$/.test(nextView.projectionDigest ?? '') || !Array.isArray(nextView.nodes) || !Array.isArray(nextView.edges) || !Array.isArray(nextView.questions) || !Array.isArray(nextView.evidence) || nextView.nodes.length > 500 || nextView.edges.length > 2000 || nextView.evidence.length > 4000 || nextView.questions.length > 100) throw new TypeError()
      current = structuredClone(nextView)
      currentRefreshStatus = nextRefreshStatus === undefined ? (previousDigest === current.projectionDigest ? previousRefreshStatus : null) : nextRefreshStatus === null ? null : { stale: nextRefreshStatus.stale === true, failure: Boolean(nextRefreshStatus.failure) }
      if (nextSelection?.projectionDigest === current.projectionDigest) {
        const keys = ['ref', 'edgeId', 'evidenceId', 'questionId'].filter(key => nextSelection[key] !== undefined)
        const available = keys.length === 1 && (keys[0] === 'ref' ? nodeFor(nextSelection.ref) :
          keys[0] === 'edgeId' ? edgeFor(nextSelection.edgeId) :
            keys[0] === 'evidenceId' ? current.evidence.find(e => e.evidenceId === nextSelection.evidenceId) :
              current.questions.find(q => q.questionId === nextSelection.questionId))
        if (available) selected = structuredClone(nextSelection)
      }
      render()
      ui.status.textContent = selected ? 'Selection updated.' : 'Graph view ready.'
    } catch {
      current = null; selected = null; currentRefreshStatus = null; query = ''; roving = null
      render(); ui.status.textContent = 'Graph view unavailable.'
      throw new TypeError('invalid structured graph view')
    }
  }
  shell()
  try { update({ view, selection, refreshStatus }) } catch (error) { mounts.delete(root); root.replaceChildren(); throw error }
  return Object.freeze({ update, clear: () => update({ view: null }), destroy: () => {
    if (disposed) return
    disposed = true; ++epoch; ++request; current = null; selected = null; currentRefreshStatus = null; query = ''; root.replaceChildren(); mounts.delete(root)
  } })
}
