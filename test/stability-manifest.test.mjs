import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveRuntimeExportTarget } from '../scripts/check-public-api-compat.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'contracts', 'stability-manifest.v1.json'), 'utf8'))
const publicApiBaseline = JSON.parse(readFileSync(join(packageRoot, 'contracts', 'public-api-baseline.json'), 'utf8'))

const VALID_TIERS = new Set(['stable', 'beta', 'experimental'])

test('stability manifest declares valid schema and classifies every package.json export', () => {
  assert.equal(manifest.schema, 'mnstry.atelier-stability-manifest@v1')
  assert.equal(manifest.package, '@mnstry/atelier')
  assert.ok(Array.isArray(manifest.excludedInternalSymbols))
  assert.ok(manifest.excludedInternalSymbols.includes('*ForOracleTests'))

  const declaredSubpaths = Object.keys(pkg.exports).sort()
  const manifestSubpaths = Object.keys(manifest.exports).sort()
  assert.deepEqual(
    manifestSubpaths,
    declaredSubpaths,
    'every package.json export subpath must be classified in contracts/stability-manifest.v1.json (and vice versa)',
  )

  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    assert.ok(VALID_TIERS.has(entry.tier), `${subpath} has invalid stability tier: ${entry.tier}`)
  }

  const baselineSubpaths = new Set(publicApiBaseline.requiredSubpaths)
  const unguardedStable = Object.entries(manifest.exports)
    .filter(([, entry]) => entry.tier === 'stable')
    .map(([subpath]) => subpath)
    .filter((subpath) => !baselineSubpaths.has(subpath))
  assert.deepEqual(
    unguardedStable,
    [],
    `every stable subpath must be enforced by contracts/public-api-baseline.json; unguarded: ${unguardedStable.join(', ')}`,
  )
})

test('every stable and beta JavaScript subpath resolves and exports non-empty symbols', async () => {
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    if (entry.tier !== 'stable' && entry.tier !== 'beta') continue
    const target = resolveRuntimeExportTarget(pkg.exports[subpath])
    if (!target || !target.endsWith('.mjs')) continue
    const mod = await import(pathToFileURL(join(packageRoot, target)).href)
    const names = Object.keys(mod).filter((name) => !name.endsWith('ForOracleTests'))
    assert.ok(names.length > 0, `${subpath} (${entry.tier}) must export at least one public symbol`)
  }
})
