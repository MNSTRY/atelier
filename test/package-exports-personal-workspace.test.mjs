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
