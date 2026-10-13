import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const supplierDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/ingestion/optional/graphify')
const supplierSource = fs.readFileSync(path.join(supplierDir, 'graphify_supplier.py'), 'utf8')
const siblings = [...supplierSource.matchAll(/Path\(__file__\)\.with_name\("([^"]+)"\)/g)].map((match) => match[1])

test('every file the Graphify supplier reads beside itself ships with it', () => {
  // 0.2.0-alpha.13 shipped the supplier without its two pin files, so it could not be imported.
  assert.deepEqual(siblings.sort(), ['native-closure-pins.json', 'native-pins.json'])
  for (const name of siblings) {
    const parsed = JSON.parse(fs.readFileSync(path.join(supplierDir, name), 'utf8'))
    assert.match(parsed.upstreamCommit, /^[0-9a-f]{40}$/, name)
  }
  const audit = fs.readFileSync(path.resolve(supplierDir, '../../../../scripts/check-release-tarball.mjs'), 'utf8')
  for (const name of siblings) {
    const admitted = [...audit.matchAll(/^\s*(\/\^src\\\/ingestion\\\/optional\\\/graphify\\\/.*\/),?$/gm)]
      .map((match) => new RegExp(match[1].slice(1, -1)))
      .some((pattern) => pattern.test(`src/ingestion/optional/graphify/${name}`))
    assert.ok(admitted, `release audit admits ${name}`)
  }
})

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })

test('the Graphify supplier imports without Graphify installed', { skip: python.status !== 0 && 'python3 unavailable' }, () => {
  const probe = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(supplierDir)})`,
    'import graphify_supplier as supplier',
    "print(len(supplier.PINS['operations']), len(supplier.NATIVE_CLOSURE['modules']))",
  ].join('\n')
  const result = spawnSync('python3', ['-c', probe], { encoding: 'utf8', cwd: path.dirname(supplierDir) })
  assert.equal(result.status, 0, result.stderr)
  const [operations, modules] = result.stdout.trim().split(/\s+/).map(Number)
  assert.ok(operations > 0 && modules > 0, result.stdout)
})
