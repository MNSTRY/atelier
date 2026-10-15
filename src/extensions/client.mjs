import { canonicalJson, exact, ExtensionError, parseInstallationBinding, parseManifest, parseOperationReceipt, parseReleaseBundle, text } from './contracts.mjs'

const opaque = value => { if (!/^[A-Za-z0-9_-]{16,128}$/.test(text(value))) throw new ExtensionError('invalid-input'); return value }
const actionIdValue = value => { if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(text(value)) || /^(?:lifecycle|installation|extension)\./.test(value)) throw new ExtensionError('invalid-input'); return value }
const codes = new Set(['invalid-input', 'unauthorized', 'forbidden', 'stale-installation', 'disabled', 'idempotency-conflict', 'operation-unknown', 'release-conflict', 'unavailable'])
const registration = (value, releaseDigest) => {
  const result=exact(value,['releaseId','releaseDigest'])
  if(result.releaseDigest!==releaseDigest)throw new ExtensionError('unavailable',503)
  return {releaseId:opaque(result.releaseId),releaseDigest:result.releaseDigest}
}
// The caller supplies an authenticated host fetch; destinations and credentials are host-owned.
export function createHttpHostTransport(hostFetch) {
  if (typeof hostFetch !== 'function') throw new ExtensionError('invalid-input')
  const base = '/api/root-runtime/extensions'
  const segment = value => encodeURIComponent(opaque(value))
  async function send(path, body) {
    const response = await hostFetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: canonicalJson(body) }) })
    let value
    const reader = response.body?.getReader()
    if (!reader) throw new ExtensionError('unavailable', 503)
    try {
      const chunks = []; let size = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 131072) throw new ExtensionError('unavailable', 503)
        chunks.push(part.value)
      }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch { throw new ExtensionError('unavailable', 503) } finally { await reader.cancel().catch(() => {}) }
    if (!response.ok) throw new ExtensionError(codes.has(value?.code) ? value.code : 'unavailable', response.status)
    return value
  }
  const installation = id => `/installations/${segment(id)}`
  return Object.freeze({
    registerRelease: async input => {
      const bundle=parseReleaseBundle(input)
      return registration(await send('/releases',bundle),bundle.manifest.releaseDigest)
    },
    getInstallation: async id => parseInstallationBinding(await send(installation(id))),
    invoke: async request => {
      const { installationId, actionId, ...body } = request
      return parseOperationReceipt(await send(`${installation(installationId)}/actions/${encodeURIComponent(actionIdValue(actionId))}`, body))
    },
    lookupOperation: async (id, idempotencyKey, actionId) => {
      const value = await send(`${installation(id)}/lookup`, { idempotencyKey, actionId })
      return value === null ? null : parseOperationReceipt(value)
    },
    recoverOperation: async ({ installationId, ...binding }, idempotencyKey, actionId) =>
      parseOperationReceipt(await send(`${installation(installationId)}/recover`, { ...binding, idempotencyKey, actionId })),
    recordResult: async operationId => {
      const value = exact(await send(`/operations/${segment(operationId)}/result`, {}), ['recorded'])
      if (value.recorded !== true) throw new ExtensionError('unavailable', 503)
    },
    configure: async (manifest, connectionRef, environment) => parseInstallationBinding(await send('/installations', { manifest, connectionRef, environment })),
    transition: async ({ installationId, ...binding }, transition) => parseInstallationBinding(await send(`${installation(installationId)}/lifecycle`, { ...binding, transition })),
    upgrade: async ({ installationId, ...binding }, manifest) => parseInstallationBinding(await send(`${installation(installationId)}/upgrade`, { ...binding, manifest })),
  })
}
export function createExtensionClient(transport) {
  return Object.freeze({
    getInstallation: async id => parseInstallationBinding(await transport.getInstallation(opaque(id))),
    invoke: async (binding, actionId, input, idempotencyKey) => parseOperationReceipt(await transport.invoke({
      ...parseInstallationBinding(binding), actionId: actionIdValue(actionId), idempotencyKey: text(idempotencyKey), input: JSON.parse(canonicalJson(input)),
    })),
    lookupOperation: async (id, key, action) => {
      const result = await transport.lookupOperation(opaque(id), text(key), actionIdValue(action))
      return result === null ? null : parseOperationReceipt(result)
    },
    recoverOperation: async (binding, key, action) => parseOperationReceipt(await transport.recoverOperation(parseInstallationBinding(binding), text(key), actionIdValue(action))),
    recordResult: async id => {
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(text(id))) throw new ExtensionError('invalid-input')
      await transport.recordResult(id)
    },
  })
}
export function createExtensionAdminClient(transport) {
  return Object.freeze({
    registerRelease: async value => {
      if(typeof transport.registerRelease!=='function')throw new ExtensionError('unavailable',503)
      const bundle=parseReleaseBundle(value)
      return registration(await transport.registerRelease(bundle),bundle.manifest.releaseDigest)
    },
    configure: async (manifest, connectionRef, environment = 'development') => {
      if (!['development', 'staging', 'production'].includes(environment)) throw new ExtensionError('invalid-input')
      return parseInstallationBinding(await transport.configure(parseManifest(manifest), text(connectionRef), environment))
    },
    transition: async (binding, transition) => {
      if (!['verify', 'enable', 'disable', 'remove'].includes(transition)) throw new ExtensionError('invalid-input')
      return parseInstallationBinding(await transport.transition(parseInstallationBinding(binding), transition))
    },
    upgrade: async (binding, manifest) => parseInstallationBinding(await transport.upgrade(parseInstallationBinding(binding), parseManifest(manifest))),
  })
}
