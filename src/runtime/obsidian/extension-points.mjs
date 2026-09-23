import { refuse } from './errors.mjs'

// The neutral registration point for the operations that later work supplies:
// the source apply operation and the proposal adapter. A registry is a plain
// value created by whoever composes the engine and handed to it. There is no
// module-level registry, so nothing registered in one engine (or one test) is
// visible to another, and no shared dispatch file has to be edited to add an
// implementation.

export const EXTENSION_KINDS = Object.freeze(['apply-operation', 'proposal-adapter'])

// What an apply operation may answer. Anything else is recorded as a failure:
// an unknown answer is never read as success.
export const APPLY_RESULT_STATUSES = Object.freeze(['applied', 'apply-unavailable', 'refused', 'conflict', 'failed'])

const REQUIRED_METHODS = Object.freeze({
  'apply-operation': ['apply'],
  'proposal-adapter': ['propose'],
})

// Until a source apply operation is registered, automatic mode has nothing to
// call. It says so; it does not pretend an edit was applied.
export const UNAVAILABLE_APPLY_OPERATION = Object.freeze({
  id: 'atelier.apply-unavailable',
  async apply() {
    return { status: 'apply-unavailable', code: 'no-apply-operation-registered' }
  },
})

export function createMaintenanceExtensions() {
  const registered = new Map()
  return Object.freeze({
    register(kind, implementation) {
      if (!EXTENSION_KINDS.includes(kind)) refuse('unknown-extension-kind', 'only the declared extension kinds can be registered', { kind: String(kind) })
      if (registered.has(kind)) refuse('extension-already-registered', 'an implementation is already registered for this extension kind', { kind })
      const valid = implementation !== null && typeof implementation === 'object' && typeof implementation.id === 'string' && implementation.id !== ''
        && REQUIRED_METHODS[kind].every((method) => typeof implementation[method] === 'function')
      if (!valid) refuse('invalid-extension', `an ${kind} needs an id and its operation`, { kind })
      registered.set(kind, implementation)
      return implementation.id
    },
    get: (kind) => registered.get(kind) ?? null,
    applyOperation: () => registered.get('apply-operation') ?? UNAVAILABLE_APPLY_OPERATION,
    describe: () => EXTENSION_KINDS.map((kind) => ({ kind, id: registered.get(kind)?.id ?? null })),
  })
}

// Normalizes whatever an apply operation returned or threw into one typed
// result. The engine persists exactly this.
export function normalizeApplyResult(value) {
  if (value !== null && typeof value === 'object' && APPLY_RESULT_STATUSES.includes(value.status)) {
    return { status: value.status, code: typeof value.code === 'string' ? value.code.slice(0, 120) : value.status }
  }
  return { status: 'failed', code: 'invalid-apply-result' }
}

// ---------------------------------------------------------------------------
// Sub-operations of the `obsidian` command, and contributions
// ---------------------------------------------------------------------------

// Later work adds `obsidian <operation>` sub-operations the same way it adds
// an apply operation: by registering on a value, never by editing the command
// dispatcher. A built-in name cannot be taken, with one exception: `apply` is
// a placeholder that only reports `apply-unavailable`, and the work that ships
// an apply operation replaces it.
const OPERATION_NAME = /^[a-z][a-z0-9-]{0,31}$/
// The operations the command ships. The service composes the same registry, so both refuse the same contributions.
export const BUILT_IN_OPERATIONS = Object.freeze(['status', 'scope', 'audience', 'mode', 'policy', 'service', 'open', 'apply', 'help'])
export const REPLACEABLE_OPERATIONS = Object.freeze(['apply'])

export function createCommandOperations({ reserved = [] } = {}) {
  const registered = new Map()
  return Object.freeze({
    register(operation) {
      const valid = operation !== null && typeof operation === 'object' && typeof operation.name === 'string' && OPERATION_NAME.test(operation.name)
        && typeof operation.summary === 'string' && operation.summary !== '' && typeof operation.run === 'function'
      if (!valid) refuse('invalid-extension', 'a command operation needs a name, a summary and run()')
      // Optional: the shared options of the command this operation takes beyond the ones every operation takes.
      if (operation.options !== undefined && !(Array.isArray(operation.options) && operation.options.every((item) => typeof item === 'string'))) refuse('invalid-extension', 'a command operation declares its options as a list of names')
      if (reserved.includes(operation.name) && !REPLACEABLE_OPERATIONS.includes(operation.name)) refuse('operation-name-reserved', 'a built-in operation cannot be replaced', { name: operation.name })
      if (registered.has(operation.name)) refuse('extension-already-registered', 'an operation of this name is already registered', { name: operation.name })
      registered.set(operation.name, operation)
      return operation.name
    },
    get: (name) => registered.get(name) ?? null,
    describe: () => [...registered.values()].map(({ name, summary }) => ({ name, summary })).sort((left, right) => (left.name < right.name ? -1 : 1)),
  })
}

// One registry per composition: the maintenance extensions the engine reads
// and the operations the command reads. A contribution is
// `{ id, register({ extensions, operations }) }`; each is applied once, in order.
export function createObsidianRegistry({ reservedOperations = BUILT_IN_OPERATIONS, contributions = [] } = {}) {
  const registry = Object.freeze({ extensions: createMaintenanceExtensions(), operations: createCommandOperations({ reserved: reservedOperations }) })
  const applied = []
  for (const contribution of contributions) {
    if (contribution === null || typeof contribution !== 'object' || typeof contribution.id !== 'string' || contribution.id === '' || typeof contribution.register !== 'function') refuse('invalid-extension', 'a contribution needs an id and register()')
    if (applied.includes(contribution.id)) refuse('extension-already-registered', 'a contribution of this id was already applied', { id: contribution.id })
    contribution.register(registry)
    applied.push(contribution.id)
  }
  return Object.freeze({ ...registry, contributions: Object.freeze(applied) })
}
