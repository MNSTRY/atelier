/** SQL adapters require pre-provisioned vaults; neither endpoint creates owners. */
export const VAULT_TABLE_SQL = `CREATE TABLE atelier_vaults (
  id TEXT PRIMARY KEY,
  owner_issuer TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  manifest TEXT NOT NULL DEFAULT '[]',
  publication TEXT
)`
function record(row) {
  return row ? { owner: { issuer: row.owner_issuer, subject: row.owner_subject }, revision: Number(row.revision), manifest: JSON.parse(row.manifest), publication: row.publication } : null
}
export function d1VaultMetadata(db) {
  return {
    async get(vault) { return record(await db.prepare('SELECT * FROM atelier_vaults WHERE id = ?').bind(vault).first()) },
    async commit(vault, update) {
      const result = await db.prepare('UPDATE atelier_vaults SET revision = revision + 1, manifest = ?, publication = ? WHERE id = ? AND revision = ? AND owner_issuer = ? AND owner_subject = ?')
        .bind(JSON.stringify(update.manifest), update.publication, vault, update.expectedRevision, update.owner.issuer, update.owner.subject).run()
      return result.success === true && result.meta.changes === 1
    },
  }
}
export function postgresVaultMetadata(db) {
  return {
    async get(vault) { return record((await db.query('SELECT * FROM atelier_vaults WHERE id = $1', [vault])).rows[0]) },
    async commit(vault, update) {
      const result = await db.query('UPDATE atelier_vaults SET revision = revision + 1, manifest = $1, publication = $2 WHERE id = $3 AND revision = $4 AND owner_issuer = $5 AND owner_subject = $6', [JSON.stringify(update.manifest), update.publication, vault, update.expectedRevision, update.owner.issuer, update.owner.subject])
      return result.rowCount === 1
    },
  }
}
