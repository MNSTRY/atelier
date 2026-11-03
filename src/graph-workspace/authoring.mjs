// Focused authoring for concepts and plan relations: one step at a time, with
// structural guidance and a draft store behind an injected storage port.
//
// Guidance here is structural (empty, too short, name-only identity, example equals
// near miss). It is not the Node ontology guide and says nothing about truth.
// "ready-for-human-review" means complete and grounded in readable records; a person
// decides. The store writes only to the storage it is given: browser storage for a
// local draft, or a host port that records drafts durably for review.

const article = word => (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word.toLowerCase()

export function conceptSteps(concept) {
  return [
    { id: 'definition', label: 'Meaning', prompt: `What makes something ${article(concept.title)}?`, help: 'One sentence. Say what it is distinct from.' },
    { id: 'identityRule', label: 'Same one?', prompt: 'How do you recognise the same one twice?', help: 'Similar names alone do not establish identity.' },
    { id: 'example', label: 'Example', prompt: 'One concrete example from your own work.', help: 'A real case you could point to.' },
    { id: 'nearMiss', label: 'Near miss', prompt: 'A close example that must stay separate.', help: 'The case people most often confuse with it.' },
    { id: 'evidence', label: 'Evidence', prompt: 'Which records ground this distinction?', help: 'Cite records you have looked at. Citing does not make them members.', kind: 'evidence' },
    { id: 'disconfirming', label: 'Prove wrong', prompt: 'What observation would show this distinction does not hold?', help: 'Name it now so you would notice it later.' },
  ]
}

export function relationSteps(relation, titleOf = id => id) {
  const verb = relation.predicate.replaceAll('_', ' ')
  return [
    { id: 'meaning', label: 'Meaning', prompt: `What does “${verb}” claim here?`, help: 'Say what the relation lets you check, not that it proves anything.' },
    { id: 'forward', label: 'Forward', prompt: `Read it from ${titleOf(relation.from)} to ${titleOf(relation.to)}.`, help: `Start with “${titleOf(relation.from)}…”` },
    { id: 'reverse', label: 'Reverse', prompt: `Read it from ${titleOf(relation.to)} back to ${titleOf(relation.from)}.`, help: 'The same claim from the other end. It creates no inverse relation.' },
    { id: 'disconfirming', label: 'Prove wrong', prompt: 'What would show this relation does not hold?', help: 'One observation is enough.' },
  ]
}

const nameOnly = t => /\b(name|title|label|called)\b/i.test(t) && !/\b(not|alone|never|only by|unless)\b/i.test(t)
const fields = list => Object.fromEntries(list.map(k => [k, []]))
const summarize = f => { const all = Object.values(f).flat(); return { fields: f, errors: all.filter(m => m.tone === 'error').length, warnings: all.filter(m => m.tone === 'warn').length } }

export function guideConcept(concept, draft, readableIds = null) {
  const f = fields(['definition', 'identityRule', 'example', 'nearMiss', 'evidence', 'disconfirming'])
  const def = (draft.definition ?? '').trim()
  if (!def) f.definition.push({ tone: 'error', text: 'Say what this is in one sentence.' })
  else {
    if (def.toLowerCase() === concept.title.toLowerCase()) f.definition.push({ tone: 'error', text: 'A definition should not just repeat the name.' })
    if (def.length < 24) f.definition.push({ tone: 'warn', text: 'Add a boundary: what is it distinct from?' })
    else if (!/\b(distinct|not|rather than|unlike|only|separate|excluding)\b/i.test(def)) f.definition.push({ tone: 'info', text: 'Naming what it is distinct from helps the next person apply it.' })
  }
  const rule = (draft.identityRule ?? '').trim()
  if (!rule) f.identityRule.push({ tone: 'error', text: 'State how two records are recognised as the same one.' })
  else if (nameOnly(rule)) f.identityRule.push({ tone: 'warn', text: 'Names alone do not establish identity. Say which event, place or id makes two the same.' })
  if (!(draft.example ?? '').trim()) f.example.push({ tone: 'error', text: 'Add one concrete example.' })
  const near = (draft.nearMiss ?? '').trim()
  if (!near) f.nearMiss.push({ tone: 'error', text: 'Add a close example that must stay separate.' })
  else if (near.toLowerCase() === (draft.example ?? '').trim().toLowerCase()) f.nearMiss.push({ tone: 'error', text: 'The near miss must differ from the example.' })
  const evidence = draft.evidence ?? []
  if (!evidence.length) f.evidence.push({ tone: 'warn', text: 'Cite at least one record you have looked at.' })
  if (readableIds) for (const b of evidence) if (!readableIds.has(b.id)) f.evidence.push({ tone: 'warn', text: 'One cited record is not readable here. It cannot support a proposal made from this view.' })
  if (!(draft.disconfirming ?? '').trim()) f.disconfirming.push({ tone: 'warn', text: 'Name one observation that would prove it wrong.' })
  return summarize(f)
}

export function guideRelation(draft) {
  const f = fields(['meaning', 'forward', 'reverse', 'disconfirming'])
  const meaning = (draft.meaning ?? '').trim()
  if (!meaning) f.meaning.push({ tone: 'error', text: 'Explain what this relation claims.' })
  else if (/\b(proves?|guarantees?|always)\b/i.test(meaning)) f.meaning.push({ tone: 'warn', text: 'Avoid claiming proof; say what it lets you check.' })
  if (!(draft.forward ?? '').trim()) f.forward.push({ tone: 'error', text: 'Write the forward reading.' })
  const reverse = (draft.reverse ?? '').trim()
  if (!reverse) f.reverse.push({ tone: 'error', text: 'Write the reverse reading.' })
  else if (reverse.toLowerCase() === (draft.forward ?? '').trim().toLowerCase()) f.reverse.push({ tone: 'warn', text: 'Start the reverse reading from the other end.' })
  if (!(draft.disconfirming ?? '').trim()) f.disconfirming.push({ tone: 'warn', text: 'Name what would show it does not hold.' })
  return summarize(f)
}

/** answered · plan (unchanged plan wording) · attention · deferred · open */
export function stepState(value, guide = [], deferred = false, original) {
  if (deferred) return 'deferred'
  if (original !== undefined && typeof value === 'string' && value === original && value.trim()) return 'plan'
  const answered = Array.isArray(value) ? value.length > 0 : !!value?.trim?.()
  if (!answered) return 'open'
  return guide.some(m => m.tone === 'error') ? 'attention' : 'answered'
}

/** Storage port shape: { getItem(key) → string|null, setItem(key, string), removeItem(key) }. */
export function memoryStorage() {
  const map = new Map()
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)) }, removeItem: k => { map.delete(k) } }
}

export function createDraftStore({ storage = memoryStorage(), key, delayMs = 600, now = () => new Date().toISOString() }) {
  if (typeof key !== 'string' || !key) throw new TypeError('A draft key is required')
  let data = { concepts: {}, relations: {}, deferred: {}, savedAt: null }
  let status = 'empty'
  try { const raw = storage.getItem(key); if (raw) { data = { ...data, ...JSON.parse(raw) }; status = 'restored' } } catch { status = 'unavailable' }
  let timer = null
  const listeners = new Set()
  const emit = () => listeners.forEach(fn => fn(status))
  function flush() {
    clearTimeout(timer); timer = null
    try { data.savedAt = now(); storage.setItem(key, JSON.stringify(data)); status = 'saved' } catch { status = 'unavailable' }
    emit()
  }
  return {
    get data() { return data },
    get status() { return status },
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    concept(c) { data.concepts[c.id] ??= { definition: c.definition ?? '', identityRule: c.identityRule ?? '', example: '', nearMiss: '', disconfirming: '', evidence: [] }; return data.concepts[c.id] },
    relation(r) { data.relations[r.id] ??= { meaning: r.meaning ?? '', forward: '', reverse: '', disconfirming: '' }; return data.relations[r.id] },
    defer(kind, id, step, value) { data.deferred[`${kind}:${id}:${step}`] = !!value; this.changed() },
    deferred(kind, id, step) { return !!data.deferred[`${kind}:${id}:${step}`] },
    changed() { status = 'saving'; emit(); clearTimeout(timer); if (delayMs <= 0) flush(); else timer = setTimeout(flush, delayMs) },
    flush,
    discard() { clearTimeout(timer); try { storage.removeItem(key) } catch { /* ignore */ } data = { concepts: {}, relations: {}, deferred: {}, savedAt: null }; status = 'empty'; emit() },
  }
}

export function readiness(plan, store, readableIds = null) {
  const items = []
  for (const c of plan?.concepts ?? []) {
    const d = store.data.concepts[c.id]
    if (!d) continue
    if (d.definition !== (c.definition ?? '') || d.identityRule !== (c.identityRule ?? '') || d.example || d.nearMiss || d.disconfirming || d.evidence?.length) items.push({ kind: 'concept', id: c.id, title: c.title, guide: guideConcept(c, d, readableIds) })
  }
  for (const r of plan?.relations ?? []) {
    const d = store.data.relations[r.id]
    if (!d) continue
    if (d.meaning !== (r.meaning ?? '') || d.forward || d.reverse || d.disconfirming) items.push({ kind: 'relation', id: r.id, title: r.id, guide: guideRelation(d) })
  }
  const errors = items.reduce((n, i) => n + i.guide.errors, 0)
  return { status: !items.length ? 'nothing-drafted' : errors ? 'needs-attention' : 'ready-for-human-review', items, errors }
}
