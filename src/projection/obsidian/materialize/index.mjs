// Materialization: the pure preparation layer for an Obsidian view. Nothing
// here writes into a vault; publication is a separate protocol.
export { EMITTER_VERSION, createPreparationCache, prepareView, withEligibility } from './prepare-view.mjs'
export { readMarkdownLens, assertStrictUtf8, sha256Digest } from './byte-lens.mjs'
export { PATH_REGISTRY_SCHEMA, allocateWorkspacePaths, collisionKey, emptyPathRegistry } from './path-registry.mjs'
export {
  COMMUNITY_PLUGINS_PATH, PLUGIN_OWNED_PATHS, POLICY_DISABLED_CORE_PLUGINS, POLICY_ENABLED_COMMUNITY_PLUGINS, POLICY_SETTINGS_PATH, POLICY_SETTINGS_PATHS, SETTINGS_ROOT,
  isPluginOwnedPath, isPolicySettingsPath, isUserOwnedSettingsPath, preparePolicySettingsFile, prepareSettings,
} from './settings.mjs'
export { stagePreparedView } from './stage.mjs'
