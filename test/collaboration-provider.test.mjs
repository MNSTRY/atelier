import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAuthoringProvider,
  renderAuthoringProviderHarnessContext,
  validateAuthoringProviderDescriptor,
} from '../src/collaboration/provider.mjs'

const descriptor = {
  schema: 'atelier-authoring-provider@v1',
  providerId: 'synthetic-collaboration',
  peerId: 'peer:synthetic:publication',
  operations: ['getContext', 'submitDraft', 'getStatus', 'withdrawDraft'],
  sourceRepositoryRequired: false,
  directWrite: false,
  applyEndpoint: null,
}

test('authoring provider is protocol-neutral and refuses apply capabilities', async () => {
  assert.equal(validateAuthoringProviderDescriptor(descriptor).ok, true)
  assert.equal(
    validateAuthoringProviderDescriptor({ ...descriptor, operations: [...descriptor.operations, 'apply.patch'] }).ok,
    false,
  )
  const drafts = []
  const provider = createAuthoringProvider({
    descriptor,
    codec: { validateDraft: (draft) => ({ ok: Boolean(draft.value), draft }) },
    draftStore: {
      save: (draft) => drafts.push(draft),
      list: () => drafts,
    },
    transport: Object.fromEntries(
      descriptor.operations.map((operation) => [operation, async (input) => ({ operation, input })]),
    ),
  })
  provider.saveDraft({ value: 'Synthetic draft' })
  assert.equal(provider.listDrafts().length, 1)
  assert.equal((await provider.invoke('submitDraft', { value: 'Synthetic draft' })).operation, 'submitDraft')
  assert.equal(provider.directWrite, false)
  const context = renderAuthoringProviderHarnessContext(descriptor)
  assert.equal(context.authority.sourceRepositoryRequired, false)
  assert.match(context.instructions.join(' '), /Never interpret review or acceptance/u)
})
