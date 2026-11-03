// Invented test fixture: a fictional coastal research commons notebook in the
// Atelier knowledge-graph format. Every name, place and record is made up.

function prng(seed) {
  let s = seed >>> 0
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const ZONES = [
  { id: 'field', folder: 'field-studies', share: 0.30, label: 'Field studies' },
  { id: 'library', folder: 'reading-library', share: 0.21, label: 'Reading library' },
  { id: 'collab', folder: 'collaborations', share: 0.15, label: 'Collaborations' },
  { id: 'archive', folder: 'archive', share: 0.08, label: 'Archive' },
  { id: 'letters', folder: 'letters', share: 0.07, label: 'Letters & notes' },
  { id: 'direction', folder: 'direction', share: 0.07, label: 'Direction' },
  { id: 'programs', folder: 'programs', share: 0.07, label: 'Programs' },
  { id: 'principles', folder: 'principles', share: 0.05, label: 'Principles' },
]
const PLACES = ['North Spit', 'Heron Flats', 'Eelgrass Bay', 'Mussel Rock', 'Dune Ridge', 'Kelp Point', 'Salt Meadow', 'Ferry Slip', 'Lantern Cove', 'Brackish Creek', 'Oyster Reach', 'Plover Beach', 'Sandbar Gap', 'Tern Island', 'Reed Marsh', 'Storm Wall']
const SUBJECTS = ['tide pools', 'eelgrass cover', 'oyster set', 'dune grass', 'mudflat worms', 'heron nests', 'kelp line', 'storm debris', 'sediment cores', 'salinity', 'shorebird counts', 'crab moults', 'marsh edge', 'water clarity']
const FIELD_KINDS = ['survey', 'transect notes', 'photo log', 'sample sheet', 'season summary', 'walk notes']
const READING = ['commons governance', 'watershed stewardship', 'citizen science methods', 'coastal resilience', 'participatory mapping', 'tidal ecology', 'volunteer retention', 'open data practice', 'place-based learning', 'restoration ethics', 'measurement bias', 'community archives', 'slow science', 'shared monitoring']
const READ_KINDS = ['reading notes', 'primer', 'summary', 'quotations', 'critique', 'glossary entry']
const PARTNERS = ['Gull Point School', 'Harbor Rowing Club', 'Estuary Volunteers', 'Lantern Cove Library', 'Ferry Slip Café', 'Driftwood Guild', 'Tern Island Trust', 'Marsh Walkers', 'Brackish Creek Farm', 'Saltwater Choir']
const COLLAB_KINDS = ['meeting notes', 'agreement draft', 'visit plan', 'shared calendar', 'feedback round', 'introduction letter']
const PROGRAMS = ['Shore Watch', 'Eelgrass Return', 'Night Tides', 'Young Mappers', 'Oyster Garden', 'Storm Log']
const PRINCIPLES = ['Count what neighbours care about', 'Data stays with the place', 'Slow before scale', 'Name the uncertainty', 'Credit every hand', 'Repair before replace', 'Invite, do not recruit', 'Keep the raw record']
const DIRECTION = ['three-year horizon', 'funding stance', 'what we will not do', 'growth question', 'membership model', 'quiet season plan', 'risk register', 'governance sketch']

export function generateCommons({ size = 1400, seed = 11 } = {}) {
  const rnd = prng(seed)
  const pick = list => list[Math.floor(rnd() * list.length)]
  const nodes = []
  const used = new Set()
  const add = (zone, kind, title, summary, type = 'document', extraTags = []) => {
    let t = title, i = 2
    while (used.has(t)) t = `${title} (${i++})`
    used.add(t)
    const id = `commons:${zone.id}:${nodes.length.toString(36)}`
    nodes.push({ id, title: t, summary, repo: 'commons-notebook', path: `notes/${zone.folder}/${t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`, type, status: rnd() < 0.12 ? 'draft' : 'active', audience: 'team', tags: [zone.id, kind, ...extraTags], relations: {} })
    return nodes.at(-1)
  }
  // Zone index records and hubs first.
  const index = {}
  for (const zone of ZONES) index[zone.id] = add(zone, 'index', `${zone.label} index`, `The entry point for ${zone.label.toLowerCase()}. Links every record in this folder.`, 'index')
  const hubs = [
    add(ZONES[1], 'map', 'Reading map', 'A curated route through the library, linking readings to the field questions they inform.', 'map'),
    add(ZONES[5], 'map', 'Working definitions', 'Newly drafted definitions and open hypotheses, each linked to where it is used.', 'map'),
    add(ZONES[3], 'ledger', 'Record ledger', 'Every archived record with its original location and the date it was moved.', 'map'),
  ]
  const target = Math.max(nodes.length + 40, size)
  const plan = { field: [], library: [], collab: [], archive: [], letters: [], direction: [], programs: [], principles: [] }
  while (nodes.length < target) {
    const r = rnd(); let acc = 0
    const zone = ZONES.find(z => (acc += z.share) >= r) ?? ZONES[0]
    let rec
    if (zone.id === 'field') {
      const place = pick(PLACES), subject = pick(SUBJECTS), kind = pick(FIELD_KINDS)
      rec = add(zone, kind, `${place}: ${subject} ${kind}`, `Observed ${subject} at ${place}. ${kind === 'season summary' ? 'Compares this season with the last two.' : 'Includes date, tide height and who was there.'}`, 'evidence', [kind === 'season summary' ? 'summary' : 'observation'])
    } else if (zone.id === 'library') {
      const topic = pick(READING), kind = pick(READ_KINDS)
      rec = add(zone, kind, `${topic[0].toUpperCase() + topic.slice(1)} — ${kind}`, `Notes on ${topic}, with the passages we keep returning to.`, 'source')
    } else if (zone.id === 'collab') {
      const partner = pick(PARTNERS), kind = pick(COLLAB_KINDS)
      rec = add(zone, kind, `${partner}: ${kind}`, `Working with ${partner}. ${kind === 'agreement draft' ? 'Not signed; terms still open.' : 'Who attended and what we agreed to try.'}`, 'document', ['partner'])
    } else if (zone.id === 'archive') {
      rec = add(zone, 'artifact', `Archived ${pick(SUBJECTS)} sheet ${Math.floor(rnd() * 900 + 100)}`, 'A moved record kept with its original location and checksum.', 'artifact')
    } else if (zone.id === 'letters') {
      rec = add(zone, 'letter', `Letter to ${pick(PARTNERS)} about ${pick(SUBJECTS)}`, 'Correspondence, kept as written.', 'document')
    } else if (zone.id === 'direction') {
      rec = add(zone, 'decision', `${(d => d[0].toUpperCase() + d.slice(1))(pick(DIRECTION))} — note ${Math.floor(rnd() * 90 + 10)}`, 'A direction note: what we are choosing and what we are leaving aside.', 'decision', ['hypothesis'])
    } else if (zone.id === 'programs') {
      const program = pick(PROGRAMS)
      rec = add(zone, 'program', `${program}: ${pick(['plan', 'session notes', 'retrospective', 'volunteer guide', 'materials list'])}`, `Part of the ${program} program.`, 'document')
    } else {
      rec = add(zone, 'principle', `${pick(PRINCIPLES)} — ${pick(['origin', 'in practice', 'tensions', 'examples'])}`, 'A principle we hold, with where it came from and where it is strained.', 'document')
    }
    plan[zone.id].push(rec)
  }
  const edges = []
  const seen = new Set()
  const link = (a, b, type) => {
    if (a.id === b.id) return
    const k = a.id + '>' + b.id + ':' + type
    if (seen.has(k)) return
    seen.add(k)
    edges.push({ source: a.id, target: b.id, type, declared: true })
    ;(a.relations[type] ??= []).push(b.id)
  }
  const byZone = id => nodes.filter(n => n.tags[0] === id && n.type !== 'index')
  for (const n of nodes) if (n.type !== 'index') link(n, index[n.tags[0]], 'belongs_to')
  for (const zone of ZONES) link(index[zone.id], hubs[0], 'related')
  // Topic neighbourhoods: records sharing a place, subject, partner or program link to each other.
  const keyOf = n => (n.title.split(/[:—]/)[0] ?? '').trim()
  const groups = new Map()
  for (const n of nodes) { const k = n.tags[0] + '|' + keyOf(n); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n) }
  for (const list of groups.values()) for (let i = 1; i < list.length; i++) { link(list[i], list[Math.floor(rnd() * i)], 'related'); if (rnd() < 0.35) link(list[i], list[Math.floor(rnd() * i)], 'related') }
  for (const n of nodes) {
    if (n.type === 'index') continue
    const k = Math.floor(rnd() * 3)
    for (let i = 0; i < k; i++) {
      const pool = rnd() < 0.8 ? byZone(n.tags[0]) : nodes
      link(n, pool[Math.floor(rnd() * pool.length)], 'related')
    }
  }
  for (const n of plan.library) if (rnd() < 0.55) link(hubs[0], n, 'related')
  for (const n of [...plan.direction, ...plan.principles, ...plan.programs]) if (rnd() < 0.7) link(hubs[1], n, 'related')
  for (const n of plan.archive) link(hubs[2], n, 'related')
  // Declared relations: a few, with meaning.
  for (const n of plan.field) if (rnd() < 0.06) link(n, pick(plan.direction), 'evidences')
  for (const n of plan.programs) { if (rnd() < 0.4) link(n, pick(plan.principles), 'implements'); if (rnd() < 0.3) link(n, pick(plan.collab), 'depends_on') }
  for (const n of plan.library) if (rnd() < 0.05) link(n, pick(plan.principles), 'supports')
  for (const n of plan.field) if (rnd() < 0.015) link(n, pick(plan.direction), 'contradicts')
  // Source-declared concept tags (the record says what it is; nothing is inferred).
  const conceptTag = (list, id, share) => { for (const n of list) if (rnd() < share) n.tags.push('concept:' + id) }
  conceptTag(plan.field.filter(n => n.tags.includes('observation')), 'observation', 0.05)
  conceptTag(plan.collab, 'partner', 0.04)
  conceptTag(plan.programs, 'program', 0.12)
  conceptTag(plan.direction, 'hypothesis', 0.15)
  conceptTag(plan.principles, 'principle', 0.15)
  conceptTag(plan.library, 'source', 0.03)
  conceptTag(plan.direction.filter(n => n.type === 'decision'), 'decision', 0.06)

  const graph = { schema: 'mnstry.atelier-knowledge-graph@v1', generatedAt: 'deterministic', project: 'commons-notebook', counts: { nodes: nodes.length, edges: edges.length, diagnostics: 0 }, nodes, edges, diagnostics: [], external: [], errors: [] }
  const knowledgePlan = {
    schema: 'atelier-knowledge-plan@v1',
    purpose: 'Keep a shared, honest record of how the coast is changing and what the commons does about it.',
    steward: 'Fictional notebook steward', reviewer: 'Fictional reviewer; no human acceptance implied.',
    concepts: [
      { id: 'observation', definition: 'One thing seen at one place and time, with who saw it.', identityRule: 'Place, date, tide and observer together; similar titles are not the same observation.', tag: 'concept:observation' },
      { id: 'site', definition: 'A named stretch of shore we return to.', identityRule: 'Bounded by the markers on the field map.', tag: 'concept:site' },
      { id: 'partner', definition: 'A group we work with by agreement.', identityRule: 'One partner per agreement holder, even when people change.', tag: 'concept:partner' },
      { id: 'program', definition: 'A recurring activity with a purpose, a season and a lead.', identityRule: 'Program name; each season is a run of the same program.', tag: 'concept:program' },
      { id: 'hypothesis', definition: 'A claim we are testing, with what would change our mind.', identityRule: 'One hypothesis per claim; a reworded claim is a revision.', tag: 'concept:hypothesis' },
      { id: 'principle', definition: 'A commitment that shapes how we work.', identityRule: 'Named principle; examples do not create new principles.', tag: 'concept:principle' },
      { id: 'source', definition: 'A reading we rely on.', identityRule: 'One edition or version of a work.', tag: 'concept:source' },
      { id: 'decision', definition: 'A recorded choice with who decided and on what evidence.', identityRule: 'One dated decision; a reversal is a new decision.', tag: 'concept:decision' },
    ],
    relations: [
      { id: 'observation-hypothesis', predicate: 'evidences', from: 'observation', to: 'hypothesis', meaning: 'An observation is evidence about a hypothesis; it does not settle it.' },
      { id: 'observation-site', predicate: 'belongs_to', from: 'observation', to: 'site', meaning: 'An observation is filed under the site where it was made.' },
      { id: 'program-principle', predicate: 'implements', from: 'program', to: 'principle', meaning: 'A program puts a principle into practice; it can strain it too.' },
      { id: 'program-partner', predicate: 'depends_on', from: 'program', to: 'partner', meaning: 'A program depends on a partner agreement to run.' },
      { id: 'hypothesis-decision', predicate: 'supports', from: 'hypothesis', to: 'decision', meaning: 'A tested hypothesis can support a decision; untested ones cannot.' },
    ],
    questions: [
      { id: 'eelgrass-return', question: 'Is eelgrass coming back where we replanted?', concepts: ['observation', 'site', 'hypothesis'], relations: ['observation-hypothesis', 'observation-site'] },
      { id: 'partner-load', question: 'Which programs depend on a single partner?', concepts: ['program', 'partner'], relations: ['program-partner'] },
      { id: 'principle-strain', question: 'Where are our principles under strain?', concepts: ['principle', 'program'], relations: ['program-principle'] },
      { id: 'decision-basis', question: 'Which decisions rest on untested hypotheses?', concepts: ['hypothesis', 'decision'], relations: ['hypothesis-decision'] },
    ],
  }
  return { graph, plan: knowledgePlan, zoneRule: { prefix: 'notes/', depth: 1, labels: Object.fromEntries(ZONES.map(z => [z.folder, z.label])) } }
}
