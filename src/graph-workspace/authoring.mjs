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
  // Readiness promises completeness and grounding in readable records, so these block it.
  if (!evidence.length) f.evidence.push({ tone: 'error', text: 'Cite at least one record you have looked at.' })
  if (readableIds) for (const b of evidence) if (!readableIds.has(b.id)) f.evidence.push({ tone: 'error', text: 'One cited record is not readable here. It cannot support a proposal made from this view.' })
  if (!(draft.disconfirming ?? '').trim()) f.disconfirming.push({ tone: 'error', text: 'Name one observation that would prove it wrong.' })
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
  if (!(draft.disconfirming ?? '').trim()) f.disconfirming.push({ tone: 'error', text: 'Name what would show it does not hold.' })
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

// Identifier-indexed state uses null-prototype records and own-property lookup,
// so an id such as "constructor" or "__proto__" is just another key.
const dict = () => Object.create(null)
const own = (o, k) => Object.hasOwn(o, k) ? o[k] : undefined
const str = v => typeof v === 'string' && v.length <= 20000
const ID = v => typeof v === 'string' && v.length > 0 && v.length <= 512
function restoreData(raw) {
  const out = { concepts: dict(), relations: dict(), deferred: dict(), savedAt: null }
  if (!raw || typeof raw !== 'object') return out
  for (const [id, c] of Object.entries(raw.concepts ?? {})) {
    if (!ID(id) || !c || typeof c !== 'object') continue
    const d = { definition: '', identityRule: '', example: '', nearMiss: '', disconfirming: '', evidence: [] }
    for (const k of ['definition', 'identityRule', 'example', 'nearMiss', 'disconfirming']) if (str(c[k])) d[k] = c[k]
    if (Array.isArray(c.evidence)) d.evidence = c.evidence.filter(b => b && ID(b.id)).slice(0, 200).map(b => ({ id: b.id, title: str(b.title) ? b.title : b.id, citedAt: str(b.citedAt) ? b.citedAt : null }))
    out.concepts[id] = d
  }
  for (const [id, r] of Object.entries(raw.relations ?? {})) {
    if (!ID(id) || !r || typeof r !== 'object') continue
    const d = { meaning: '', forward: '', reverse: '', disconfirming: '' }
    for (const k of Object.keys(d)) if (str(r[k])) d[k] = r[k]
    out.relations[id] = d
  }
  for (const [k, v] of Object.entries(raw.deferred ?? {})) if (ID(k) && v === true) out.deferred[k] = true
  if (str(raw.savedAt)) out.savedAt = raw.savedAt
  return out
}

/**
 * Drafts behind a storage port. `identity` binds saved drafts to one workspace
 * (and reader scope, where a host has one); a saved draft with another identity is
 * never shown. `persistence` names where drafts live: 'tab', 'browser' or 'host'.
 */
export function createDraftStore({ storage = memoryStorage(), key, identity, persistence = 'tab', delayMs = 600, now = () => new Date().toISOString() }) {
  if (typeof key !== 'string' || !key) throw new TypeError('A draft key is required')
  if (!identity || typeof identity !== 'object' || typeof identity.workspace !== 'string' || !identity.workspace) throw new TypeError('A draft identity with a workspace id is required')
  if (!['tab', 'browser', 'host'].includes(persistence)) throw new TypeError('persistence must be tab, browser or host')
  const identityKey = JSON.stringify(Object.keys(identity).sort().map(k => [k, identity[k]]))
  let data = restoreData(null)
  let status = 'empty'
  try {
    const raw = storage.getItem(key)
    if (raw) {
      const envelope = JSON.parse(raw)
      if (envelope?.schema === 'atelier.graph-workspace-draft@v1' && envelope.identity === identityKey) { data = restoreData(envelope.data); status = 'restored' }
      else status = 'empty'
    }
  } catch { status = 'unavailable' }
  let timer = null
  const listeners = new Set()
  const emit = () => listeners.forEach(fn => fn(status))
  function flush() {
    clearTimeout(timer); timer = null
    try { data.savedAt = now(); storage.setItem(key, JSON.stringify({ schema: 'atelier.graph-workspace-draft@v1', identity: identityKey, data })); status = 'saved' } catch { status = 'unavailable' }
    emit()
  }
  return {
    get data() { return data },
    get status() { return status },
    persistence,
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    concept(c) { if (!own(data.concepts, c.id)) data.concepts[c.id] = { definition: c.definition ?? '', identityRule: c.identityRule ?? '', example: '', nearMiss: '', disconfirming: '', evidence: [] }; return data.concepts[c.id] },
    relation(r) { if (!own(data.relations, r.id)) data.relations[r.id] = { meaning: r.meaning ?? '', forward: '', reverse: '', disconfirming: '' }; return data.relations[r.id] },
    conceptDraft(id) { return own(data.concepts, id) },
    relationDraft(id) { return own(data.relations, id) },
    defer(kind, id, step, value) { const k = `${kind}:${id}:${step}`; if (value) data.deferred[k] = true; else delete data.deferred[k]; this.changed() },
    deferred(kind, id, step) { return own(data.deferred, `${kind}:${id}:${step}`) === true },
    changed() { status = 'saving'; emit(); clearTimeout(timer); if (delayMs <= 0) flush(); else timer = setTimeout(flush, delayMs) },
    flush,
    discard() { clearTimeout(timer); try { storage.removeItem(key) } catch { /* ignore */ } data = restoreData(null); status = 'empty'; emit() },
  }
}

/** ready-for-human-review requires every step complete, evidence cited and every citation readable here. */
export function readiness(plan, store, readableIds) {
  if (!(readableIds instanceof Set)) throw new TypeError('readiness needs the set of readable record ids')
  const items = []
  for (const c of plan?.concepts ?? []) {
    const d = store.conceptDraft ? store.conceptDraft(c.id) : (Object.hasOwn(store.data.concepts, c.id) ? store.data.concepts[c.id] : undefined)
    if (!d) continue
    if (d.definition !== (c.definition ?? '') || d.identityRule !== (c.identityRule ?? '') || d.example || d.nearMiss || d.disconfirming || d.evidence?.length) items.push({ kind: 'concept', id: c.id, title: c.title, guide: guideConcept(c, d, readableIds) })
  }
  for (const r of plan?.relations ?? []) {
    const d = store.relationDraft ? store.relationDraft(r.id) : (Object.hasOwn(store.data.relations, r.id) ? store.data.relations[r.id] : undefined)
    if (!d) continue
    if (d.meaning !== (r.meaning ?? '') || d.forward || d.reverse || d.disconfirming) items.push({ kind: 'relation', id: r.id, title: r.id, guide: guideRelation(d) })
  }
  const errors = items.reduce((n, i) => n + i.guide.errors, 0)
  return { status: !items.length ? 'nothing-drafted' : errors ? 'needs-attention' : 'ready-for-human-review', items, errors }
}
