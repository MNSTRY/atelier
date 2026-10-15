// Portable wire contracts. Host authentication and persistence stay with the consumer.
export class ExtensionError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'ExtensionError'; this.code = code; this.status = status }
}
const reject = () => { throw new ExtensionError('invalid-input') }
export function canonicalJson(value) {
  const seen = new Set()
  function visit(item, depth) {
    if (depth > 16) return reject()
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : reject()
    if (typeof item === 'string') {
      for (let n = 0; n < item.length; n++) {
        const c = item.charCodeAt(n)
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = item.charCodeAt(++n)
          if (!(next >= 0xdc00 && next <= 0xdfff)) return reject()
        } else if (c >= 0xdc00 && c <= 0xdfff) return reject()
      }
      return JSON.stringify(item)
    }
    if (!item || typeof item !== 'object' || seen.has(item)) return reject()
    seen.add(item)
    let result
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1 || Array.from({ length: item.length }, (_, i) => i).some(i => !Object.hasOwn(item, i) || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, String(i)), 'value'))) return reject()
      result = `[${item.map(x => visit(x, depth + 1)).join(',')}]`
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(item).some(k => typeof k !== 'string')) return reject()
      const keys = Reflect.ownKeys(item).sort()
      if (keys.some(k => !Object.getOwnPropertyDescriptor(item, k).enumerable)) return reject()
      if (keys.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(item, k), 'value'))) return reject()
      result = `{${keys.map(k => `${visit(k, depth + 1)}:${visit(item[k], depth + 1)}`).join(',')}}`
    }
    seen.delete(item)
    return result
  }
  const encoded = visit(value, 0)
  if (new TextEncoder().encode(encoded).length > 131072) return reject()
  return encoded
}
export function text(value, limit = 128) {
  if (typeof value !== 'string' || !value.length || value.length > limit || /[\u0000-\u001f]/u.test(value)) return reject()
  canonicalJson(value)
  return value
}
export function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) return reject()
  return value
}
const digest = value => /^[a-f0-9]{64}$/.test(text(value, 64)) ? value : reject()
const strings = (value, max = 64) => {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string') || new Set(value).size !== value.length) return reject()
  return value.map(x => text(x, 256))
}
const schemaRef = value => {
  text(value, 256)
  if (!/^schemas\/[a-zA-Z0-9._-]+\.json$/.test(value) || value.startsWith('/') || value.split('/').some(x => !x || x === '.' || x === '..')) return reject()
  return value
}
function manifestObject(value, required, optional = []) {
  exact(value, required, [...optional, 'ext'])
  if (value.ext !== undefined) exact(value.ext, [])
}
export function parseManifest(value) {
  const m = JSON.parse(canonicalJson(value))
  manifestObject(m, ['schema', 'extensionId', 'releaseVersion', 'releaseDigest', 'protocol', 'compatibility', 'deployment', 'actions', 'permissions', 'surfaces', 'data'], ['recovery', 'contractVersion'])
  if (m.contractVersion !== undefined && !/^1\.[0-9]+\.[0-9]+$/.test(text(m.contractVersion))) return reject()
  if (m.schema !== 'mnstry.extension-manifest/v1' || m.protocol !== 'mnstry.extension/v1' ||
      !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(text(m.extensionId)) ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(text(m.releaseVersion))) return reject()
  const prerelease = m.releaseVersion.split('+')[0].split('-').slice(1).join('-')
  if (prerelease.split('.').some(part => /^0\d+$/.test(part))) return reject()
  digest(m.releaseDigest)
  manifestObject(m.compatibility, ['sdkMajor', 'rootContracts', 'hosts'])
  if (m.compatibility.sdkMajor !== 1 || !m.compatibility.hosts.length || strings(m.compatibility.hosts).some(x => !['web', 'native'].includes(x))) return reject()
  strings(m.compatibility.rootContracts)
  manifestObject(m.deployment, ['profile', 'bundleDigest', 'schemaDigest'])
  if (!['postgres-sql', 'drizzle-db-first', 'drizzle-code-first', 'prisma-7-postgres', 'prisma-8-postgres-experimental', 'convex-native'].includes(text(m.deployment.profile))) return reject()
  digest(m.deployment.bundleDigest); digest(m.deployment.schemaDigest)
  if (!Array.isArray(m.actions) || !m.actions.length || m.actions.length > 64) return reject()
  const actions = new Map()
  for (const action of m.actions) {
    manifestObject(action, ['id', 'effect', 'scope', 'inputSchemaRef', 'outputSchemaRef', 'timeoutMs'])
    text(action.id)
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(action.id) || actions.has(action.id) || /^(?:lifecycle|installation|extension)\./.test(action.id) ||
        !['read', 'write'].includes(action.effect) || !['member', 'tenant'].includes(action.scope) ||
        !Number.isInteger(action.timeoutMs) || action.timeoutMs < 1 || action.timeoutMs > 30000) return reject()
    schemaRef(action.inputSchemaRef); schemaRef(action.outputSchemaRef); actions.set(action.id, action)
  }
  if (m.recovery !== undefined) {
    manifestObject(m.recovery, ['lookupActionId'])
    const action = actions.get(m.recovery.lookupActionId)
    if (!action || action.effect !== 'read' || action.scope !== 'member') return reject()
  }
  manifestObject(m.permissions, ['rootReads', 'rootWrites', 'egress'])
  for (const key of ['rootReads', 'rootWrites', 'egress']) strings(m.permissions[key])
  if (!Array.isArray(m.surfaces) || m.surfaces.length > 32) return reject()
  const surfaces = new Set()
  for (const surface of m.surfaces) {
    manifestObject(surface, ['id', 'compositionDigest', 'actionIds']); text(surface.id); digest(surface.compositionDigest)
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(surface.id) || surfaces.has(surface.id) || strings(surface.actionIds).some(id => !actions.has(id))) return reject()
    surfaces.add(surface.id)
  }
  manifestObject(m.data, ['classes', 'retention', 'exportVersion', 'schemaVersion', 'readableSchemaVersions'])
  strings(m.data.classes); text(m.data.schemaVersion)
  if (m.data.retention !== 'until-user-delete' || m.data.exportVersion !== 1 ||
      !strings(m.data.readableSchemaVersions).includes(m.data.schemaVersion)) return reject()
  return m
}
export function parseInstallationBinding(value) {
  value = JSON.parse(canonicalJson(value))
  exact(value, ['installationId', 'generation', 'releaseDigest'])
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(text(value.installationId)) ||
      !/^[1-9][0-9]{0,18}$/.test(text(value.generation)) || BigInt(value.generation) > 9223372036854775807n) return reject()
  digest(value.releaseDigest)
  return { ...value }
}
export function parseOperationReceipt(value) {
  exact(value, ['operationId', 'state'], ['result', 'resultDigest'])
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(text(value.operationId)) || !['pending', 'admitted', 'succeeded', 'unknown', 'failed'].includes(value.state)) return reject()
  if (value.state === 'succeeded') {
    if (!Object.hasOwn(value, 'result')) return reject()
    digest(value.resultDigest); canonicalJson(value.result)
  } else if (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'resultDigest')) return reject()
  return JSON.parse(canonicalJson(value))
}

export function parseProviderOperationProof(value) {
  const proof = JSON.parse(canonicalJson(value))
  exact(proof, ['schema', 'installationId', 'generation', 'releaseDigest', 'operationId', 'actionId', 'payloadDigest', 'resultDigest', 'result'])
  if (proof.schema !== 'mnstry.extension-provider-operation/v1' || !/^[A-Za-z0-9_-]{16,128}$/.test(text(proof.operationId))) return reject()
  parseInstallationBinding({ installationId: proof.installationId, generation: proof.generation, releaseDigest: proof.releaseDigest })
  text(proof.actionId); digest(proof.payloadDigest); digest(proof.resultDigest)
  return proof
}
