import { projectExtMember } from '../../project/config.mjs'
import { OBSIDIAN_EXT_KEY, ObsidianContractRefusal, assertObsidianContract } from '../../projection/obsidian/contracts.mjs'
import { refuse } from './errors.mjs'

// Typed enablement. The project v1 schema is unchanged: a project without the
// ext member is valid and means "not configured", which is disabled. A member
// that is present must satisfy the closed ext-settings contract exactly. An
// unknown key or value refuses here; it is never ignored and never read as
// permission, so a newer or mistyped setting cannot switch anything on.

export const ENABLEMENT_STATES = Object.freeze(['disabled', 'enabled'])
export const DISABLED_REASONS = Object.freeze(['not-configured', 'disabled-in-settings'])

const SCOPE_SCHEMA = 'atelier-obsidian-scope/v1'

function scopeDocument({ scopeId, mode, selector, expansion, ext }) {
  return {
    schema: SCOPE_SCHEMA,
    scopeId,
    mode,
    selector,
    ...(expansion === undefined ? {} : { expansion }),
    ...(ext === undefined ? {} : { ext }),
  }
}

function assertOrRefuse(shape, document, code, message) {
  try {
    return assertObsidianContract(shape, document)
  } catch (error) {
    if (error instanceof ObsidianContractRefusal) refuse(code, message, { errors: error.detail?.errors ?? [] })
    throw error
  }
}

// Returns a frozen { state, reason, settings, scopes, defaultScopeId }.
// `scopes` are complete scope contract documents, in declared order, and are
// listed even when the integration is disabled so a caller can name them.
export function readObsidianEnablement(project) {
  const member = projectExtMember(project, OBSIDIAN_EXT_KEY)
  if (!member.present) {
    return Object.freeze({ state: 'disabled', reason: 'not-configured', settings: null, scopes: Object.freeze([]), defaultScopeId: null })
  }
  const settings = assertOrRefuse('ext-settings', member.value, 'invalid-ext-settings', 'the project Obsidian settings do not satisfy their contract; nothing is enabled')
  const scopes = settings.scopes.map((scope) => assertOrRefuse('scope', scopeDocument(scope), 'invalid-ext-settings', 'a declared scope does not satisfy the scope contract; nothing is enabled'))
  return Object.freeze({
    state: settings.enabled === true ? 'enabled' : 'disabled',
    reason: settings.enabled === true ? 'enabled' : 'disabled-in-settings',
    settings,
    scopes: Object.freeze(scopes),
    defaultScopeId: settings.defaultScopeId ?? null,
  })
}
