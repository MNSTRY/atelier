import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

export const LOCAL_AUDIENCES = ['public', 'team', 'operator', 'staff', 'private', 'sensitive']
export const RUNTIME_VISIBILITIES = ['private', 'shared', 'platform', 'public']

export const OBJECT_CLASSES = [
  'offer',
  'public_surface',
  'surface',
  'sdui_block',
  'commitment_path',
  'space',
  'trackable',
  'consent_boundary',
  'staff_prep',
  'provider_egress',
]

export const RUNTIME_OWNERS = [
  'identity',
  'catalog',
  'commitments',
  'events',
  'projection',
  'consent',
  'messaging',
  'providers',
  'audit',
]

export const ALLOWED_RUNTIME_TARGETS = [
  'content.material',
  'core.artifact',
  'core.trackable',
  'scheduling.commitment',
  'space.space',
  'space.provision',
]

const LOCAL_AUDIENCE_SET = new Set(LOCAL_AUDIENCES)
const RUNTIME_VISIBILITY_SET = new Set(RUNTIME_VISIBILITIES)
const LOCAL_RUNTIME_VISIBILITY_SET = new Set(
  LOCAL_AUDIENCES.filter((audience) => !RUNTIME_VISIBILITY_SET.has(audience))
)
const OBJECT_CLASS_SET = new Set(OBJECT_CLASSES)
const RUNTIME_OWNER_SET = new Set(RUNTIME_OWNERS)
const ALLOWED_RUNTIME_TARGET_SET = new Set(ALLOWED_RUNTIME_TARGETS)

const OBJECT_COLLECTION_TARGETS = {
  offers: 'content.material',
  surfaces: 'content.material',
  sdui: 'content.material',
  commitmentPaths: 'scheduling.commitment',
  spaces: 'space.space',
  trackables: 'core.trackable',
  consentBoundaries: 'core.artifact',
  staffPrep: 'core.artifact',
  providerEgress: 'core.artifact',
}

const IMPORT_OBJECT_CLASS_TARGETS = {
  offer: 'content.material',
  public_surface: 'content.material',
  surface: 'content.material',
  sdui_block: 'content.material',
  commitment_path: 'scheduling.commitment',
  space: 'space.space',
  trackable: 'core.trackable',
  consent_boundary: 'core.artifact',
  staff_prep: 'core.artifact',
  provider_egress: 'core.artifact',
}

const TARGET_FIELD_NAMES = new Set([
  'runtimeObject',
  'runtime_object',
  'targetObject',
  'target_object',
  'targetRuntimeObject',
  'target_runtime_object',
  'targetClass',
  'target_class',
])

const MUTATION_FLAG_KEYS = new Set([
  'apply',
  'write',
  'databasewrite',
  'database_write',
  'dbwrite',
  'db_write',
  'runtimemutation',
  'runtime_mutation',
  'mutation',
  'mutate',
  'persist',
  'commit',
  'commitwrite',
  'commit_write',
])

const TOP_LEVEL_MUTATION_SECTION_KEYS = new Set([
  'applyPlan',
  'databaseWrite',
  'database_write',
  'dbWrite',
  'db_write',
  'runtimeMutation',
  'runtime_mutation',
  'mutationPlan',
  'mutation_plan',
  'writePlan',
  'write_plan',
])

const SOURCE_REF_FIELD_NAMES = new Set([
  'sourceRef',
  'sourceRefs',
  'sourceNodeId',
  'sourceNodeIds',
  'sourceKgId',
  'sourceKgIds',
  'evidenceRef',
  'evidenceRefs',
  'evidenceKgId',
  'evidenceKgIds',
  'kgId',
  'kgIds',
])

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function stableCompare(left, right) {
  return String(left).localeCompare(String(right), 'en')
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(stableCompare)
}

function objectId(object, fallback) {
  if (typeof object?.id === 'string' && object.id.length > 0) return object.id
  if (typeof object?.providerClass === 'string' && object.providerClass.length > 0) {
    return `provider-egress:${object.providerClass}`
  }
  return fallback
}

function pointerEscape(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1')
}

function formatLocation(parts) {
  return `/${parts.map(pointerEscape).join('/')}`
}

function ajvForSchema() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  })
  addFormats(ajv)
  return ajv
}

function formatAjvError(error) {
  const location = error.instancePath || '/'
  if (error.keyword === 'additionalProperties') {
    return `${location} must not include additional property ${error.params?.additionalProperty ?? '(unknown)'}`
  }
  if (error.keyword === 'required') {
    return `${location} must include required property ${error.params?.missingProperty ?? '(unknown)'}`
  }
  if (error.keyword === 'enum') {
    return `${location} must be one of ${asArray(error.params?.allowedValues ?? error.schema).join(', ')}`
  }
  if (error.keyword === 'const') {
    return `${location} must be ${JSON.stringify(error.params?.allowedValue ?? error.schema)}`
  }
  if (error.keyword === 'pattern') {
    return `${location} must match pattern ${JSON.stringify(error.params?.pattern ?? error.schema)}`
  }
  if (error.keyword === 'minItems') {
    return `${location} must contain at least ${error.params?.limit ?? error.schema} item(s)`
  }
  return `${location} ${error.message ?? 'failed schema validation'}`
}

export function validateJsonSchema(schema, doc) {
  const validate = ajvForSchema().compile(schema)
  if (validate(doc)) return []
  return asArray(validate.errors).map(formatAjvError)
}

export function validateSchemaShape(schema) {
  const errors = []
  const sourceSha = schema?.properties?.sourceCommit?.properties?.sha
  const pricing = schema?.$defs?.offer?.properties?.pricing
  const band = pricing?.properties?.bands?.items
  const objectClassEnum = schema?.$defs?.objectClass?.enum
  const ownerEnum = schema?.$defs?.runtimeOwnerName?.enum
  const visibilityEnum = schema?.$defs?.visibility?.enum
  const dirtyRule = asArray(schema?.allOf).find((rule) => rule?.if?.properties?.dirtyTree?.const === true)

  if (sourceSha?.pattern !== '^[0-9a-f]{40}$') {
    errors.push('schema sourceCommit.sha must require a 40-character architecture repo SHA')
  }
  if (pricing?.properties?.currency?.pattern !== '^[A-Z]{3}$') {
    errors.push('schema pricing currency must require ISO-4217 shape')
  }
  if (!band?.required?.includes('amountMinor')) {
    errors.push('schema pricing band must require amountMinor')
  }
  if (band?.properties?.amount) {
    errors.push('schema pricing band must not expose legacy amount')
  }
  if (band?.properties?.amountMinor?.type !== 'integer') {
    errors.push('schema pricing band amountMinor must be integer')
  }
  for (const value of OBJECT_CLASSES) {
    if (!objectClassEnum?.includes(value)) errors.push(`schema objectClass enum missing ${value}`)
  }
  for (const value of RUNTIME_OWNERS) {
    if (!ownerEnum?.includes(value)) errors.push(`schema runtimeOwnerName enum missing ${value}`)
  }
  for (const value of RUNTIME_VISIBILITIES) {
    if (!visibilityEnum?.includes(value)) errors.push(`schema runtime visibility enum missing ${value}`)
  }
  for (const value of LOCAL_AUDIENCES.filter((audience) => !RUNTIME_VISIBILITY_SET.has(audience))) {
    if (visibilityEnum?.includes(value)) errors.push(`schema runtime visibility enum must not include local audience ${value}`)
  }
  if (dirtyRule?.then?.properties?.forced?.const !== true || !asArray(dirtyRule?.then?.required).includes('forced')) {
    errors.push('schema must force dirtyTree exports to set forced true')
  }
  if (dirtyRule?.then?.properties?.visibilityGate?.properties?.taint?.minItems !== 1) {
    errors.push('schema must force dirtyTree exports to carry non-empty taint')
  }
  const sourceNode = schema?.$defs?.sourceNode
  if (!sourceNode?.required?.includes('audience')) {
    errors.push('schema sourceNode must require audience')
  }
  if (sourceNode?.required?.includes('visibility') || Object.hasOwn(sourceNode?.properties ?? {}, 'visibility')) {
    errors.push('schema sourceNode must not expose visibility')
  }
  if (!Object.hasOwn(sourceNode?.properties ?? {}, 'audience')) {
    errors.push('schema sourceNode must expose audience')
  }
  return errors
}

function summarizeObjects(doc) {
  const byCollection = {}
  let total = 0
  for (const collection of Object.keys(doc?.objects ?? {}).sort(stableCompare)) {
    const rows = asArray(doc.objects[collection])
    const ids = rows.map((object, index) => objectId(object, `${collection}[${index}]`)).sort(stableCompare)
    byCollection[collection] = { count: rows.length, ids }
    total += rows.length
  }
  return { total, byCollection }
}

function summarizeSourceNodes(sourceNodesById) {
  return [...sourceNodesById.values()]
    .map((sourceNode) => ({
      kgId: sourceNode.kgId,
      audience: sourceNode.audience ?? null,
      publicProjectable: sourceNode?.audience === 'public',
    }))
    .sort((left, right) => stableCompare(left.kgId, right.kgId))
}

function deriveGraphProvenanceMode(doc, graphNodes) {
  if (Array.isArray(graphNodes) && graphNodes.length > 0) return 'verified'
  if (asArray(doc?.provenance?.sourceNodes).length > 0) return 'self-attested'
  return 'absent'
}

function addViolation(violations, pathValue, message, value = undefined) {
  const violation = { path: pathValue, message }
  if (value !== undefined) violation.value = value
  violations.push(violation)
}

function collectSourceNodes(doc, errors) {
  const sourceNodesById = new Map()
  for (const [index, sourceNode] of asArray(doc?.provenance?.sourceNodes).entries()) {
    const location = `/provenance/sourceNodes/${index}`
    if (sourceNode == null || typeof sourceNode !== 'object' || Array.isArray(sourceNode)) {
      errors.push(`${location} must be an object`)
      continue
    }
    if (Object.hasOwn(sourceNode, 'visibility')) {
      errors.push(`${location} must use audience, not visibility`)
    }
    if (typeof sourceNode.kgId !== 'string' || sourceNode.kgId.length === 0) {
      errors.push(`${location}/kgId must be a non-empty string`)
      continue
    }
    if (sourceNodesById.has(sourceNode.kgId)) {
      errors.push(`${location}/kgId duplicates provenance source node ${sourceNode.kgId}`)
    }
    if (!LOCAL_AUDIENCE_SET.has(sourceNode.audience)) {
      errors.push(`${location}/audience must be one of ${LOCAL_AUDIENCES.join(', ')}`)
    }
    sourceNodesById.set(sourceNode.kgId, sourceNode)
  }
  return sourceNodesById
}

function collectExportObjects(doc, errors) {
  const exportObjectsById = new Map()
  for (const [collection, rows] of Object.entries(doc?.objects ?? {})) {
    for (const [index, object] of asArray(rows).entries()) {
      const id = typeof object?.id === 'string' ? object.id : null
      if (!id) continue
      if (exportObjectsById.has(id)) {
        errors.push(`/objects/${collection}/${index}/id duplicates export object ${id}`)
      }
      exportObjectsById.set(id, {
        collection,
        index,
        object,
        path: `/objects/${collection}/${index}`,
      })
    }
  }
  return exportObjectsById
}

function resolveSourceRef(ref, context, stack = []) {
  const { sourceNodesById, exportObjectsById, errors, ownerPath } = context
  if (sourceNodesById.has(ref)) return [sourceNodesById.get(ref)]

  const exportObject = exportObjectsById.get(ref)
  if (!exportObject) {
    errors.push(`${ownerPath} sourceRef ${ref} does not resolve to provenance.sourceNodes or an export object`)
    return []
  }

  if (stack.includes(ref)) {
    errors.push(`${ownerPath} sourceRef ${ref} creates a sourceRef cycle`)
    return []
  }

  const nestedRefs = asArray(exportObject.object?.sourceRefs)
  if (nestedRefs.length === 0) {
    errors.push(`${ownerPath} sourceRef ${ref} resolves to export object ${exportObject.path} without provenance sourceRefs`)
    return []
  }

  return nestedRefs.flatMap((nestedRef) => {
    if (typeof nestedRef !== 'string' || nestedRef.length === 0) {
      errors.push(`${exportObject.path}/sourceRefs must contain only non-empty strings`)
      return []
    }
    return resolveSourceRef(nestedRef, { ...context, ownerPath: `${exportObject.path}/sourceRefs` }, [...stack, ref])
  })
}

function collectSourceRefFields(value, pathParts = [], refs = []) {
  if (value == null || typeof value !== 'object') return refs
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) collectSourceRefFields(child, [...pathParts, index], refs)
    return refs
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key]
    if (SOURCE_REF_FIELD_NAMES.has(key)) {
      const values = Array.isArray(child) ? child : [child]
      for (const [index, ref] of values.entries()) {
        const refPath = Array.isArray(child) ? [...nextPath, index] : nextPath
        refs.push({ ref, path: formatLocation(refPath) })
      }
      continue
    }
    collectSourceRefFields(child, nextPath, refs)
  }
  return refs
}

function validateSourceRefs(doc, sourceNodesById, exportObjectsById, errors) {
  const publicResolvedKgIds = new Set()
  for (const [collection, rows] of Object.entries(doc?.objects ?? {})) {
    for (const [index, object] of asArray(rows).entries()) {
      if (object == null || typeof object !== 'object' || Array.isArray(object)) continue
      const ownerPath = `/objects/${collection}/${index}`
      const refs = collectSourceRefFields(object, ['objects', collection, index])
      const seen = new Set()
      const resolvedSourceNodes = []

      for (const { ref, path } of refs) {
        if (seen.has(`${path}:${ref}`)) continue
        seen.add(`${path}:${ref}`)
        if (typeof ref !== 'string' || ref.length === 0) {
          errors.push(`${path} must be a non-empty source reference string`)
          continue
        }
        resolvedSourceNodes.push(
          ...resolveSourceRef(ref, {
            sourceNodesById,
            exportObjectsById,
            errors,
            ownerPath: path,
          })
        )
      }

      if (object.visibility === 'public') {
        for (const sourceNode of resolvedSourceNodes) {
          publicResolvedKgIds.add(sourceNode.kgId)
          if (sourceNode.audience !== 'public') {
            errors.push(
              `${ownerPath} is public but source node ${sourceNode.kgId} audience ${sourceNode.audience ?? '(missing)'} is not public-projectable`
            )
          }
        }
      }
    }
  }
  return [...publicResolvedKgIds].sort(stableCompare)
}

function validateGraphSourceRefs(nodes, publicSourceRefs, errors) {
  if (!Array.isArray(nodes) || nodes.length === 0) return
  const verdict = publicSourceVerdict(nodes, publicSourceRefs)
  if (!verdict.ok) {
    for (const failure of verdict.failures) {
      errors.push(`public sourceRef ${failure.kgId} is not public-safe: ${failure.reason}`)
    }
  }
}

function publicSourceVerdict(nodes, kgIds) {
  const byId = new Map((nodes ?? []).map((node) => [node.id, node]))
  const failures = []
  for (const kgId of kgIds) {
    const node = byId.get(kgId)
    if (!node) {
      failures.push({ kgId, reason: 'source-node-not-found' })
      continue
    }
    if (node?.audience !== 'public') {
      failures.push({
        kgId,
        reason: `audience-${node?.audience ?? 'missing'}-blocked-for-public`,
        audience: node?.audience ?? null,
      })
    }
  }
  return { ok: failures.length === 0, failures }
}

function validateGraphProvenance(doc, nodes, errors) {
  if (!Array.isArray(nodes) || nodes.length === 0) return
  const graphById = new Map((nodes ?? []).map((node) => [node.id, node]))
  for (const [index, sourceNode] of asArray(doc?.provenance?.sourceNodes).entries()) {
    const kgId = sourceNode?.kgId
    const graphNode = graphById.get(kgId)
    if (!graphNode) {
      errors.push(`provenance sourceNode ${index} kgId ${kgId ?? '(missing)'} was not found in the source provenance graph`)
      continue
    }
    if (sourceNode?.audience && sourceNode.audience !== graphNode.audience) {
      errors.push(`provenance sourceNode ${index} audience ${sourceNode.audience} does not match graph audience ${graphNode.audience}`)
    }
  }
}

function validateMutationIntent(doc, errors, { dryRunOnly }) {
  if (dryRunOnly && doc?.importPlan?.mode === 'apply') {
    errors.push('/importPlan/mode must be dry-run for atelier-export@v1 dry-run validation')
  }
  if (dryRunOnly && doc?.importPlan?.mode != null && doc.importPlan.mode !== 'dry-run') {
    errors.push('/importPlan/mode must be dry-run')
  }

  const topLevel = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  for (const key of Object.keys(topLevel)) {
    if (!TOP_LEVEL_MUTATION_SECTION_KEYS.has(key)) continue
    errors.push(`/${key} declares mutation/write intent and is not allowed in dry-run validation`)
  }

  const sections = [
    { path: [], value: doc },
    { path: ['importPlan'], value: doc?.importPlan },
    { path: ['import'], value: doc?.import },
    { path: ['importer'], value: doc?.importer },
    { path: ['runtimeImport'], value: doc?.runtimeImport },
    { path: ['execution'], value: doc?.execution },
  ]

  for (const section of sections) scanMutationFlags(section.value, section.path, errors)
}

function scanMutationFlags(value, pathParts, errors) {
  if (value == null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) scanMutationFlags(item, [...pathParts, index], errors)
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase()
    const location = formatLocation([...pathParts, key])
    if (MUTATION_FLAG_KEYS.has(normalizedKey) && child !== false && child !== null && child !== 'dry-run') {
      errors.push(`${location} declares mutation/write intent and is not allowed in dry-run validation`)
    }
    if (key === 'dryRun' && child === false) {
      errors.push(`${location} must not be false for dry-run validation`)
    }
    if (key === 'mode' && typeof child === 'string' && ['apply', 'write', 'mutate'].includes(child)) {
      errors.push(`${location} declares ${child} intent and is not allowed in dry-run validation`)
    }
    scanMutationFlags(child, [...pathParts, key], errors)
  }
}

function runtimeTargetForImportClass(objectClass) {
  if (ALLOWED_RUNTIME_TARGET_SET.has(objectClass)) return objectClass
  return IMPORT_OBJECT_CLASS_TARGETS[objectClass] ?? null
}

function validateImportPlanTargets(doc, runtimeTargets, semanticProfileViolations) {
  for (const [index, owner] of asArray(doc?.importPlan?.runtimeOwners).entries()) {
    const sourceObjectClass = owner?.objectClass
    const targetObject = runtimeTargetForImportClass(sourceObjectClass)
    const ownerPath = `/importPlan/runtimeOwners/${index}/objectClass`
    if (!targetObject) {
      addViolation(
        semanticProfileViolations,
        ownerPath,
        `unsupported target runtime object/class ${sourceObjectClass ?? '(missing)'}`,
        sourceObjectClass ?? null
      )
      continue
    }
    runtimeTargets.push({
      path: `/importPlan/runtimeOwners/${index}`,
      sourceObjectClass,
      targetObject,
      owner: owner?.owner ?? null,
    })
  }

  for (const [index, operation] of asArray(doc?.importPlan?.operations).entries()) {
    const sourceObjectClass = operation?.objectClass
    const targetObject = runtimeTargetForImportClass(sourceObjectClass)
    const operationPath = `/importPlan/operations/${index}/objectClass`
    if (!targetObject) {
      addViolation(
        semanticProfileViolations,
        operationPath,
        `unsupported target runtime object/class ${sourceObjectClass ?? '(missing)'}`,
        sourceObjectClass ?? null
      )
      continue
    }
    runtimeTargets.push({
      path: `/importPlan/operations/${index}`,
      externalId: operation?.externalId ?? null,
      sourceObjectClass,
      targetObject,
      op: operation?.op ?? null,
      status: operation?.status ?? null,
    })
  }
}

function validateDeclaredRuntimeTargetFields(value, pathParts, semanticProfileViolations) {
  if (value == null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateDeclaredRuntimeTargetFields(item, [...pathParts, index], semanticProfileViolations)
    }
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const location = formatLocation([...pathParts, key])
    if (TARGET_FIELD_NAMES.has(key) && typeof child === 'string' && !ALLOWED_RUNTIME_TARGET_SET.has(child)) {
      addViolation(semanticProfileViolations, location, `unsupported target runtime object/class ${child}`, child)
    }
    validateDeclaredRuntimeTargetFields(child, [...pathParts, key], semanticProfileViolations)
  }
}

function deriveObjectRuntimeTargets(doc, runtimeTargets, semanticProfileViolations, errors) {
  for (const [collection, targetObject] of Object.entries(OBJECT_COLLECTION_TARGETS)) {
    for (const [index, object] of asArray(doc?.objects?.[collection]).entries()) {
      const objectPath = `/objects/${collection}/${index}`
      const id = objectId(object, `${collection}[${index}]`)
      const target = {
        path: objectPath,
        id,
        collection,
        targetObject,
      }

      if (Object.hasOwn(object ?? {}, 'visibility')) {
        if (!RUNTIME_VISIBILITY_SET.has(object.visibility)) {
          addViolation(
            semanticProfileViolations,
            `${objectPath}/visibility`,
            `runtime visibility must be one of ${RUNTIME_VISIBILITIES.join(', ')}`,
            object.visibility ?? null
          )
          if (LOCAL_RUNTIME_VISIBILITY_SET.has(object.visibility)) {
            errors.push(
              `${objectPath}/visibility uses local audience ${object.visibility}; runtime/export visibility must be one of ${RUNTIME_VISIBILITIES.join(', ')}`
            )
          }
        } else {
          target.visibility = object.visibility
        }
      }

      runtimeTargets.push(target)
    }
  }
}

function summarizeImportOperations(doc) {
  const counts = { ready: 0, warning: 0, blocked: 0, other: 0 }
  for (const operation of asArray(doc?.importPlan?.operations)) {
    if (Object.hasOwn(counts, operation?.status)) counts[operation.status] += 1
    else counts.other += 1
  }
  let worstOperationStatus = 'ready'
  if (counts.other > 0) worstOperationStatus = 'other'
  if (counts.warning > 0) worstOperationStatus = 'warning'
  if (counts.blocked > 0) worstOperationStatus = 'blocked'
  return {
    counts,
    worstOperationStatus,
    total: asArray(doc?.importPlan?.operations).length,
  }
}

function hasPublicRuntimeVisibility(runtimeTargets) {
  return runtimeTargets.some((target) => target.visibility === 'public')
}

function reportBase({
  accepted,
  importable,
  graphProvenanceMode,
  errors,
  warnings,
  objects,
  sourceNodes,
  runtimeTargets,
  semanticProfileViolations,
  operationSummary,
}) {
  return {
    accepted,
    importable,
    worstOperationStatus: operationSummary.worstOperationStatus,
    graphProvenanceMode,
    operationSummary,
    errors: uniqueSorted(errors),
    warnings: uniqueSorted(warnings),
    objects,
    sourceNodes,
    runtimeTargets,
    semanticProfileViolations: [...semanticProfileViolations].sort((left, right) => {
      return stableCompare(`${left.path}:${left.message}`, `${right.path}:${right.message}`)
    }),
  }
}

export function validateAtelierExportContract(doc, { schema, graphNodes = [], dryRunOnly = false } = {}) {
  const errors = []
  const warnings = []
  const semanticProfileViolations = []
  const runtimeTargets = []

  if (schema) errors.push(...validateJsonSchema(schema, doc).map((error) => `schema ${error}`))

  const sourceNodesById = collectSourceNodes(doc, errors)
  const exportObjectsById = collectExportObjects(doc, errors)
  validateGraphProvenance(doc, graphNodes, errors)
  const publicSourceRefs = validateSourceRefs(doc, sourceNodesById, exportObjectsById, errors)
  validateGraphSourceRefs(graphNodes, publicSourceRefs, errors)
  validateMutationIntent(doc, errors, { dryRunOnly })
  deriveObjectRuntimeTargets(doc, runtimeTargets, semanticProfileViolations, errors)
  validateImportPlanTargets(doc, runtimeTargets, semanticProfileViolations)
  validateDeclaredRuntimeTargetFields(doc, [], semanticProfileViolations)

  for (const [index, owner] of asArray(doc?.importPlan?.runtimeOwners).entries()) {
    if (!OBJECT_CLASS_SET.has(owner?.objectClass)) {
      errors.push(`runtime owner ${index} invalid runtime owner objectClass ${owner?.objectClass ?? '(missing)'}`)
    }
    if (!RUNTIME_OWNER_SET.has(owner?.owner)) {
      errors.push(`runtime owner ${index} invalid runtime owner ${owner?.owner ?? '(missing)'}`)
    }
  }

  for (const [index, operation] of asArray(doc?.importPlan?.operations).entries()) {
    if (!OBJECT_CLASS_SET.has(operation?.objectClass)) {
      errors.push(`operation ${index} invalid operation objectClass ${operation?.objectClass ?? '(missing)'}`)
    }
  }

  runtimeTargets.sort((left, right) => stableCompare(left.path, right.path))
  const operationSummary = summarizeImportOperations(doc)
  const graphProvenanceMode = deriveGraphProvenanceMode(doc, graphNodes)
  const accepted = errors.length === 0 && semanticProfileViolations.length === 0
  const graphReadyForPublicImport =
    graphProvenanceMode === 'verified' || !hasPublicRuntimeVisibility(runtimeTargets)
  const importable =
    accepted &&
    operationSummary.worstOperationStatus === 'ready' &&
    asArray(doc?.blockers).length === 0 &&
    graphReadyForPublicImport

  return reportBase({
    accepted,
    importable,
    graphProvenanceMode,
    errors,
    warnings,
    objects: summarizeObjects(doc),
    sourceNodes: summarizeSourceNodes(sourceNodesById),
    runtimeTargets,
    semanticProfileViolations,
    operationSummary,
  })
}
