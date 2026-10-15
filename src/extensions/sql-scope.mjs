import { canonicalJson, ExtensionError } from './contracts.mjs'

export async function assertApplicationRole(sql) {
  const [role] = await sql`SELECT r.rolsuper, r.rolbypassrls,
    EXISTS (SELECT 1 FROM pg_roles parent WHERE pg_has_role(r.oid,parent.oid,'MEMBER')
      AND (parent.rolsuper OR parent.rolbypassrls)) AS unsafe_membership,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='extension_data' AND c.relkind IN ('r','p')
        AND (pg_has_role(r.oid,c.relowner,'MEMBER') OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) AS unsafe_tables
    FROM pg_roles r WHERE r.rolname=current_user`
  if (!role || role.rolsuper || role.rolbypassrls || role.unsafe_membership || role.unsafe_tables) throw new ExtensionError('forbidden', 403)
}

export function boundedSqlResult(value) {
  const encoded=canonicalJson(value)
  if(Buffer.byteLength(encoded)>60*1024)throw new ExtensionError('invalid-input')
  return JSON.parse(encoded)
}
