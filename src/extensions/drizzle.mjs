import { withPostgresScope, oncePostgresOperation, lookupPostgresOperation, postgresHealth } from './postgres.mjs'
import { ExtensionError } from './contracts.mjs'

// The native ORM owns the transaction. The application supplies its SQL tag;
// Atelier never imports the optional ORM or reconstructs it around a driver tx.
function bridge(database, sqlTag) {
  if(typeof database?.transaction!=='function'||typeof sqlTag!=='function')throw new ExtensionError('invalid-input')
  const transactions=new WeakMap()
  return { transactions, database:{begin:callback=>database.transaction(tx=>{
    const query=(chunks,...values)=>tx.execute(sqlTag(chunks,...values))
    query.json=value=>JSON.stringify(value)
    transactions.set(query,tx)
    return callback(query)
  })} }
}
export function withDrizzleScope(database, scope, sqlTag, run) {
  if(typeof run!=='function')throw new ExtensionError('invalid-input')
  const native=bridge(database,sqlTag)
  return withPostgresScope(native.database,scope,query=>run(native.transactions.get(query)))
}
export function onceDrizzleOperation(database, scope, input, sqlTag, run) {
  if(typeof run!=='function')throw new ExtensionError('invalid-input')
  const native=bridge(database,sqlTag)
  return oncePostgresOperation(native.database,scope,input,query=>run(native.transactions.get(query)))
}
export function lookupDrizzleOperation(database,scope,sqlTag,operationId) {
  return lookupPostgresOperation(bridge(database,sqlTag).database,scope,operationId)
}
export async function drizzleHealth(driver, profile) {
  if (!['drizzle-db-first', 'drizzle-code-first'].includes(profile)) throw new ExtensionError('invalid-input')
  const health = await postgresHealth(driver)
  return { ...health, profile }
}
