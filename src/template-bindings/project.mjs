import fs from 'node:fs'
import { buildCanonicalGraph, createGraphFileCache } from '../graph/graph.mjs'
import { projectGraph, PROJECTION_TARGETS } from '../projection/policy.mjs'
import { renderReadOnlyDocument, validatePresentation } from '../ui/presentation/index.mjs'
import { templateReference, validateTemplateDefinition, validateTemplateBinding, validateTemplateHost } from '../templates/profile.mjs'

const packageVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const identity = value => templateReference('PayloadRef', 'identity', '1', value).digest.slice(7, 39)
const outcome = (ok, errors, rest = {}) => ({ ok, errors, authority: 'structural-only', executionAuthority: false, publicationAuthority: false, conformanceClaim: 'none', ...rest })

/** Read-only composition over a loaded project, not a graph or source writer.
 * The request is bounded JSON text: {profile, projectRef, roleNodeIds, target,
 * theme?}. This initial binding supports classified active Markdown resources,
 * Resource bindings and CollectionView/StatusView. Other requirements
 * refuse instead of being converted to a superficially similar surface.
 */
export function createTemplateProjectView(project, requestJson) {
  try {
    if (typeof requestJson !== 'string' || Buffer.byteLength(requestJson) > 1048576) return outcome(false, ['invalid request'])
    const request = JSON.parse(requestJson)
    // The profile reference validator also enforces bounded plain JSON before
    // the request is used; no caller-supplied accessors enter this adapter.
    templateReference('PayloadRef', 'request', '1', request)
    if (!request || Array.isArray(request) || Object.keys(request).some(key => !['profile', 'projectRef', 'roleNodeIds', 'target', 'theme'].includes(key))) return outcome(false, ['invalid request'])
    const { profile, projectRef, roleNodeIds, target, theme = 'light' } = request
    const definition = validateTemplateDefinition(profile)
    if (!definition.ok) return outcome(false, definition.errors)
    if (!Object.hasOwn(PROJECTION_TARGETS, target)) return outcome(false, ['unknown projection target'])
    if (!roleNodeIds || Array.isArray(roleNodeIds) || typeof roleNodeIds !== 'object') return outcome(false, ['invalid role selection'])
    if (profile.runtimeProfileRef !== null) return outcome(false, ['runtime profile requires its owning adapter'])
    const templateRef = templateReference('TemplateRef', profile.id, profile.version, profile)
    const host = validateTemplateHost(profile, {
      schema: 'atelier-template-host@v1', templateRef, carrier: 'web', atelierVersion: packageVersion,
      packRefs: [], semanticPrimitives: ['Resource'], surfacePrimitives: ['CollectionView', 'StatusView'],
      runtimeProfileRef: null, optionalDecisions: [],
    })
    if (!host.ok) return outcome(false, host.errors)
    const cache = createGraphFileCache()
    const graph = buildCanonicalGraph(project, { fileCache: cache })
    if (!graph.ok) return outcome(false, ['canonical graph invalid'])
    const projected = projectGraph(graph, { target })
    const visible = new Map(projected.nodes.filter(node => node.classification === 'classified' && node.status === 'active').map(node => [node.id, node]))
    const records = [], sources = new Map(), roles = []
    for (const [roleRef, ids] of Object.entries(roleNodeIds)) {
      if (!profile.semanticRoles.some(role => role.id === roleRef) || !Array.isArray(ids) || !ids.length || ids.length > 256 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) return outcome(false, ['invalid role selection'])
      if (profile.semanticRoles.find(role => role.id === roleRef).primitive !== 'Resource') return outcome(false, ['semantic role has no canonical binding'])
      const refs = []
      for (const id of ids) {
        const node = visible.get(id)
        // A node's audience cannot widen its repository's read boundary.
        if (!node || !PROJECTION_TARGETS[target].has(node.repoAccess?.readBoundary)) return outcome(false, ['selected source unavailable for this view'])
        const source = cache.files.get(`${node.repo}\u0000${node.path}`)
        if (!source || !/^[a-f0-9]{64}$/.test(source.digest)) return outcome(false, ['source byte pin unavailable'])
        if (!sources.has(id)) {
          const document = { nodeId: id, repository: node.repo, path: node.path, rawDigest: `sha256:${source.digest}`, title: node.title, summary: node.summary }
          const ref = templateReference('SourceRef', `source.${identity(id)}`, document.rawDigest, document)
          sources.set(id, { ref, document }); records.push({ ref, document })
        }
        refs.push(sources.get(id).ref)
      }
      roles.push({ roleRef, sourceRefs: refs })
    }
    const binding = { schema: 'atelier-template-binding@v1', id: `binding.${identity(projectRef)}`, version: '1.0.0', templateRef, projectRef, roles }
    const checked = validateTemplateBinding(profile, binding, records)
    if (!checked.ok) return outcome(false, checked.errors)
    const bindingRef = templateReference('BindingRef', binding.id, binding.version, binding)
    const nodes = profile.surfaceRoles.map((view, index) => {
      const id = `view-${index}`
      if (view.primitive === 'StatusView') return { id, type: 'status', label: view.id, text: 'Read-only local projection. Runtime actions and publication are unavailable.', tone: 'neutral', details: host.diagnostics.map(item => ({ label: item.id, value: item.kind === 'semantic-role' ? 'Optional role unsupported; binding unavailable' : `${item.status}; deterministic or manual fallback` })), actions: [] }
      const sourceIds = [...new Set(view.semanticRoleRefs.flatMap(role => roleNodeIds[role] ?? []))]
      return { id, type: 'collection', label: view.id, items: sourceIds.map(sourceId => ({ id: `item-${identity(sourceId)}`, label: sources.get(sourceId).document.title, detail: sources.get(sourceId).document.summary })) }
    })
    nodes.unshift({ id: 'description', type: 'text', label: 'Inputs and limits', text: `Inputs: ${profile.inputs.join('; ')}. Limits: ${profile.limitations.join('; ')}` })
    const model = { schema: 'atelier.presentation/v1', version: '1.0.0', id: `template-${identity(profile.id)}`, title: profile.purpose, lang: 'en', direction: 'ltr', theme, density: 'comfortable', navigation: [], panes: [{ id: 'content', label: 'Template preview', role: 'primary', blocks: nodes.map(node => node.id) }], nodes }
    if (validatePresentation(model).length) return outcome(false, ['presentation binding invalid'])
    // Reuse the exact same non-interactive renderer for local web and document
    // preview. This creates bytes only; it does not publish or erase old copies.
    const html = renderReadOnlyDocument(model)
    const textPreview = [model.title, ...nodes.flatMap(node => [node.label, ...(node.items ? node.items.flatMap(item => [item.label, item.detail]) : [node.text]), ...(node.details ?? []).map(item => `${item.label}: ${item.value}`)])].join('\n\n')
    return outcome(true, [], { templateRef, bindingRef, binding, records, model, html, textPreview, capabilityDiagnostics: host.diagnostics, optionalDecisions: host.diagnostics.filter(item => item.kind !== 'semantic-role'), target, lifecycle: 'active-only', artifacts: { web: html, documents: html } })
  } catch {
    // Do not disclose source paths or source text through exception messages.
    return outcome(false, ['template project composition refused'])
  }
}
