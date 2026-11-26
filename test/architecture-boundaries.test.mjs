import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Internal layer import ratchet. Keeps optional or experimental domains isolated
// and stops new cross-layer coupling from accumulating before internal refactors.

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

function collectCrossAreaEdges() {
  const edges = new Map()
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (!entry.name.endsWith('.mjs')) continue
      const relFile = path.relative(srcRoot, fullPath).replaceAll(path.sep, '/')
      const fromArea = relFile.includes('/') ? relFile.split('/')[0] : '(root)'
      const source = fs.readFileSync(fullPath, 'utf8')
      const importRegex = /(?:from\s+|import\s*\(?\s*)['"](\.[^'"]+)['"]/g
      let match
      while ((match = importRegex.exec(source)) !== null) {
        const resolved = path.relative(srcRoot, path.resolve(path.dirname(fullPath), match[1])).replaceAll(path.sep, '/')
        if (resolved.startsWith('..')) continue
        const toArea = resolved.includes('/') ? resolved.split('/')[0] : '(root)'
        if (fromArea === toArea) continue
        const key = `${fromArea} -> ${toArea}`
        if (!edges.has(key)) edges.set(key, new Set())
        edges.get(key).add(`${relFile} -> ${resolved}`)
      }
    }
  }
  walk(srcRoot)
  return edges
}

test('experimental vault module has zero inbound imports from other src areas', () => {
  const edges = collectCrossAreaEdges()
  const vaultInbound = [...edges.keys()].filter((edge) => edge.endsWith(' -> vault'))
  assert.deepEqual(vaultInbound, [], `vault must remain isolated; found inbound edges: ${vaultInbound.join(', ')}`)
})

test('leaf governance contracts and scanners stay free of unexpected outbound cross-area imports', () => {
  const edges = collectCrossAreaEdges()
  const allowedEdges = {
    contracts: new Set(['contracts -> readiness-protocols']),
    disclosure: new Set(),
    egress: new Set(),
  }
  for (const [leafArea, allowed] of Object.entries(allowedEdges)) {
    const outbound = [...edges.keys()]
      .filter((edge) => edge.startsWith(`${leafArea} -> `))
      .filter((edge) => !allowed.has(edge))
    assert.deepEqual(outbound, [], `${leafArea} has unexpected outbound cross-area import(s): ${outbound.join(', ')}`)
  }
})

test('core graph and governance areas do not import UI, harnesses, adapters, or optional capabilities', () => {
  const edges = collectCrossAreaEdges()
  const coreAreas = ['graph', 'graphmark', 'boundary', 'export']
  const forbiddenTargets = new Set([
    'ui',
    'vault',
    'harnesses',
    'extensions',
    'impeccable',
    'inquiry',
    'knowledge',
    'knowledge-health',
    'learning',
    'build',
    'coauthor',
  ])
  const violations = []
  for (const [edge, files] of edges.entries()) {
    const [fromArea, toArea] = edge.split(' -> ')
    if (coreAreas.includes(fromArea) && forbiddenTargets.has(toArea)) {
      violations.push(`${edge} (${[...files].join(', ')})`)
    }
  }
  assert.deepEqual(violations, [], `forbidden core-to-optional import(s):\n${violations.join('\n')}`)
})

test('ui imports remain bounded to the explicit allowlist', () => {
  const edges = collectCrossAreaEdges()
  const allowedUiCallers = new Set(['projection', 'server', 'template-bindings'])
  const unexpected = [...edges.keys()]
    .filter((edge) => edge.endsWith(' -> ui'))
    .filter((edge) => !allowedUiCallers.has(edge.split(' -> ')[0]))
  assert.deepEqual(
    unexpected,
    [],
    `new area coupled to src/ui (not in allowlist): ${unexpected.join(', ')}`,
  )
})
