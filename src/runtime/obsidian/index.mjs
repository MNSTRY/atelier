// Continuous maintenance of Obsidian views: typed enablement, private machine
// settings, observation by digest, pending edits and per-view freshness.
// Nothing here starts a process, a timer or a listener; `tick()` is explicit.
export { ObsidianMaintenanceRefusal } from './errors.mjs'
export { DISABLED_REASONS, ENABLEMENT_STATES, readObsidianEnablement } from './enablement.mjs'
export {
  LOCAL_POINTER_SCHEMA, MACHINE_SETTINGS_SCHEMA, MAINTENANCE_MODES, authorizeAutomaticApply, defaultDataRoot, defaultMachineSettings, ensureWorkspaceIdentity,
  installApplyPolicy, localPointerPath, protectedRoots, readLocalPointer, readMachineSettings, resolveDataRoot, workspaceStateRoot, writeLocalPointer, writeMachineSettings,
} from './machine-settings.mjs'
export { APPLY_RESULT_STATUSES, EXTENSION_KINDS, UNAVAILABLE_APPLY_OPERATION, createMaintenanceExtensions } from './extension-points.mjs'
export {
  CHANGE_CLASSES, CLOSED_EDIT_STATES, EDIT_STATES, FRESHNESS_SCHEMA, FRESHNESS_STATES, LATE_WRITERS_SCHEMA, OPEN_EDIT_STATES, PENDING_EDITS_SCHEMA,
  createMaintenanceStateStore, validateFreshness, validateLateWriters, validatePendingEdits,
} from './state-store.mjs'
export { listConfigFiles, listSourceFiles, listVaultNotes, reconcile } from './observation.mjs'
export { createFsWatcherFactory, createNullWatcherFactory } from './watchers.mjs'
export { DEFAULT_ELIGIBILITY, assetEligibilityFor, createProductionSeams } from './pipeline.mjs'
export { DEFAULT_FULL_RECONCILIATION_INTERVAL_MS, DEFAULT_LATE_WRITER_WINDOW_MS, DEFAULT_RETRY_INTERVAL_MS, createMaintenanceEngine } from './engine.mjs'
