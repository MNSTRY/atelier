import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execNpmSync } from '../scripts/npm-cli.mjs'
import { resolveExchange } from '../src/projection/obsidian/publication/index.mjs'

// AP-06 package proof. The package is packed, its bytes are extracted into a
// bare consumer project, and a separate process imports the Obsidian entry
// points by package name and runs the production pipeline over a synthetic
// workspace into a vault no application has open. Nothing here starts the
// app, and nothing reaches a registry: the tarball is extracted rather than
// installed, and its runtime dependencies are linked from this checkout.
// `npm run consumer:smoke` is the proof of a real `npm install` of the same
// tarball and imports every declared subpath, these included.
//
// This is package proof only. It closes no gate: G18 also needs a separately
// recorded adopter acceptance.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which is asserted separately' }

const OBSIDIAN_MODULE_SUBPATHS = Object.keys(packageJson.exports).filter((subpath) => subpath === './obsidian' || subpath.startsWith('./obsidian/'))
const OBSIDIAN_SCHEMA_SUBPATHS = Object.keys(packageJson.exports).filter((subpath) => subpath.startsWith('./contracts/atelier-obsidian-'))

// Strings that exist only in a document the census never classified. A vault
// byte or path that carries one means a withheld document was published.
const WITHHELD_SENTINEL = 'sentinel-withheld-quillfeather-7731'

let packed = null

function packOnce() {
  if (packed) return packed
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-obsidian-package-'))
  const stdout = execNpmSync(['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const pack = JSON.parse(stdout)[0]
  const consumer = path.join(root, 'consumer')
  const installed = path.join(consumer, 'node_modules', '@mnstry', 'atelier')
  fs.mkdirSync(installed, { recursive: true })
  // Relative operands: a tar that reads `C:` as a remote host still extracts.
  execFileSync('tar', ['-xzf', pack.filename, '-C', 'consumer/node_modules/@mnstry/atelier', '--strip-components=1'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  fs.writeFileSync(path.join(consumer, 'package.json'), `${JSON.stringify({ name: 'atelier-obsidian-consumer', private: true, type: 'module' }, null, 2)}\n`)
  // The non-dev dependency closure, by name, from the lockfile. The consumer
  // resolves each through a link to this checkout's installed copy.
  const lockfile = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  for (const [entryPath, entry] of Object.entries(lockfile.packages ?? {})) {
    if (!entryPath.startsWith('node_modules/') || entryPath.includes('/node_modules/', 1) || entry.dev) continue
    const name = entryPath.slice('node_modules/'.length)
    const target = path.join(consumer, 'node_modules', ...name.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(path.join(ROOT, 'node_modules', ...name.split('/')), target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  packed = { root, consumer, installed, files: pack.files.map((file) => file.path).sort() }
  return packed
}

test.after(() => { if (packed) fs.rmSync(packed.root, { recursive: true, force: true }) })

function runConsumer(name, source, env = {}) {
  const { consumer, root } = packOnce()
  const home = path.join(root, `home-${name}`)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(consumer, `${name}.mjs`), source)
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MNSTRY_|ATELIER_|NODE_OPTIONS$|NODE_PATH$)/.test(key)))
  const stdout = execFileSync(process.execPath, [`${name}.mjs`], { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 50_000, env: { ...childEnv, HOME: home, USERPROFILE: home, ...env } })
  return JSON.parse(stdout.trim().split('\n').at(-1))
}

function writeSyntheticWorkspace(workspaceDir) {
  const repo = path.join(workspaceDir, 'field-notes')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'notes'), { recursive: true })
  const note = ({ id, title, relations = '' }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n${relations}---\n\n# ${title}\n\nSynthetic body of ${id}.\n`
  fs.writeFileSync(path.join(repo, 'notes', 'lantern.md'), note({ id: 'field-notes:lantern', title: 'Lantern survey', relations: '  relations:\n    supports:\n      - "field-notes:harbour"\n' }))
  fs.writeFileSync(path.join(repo, 'notes', 'harbour.md'), note({ id: 'field-notes:harbour', title: 'Harbour ledger' }))
  fs.writeFileSync(path.join(repo, 'notes', 'unclassified.md'), `# Unclassified draft\n\n${WITHHELD_SENTINEL}\n`)
  const scope = { scopeId: 'scope-full', mode: 'full', selector: { all: true } }
  fs.writeFileSync(path.join(workspaceDir, 'atelier.project.json'), `${JSON.stringify({
    schema: 'mnstry.atelier-project-config@v1',
    name: 'obsidian-package-proof',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'field-notes', path: 'field-notes', readBoundary: 'team' }],
    ext: { 'mnstry.atelier.obsidian': { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [scope] } },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(workspaceDir, 'repo-access.v1.json'), `${JSON.stringify({ schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: { 'field-notes': { readBoundary: 'team' } } }, null, 2)}\n`)
  return path.join(workspaceDir, 'atelier.project.json')
}

// The consumer's pipeline, by package name only. `publish: false` stops after
// prepareView, which needs no exchange and so runs on every platform.
const PIPELINE_SOURCE = `
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveProjectConfig } from '@mnstry/atelier/project'
import { DEFAULT_ELIGIBILITY, createProductionSeams } from '@mnstry/atelier/obsidian'
import { validateObsidianContract } from '@mnstry/atelier/obsidian/contracts'
import { PROTOCOL_ID, createEditorAdapter } from '@mnstry/atelier/obsidian/publication'

const [projectFile, stateRoot, vaultRoot, publish] = [process.env.PROOF_PROJECT, process.env.PROOF_STATE, process.env.PROOF_VAULT, process.env.PROOF_PUBLISH === '1']
const scope = { schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-full', mode: 'full', selector: { all: true } }
const workspaceId = 'ws-package-0001'
const seams = createProductionSeams()
const project = resolveProjectConfig({ argv: ['--project=' + projectFile], cwd: path.dirname(projectFile) })
const graph = await seams.buildGraph({ project, eligibility: DEFAULT_ELIGIBILITY })
const configDigest = 'sha256:' + createHash('sha256').update(fs.readFileSync(projectFile)).digest('hex')
const snapshot = await seams.captureSnapshot({ project, graph, workspaceId, index: new Map(), configDigest, capturedAt: '2026-02-01T12:00:00.000Z' })
const profile = seams.profileFor({ project, workspaceId, audienceAllow: ['team'] })
const prepared = await seams.prepareView({ snapshot, profile, scope, priorManifest: null, clock: () => '2026-02-01T12:00:01.000Z' })
const manifestErrors = validateObsidianContract('generation-manifest', prepared.manifest)
const answer = {
  manifestErrors,
  notes: prepared.files.filter((file) => file.kind === 'note').map((file) => file.path).sort(),
  links: prepared.manifest.links.length,
  published: null,
}
if (publish) {
  // No application has this vault open, so the editor is reported absent and
  // publication takes the direct path.
  const repositoryRoots = project.repos.filter((repo) => !repo.external).map((repo) => repo.path)
  const store = seams.createRecoveryStore({ workspaceRoot: stateRoot, workspaceId, scopeId: scope.scopeId, vaultRoot, repositoryRoots })
  const adapter = createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })
  const result = await seams.publishView({ preparedView: prepared, protocolId: PROTOCOL_ID, expectedGeneration: null, recoveryStore: store, adapter, clock: () => new Date('2026-02-01T12:00:02.000Z'), quietPeriodMs: 0 })
  answer.published = { state: result.state, mode: result.mode ?? null }
}
console.log(JSON.stringify(answer))
`

test('the packed tarball carries the Obsidian runtime, contracts and documents, and none of the proof tooling', () => {
  const { files } = packOnce()
  const shipped = new Set(files)
  for (const [subpath, target] of Object.entries(packageJson.exports)) {
    if (!subpath.includes('obsidian')) continue
    assert.ok(shipped.has(target.replace(/^\.\//, '')), `${subpath} names a packed file`)
  }
  assert.equal(OBSIDIAN_MODULE_SUBPATHS.length, 8)
  const sourceSchemas = fs.readdirSync(path.join(ROOT, 'contracts')).filter((name) => /^atelier-obsidian-.*\.schema\.json$/.test(name)).sort()
  assert.ok(sourceSchemas.length >= 11)
  assert.deepEqual(OBSIDIAN_SCHEMA_SUBPATHS.map((subpath) => subpath.slice('./contracts/'.length)).sort(), sourceSchemas, 'every Obsidian schema is an export')
  for (const required of ['docs/obsidian.md', 'docs/obsidian-contract.md', 'docs/local-services.md', 'src/commands/obsidian.mjs', 'src/runtime/obsidian/service-main.mjs', 'src/runtime/obsidian/contributions/source-apply.mjs', 'src/runtime/obsidian/contributions/proposal-adapter.mjs']) {
    assert.ok(shipped.has(required), `${required} is packed`)
  }
  const forbidden = files.filter((file) => /^(experiments|scripts|test|examples|\.artifacts|\.github)\//.test(file) || /\.asar$/i.test(file) || file.includes('node_modules/') || /(^|\/)\.artifacts\//.test(file))
  assert.deepEqual(forbidden, [], 'no proof tooling, test, experiment, receipt directory or app archive is packed')
  const oversized = files.filter((file) => file.startsWith('fixtures/obsidian/')).filter((file) => fs.statSync(path.join(packOnce().installed, file)).size > 262_144)
  assert.deepEqual(oversized, [], 'packed Obsidian fixtures are small text; scale corpora are generated at test time')
})

test('a consumer imports every Obsidian entry point and schema from the packed bytes', () => {
  const { installed } = packOnce()
  const answer = runConsumer('imports', `
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const modules = ${JSON.stringify(OBSIDIAN_MODULE_SUBPATHS)}
const schemas = ${JSON.stringify(OBSIDIAN_SCHEMA_SUBPATHS)}
const names = {}
for (const subpath of modules) names[subpath] = Object.keys(await import('@mnstry/atelier' + subpath.slice(1))).length
const ids = []
for (const subpath of schemas) ids.push(JSON.parse(fs.readFileSync(fileURLToPath(import.meta.resolve('@mnstry/atelier' + subpath.slice(1))), 'utf8')).$id ?? null)
let blocked = null
try { await import('@mnstry/atelier/src/runtime/obsidian/engine.mjs') } catch (error) { blocked = error.code }
const { MINIMUM_APP_VERSION, createMaintenanceEngine, openScope } = await import('@mnstry/atelier/obsidian')
const { prepareView } = await import('@mnstry/atelier/obsidian/materialize')
const { publishView } = await import('@mnstry/atelier/obsidian/publication')
const { resolveSelection, validateAcceptanceReceipt } = await import('@mnstry/atelier/obsidian/selection')
console.log(JSON.stringify({ names, ids, blocked, floor: MINIMUM_APP_VERSION, functions: [createMaintenanceEngine, openScope, prepareView, publishView, resolveSelection, validateAcceptanceReceipt].map((value) => typeof value), resolved: fs.realpathSync(fileURLToPath(import.meta.resolve('@mnstry/atelier/obsidian'))) }))
`)
  for (const subpath of OBSIDIAN_MODULE_SUBPATHS) assert.ok(answer.names[subpath] > 0, `${subpath} exports names`)
  assert.equal(answer.ids.length, OBSIDIAN_SCHEMA_SUBPATHS.length)
  assert.ok(answer.ids.every((id) => typeof id === 'string' && id.includes('atelier-obsidian-')), 'every schema parses and names itself')
  assert.equal(answer.blocked, 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'an undeclared internal path stays closed')
  assert.deepEqual(answer.functions, Array(6).fill('function'))
  assert.equal(typeof answer.floor, 'string')
  assert.ok(answer.resolved.startsWith(fs.realpathSync(installed) + path.sep), 'the consumer loaded the packed copy, not this checkout')
})

test('a consumer prepares a view of a synthetic workspace from the packed bytes, and the withheld document stays out', () => {
  const { root } = packOnce()
  const dir = fs.mkdtempSync(path.join(root, 'prepare-'))
  const projectFile = writeSyntheticWorkspace(path.join(dir, 'workspace'))
  const answer = runConsumer('prepare', PIPELINE_SOURCE, { PROOF_PROJECT: projectFile, PROOF_STATE: path.join(dir, 'state'), PROOF_VAULT: path.join(dir, 'vault'), PROOF_PUBLISH: '0' })
  assert.equal(answer.notes.length, 2, 'the two classified documents are notes; the unclassified one is withheld')
  assert.ok(answer.notes.some((note) => /^notes\/Lantern survey--[0-9a-f]{12,}\.md$/.test(note)), answer.notes.join(', '))
  assert.equal(answer.links, 1)
  assert.deepEqual(answer.manifestErrors, [], 'the generation manifest satisfies the packed schema')
  assert.equal(answer.published, null)
})

test('a consumer publishes that view into a temporary vault with no app, from the packed bytes', needsExchange, () => {
  const { root } = packOnce()
  const dir = fs.mkdtempSync(path.join(root, 'publish-'))
  const projectFile = writeSyntheticWorkspace(path.join(dir, 'workspace'))
  const vaultRoot = path.join(dir, 'vault')
  const answer = runConsumer('publish', PIPELINE_SOURCE, { PROOF_PROJECT: projectFile, PROOF_STATE: path.join(dir, 'state'), PROOF_VAULT: vaultRoot, PROOF_PUBLISH: '1' })
  assert.deepEqual(answer.published, { state: 'committed', mode: 'direct' })
  for (const note of answer.notes) assert.ok(fs.statSync(path.join(vaultRoot, note)).isFile(), `${note} exists in the vault`)
  const lantern = fs.readFileSync(path.join(vaultRoot, answer.notes.find((note) => note.includes('Lantern survey'))), 'utf8')
  assert.match(lantern, /Synthetic body of field-notes:lantern\./)
  assert.match(lantern, /Harbour ledger--[0-9a-f]{12,}/, 'the declared relation is a link to the other note')
  const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(current, entry.name)) : [path.join(current, entry.name)])
  for (const file of walk(vaultRoot)) {
    assert.ok(!fs.readFileSync(file).toString('latin1').includes(WITHHELD_SENTINEL), `${path.relative(vaultRoot, file)} carries no withheld byte`)
  }
  assert.ok(!walk(vaultRoot).some((file) => /unclassified/i.test(path.relative(vaultRoot, file))), 'the withheld document names no vault path')
})

// Mutation control for the tarball audit: a synthetic package that packs what
// must never ship. Each refusal is matched by its own message, so an audit
// that stopped looking for one class fails here.
test('mutation control: the release audit refuses proof tooling, experiments, a receipt directory, an app archive, a harness receipt, an oversized Obsidian fixture and an export with no packed file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-obsidian-audit-mutation-'))
  try {
    for (const rel of ['scripts/check-release-tarball.mjs', 'scripts/npm-cli.mjs', 'scripts/structural-patterns.mjs', 'src/disclosure/content-scan.mjs', 'src/egress/forbidden-egress.mjs']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel))
    }
    const identity = (host, operator) => ({ 'mnstry.atelier.obsidian': { host: { id: host }, operator: { id: operator } } })
    const receipt = (ext) => `${JSON.stringify({ schema: 'atelier-obsidian-acceptance-receipt/v1', receiptId: 'acceptance-synthetic-0001', ext })}\n`
    const files = {
      'README.md': 'fixture 0.0.0-mutation.1\n',
      'CHANGELOG.md': '# Changelog\n\n## 0.0.0-mutation.1\n',
      LICENSE: 'Apache-2.0\n',
      NOTICE: 'fixture\n',
      'TRADEMARKS.md': 'fixture\n',
      'SECURITY.md': 'fixture\n',
      'bin/atelier.mjs': 'export {}\n',
      'bin/mnstry-atelier.mjs': 'export {}\n',
      'scripts/obsidian/desktop-receipts.mjs': 'export {}\n',
      'experiments/probe/notes.md': '# Probe\n',
      '.artifacts/obsidian/desktop/G07.json': receipt({}),
      'fixtures/app/synthetic.asar': 'not an archive\n',
      'fixtures/obsidian/acceptance/receipts/harness.v1.json': receipt({ ...identity('host-synthetic-desk-01', 'operator-synthetic'), 'mnstry.atelier.obsidian.desktop-receipts': { closes: false } }),
      'fixtures/obsidian/acceptance/receipts/stripped.v1.json': receipt(identity('host-Example-Laptop.local', 'code-1a')),
      'fixtures/obsidian/acceptance/receipts/no-identity.v1.json': receipt({}),
      'fixtures/obsidian/contracts/acceptance-receipt/valid/shape.v1.json': receipt({}),
      'fixtures/obsidian/acceptance/receipts/synthetic.v1.json': receipt(identity('host-synthetic-desk-01', 'operator-synthetic')),
      'fixtures/elsewhere/receipt.v1.json': receipt(identity('host-synthetic-desk-01', 'operator-synthetic')),
      'fixtures/obsidian/scale/corpus.json': `${JSON.stringify({ filler: 'a'.repeat(300_000) })}\n`,
      'fixtures/scale/corpus.json': `${JSON.stringify({ filler: 'c'.repeat(300_000) })}\n`,
    }
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), content)
    }
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
      name: '@mnstry/atelier', version: '0.0.0-mutation.1', private: false, license: 'Apache-2.0', type: 'module',
      bin: { atelier: 'bin/atelier.mjs', 'mnstry-atelier': 'bin/mnstry-atelier.mjs' },
      exports: { './obsidian': './src/runtime/obsidian/index.mjs' },
      files: ['README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'TRADEMARKS.md', 'SECURITY.md', 'bin/', 'scripts/obsidian/', 'experiments/', '.artifacts/', 'fixtures/'],
    }, null, 2)}\n`)
    let status = 0
    let stderr = ''
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts', 'check-release-tarball.mjs')], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ATELIER_DENYLIST_JSON: '{"patterns":[]}', ATELIER_CANDIDATE_TARBALL: '', ATELIER_CANDIDATE_PACK_JSON: '', ATELIER_EXPECTED_TARBALL_SHA256: '' } })
    } catch (error) {
      status = error.status
      stderr = String(error.stderr)
    }
    assert.equal(status, 1, stderr)
    for (const expected of [
      /proof tooling, tests and experiments are not shipped: scripts\/obsidian\/desktop-receipts\.mjs/,
      /proof tooling, tests and experiments are not shipped: experiments\/probe\/notes\.md/,
      /acceptance receipts and their evidence are not shipped: \.artifacts\/obsidian\/desktop\/G07\.json/,
      /an application archive is not shipped: fixtures\/app\/synthetic\.asar/,
      /packed acceptance receipt is not a synthetic fixture: fixtures\/obsidian\/acceptance\/receipts\/harness\.v1\.json/,
      /packed acceptance receipt is not a synthetic fixture: fixtures\/obsidian\/acceptance\/receipts\/stripped\.v1\.json/,
      /packed acceptance receipt is not a synthetic fixture: fixtures\/obsidian\/acceptance\/receipts\/no-identity\.v1\.json/,
      /packed acceptance receipt is not a synthetic fixture: fixtures\/elsewhere\/receipt\.v1\.json/,
      /packed fixture exceeds 262144 bytes: fixtures\/obsidian\/scale\/corpus\.json/,
      /packed fixture exceeds 262144 bytes: fixtures\/scale\/corpus\.json/,
      /package export \.\/obsidian names a file the tarball does not carry/,
      /tarball must include docs\/obsidian\.md/,
      /tarball must include src\/projection\/obsidian\/publication\/index\.mjs/,
    ]) assert.match(stderr, expected)
    assert.doesNotMatch(stderr, /synthetic\.v1\.json/)
    assert.doesNotMatch(stderr, /shape\.v1\.json/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
