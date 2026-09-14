import { digest } from './service.mjs'
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item)
const MAX_BYTES = 4 * 1024 * 1024
const cleanUrl = value => {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Unsafe probe URL')
  return url.href
}
async function classify(response, target, loginUrls) {
  if (!(response instanceof Response)) return 'unknown'
  const reader = response.body?.getReader()
  const chunks = []; let length = 0
  try {
    for (; reader;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BYTES) { await reader.cancel(); return 'unknown' }
      chunks.push(value)
    }
  } finally { reader?.releaseLock() }
  const bytes = new Uint8Array(length); let offset = 0
  for (const value of chunks) { bytes.set(value, offset); offset += value.length }
  // Content exposure wins over misleading error or redirect status codes.
  if (length > 0 && (await digest(bytes) === target.sha256 || (typeof target.canary === 'string' && target.canary.length >= 32 && new TextDecoder().decode(bytes).includes(target.canary)))) return 'content'
  if (response.redirected) return 'unknown'
  if ([401, 403, 404].includes(response.status)) return length === 0 ? 'denied' : 'unknown'
  if ([302, 303, 307, 308].includes(response.status)) {
    try {
      const location = new URL(response.headers.get('location'), target.url)
      if (location.protocol !== 'https:' || location.username || location.password || location.hash) return 'unknown'
      const endpoint = loginUrls.find(item => item.url === location.origin + location.pathname)
      return endpoint && [...location.searchParams.keys()].every(key => endpoint.queryKeys.includes(key)) ? 'denied' : 'unknown'
    } catch { return 'unknown' }
  }
  return 'unknown'
}
/**
 * inspect(context) is a trusted provider configuration/inventory collector.
 * request({url,identity,redirect,signal}) is host transport; credentials never
 * cross identities or redirects. No global fetch or ambient credentials here.
 * Each collection re-inspects policy after probing to refuse changed settings.
 */
export function createVaultPrivacyProbe({ inspect, request, now = () => Date.now(), timeoutMs = 60000, onExposure }) {
  if (typeof inspect !== 'function' || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Explicit probe bindings required')
  return {
    async verify(context) {
      const controller = new AbortController()
      let timer
      const checkedAt = now()
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Probe deadline exceeded')) }, timeoutMs) })
      const collect = async () => {
        const inventory = structuredClone(await inspect(context, { signal: controller.signal }))
        if (!inventory || !Array.isArray(inventory.targets) || !inventory.targets.length || inventory.targets.length > 2000) throw new Error('Invalid probe inventory')
        const targets = inventory.targets.map(target => {
          if (!target || !/^[a-f0-9]{64}$/.test(target.sha256)) throw new Error('Expected content digest required')
          return { ...target, url: cleanUrl(target.url) }
        })
        const loginUrls = (inventory.loginEndpoints ?? []).map(item => {
          if (!Array.isArray(item.queryKeys) || item.queryKeys.some(key => !['state', 'redirect_uri', 'redirect_url', 'returnTo', 'next', 'client_id', 'response_type', 'scope', 'nonce', 'code_challenge', 'code_challenge_method'].includes(key))) throw new Error('Unsafe login parameters')
          return { url: cleanUrl(item.url), queryKeys: item.queryKeys }
        })
        const evidence = results => ({ vault: context.vault, publication: context.publication, revision: context.revision, phase: context.phase, owner: context.owner, deployment: context.deployment, checkedAt, validUntil: checkedAt + 60000, policyRevision: inventory.policyRevision, configuration: inventory.configuration, targets: results })
        const results = []
        for (const target of targets) {
          const result = { url: target.url, kind: target.kind, sha256: target.sha256, key: target.key, size: target.size }
          for (const identity of ['anonymous', 'otherUser']) {
            if (controller.signal.aborted) throw new Error('Probe aborted')
            try { result[identity] = await classify(await request({ url: target.url, identity, redirect: 'manual', signal: controller.signal }), target, loginUrls) }
            catch { result[identity] = 'unknown' }
            if (result[identity] === 'content') {
              const alarm = evidence([...results, result])
              // Notification cannot delay or downgrade the exposure verdict. The
              // host owns durable incident persistence and provider containment.
              if (typeof onExposure === 'function') Promise.resolve().then(() => onExposure(alarm)).catch(() => {})
              return alarm
            }
          }
          results.push(result)
        }
        const after = await inspect(context, { signal: controller.signal })
        if (canonical(after) !== canonical(inventory)) throw new Error('Provider protection changed during verification')
        return evidence(results)
      }
      try { return await Promise.race([collect(), deadline]) }
      finally { clearTimeout(timer); controller.abort() }
    },
  }
}
