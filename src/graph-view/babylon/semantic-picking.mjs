// Contribution only. CR-1 owns the adopted reference and event contracts.
export function referenceKey(ref) {
  const fields = ['domain', 'kind', 'id', 'revision']
  if (!ref || fields.some(field => typeof ref[field] !== 'string' || !ref[field].trim())) {
    throw new TypeError('A complete versioned semantic reference is required')
  }
  return JSON.stringify(fields.map(field => ref[field]))
}

export function semanticBinding(node) {
  referenceKey(node.ref)
  if (typeof node.sourceRevision !== 'string' || !node.sourceRevision.trim() ||
      !Array.isArray(node.evidenceIds) || node.evidenceIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('Source revision and declared evidence identities are required')
  }
  return Object.freeze({
    target: Object.freeze(Object.fromEntries(['domain', 'kind', 'id', 'revision'].map(key => [key, node.ref[key]]))),
    sourceRevision: node.sourceRevision,
    evidenceIds: Object.freeze([...node.evidenceIds]),
  })
}

// Mesh objects have adapter-local custody. Mesh names and metadata never establish identity.
export function createSemanticPickingMap() {
  let bindings = new WeakMap()
  return Object.freeze({
    bind(mesh, node) {
      if (!mesh || typeof mesh !== 'object') throw new TypeError('Mesh object required')
      if (bindings.has(mesh)) throw new Error('Mesh already bound')
      bindings.set(mesh, semanticBinding(node))
    },
    resolve(mesh) { return mesh && typeof mesh === 'object' ? bindings.get(mesh) ?? null : null },
    clear() { bindings = new WeakMap() },
  })
}
