/** Provider SDKs/bindings are explicitly supplied by the host, never auto-loaded. */
export function r2PrivateStorage(bucket) {
  return {
    async put(key, bytes) { await bucket.put(key, bytes) },
    async get(key) {
      const object = await bucket.get(key)
      return object ? new Uint8Array(await object.arrayBuffer()) : null
    },
  }
}
export function vercelPrivateStorage(blob) {
  return {
    async put(key, bytes) {
      await blob.put(key, bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/octet-stream' })
    },
    async get(key) {
      const object = await blob.get(key, { access: 'private', useCache: false })
      if (!object) return null
      if (object.statusCode !== 200 || !object.stream) throw new Error('Private storage unavailable')
      return new Uint8Array(await new Response(object.stream).arrayBuffer())
    },
  }
}
