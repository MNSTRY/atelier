import test from 'node:test'
import assert from 'node:assert/strict'
import * as personalWorkspace from '@mnstry/atelier/personal-workspace'

// The public API of @mnstry/atelier/personal-workspace is frozen at these fifteen
// exports. Adding or removing one is a deliberate, reviewed contract change.
test('the personal-workspace entry point exports exactly its frozen API', () => {
  assert.deepEqual(Object.keys(personalWorkspace).sort(), [
    'MANIFEST_SCHEMA',
    'OVERLAY_SCHEMA',
    'PersonalWorkspaceRefusal',
    'composePersonalWorkspace',
    'inventoryPersonalHome',
    'loadPersonalManifest',
    'loadPersonalOverlay',
    'materializePersonalGeneration',
    'planPersonalGeneration',
    'planPersonalRestore',
    'readPersonalSelection',
    'resolvePersonalWorkspace',
    'restorePersonalInputs',
    'selectPersonalGeneration',
    'selectionConfirmDigest',
  ])
})

test('the personal-workspace schema subpaths resolve to the schemas the module names', async () => {
  for (const [subpath, schema] of [
    ['@mnstry/atelier/contracts/atelier-personal-workspace-manifest.v1.schema.json', personalWorkspace.MANIFEST_SCHEMA],
    ['@mnstry/atelier/contracts/atelier-personal-workspace-overlay.v1.schema.json', personalWorkspace.OVERLAY_SCHEMA],
  ]) {
    const { default: document } = await import(subpath, { with: { type: 'json' } })
    assert.equal(document.title, schema)
  }
})
