import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { architectureEntry, responsibilityCatalog, resolveBehaviorBinding, validateArchitecture } from '../src/architecture/index.mjs'

const fixture = (shape, status) => JSON.parse(fs.readFileSync(new URL(`../fixtures/atelier-architecture/${shape}/${status}/document.json`, import.meta.url)))
test('catalog preserves responsibility, role, workflow and method distinctions through the CLI', () => {
  const catalog = responsibilityCatalog()
  assert.equal(catalog.entries.filter(e => e.kind === 'responsibility').length, 8)
  assert.equal(architectureEntry('Skill Steward').kind, 'role')
  assert.equal(architectureEntry('Skills Harness').id, 'capability-harness')
  assert.equal(architectureEntry('Discovery Engine').id, 'discovery')
  assert.equal(architectureEntry('Coaching').kind, 'method')
  const actual = JSON.parse(execFileSync(process.execPath, ['bin/atelier.mjs', 'architecture', 'catalog']))
  assert.deepEqual(actual, catalog)
  for (const e of catalog.entries) for (const file of e.implementation) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file)
})
test('taxonomy rejects cross-kind relationships and ambiguous names', () => {
  const catalog = responsibilityCatalog()
  catalog.relations.push({ from: 'companion', type: 'realizes', to: 'reflection' })
  assert.match(validateArchitecture(catalog).join(), /incompatible/)
  catalog.entries[0].aliases.push('Witness')
  assert.match(validateArchitecture(catalog).join(), /ambiguous/)
  for (const shape of ['catalog', 'binding']) {
    assert.deepEqual(validateArchitecture(fixture(shape, 'valid'), shape), [])
    assert.ok(validateArchitecture(fixture(shape, 'invalid'), shape).length)
  }
})
test('exact consumer profile, revision and behavior classification are required; diagnostics retain authored pointers', () => {
  const binding = fixture('binding', 'valid')
  const c = { ...binding.fields[0].consumer, classifications: ['guidance'] }
  const resolved = resolveBehaviorBinding({ binding, consumers: [c] })
  assert.equal(resolved.resolved, true)
  assert.equal(resolved.adoption, 'not-established')
  for (const consumers of [[], [{ ...c, revision: '2' }], [{ ...c, classifications: ['presentation'] }]]) {
    const r = resolveBehaviorBinding({ binding, consumers })
    assert.equal(r.resolved, false); assert.equal(r.diagnostics[0].pointer, '/question')
  }
  assert.throws(() => resolveBehaviorBinding({ binding, consumers: [c, c] }), /duplicate/)
  const cli = spawnSync(process.execPath, ['bin/atelier.mjs', 'architecture', 'resolve'], { input: JSON.stringify({ binding, consumers: [] }), encoding: 'utf8' })
  assert.equal(cli.status, 1); assert.equal(JSON.parse(cli.stdout).resolved, false)
  binding.fields[0].required = false
  assert.equal(resolveBehaviorBinding({ binding, consumers: [] }).diagnostics.length, 1)
  binding.fields[0].classification = 'enforced'; binding.fields[0].consumer = null
  assert.match(validateArchitecture(binding, 'binding').join(), /enforcement/)
})
