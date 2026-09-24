// Materialization: the pure preparation layer for an Obsidian view. Nothing
// here writes into a vault; publication is a separate protocol.
export { CURRENT_VAULT_LAYOUT, EMITTER_VERSION, createPreparationCache, prepareView, withEligibility } from './prepare-view.mjs'
export { readMarkdownLens, assertStrictUtf8, sha256Digest } from './byte-lens.mjs'
export { PATH_REGISTRY_SCHEMA, allocateViewPaths, collisionKey, emptyPathRegistry } from './path-registry.mjs'
export { POLICY_DISABLED_CORE_PLUGINS, POLICY_SETTINGS_PATH, SETTINGS_ROOT, isPolicySettingsPath, isUserOwnedSettingsPath, prepareSettings } from './settings.mjs'
export { stagePreparedView } from './stage.mjs'
