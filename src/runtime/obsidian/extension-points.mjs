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
