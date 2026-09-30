import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import { workspaceRoot } from '../src/capabilities/files.mjs'
import * as capabilities from '../src/capabilities/index.mjs'
import * as inquiry from '../src/inquiry/index.mjs'
import * as harness from '../src/harnesses/index.mjs'

const CLI = fileURLToPath(new URL('../bin/atelier.mjs', import.meta.url))
const campaign = JSON.parse(fs.readFileSync(new URL('../fixtures/inquiry/workshop.json', import.meta.url)))
const cycle = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url)))
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-workspace-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  return root
}

test('workspace identity accepts Git directory aliases and refuses a nested directory', t => {
  const root = workspace(t), gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const identity = p => { const s = fs.statSync(p, { bigint: true }); return [s.dev, s.ino] }
  assert.deepEqual(identity(workspaceRoot(root)), identity(gitRoot))
  assert.deepEqual(identity(workspaceRoot(gitRoot)), identity(root))
  const nested = path.join(root, 'nested'); fs.mkdirSync(nested)
  assert.throws(() => workspaceRoot(nested), /must be the repository root/)
  // A changed spelling is an alias only when the filesystem says so. Never
  // assume that case folding is safe on every Windows or POSIX volume.
  const alternate = root.slice(0, -1) + (root.at(-1) === root.at(-1).toUpperCase() ? root.at(-1).toLowerCase() : root.at(-1).toUpperCase())
  if (alternate !== root && fs.existsSync(alternate)) assert.deepEqual(identity(workspaceRoot(alternate)), identity(root))
  assert.equal(fs.existsSync(path.join(root, '.atelier-local')), false)
})

test('all sealed example packages retain byte integrity on the checked-out host', () => {
  for (const group of ['capability-packages', 'inquiry-packages', 'harness-packages']) {
    const base = fileURLToPath(new URL(`../fixtures/${group}/`, import.meta.url))
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory())) {
      const packageRoot = path.join(base, entry.name)
      const release = capabilities.verifyCapabilityRelease({ packageRoot })
      assert.ok(release.digest, `${group}/${entry.name}`)
    }
  }
})

test('read-only inquiry and harness journals remain available on every host', t => {
  const root = workspace(t)
  const ledgers = [
    { profile: 'inquiry', records: campaign, run: campaign[0].campaign, schema: 'atelier-inquiry-ledger@v1', head: inquiry.inspectInquiry(campaign).head },
    ...['knowledge', 'build'].map(profile => ({ profile, records: cycle[profile], run: cycle[profile][0].run, schema: 'atelier-harness-ledger@v1', head: harness.inspectHarness(profile, cycle[profile]).head })),
  ]
  for (const { profile, records, run, schema, head } of ledgers) {
    const dir = path.join(root, '.atelier-local', ...(profile === 'inquiry' ? ['inquiry', run] : ['harnesses', profile, run]))
    fs.mkdirSync(dir, { recursive: true })
    const ledger = { schema, records, head, ...(profile === 'inquiry' ? {} : { profile }) }
    const file = path.join(dir, 'ledger.json'); fs.writeFileSync(file, JSON.stringify(ledger)); const before = fs.readFileSync(file)
    const state = profile === 'inquiry' ? inquiry.readInquiry({ workspaceRoot: root, campaign: run }) : harness.readHarness({ workspaceRoot: root, profile, run })
    assert.deepEqual(state.records, records)
    const args = profile === 'inquiry' ? ['inquiry', 'export', '--campaign', run] : ['harness', profile, 'export', '--run', run]
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), ledger)
    assert.deepEqual(fs.readFileSync(file), before)
  }
  assert.equal(fs.existsSync(path.join(root, '.atelier-local/skill-steward')), false)
})

test('Windows refuses adoption, recovery, evidence and ledger writes before creating state', { skip: process.platform !== 'win32' }, t => {
  const root = workspace(t)
  const packageRoot = fileURLToPath(new URL('../fixtures/capability-packages/evidence-review/', import.meta.url))
  const release = capabilities.verifyCapabilityRelease({ packageRoot })
  const settings = { workspaceRoot: root, sources: [packageRoot], adoption: {
    schema: 'mnstry.atelier-capability-adoption@v1', id: 'example-workspace', packages: [{ id: release.package.id, digest: release.digest, mode: 'managed',
      bindings: [{ skill: 'review', host: 'codex-repo-v1', alias: 'evidence-review' }], allowedTools: [], allowedEffects: ['read-workspace'] }],
  } }
  const plan = capabilities.planCapabilityAdoption(settings)
  assert.equal(plan.applyAllowed, true)
  const calls = [
    () => capabilities.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest }),
    () => capabilities.recoverCapabilityAdoption({ workspaceRoot: root }),
    () => capabilities.recordCapabilityEvent({ workspaceRoot: root, event: {} }),
    () => inquiry.appendInquiry({ workspaceRoot: root, record: campaign[0], confirm: inquiry.EMPTY_INQUIRY_HEAD }),
    ...['knowledge', 'build'].map(profile => () => harness.appendHarness({ workspaceRoot: root, profile, record: cycle[profile][0], confirm: harness.EMPTY_HARNESS_HEAD })),
  ]
  for (const invoke of calls) {
    assert.throws(invoke, /qualified POSIX/)
    for (const name of ['.atelier-local', '.agents', '.claude']) assert.equal(fs.existsSync(path.join(root, name)), false)
  }
})
