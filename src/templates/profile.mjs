import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { canonicalize } from '../attestation/jcs.mjs'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'
import { validateDecisionRequest, validateDecisionResult } from '../decisions/contracts.mjs'

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-template-profile.v1.schema.json', import.meta.url), 'utf8'))
const shapes = Object.fromEntries(Object.keys(schema.$defs).map(kind => [kind, {
  $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${kind}`,
}]))
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const referenceKinds = new Set(Object.keys(schema.$defs).filter(kind => kind.endsWith('Ref')))

// Inspect descriptors before traversing untrusted values; no getters or toJSON.
// All public entry points snapshot once before relational or hash checks.
function snapshot(input) {
  const ancestors = new Set()
  let nodes = 0, bytes = 0
  function copy(value, depth) {
    if (++nodes > 20000 || depth > 24) throw new TypeError('template input limit')
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) {
      if (typeof value === 'string' && value.length > 1048576) throw new TypeError('template input limit')
      bytes += Buffer.byteLength(JSON.stringify(value))
      if (bytes > 1048576) throw new TypeError('template input limit')
      return value
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new TypeError('template input is not JSON')
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError('template input prototype')
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== 'string' || forbidden.has(key))) throw new TypeError('template input key')
    ancestors.add(value)
    const result = array ? [] : {}
    if (array && (descriptors.length.value > 20000 || keys.length !== descriptors.length.value + 1)) throw new TypeError('template array shape')
    for (const key of keys) {
      if (array && key === 'length') continue
      const d = descriptors[key]
      if (!Object.hasOwn(d, 'value') || !d.enumerable || array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError('template input descriptor')
      bytes += Buffer.byteLength(key) + 4
      if (bytes > 1048576) throw new TypeError('template input limit')
      result[key] = copy(d.value, depth + 1)
    }
    if (array && result.length !== descriptors.length.value) throw new TypeError('template sparse array')
    ancestors.delete(value)
    return result
  }
  return copy(input, 0)
}

function shape(kind, value, errors) {
  const invalid = validateJsonSchema(shapes[kind], value).length > 0
  if (invalid) errors.push(`invalid ${kind} shape`)
  return !invalid
}
function same(a, b) { return canonicalize(a) === canonicalize(b) }
function unique(items, key, errors, label) {
  if (new Set(items.map(key)).size !== items.length) errors.push(`duplicate ${label}`)
}
function refFor(kind, id, version, document) {
  if (!referenceKinds.has(kind)) throw new TypeError('unsupported reference kind')
  const domain = { schema: 'atelier-template-digest@v1', kind, id, version, document }
  const digest = `sha256:${createHash('sha256').update(canonicalize(domain)).digest('hex')}`
  const ref = { kind, id, version, digest }
  if (validateJsonSchema(shapes[kind], ref).length) throw new TypeError('invalid reference identity')
  return ref
}

/** Content identity only; neither signature verification nor owner acceptance. */
export function templateReference(kind, id, version, document) {
  const value = snapshot({ kind, id, version, document })
  return refFor(value.kind, value.id, value.version, value.document)
}

function run(stage, input, inspect) {
  const errors = [], diagnostics = []
  try { inspect(snapshot(input), errors, diagnostics) }
  catch { errors.push('expected bounded plain JSON and supported reference identity') }
  return { ok: errors.length === 0, stage, errors: [...new Set(errors)], diagnostics,
    authority: 'structural-only', executionAuthority: false, publicationAuthority: false }
}

function definition(value, errors) {
  if (!shape('definition', value, errors)) return false
  unique(value.semanticRoles, x => x.id, errors, 'semantic role')
  unique(value.surfaceRoles, x => x.id, errors, 'surface role')
  unique(value.carriers, x => x.id, errors, 'carrier')
  unique(value.extensions, x => x.namespace, errors, 'extension namespace')
  unique(value.optionalDecisions, x => x.id, errors, 'optional decision')
  unique(value.compatibility.packRefs, x => x.id, errors, 'pack identity')
  const roles = new Set(value.semanticRoles.map(x => x.id))
  for (const view of value.surfaceRoles) {
    if (view.semanticRoleRefs.some(id => !roles.has(id))) errors.push('dangling surface semantic role')
  }
  // No extension handlers are registered by this additive profile. Optional
  // opaque payloads remain inert. Required semantics cannot be silently ignored.
  if (value.extensions.some(x => x.required)) errors.push('required extension unsupported')
  return errors.length === 0
}

export function validateTemplateDefinition(input) {
  return run('definition', input, (value, errors) => definition(value, errors))
}

function inventory(records, errors) {
  const entries = new Map(), identities = new Set()
  if (!Array.isArray(records) || records.length > 256) {
    errors.push('invalid reference inventory'); return entries
  }
  for (const record of records) {
    if (!shape('record', record, errors)) continue
    const { ref, document } = record
    const key = canonicalize(ref), identity = canonicalize([ref.kind, ref.id, ref.version])
    if (identities.has(identity)) errors.push('ambiguous reference inventory')
    identities.add(identity)
    if (!same(ref, refFor(ref.kind, ref.id, ref.version, document))) errors.push('reference digest mismatch')
    entries.set(key, document)
  }
  return entries
}
function resolve(ref, entries, errors) {
  const key = canonicalize(ref)
  if (!entries.has(key)) errors.push('dangling exact reference')
  return entries.get(key)
}
function extensions(value, entries, errors) {
  for (const entry of value.extensions) {
    resolve(entry.schemaRef, entries, errors)
    resolve(entry.payloadRef, entries, errors)
  }
}
function binding(profile, value, entries, errors) {
  if (!shape('binding', value, errors)) return false
  if (!same(value.templateRef, refFor('TemplateRef', profile.id, profile.version, profile))) errors.push('template binding mismatch')
  unique(value.roles, x => x.roleRef, errors, 'role binding')
  const roles = new Map(profile.semanticRoles.map(x => [x.id, x]))
  for (const entry of value.roles) {
    const role = roles.get(entry.roleRef)
    if (!role) errors.push('unknown semantic role')
    if (role?.cardinality === 'one' && entry.sourceRefs.length !== 1) errors.push('plural singular role binding')
    for (const ref of entry.sourceRefs) resolve(ref, entries, errors)
  }
  for (const role of profile.semanticRoles) {
    if (role.required && !value.roles.some(x => x.roleRef === role.id)) errors.push('required semantic role unbound')
  }
  extensions(profile, entries, errors)
  return errors.length === 0
}

export function validateTemplateBinding(profile, projectBinding, records = []) {
  return run('binding', { profile, projectBinding, records }, (value, errors) => {
    if (!definition(value.profile, errors)) return
    binding(value.profile, value.projectBinding, inventory(value.records, errors), errors)
  })
}

export function validateTemplateRelease(profile, projectBinding, release, records = []) {
  return run('release', { profile, projectBinding, release, records }, (value, errors) => {
    if (!definition(value.profile, errors) || !shape('release', value.release, errors)) return
    const entries = inventory(value.records, errors)
    if (!binding(value.profile, value.projectBinding, entries, errors)) return
    const templateRef = refFor('TemplateRef', value.profile.id, value.profile.version, value.profile)
    const bindingRef = refFor('BindingRef', value.projectBinding.id, value.projectBinding.version, value.projectBinding)
    if (!same(value.release.templateRef, templateRef) || !same(value.release.bindingRef, bindingRef)) errors.push('release binding mismatch')
    const carriers = new Set(), sources = new Set(value.projectBinding.roles.flatMap(x => x.sourceRefs.map(canonicalize)))
    for (const ref of value.release.projectionRefs) {
      const projection = resolve(ref, entries, errors)
      if (!shape('projection', projection, errors)) continue
      if (projection.id !== ref.id || projection.version !== ref.version) errors.push('projection identity mismatch')
      if (!same(projection.templateRef, templateRef) || !same(projection.bindingRef, bindingRef)) errors.push('projection binding mismatch')
      if (carriers.has(projection.carrier)) errors.push('duplicate projection carrier')
      carriers.add(projection.carrier)
      if (!value.profile.carriers.some(x => x.id === projection.carrier)) errors.push('undeclared projection carrier')
      for (const source of projection.sourceRefs) {
        if (!sources.has(canonicalize(source))) errors.push('projection source outside project binding')
        resolve(source, entries, errors)
      }
      for (const item of [...projection.policyRefs, ...projection.authorityDecisionRefs, projection.payloadRef, projection.capabilityRef]) resolve(item, entries, errors)
    }
    for (const carrier of value.profile.carriers) {
      if (carrier.required && !carriers.has(carrier.id)) errors.push('required carrier missing')
    }
  })
}

/** Host declarations are structural observations, never runtime grants. */
export function validateTemplateHost(profile, host) {
  return run('host', { profile, host }, (value, errors, diagnostics) => {
    if (!definition(value.profile, errors) || !shape('host', value.host, errors)) return
    const { profile: p, host: h } = value
    if (!same(h.templateRef, refFor('TemplateRef', p.id, p.version, p))) errors.push('host template mismatch')
    if (!p.carriers.some(x => x.id === h.carrier)) errors.push('undeclared host carrier')
    if (!p.compatibility.atelierVersions.includes(h.atelierVersion)) errors.push('incompatible host version')
    unique(h.packRefs, x => x.id, errors, 'host pack')
    for (const pack of p.compatibility.packRefs) {
      if (!h.packRefs.some(x => same(x, pack))) errors.push('required exact pack unavailable')
    }
    for (const role of p.semanticRoles) if (!h.semanticPrimitives.includes(role.primitive)) errors.push('unsupported semantic primitive')
    for (const role of p.surfaceRoles) if (!h.surfacePrimitives.includes(role.primitive)) errors.push('unsupported surface primitive')
    if (!same(p.runtimeProfileRef, h.runtimeProfileRef)) errors.push('runtime profile missing or mismatched')
    unique(h.optionalDecisions, x => x.id, errors, 'host decision')
    for (const observation of h.optionalDecisions) {
      if (!p.optionalDecisions.some(x => x.id === observation.id)) errors.push('undeclared optional decision')
      if (observation.status === 'available' && observation.capabilityRef === null) errors.push('available decision needs exact capability reference')
      if (observation.status === 'absent' && observation.capabilityRef !== null) errors.push('absent decision cannot claim a capability reference')
    }
    for (const request of p.optionalDecisions) {
      const status = h.optionalDecisions.find(x => x.id === request.id)?.status ?? 'absent'
      diagnostics.push({ id: request.id, status, fallback: 'deterministic-or-manual', invocationAuthorized: false })
    }
  })
}

/** Reuse provider-neutral decision semantics; never select or invoke a provider. */
export function validateTemplateDecision(profile, decisionId, request, result) {
  return run('advisory-decision', { profile, decisionId, request, result }, (value, errors) => {
    if (!definition(value.profile, errors)) return
    if (!value.profile.optionalDecisions.some(x => x.id === value.decisionId)) errors.push('undeclared optional decision')
    if (value.request?.task !== value.decisionId) errors.push('decision task binding mismatch')
    if (!validateDecisionRequest(value.request).ok) errors.push('invalid decision request')
    else if (!validateDecisionResult(value.request, value.result).ok) errors.push('invalid decision result')
  })
}
