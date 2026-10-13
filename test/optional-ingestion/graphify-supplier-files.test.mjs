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

// The supplier imports fcntl, so it is a POSIX module; Windows hosts skip the Python probes.
const python = process.platform === 'win32' ? { status: 1 } : spawnSync('python3', ['--version'], { encoding: 'utf8' })
const skipPython = python.status !== 0 && 'python3 unavailable or not a POSIX host'

// -B: the probes must not leave bytecode in src/, which the release audit would refuse.
function runPython(lines) {
  return spawnSync('python3', ['-B', '-c', ['import sys', `sys.path.insert(0, ${JSON.stringify(supplierDir)})`, ...lines].join('\n')], {
    encoding: 'utf8',
    cwd: path.dirname(supplierDir),
  })
}

test('the Graphify supplier imports without Graphify installed', { skip: skipPython }, () => {
  const result = runPython([
    'import graphify_supplier as supplier',
    "print(len(supplier.PINS['operations']), len(supplier.NATIVE_CLOSURE['modules']))",
  ])
  assert.equal(result.status, 0, result.stderr)
  const [operations, modules] = result.stdout.trim().split(/\s+/).map(Number)
  assert.ok(operations > 0 && modules > 0, result.stdout)
  assert.ok(!fs.existsSync(path.join(supplierDir, '__pycache__')), 'the probe left bytecode beside the supplier')
})

test('parallel native extraction is refused before any native call', { skip: skipPython }, () => {
  // Worker processes import Graphify outside the pinned source loader.
  const result = runPython([
    'import hashlib, tempfile, pathlib',
    'import graphify_supplier as supplier',
    'base = pathlib.Path(tempfile.mkdtemp())',
    "(base / 'src').mkdir(); (base / 'src' / 'a.py').write_text('x = 1\\n')",
    "digest = hashlib.sha256((base / 'src' / 'a.py').read_bytes()).hexdigest()",
    "catalog = {'a': {'sourceId': 'a', 'revision': 1, 'path': 'a.py', 'sourceDigest': digest}}",
    "instance = supplier.GraphifySupplier(runtime=supplier.InstalledGraphifyRuntime(package_root=base / 'absent'), source_root=base / 'src', source_root_id='invented-root', cache_root=base / 'cache', artifact_root=base / 'artifacts', source_catalog=lambda: catalog)",
    'def code(settings):',
    '    try:',
    "        instance.call('extract-structure', {'source_ids': ['a'], 'settings': settings})",
    "        return 'no-error'",
    '    except supplier.SupplierError as error:',
    '        return error.code',
    "print(code({'parallel': True, 'max_workers': 4}), code({'parallel': True}), code({}))",
  ])
  assert.equal(result.status, 0, result.stderr)
  const [parallelWorkers, parallelOnly, serial] = result.stdout.trim().split(/\s+/)
  assert.equal(parallelWorkers, 'NATIVE_WORKERS_UNATTESTED')
  assert.equal(parallelOnly, 'NATIVE_WORKERS_UNATTESTED')
  assert.notEqual(serial, 'NATIVE_WORKERS_UNATTESTED')
  assert.notEqual(serial, 'no-error', 'a serial call must still reach the native boundary and stop there without Graphify installed')
})
