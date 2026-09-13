import { createVaultService } from './service.mjs'
import { vaultIdentity } from './identity.mjs'
import { r2PrivateStorage, vercelPrivateStorage } from './storage.mjs'
import { d1VaultMetadata, postgresVaultMetadata } from './metadata.mjs'

/** Vercel host passes its established session verifier, credential store and SDKs. */
export function createVercelVault({ blob, postgres, verifySession, lookupCredential, privacy }) {
  return createVaultService({ privacy, storage: vercelPrivateStorage(blob), metadata: postgresVaultMetadata(postgres), identity: vaultIdentity({ verifySession, lookupCredential, privacy }) })
}
/** Create a handler per request so D1 sessions cannot carry stale bookmarks. */
export function createCloudflareVault({ verifySession, lookupCredential, privacy }) {
  async function handle(request, env) {
    const db = env.VAULT_DB.withSession('first-primary')
    const identity = vaultIdentity({ verifySession: req => verifySession(req, env), lookupCredential: hash => lookupCredential(hash, env, db) })
    return createVaultService({ privacy, storage: r2PrivateStorage(env.VAULT_OBJECTS), metadata: d1VaultMetadata(db), identity })(request)
  }
  return { fetch: handle }
}
