// Continuous maintenance of Obsidian views: typed enablement, private machine
// settings, observation by digest, pending edits and per-view freshness.
// The engine starts no process, timer or listener; `tick()` is explicit. The
// owned lifecycle (start / status / stop of one loopback service per
// workspace) is separate, below, and is the only thing here that does.
export { ObsidianMaintenanceRefusal } from './errors.mjs'
export { DISABLED_REASONS, ENABLEMENT_STATES, readObsidianEnablement } from './enablement.mjs'
export {
  DECISIONS, DECISION_SOURCES, LOCAL_POINTER_SCHEMA, MACHINE_SETTINGS_SCHEMA, MACHINE_SETTINGS_SCHEMA_V1, MAINTENANCE_MODES, ONLY_YOU_AUDIENCES, authorizeAutomaticApply,
  defaultDataRoot, defaultMachineSettings, ensureWorkspaceIdentity, installApplyPolicy, localPointerPath, protectedRoots, readInstalledApplyPolicy, readLocalPointer,
  readMachineSettings, resolveDataRoot, revokeApplyPolicy, withDecision, workspaceStateRoot, writeLocalPointer, writeMachineSettings,
} from './machine-settings.mjs'
export { APPLY_RESULT_STATUSES, BUILT_IN_OPERATIONS, EXTENSION_KINDS, REPLACEABLE_OPERATIONS, UNAVAILABLE_APPLY_OPERATION, createCommandOperations, createMaintenanceExtensions, createObsidianRegistry } from './extension-points.mjs'
export { CONTRIBUTIONS_DIRECTORY, loadContributions } from './contributions.mjs'
export { APP_OUTCOMES, MINIMUM_APP_VERSION, compareAppVersions, createQualifiedAdapterFactory, meetsMinimumAppVersion, parseAppVersion, qualifyApp } from './app-capability.mjs'
export { OPENING_OUTCOMES, describeOutcome, openScope, scopeReport } from './opening.mjs'
export { appStateSignature, registerVaultInObsidianSettings } from './app-registration.mjs'
export {
  CHANGE_CLASSES, CLOSED_EDIT_STATES, EDIT_STATES, FRESHNESS_SCHEMA, FRESHNESS_STATES, LATE_WRITERS_SCHEMA, OPEN_EDIT_STATES, PENDING_EDITS_SCHEMA,
  createMaintenanceStateStore, validateFreshness, validateLateWriters, validatePendingEdits,
} from './state-store.mjs'
export { listConfigFiles, listSourceFiles, listVaultNotes, reconcile } from './observation.mjs'
export { createFsWatcherFactory, createNullWatcherFactory } from './watchers.mjs'
export { DEFAULT_ELIGIBILITY, assetEligibilityFor, createProductionSeams } from './pipeline.mjs'
export { DEFAULT_FULL_RECONCILIATION_INTERVAL_MS, DEFAULT_LATE_WRITER_WINDOW_MS, DEFAULT_PUBLICATION_RETRY_MS, DEFAULT_RETRY_INTERVAL_MS, createMaintenanceEngine } from './engine.mjs'
export { ENGINE_LOCK_DIRECTORY, LOCK_TICKET_SCHEMA, acquirePrivateGenerationLock, createAbandonmentProof, inspectPrivateGenerationLock } from './private-lock.mjs'
export { DEFAULT_MAX_BACKOFF_MS, DEFAULT_TICK_INTERVAL_MS, createTickLoop } from './tick-loop.mjs'
export { HEALTH_SCHEMA, LOOPBACK_HOSTS, probeHealth, requestLoopback } from './service-client.mjs'
export {
  CONSENT_COVERAGES, SERVICE_ERROR_SCHEMA, SERVICE_SETTINGS_SCHEMA, executableIdentity, publicRecord, readLastServiceError, readServiceRecord, readServiceSettings,
  removeServiceRecord, serviceNameFor, servicePaths, validateServiceRecord, writeServiceRecord, writeServiceSettings,
} from './service-record.mjs'
export { MAX_REQUEST_BYTES, SERVICE_OPERATIONS, createServiceServer } from './service-server.mjs'
export { PLUGIN_BEARER_SCHEMA, PLUGIN_PRESENCE_SCHEMA, createPluginChannel, createPluginSessions, ensurePluginBearer, pluginBearerDirectory, pluginPresence, readPluginBearers } from './plugin-channel.mjs'
export { PLUGIN_PRESENCE_REASONS, pluginPresenceOf, turnPluginOnNext, withPluginReportedVersion } from './plugin-presence.mjs'
export { PLUGIN_CHOICE_SCHEMA, PLUGIN_CHOICE_STATES, confirmPluginEntry, confirmPluginSeen, currentPluginChoice, decidePluginChoice, pluginChoiceDirectory, readCommunityEntry, readPluginChoice, viewVaultRoot, writePluginChoice } from './plugin-choice.mjs'
export { DEFAULT_SHUTDOWN_GRACE_MS, SERVICE_STATUS_SCHEMA, resolveServiceWorkspace, runMaintenanceService } from './service.mjs'
export { DEFAULT_START_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, SERVICE_STATES, readServiceStatusDocument, requestServiceTick, serviceStatus, startService, stopService } from './lifecycle.mjs'
export { STARTUP_PLATFORMS, buildStartupAdapter } from './startup-adapters.mjs'
