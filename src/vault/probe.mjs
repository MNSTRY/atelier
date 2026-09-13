import { digest } from './service.mjs'
const MAX_BYTES = 4 * 1024 * 1024
const cleanUrl = value => {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Unsafe probe URL')
  return url.href
}
async function classify(response, target, loginUrls) {
  if (!(response instanceof Response)) return 'unknown'
  if (response.redirected) return 'unknown'
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
  if (await digest(bytes) === target.sha256) return 'content'
  if ([401, 403, 404].includes(response.status)) return 'denied'
  if ([302, 303, 307, 308].includes(response.status)) {
    try {
      const location = new URL(response.headers.get('location'), target.url)
      return loginUrls.includes(cleanUrl(location.href)) ? 'denied' : 'unknown'
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
export function createVaultPrivacyProbe({ inspect, request, now = () => Date.now(), timeoutMs = 15000 }) {
  if (typeof inspect !== 'function' || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Explicit probe bindings required')
  return {
    async verify(context) {
      const controller = new AbortController()
      let timer
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Probe deadline exceeded')) }, timeoutMs) })
      const collect = async () => {
        const inventory = structuredClone(await inspect(context, { signal: controller.signal }))
        if (!inventory || !Array.isArray(inventory.targets) || !inventory.targets.length || inventory.targets.length > 100) throw new Error('Invalid probe inventory')
        const targets = inventory.targets.map(target => {
          if (!target || !/^[a-f0-9]{64}$/.test(target.sha256)) throw new Error('Expected content digest required')
          return { ...target, url: cleanUrl(target.url) }
        })
        const loginUrls = (inventory.loginUrls ?? []).map(cleanUrl)
        const results = []
        for (const target of targets) {
          const result = { url: target.url, kind: target.kind }
          for (const identity of ['owner', 'anonymous', 'otherUser']) {
            if (controller.signal.aborted) throw new Error('Probe aborted')
            try { result[identity] = await classify(await request({ url: target.url, identity, redirect: 'manual', signal: controller.signal }), target, loginUrls) }
            catch { result[identity] = 'unknown' }
          }
          results.push(result)
        }
        const after = await inspect(context, { signal: controller.signal })
        if (JSON.stringify(after) !== JSON.stringify(inventory)) throw new Error('Provider protection changed during verification')
        const checkedAt = now()
        return { vault: context.vault, publication: context.publication, phase: context.phase, owner: context.owner, checkedAt, validUntil: checkedAt + 60000, policyRevision: inventory.policyRevision, configuration: inventory.configuration, targets: results }
      }
      try { return await Promise.race([collect(), deadline]) }
      finally { clearTimeout(timer); controller.abort() }
    },
  }
}
