// The review: before and proposed, evidence state, who decides. Nothing else.
// Local and simulated: it shows the intent a host would receive and sends nothing.
import { h, clear } from './dom.mjs'
import { readiness } from '../authoring.mjs'

const STATUS = {
  'nothing-drafted': ['Nothing drafted yet', 'Shape a concept or explain a relation first.'],
  'needs-attention': ['Needs attention', 'Some steps are incomplete; the step rail shows which.'],
  'ready-for-human-review': ['Ready for a person to review', 'Complete and grounded in records you can read. Not a judgment that it is true; a person decides that.'],
}

export function renderReview(root, { model, store, onBack, onOpen }) {
  const plan = model.plan
  const visible = new Set(model.nodes.map(n => n.id))
  const byId = new Map(model.nodes.map(n => [n.id, n]))
  const r = readiness(plan, store, visible)
  const [label, explain] = STATUS[r.status]
  clear(root)
  root.hidden = false
  const panel = h('section', { class: 'review', 'aria-labelledby': 'review-title' })
  panel.append(h('header', { class: 'review-head' }, h('button', { class: 'back', type: 'button', id: 'review-back', onclick: onBack }, '← Back to the workbench'),
    h('h2', { id: 'review-title', tabindex: '-1', text: 'Your proposed change' }),
    h('p', { class: 'review-status', id: 'review-status', dataset: { status: r.status } }, h('b', { text: label }), ' ', explain)))
  for (const item of r.items) {
    const card = h('article', { class: 'change' })
    if (item.kind === 'concept') {
      const c = plan.concepts.find(x => x.id === item.id), d = store.data.concepts[item.id]
      card.append(h('h3', {}, h('button', { class: 'link', type: 'button', onclick: () => onOpen({ kind: 'concept', id: c.id }) }, c.title)))
      card.append(pair('Meaning', c.definition, d.definition), pair('Same one?', c.identityRule, d.identityRule))
      for (const [k, v] of [['Example', d.example], ['Must stay separate', d.nearMiss], ['Would prove it wrong', d.disconfirming]]) if (v) card.append(h('p', { class: 'line' }, h('span', { class: 'label', text: k + ' ' }), v))
      card.append(h('p', { class: 'label', text: `Evidence · ${d.evidence.length}` }), h('ul', { class: 'cited' }, d.evidence.map(b => h('li', { text: visible.has(b.id) ? byId.get(b.id).title : 'A record outside what you can read' }))))
    } else {
      const rel = plan.relations.find(x => x.id === item.id), d = store.data.relations[item.id]
      const t = id => plan.concepts.find(c => c.id === id)?.title ?? id
      card.append(h('h3', { text: `${t(rel.from)} → ${t(rel.to)}` }), pair('Meaning', rel.meaning, d.meaning))
      for (const [k, v] of [['Forward', d.forward], ['Reverse', d.reverse], ['Would prove it wrong', d.disconfirming]]) if (v) card.append(h('p', { class: 'line' }, h('span', { class: 'label', text: k + ' ' }), v))
      card.append(h('p', { class: 'step-help', text: 'One directed relation. The reverse reading is explanation, not a second relation.' }))
    }
    if (item.guide.errors) card.append(h('p', { class: 'guide-error', text: `${item.guide.errors} step(s) still need attention.` }))
    panel.append(card)
  }
  panel.append(h('div', { class: 'decide' },
    h('p', {}, h('b', { text: 'A person decides. ' }), 'Nothing has been saved to the source, applied to the plan or sent anywhere. Drafts stay in this browser.'),
    h('details', {}, h('summary', { text: 'The intent a host would receive (not sent)' }), h('pre', { text: JSON.stringify({ type: 'proposeModelChange', draftRef: `local-browser-draft:${model.systemId}`, items: r.items.map(i => `${i.kind}:${i.id}`) }, null, 2) }))))
  root.replaceChildren(panel)
  root.querySelector('#review-title').focus()
  return r
}

function pair(label, before, after) {
  if ((before ?? '') === (after ?? '')) return h('div', { class: 'pair same' }, h('p', { class: 'label', text: label }), h('p', { text: before || '—' }), h('small', { text: 'Unchanged' }))
  return h('div', { class: 'pair' }, h('p', { class: 'label', text: label }), h('div', { class: 'pair-grid' }, h('div', {}, h('small', { text: 'Now' }), h('p', { text: before || '—' })), h('div', {}, h('small', { text: 'Proposed' }), h('blockquote', { text: after || '—' }))))
}
