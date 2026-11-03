// Work recipes, layered: Atelier ships defaults, a distribution (the tier that
// adapts Atelier for a programme or cohort) adds or adjusts, and the owner has the
// final say. A recipe is data that chooses the room, the lens
// and the one primary action. Every resolved field records which layer set it.

export const ROOMS = Object.freeze(['map', 'workbench', 'review'])
/** Names accepted for one release and read as their replacements. */
export const DEPRECATED_ROOMS = Object.freeze({ constellation: 'map' })
export const LENSES = Object.freeze([null, 'question', 'concept', 'zone'])
export const SUBJECTS = Object.freeze([null, 'record', 'concept', 'relation'])
export const LAYERS = Object.freeze(['atelier', 'distribution', 'owner'])
/** The single emphasised action of a recipe. The default shell implements each one. */
export const PRIMARY_ACTIONS = Object.freeze(['search', 'open-evidence', 'next-step', 'walk', 'review', 'pick'])

/** The primary actions the default shell honours for a recipe's room, lens and subject. */
export function primaryActionsFor({ room, lens = null, subject = null }) {
  if (room === 'review') return ['review']
  if (room === 'workbench') return subject === 'record' ? ['walk'] : ['next-step']
  if (lens === 'zone') return ['pick', 'search']
  if (lens) return ['open-evidence', 'pick', 'search']
  return ['search']
}

export const DEFAULT_RECIPES = Object.freeze([
  { id: 'explore', label: 'Explore', room: 'map', lens: null, subject: null, primary: 'search', description: 'Wander the whole graph. Zones on, search ready.' },
  { id: 'question', label: 'Answer a question', room: 'map', lens: 'question', subject: null, primary: 'open-evidence', description: 'Light the records that declare a question’s concepts.' },
  { id: 'refine', label: 'Refine a concept', room: 'workbench', lens: null, subject: 'concept', primary: 'next-step', description: 'One concept, one step at a time.' },
  { id: 'inspect', label: 'Inspect a record', room: 'workbench', lens: null, subject: 'record', primary: 'walk', description: 'A record and its closest links, with room to read.' },
].map(Object.freeze))

const FIELDS = ['label', 'room', 'lens', 'subject', 'primary', 'description']
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
/** A room name as this release reads it: deprecated names map to their replacements. */
export const currentRoom = room => (typeof room === 'string' && Object.hasOwn(DEPRECATED_ROOMS, room) ? DEPRECATED_ROOMS[room] : room)

export function validateRecipe(recipe, { partial = false } = {}) {
  const problems = []
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return ['recipe must be an object']
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(recipe.id ?? '')) problems.push('id must be a short lowercase slug')
  for (const key of Object.keys(recipe)) if (!['id', 'hidden', ...FIELDS].includes(key)) problems.push(`unknown field ${key}`)
  const need = !partial
  if ((need || 'label' in recipe) && !text(recipe.label, 60)) problems.push('label must be 1–60 characters')
  if ((need || 'description' in recipe) && !text(recipe.description, 200)) problems.push('description must be 1–200 characters')
  if ((need || 'room' in recipe) && !ROOMS.includes(currentRoom(recipe.room))) problems.push(`room must be one of ${ROOMS.join(', ')}`)
  if ('lens' in recipe && !LENSES.includes(recipe.lens)) problems.push('unknown lens')
  if ('subject' in recipe && !SUBJECTS.includes(recipe.subject)) problems.push('unknown subject')
  if ((need || 'primary' in recipe) && !PRIMARY_ACTIONS.includes(recipe.primary)) problems.push(`primary must be one of ${PRIMARY_ACTIONS.join(', ')}`)
  if ('hidden' in recipe && typeof recipe.hidden !== 'boolean') problems.push('hidden must be true or false')
  return problems
}

/**
 * Compose recipe layers. Each layer is a list; an entry with an existing id adjusts
 * it (partial), a new id adds a complete recipe, and `hidden: true` removes it from
 * what the owner sees. Later layers win. Throws on any invalid entry.
 * `coach` is the alpha.15 name of the distribution layer, accepted for one release;
 * the room `constellation` is likewise read as `map`.
 */
export function composeRecipes({ atelier = DEFAULT_RECIPES, distribution, coach, owner = [] } = {}) {
  if (distribution !== undefined && coach !== undefined) throw new TypeError('Give the distribution layer once: `coach` is its deprecated name')
  // Only an omitted layer defaults; anything supplied (null included) is validated below.
  const middle = distribution !== undefined ? distribution : coach !== undefined ? coach : []
  const resolved = new Map()
  const provenance = new Map()
  for (const [layer, list] of [['atelier', atelier], ['distribution', middle], ['owner', owner]]) {
    if (!Array.isArray(list)) throw new TypeError(`${layer} recipes must be a list`)
    for (const raw of list) {
      const entry = raw && typeof raw === 'object' && 'room' in raw ? { ...raw, room: currentRoom(raw.room) } : raw
      const existing = resolved.get(entry?.id)
      const problems = validateRecipe(entry, { partial: !!existing })
      if (problems.length) throw new TypeError(`${layer} recipe ${entry?.id ?? '(no id)'}: ${problems.join('; ')}`)
      const next = { lens: null, subject: null, hidden: false, ...(existing ?? {}), ...entry }
      // Only combinations a shell can honour: lenses belong to the map,
      // subjects to the workbench, and the review room takes neither.
      if (next.room === 'workbench' && !next.subject) throw new TypeError(`${layer} recipe ${entry.id}: a workbench recipe needs a subject`)
      if (next.room !== 'workbench' && next.subject) throw new TypeError(`${layer} recipe ${entry.id}: only a workbench recipe takes a subject`)
      if (next.room !== 'map' && next.lens) throw new TypeError(`${layer} recipe ${entry.id}: only a map recipe takes a lens`)
      const actions = primaryActionsFor(next)
      if (!actions.includes(next.primary)) throw new TypeError(`${layer} recipe ${entry.id}: primary ${next.primary} is not available here; use ${actions.join(' or ')}`)
      resolved.set(entry.id, next)
      const fields = provenance.get(entry.id) ?? {}
      for (const key of Object.keys(entry)) if (key !== 'id') fields[key] = layer
      if (!existing) for (const key of FIELDS) fields[key] ??= layer
      provenance.set(entry.id, fields)
    }
  }
  const visible = [...resolved.values()].filter(r => !r.hidden)
  return { recipes: visible.map(r => ({ ...r, setBy: { ...provenance.get(r.id) } })), hidden: [...resolved.values()].filter(r => r.hidden).map(r => r.id) }
}

/** Recipes a workspace can actually run: concept work needs a plan with concepts. */
export function availableRecipes(recipes, model) {
  const concepts = !!model.plan?.concepts.length, relations = !!model.plan?.relations.length, questions = !!model.plan?.questions.length
  return recipes.filter(r =>
    (r.subject !== 'concept' || concepts) && (r.subject !== 'relation' || relations) &&
    (r.lens !== 'question' || questions) && (r.lens !== 'concept' || concepts) &&
    (r.room !== 'review' || concepts) && (r.subject !== 'record' || model.nodes.length > 0) &&
    (r.lens !== 'zone' || model.zones?.length > 0))
}
