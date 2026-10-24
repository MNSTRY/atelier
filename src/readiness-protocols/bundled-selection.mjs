import { AtelierDiagnosticError } from '../project/config.mjs'

// Selection belongs to tracked project configuration, like pack declarations.
// An absent setting preserves the published bundled default.
export function bundledReadinessEnabled(project) {
  const selection = project?.config?.ext?.['mnstry.atelier']?.readiness
  if (selection === undefined) return true
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new AtelierDiagnosticError('readiness-selection-invalid', 'Project readiness selection must be an object.')
  }
  if (selection.includeBundled === undefined) return true
  if (typeof selection.includeBundled !== 'boolean') {
    throw new AtelierDiagnosticError('readiness-selection-invalid', 'Project readiness includeBundled must be a boolean.')
  }
  return selection.includeBundled
}

export function requireBundledReadiness(project) {
  if (!bundledReadinessEnabled(project)) {
    throw new AtelierDiagnosticError('readiness-pack-disabled', 'The bundled readiness pack is disabled for this project.', {
      hint: 'Use the selected custom protocols, or explicitly select the bundled pack in tracked project configuration.',
    })
  }
}

export function requireSelectedReadinessProtocol(project, registry, protocolId) {
  if (!bundledReadinessEnabled(project) && !registry.protocolById(protocolId)) {
    throw new AtelierDiagnosticError('readiness-protocol-unavailable', 'The requested readiness protocol is unavailable in the selected packs.', {
      hint: 'Run readiness protocols with this project to list available protocol IDs.',
    })
  }
}
