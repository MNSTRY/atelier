import { canonicalJson, exact, ExtensionError } from './contracts.mjs'

function joinBytes(chunks, size) {
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
async function cancelResponseBody(body) {
  if (!body) return
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(() => body.cancel()).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 100) }),
    ])
  } finally { clearTimeout(timer) }
}
export async function readInvocationBody(request) {
  const body = request.body?.getReader()
  if (!body) throw new ExtensionError('invalid-input')
  try {
    let size = 0
    const chunks = []
    for (;;) {
      const { value, done } = await body.read()
      if (done) break
      size += value.byteLength
      if (size > 65536) throw new ExtensionError('invalid-input')
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joinBytes(chunks, size)))
  } finally { await body.cancel().catch(() => {}) }
}
export function createRootAdmissionConsumer(options) {
  return createAdmissionConsumer(options, options.allowLocalTesting && ['test', 'development'].includes(process.env.NODE_ENV))
}
export function createAdmissionConsumer({ origin, fetch: hostFetch = globalThis.fetch }, localTestingAuthorized = false) {
  const target = new URL(origin)
  const local = localTestingAuthorized &&
    target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname)
  if ((target.protocol !== 'https:' && !local) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new ExtensionError('invalid-input')
  const endpoint = new URL('/api/root-runtime/extensions/admissions/consume', target)
  return async (_claims, delegation) => {
    // Convex supports AbortController and action timers, but not every runtime
    // implements AbortSignal.timeout. The deadline includes the response body.
    const controller = new AbortController()
    let timer, response, reader
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ExtensionError('unavailable', 503)) }, 5000)
    })
    const consume = async () => {
      response = await hostFetch(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: canonicalJson({ delegation }) })
      if (response.status === 401 || response.status === 403) return false
      if (response.status != 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new ExtensionError('unavailable', 503)
      reader = response.body?.getReader()
      if (!reader) throw new ExtensionError('unavailable', 503)
      try {
        let size = 0
        const chunks = []
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 1024) throw new ExtensionError('unavailable', 503)
          chunks.push(value)
        }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joinBytes(chunks, size)))
        exact(body, ['admitted'])
        if (body.admitted !== true) throw new ExtensionError('unavailable', 503)
        return true
      } catch { throw new ExtensionError('unavailable', 503) }
    }
    try { return await Promise.race([consume(), expired]) } finally {
      clearTimeout(timer)
      // Also close refusal/error responses, whose body reader was never acquired.
      // Abort first; a broken/custom stream cancellation cannot extend transport.
      controller.abort()
      await cancelResponseBody(reader ?? response?.body)
    }
  }
}
