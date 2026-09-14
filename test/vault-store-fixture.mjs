// Synthetic versioned store; real hosts need an atomic durable transaction.
export function evidenceStore() {
  const values = new Map()
  let fail = false
  return {
    values,
    failWrites() { fail = true },
    recoverWrites() { fail = false },
    async load(key) { return structuredClone(values.get(key) ?? { version: 0, evidence: null }) },
    async compareAndSet(key, evidence, { expectedVersion }) {
      if (fail) throw new Error('Synthetic store unavailable')
      const current = values.get(key) ?? { version: 0, evidence: null }
      if (current.version !== expectedVersion || current.evidence?.targets?.some(t => t.anonymous === 'content' || t.otherUser === 'content')) return false
      if (!evidence.targets?.some(t => t.anonymous === 'content' || t.otherUser === 'content') && current.evidence?.revision > evidence.revision) return false
      values.set(key, { version: current.version + 1, evidence: structuredClone(evidence) })
      return true
    },
  }
}
