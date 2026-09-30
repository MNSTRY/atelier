import { assertHarness, harnessDigest, HARNESS_LIMITS } from './contracts.mjs'
export const unique = (items, label) => { if (new Set(items).size !== items.length) throw new Error(`duplicate ${label}`) }

// Shared integrity mechanics; each domain retains its own states and meaning.
export function replay(records, profile, firstKind, visit) {
  if (!Array.isArray(records) || records.length > HARNESS_LIMITS.records || Buffer.byteLength(JSON.stringify(records)) > HARNESS_LIMITS.bytes) throw new Error('harness history exceeds bounds')
  const entries = new Map(), dependencies = new Map(), stale = new Map()
  const context = {
    entries, stale, dependencies, first: null,
    resolve(ref, kinds, current = true) {
      const r = entries.get(ref.id)
      if (!r || harnessDigest(r) !== ref.digest || !kinds.includes(r.kind)) throw new Error('missing, wrong-kind or mismatched reference')
      if (current && stale.has(r.id)) throw new Error('reference requires reconsideration')
      return r
    },
    invalidate(id, reason) {
      const queue = [id], visited = new Set()
      while (queue.length) {
        const next = queue.shift(); if (visited.has(next)) continue; visited.add(next)
        stale.set(next, [...new Set([...(stale.get(next) ?? []), reason])])
        for (const [child, refs] of dependencies) if (refs.includes(next)) queue.push(child)
      }
    },
  }
  for (const record of records) {
    assertHarness(record, profile)
    if (entries.has(record.id)) throw new Error('immutable record identity already exists')
    if (!context.first) {
      if (record.kind !== firstKind || record.id !== record.run) throw new Error('harness establishment must be first')
      context.first = record
    } else if (record.run !== context.first.id || record.kind === firstKind) throw new Error('harness run mismatch')
    const refs = visit(record, context) ?? []
    entries.set(record.id, record); dependencies.set(record.id, [...new Set(refs)])
    for (const target of refs) for (const reason of stale.get(target) ?? []) context.invalidate(record.id, reason)
  }
  return { establishment: context.first, records, head: harnessDigest(records), reconsider: [...stale].map(([id, reasons]) => ({ id, kind: entries.get(id).kind, reasons })), assurance: 'caller-reported; integrity-and-consistency-only', authority: 'none' }
}
