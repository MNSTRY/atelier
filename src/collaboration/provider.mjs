export const ATELIER_AUTHORING_PROVIDER_SCHEMA = 'atelier-authoring-provider@v1'

const DIRECT_APPLY_RE = /(?:^|[._:-])(apply|write|commit|persist|mutate|database|db)(?:$|[._:-])/i

export function validateAuthoringProviderDescriptor(descriptor) {
  const issues = []
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return { ok: false, issues: ['provider descriptor must be an object'] }
  }
  if (descriptor.schema !== ATELIER_AUTHORING_PROVIDER_SCHEMA) issues.push('provider schema is unsupported')
  if (typeof descriptor.providerId !== 'string' || !descriptor.providerId.trim()) issues.push('providerId is required')
  if (typeof descriptor.peerId !== 'string' || !descriptor.peerId.trim()) issues.push('peerId is required')
  if (!Array.isArray(descriptor.operations) || descriptor.operations.length === 0) {
    issues.push('operations must be a nonempty array')
  } else if (descriptor.operations.some((operation) => DIRECT_APPLY_RE.test(operation))) {
    issues.push('direct apply operation is forbidden')
  }
  if (descriptor.sourceRepositoryRequired !== false) issues.push('sourceRepositoryRequired must be false')
  if (descriptor.directWrite !== false) issues.push('directWrite must be false')
  if (descriptor.applyEndpoint !== null) issues.push('applyEndpoint must be null')
  return issues.length === 0 ? { ok: true, value: descriptor } : { ok: false, issues }
}

export function createAuthoringProvider({ descriptor, codec, draftStore, transport }) {
  const validation = validateAuthoringProviderDescriptor(descriptor)
  if (!validation.ok) throw new TypeError(validation.issues.join('; '))
  for (const [name, value] of Object.entries({ codec, draftStore, transport })) {
    if (!value || typeof value !== 'object') throw new TypeError(`${name} is required`)
  }
  if (typeof codec.validateDraft !== 'function') throw new TypeError('codec.validateDraft is required')
  if (typeof draftStore.save !== 'function' || typeof draftStore.list !== 'function') {
    throw new TypeError('draftStore.save and draftStore.list are required')
  }
  for (const operation of descriptor.operations) {
    if (typeof transport[operation] !== 'function') {
      throw new TypeError(`transport.${operation} is required`)
    }
  }
  return Object.freeze({
    descriptor,
    validateDraft: (draft) => codec.validateDraft(draft),
    saveDraft: (draft) => draftStore.save(draft),
    listDrafts: () => draftStore.list(),
    async invoke(operation, input) {
      if (!descriptor.operations.includes(operation)) {
        throw new TypeError(`authoring operation ${operation} is not declared`)
      }
      if (DIRECT_APPLY_RE.test(operation)) {
        throw new TypeError('direct apply operation is forbidden')
      }
      return transport[operation](input)
    },
    directWrite: false,
    applyEndpoint: null,
  })
}

export function renderAuthoringProviderHarnessContext(descriptor) {
  const validation = validateAuthoringProviderDescriptor(descriptor)
  if (!validation.ok) throw new TypeError(validation.issues.join('; '))
  return {
    schema: 'atelier-authoring-harness-context@v1',
    providerId: descriptor.providerId,
    peerId: descriptor.peerId,
    operations: [...descriptor.operations],
    authority: {
      sourceRepositoryRequired: false,
      directWrite: false,
      applyEndpoint: null,
    },
    instructions: [
      'Resolve the exact authoring context before drafting.',
      'Validate and save drafts locally before invoking an external provider.',
      'Retain returned receipts as contributor-owned evidence.',
      'Never interpret review or acceptance as source-write authority.',
    ],
  }
}
