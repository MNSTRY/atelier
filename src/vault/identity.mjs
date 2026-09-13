/**
 * The host verifies browser sessions using its established identity provider.
 * Machine credentials are high-entropy secrets whose SHA-256 hashes are stored
 * by the host. Lookup must read authoritative, current expiry/revocation state.
 */
import { digest } from './service.mjs'
export function vaultIdentity({ verifySession, lookupCredential, now = () => Date.now() }) {
  if (typeof verifySession !== 'function' || typeof lookupCredential !== 'function') throw new TypeError('Identity bindings required')
  return {
    read: request => verifySession(request),
    async publish(request, vault) {
      const value = request.headers.get('authorization')
      if (!value || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(value)) return null
      const record = await lookupCredential(await digest(new TextEncoder().encode(value.slice(7))))
      if (!record || record.vault !== vault || record.revoked !== false || !Number.isFinite(record.expiresAt) || record.expiresAt <= now()) return null
      return record.owner
    },
  }
}
