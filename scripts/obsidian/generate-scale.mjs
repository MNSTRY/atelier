#!/usr/bin/env node
// AP-04 scale dataset generator. Writes a synthetic multi-repository
// workspace of the requested size into an external temporary directory,
// never under this repository or any fixtures path, with a dataset manifest
// that pins seed, counts, generator version and fixture digest. The same
// seed and counts give the same fixture digest on every machine.
//
// With --derive it also runs the production derivation pipeline (canonical
// graph -> snapshot -> prepareView -> publishView) into a vault beside the
// workspace with no application involved, recording cold timings, RSS/CPU
// samples and bytes written; --warm N then applies N single-note source
// changes and records source-to-file latency per change. Source-to-app
// latency and app indexing are recorded separately by desktop-receipts.mjs
// against an isolated instance; nothing here claims them.
//
// Usage:
//   node scripts/obsidian/generate-scale.mjs --out DIR [--profile tiny|standard|stress]
//       [--nodes N --edges M --repositories R] [--seed S] [--derive] [--warm N] [--json]

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { OutputRefusal, assertExternalOutput, hardwareProfile, isoNow, parseArgs, sha256Digest, sha256Hex, writeJson } from './lib/common.mjs'
import { FULL_SCOPE, createEngineSeams, deriveWorkspace, loadProject, writeWorkspaceConfig } from './lib/derive.mjs'
import { PROPOSED_TARGETS, createResourceSampler, warmChangeSummary } from './lib/measure.mjs'

export const GENERATOR_VERSION = '1.0.0'
export const DATASET_SCHEMA = 'atelier-obsidian-scale-dataset/v1'
export const MANIFEST_NAME = 'atelier-scale-dataset.json'
export const DEFAULT_SEED = 20260919

// The two AP-04 sets, and a tiny one the unit tests pin.
export const PROFILES = Object.freeze({
  tiny: Object.freeze({ nodes: 50, edges: 100, repositories: 2 }),
  standard: Object.freeze({ nodes: 10000, edges: 50000, repositories: 4 }),
  stress: Object.freeze({ nodes: 100000, edges: 500000, repositories: 8 }),
})

const RELATION_TYPES = ['related', 'supports', 'depends_on', 'implements', 'evidences']
const WORDS = ['harbor', 'tide', 'lantern', 'ledger', 'compass', 'quarry', 'meadow', 'signal', 'anchor', 'orchard', 'summit', 'canvas', 'ember', 'river', 'atlas', 'beacon', 'cellar', 'garden', 'mosaic', 'timber']
const NOTES_PER_BUCKET = 1000

// mulberry32: a small deterministic 32-bit generator.
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (number, width) => String(number).padStart(width, '0')

// The dataset as records: which repository each node lives in, its path,
// title, tags and declared relations. Edges are declared relations to other
// nodes of the set, so the canonical graph holds exactly `edges` of them.
export function planDataset({ nodes, edges, repositories, seed = DEFAULT_SEED }) {
  if (!Number.isInteger(nodes) || nodes < 2) throw new OutputRefusal('invalid-size', 'a dataset has at least two nodes')
  if (!Number.isInteger(edges) || edges < 0 || edges > nodes * (nodes - 1)) throw new OutputRefusal('invalid-size', 'edges must fit between distinct node pairs')
  if (!Number.isInteger(repositories) || repositories < 1 || repositories > nodes) throw new OutputRefusal('invalid-size', 'repositories must be between 1 and the node count')
  const random = mulberry32(seed)
  const width = String(nodes - 1).length
  const repoIds = Array.from({ length: repositories }, (_, index) => `scale-${index + 1}`)
  const records = []
  for (let index = 0; index < nodes; index += 1) {
    const repoId = repoIds[index % repositories]
    const ordinal = Math.floor(index / repositories)
    const bucket = pad(Math.floor(ordinal / NOTES_PER_BUCKET), 3)
    const nodeId = `${repoId}:n-${pad(index, width)}`
    const shared = index % 997 === 0 && index > 0
    const title = shared ? 'Shared concept' : `${WORDS[Math.floor(random() * WORDS.length)]} ${WORDS[Math.floor(random() * WORDS.length)]} ${pad(index, width)}`
    const tags = ['scale', `bucket-${bucket}`, WORDS[Math.floor(random() * WORDS.length)]]
    records.push({ index, repoId, nodeId, path: `notes/${bucket}/n-${pad(index, width)}.md`, title, tags, relations: {} })
  }
  const perNode = Math.floor(edges / nodes)
  const extra = edges % nodes
  for (const record of records) {
    const wanted = perNode + (record.index < extra ? 1 : 0)
    const chosen = new Set()
    while (chosen.size < wanted) {
      const target = Math.floor(random() * nodes)
      if (target !== record.index) chosen.add(target)
    }
    for (const target of chosen) {
      const type = RELATION_TYPES[Math.floor(random() * RELATION_TYPES.length)]
      if (!record.relations[type]) record.relations[type] = []
      record.relations[type].push(records[target].nodeId)
    }
    for (const type of Object.keys(record.relations)) record.relations[type].sort()
  }
  return { repoIds, records, counts: { nodes, edges, repositories } }
}

const yamlString = (value) => JSON.stringify(String(value))

export function renderNote(record, random) {
  const lines = ['---', `title: ${yamlString(record.title)}`, 'tags:']
  for (const tag of record.tags) lines.push(`  - ${yamlString(tag)}`)
  lines.push('kg:', `  id: ${yamlString(record.nodeId)}`, '  type: "document"', '  status: "active"', '  audience: "team"')
  const types = Object.keys(record.relations).sort()
  if (types.length > 0) {
    lines.push('  relations:')
    for (const type of types) {
      lines.push(`    ${type}:`)
      for (const target of record.relations[type]) lines.push(`      - ${yamlString(target)}`)
    }
  }
  lines.push('---', '', `# ${record.title}`, '')
  for (let paragraph = 0; paragraph < 3; paragraph += 1) {
    const words = []
    for (let word = 0; word < 12; word += 1) words.push(WORDS[Math.floor(random() * WORDS.length)])
    lines.push(`${words.join(' ')}.`, '')
  }
  lines.push('## Detail', '', `Synthetic detail block for ${record.nodeId}. ^detail`, '')
  return lines.join('\n')
}

// Generates the dataset files. The fixture digest covers every generated
// note as (path, sha256) in path order; the workspace configuration is
// deterministic too but excluded so the digest names the corpus alone.
export function generateScaleDataset({ outDir, profile = 'standard', nodes, edges, repositories, seed = DEFAULT_SEED, assertOutput = assertExternalOutput } = {}) {
  const chosen = PROFILES[profile]
  if (!chosen) throw new OutputRefusal('unknown-profile', `profiles: ${Object.keys(PROFILES).join(', ')}`)
  const size = { nodes: nodes ?? chosen.nodes, edges: edges ?? chosen.edges, repositories: repositories ?? chosen.repositories }
  const resolved = assertOutput(outDir)
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) throw new OutputRefusal('output-not-empty', 'the output directory is empty or absent; remove a previous dataset first', { target: resolved })
  const plan = planDataset({ ...size, seed })
  const workspaceDir = path.join(resolved, 'workspace')
  const random = mulberry32(seed ^ 0x5bd1e995)
  const digests = []
  let bytes = 0
  for (const record of plan.records) {
    const content = Buffer.from(renderNote(record, random), 'utf8')
    const absolute = path.join(workspaceDir, record.repoId, ...record.path.split('/'))
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
    digests.push(`${record.repoId}/${record.path}\n${sha256Hex(content)}\n`)
    bytes += content.length
  }
  const projectFile = writeWorkspaceConfig(workspaceDir, { name: `scale-${profile}`, repositories: plan.repoIds, scopes: [FULL_SCOPE] })
  const manifest = {
    schema: DATASET_SCHEMA,
    generatorVersion: GENERATOR_VERSION,
    profile,
    seed,
    counts: { ...size, files: plan.records.length, bytes },
    fixtureDigest: sha256Digest(digests.join('')),
    repositories: plan.repoIds,
    workspaceDir,
    projectFile,
    generatedAt: isoNow(),
    derivation: null,
  }
  writeJson(path.join(resolved, MANIFEST_NAME), manifest)
  return { manifest, manifestPath: path.join(resolved, MANIFEST_NAME), plan }
}

// Cold derivation and warm single-note changes, no application. Appends the
// measurements to the dataset manifest. The warm changes go through the
// engine's seams (createEngineSeams): sources observed by stat hint after the
// cold pass hashed them all, the graph and preparation caches carried from one
// change to the next. That is the path a running maintenance service takes
// for one edited source; a derivation from bare production seams is the cold
// path and is what `cold` records.
export async function measureDerivation({ manifestPath, warm = 0, adapter, sampleIntervalMs = 500, clock = () => new Date() } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const root = path.dirname(manifestPath)
  const stateRoot = path.join(root, 'derived', 'state')
  const vaultRoot = path.join(root, 'derived', 'vault')
  const engine = createEngineSeams()
  const sampler = createResourceSampler({ intervalMs: sampleIntervalMs }).start()
  engine.observe(loadProject(manifest.projectFile), { full: true })
  const cold = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot, vaultRoot, adapter, clock, sampler, seams: engine.seams })
  const coldSamples = sampler.stop()
  const coldSummary = sampler.summary()
  const warmSamples = []
  const random = mulberry32(manifest.seed ^ 0x9e3779b9)
  const repositories = manifest.repositories
  for (let change = 0; change < warm; change += 1) {
    const repoId = repositories[Math.floor(random() * repositories.length)]
    const notes = listNotes(path.join(manifest.workspaceDir, repoId))
    const source = notes[Math.floor(random() * notes.length)]
    const editedAt = clock().toISOString()
    const marker = `Warm change ${change + 1} at ${editedAt}.`
    const started = performance.now()
    fs.appendFileSync(source, `\n${marker}\n`)
    // The service observes the sources before it builds: by stat hint, the cold pass having hashed every file.
    const observeStarted = performance.now()
    const observed = engine.observe(loadProject(manifest.projectFile), { full: false })
    const observeMs = Math.round((performance.now() - observeStarted) * 1000) / 1000
    const result = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot, vaultRoot, adapter, clock, seams: engine.seams })
    // The edited source's note, by the identity the generator gave it, read once: the sample ends when its bytes carry the marker.
    const nodeId = `${repoId}:${path.basename(source, '.md')}`
    const note = result.manifest.notes.find((entry) => entry.nodeId === nodeId)
    const notePath = note ? path.join(vaultRoot, note.path) : null
    const replaced = notePath && fs.existsSync(notePath) && fs.readFileSync(notePath, 'utf8').includes(marker) ? note : null
    const sourceToFileMs = replaced ? Math.round(performance.now() - started) : null
    warmSamples.push({ change: change + 1, source: path.relative(manifest.workspaceDir, source), editedAt, sourceToFileMs, sourceToAppMs: null, state: result.state, timings: { observeMs, ...result.timings }, observed: { changes: observed.changes.length, hashed: observed.hashed }, fileFound: Boolean(replaced) })
  }
  manifest.derivation = {
    measuredAt: clock().toISOString(),
    hardware: hardwareProfile(),
    mode: cold.mode,
    warmPath: 'engine seams: graph file cache, preparation cache and an observation index reconciled by stat hint after a full cold pass',
    adapter: adapter ? 'caller-supplied' : 'absent (direct publication into a vault no application has open)',
    quietPeriodMs: cold.quietPeriodMs,
    cold: { timings: cold.timings, graph: cold.graph, generationId: cold.generationId, written: cold.written, notes: cold.manifest.notes.length, links: cold.manifest.links.length, resources: coldSummary, samples: coldSamples },
    appIndexing: { status: 'not-measured', note: 'app indexing and usable-open timings are recorded by desktop-receipts.mjs AP-04 against an isolated instance' },
    warm: { samples: warmSamples, summary: warmChangeSummary(warmSamples) },
    targets: PROPOSED_TARGETS,
    vaultRoot,
    stateRoot,
  }
  writeJson(manifestPath, manifest)
  return manifest
}

function listNotes(directory) {
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(absolute)
    }
  }
  walk(directory)
  return found.sort()
}

async function main(argv) {
  const args = parseArgs(argv, { flags: ['derive', 'json', 'help'], values: ['out', 'profile', 'nodes', 'edges', 'repositories', 'seed', 'warm'] })
  if (args.help || !args.out) {
    console.log('Usage: node scripts/obsidian/generate-scale.mjs --out DIR [--profile tiny|standard|stress] [--nodes N --edges M --repositories R] [--seed S] [--derive] [--warm N] [--json]')
    return args.help ? 0 : 2
  }
  const integer = (name) => (args[name] === undefined ? undefined : Number.parseInt(args[name], 10))
  const generated = generateScaleDataset({ outDir: path.resolve(args.out), profile: args.profile ?? 'standard', nodes: integer('nodes'), edges: integer('edges'), repositories: integer('repositories'), seed: integer('seed') ?? DEFAULT_SEED })
  let manifest = generated.manifest
  if (args.derive) manifest = await measureDerivation({ manifestPath: generated.manifestPath, warm: integer('warm') ?? 0 })
  if (args.json) console.log(JSON.stringify(manifest, null, 2))
  else {
    console.log(`[generate-scale] ${manifest.profile}: ${manifest.counts.nodes} nodes, ${manifest.counts.edges} edges, ${manifest.counts.files} files, ${manifest.counts.bytes} bytes`)
    console.log(`[generate-scale] fixtureDigest ${manifest.fixtureDigest}`)
    console.log(`[generate-scale] manifest ${generated.manifestPath}`)
    if (manifest.derivation) {
      console.log(`[generate-scale] cold derivation ${manifest.derivation.cold.timings.totalMs} ms (${JSON.stringify(manifest.derivation.cold.timings)}), vault ${manifest.derivation.cold.written.files} files / ${manifest.derivation.cold.written.bytes} bytes, rss peak ${manifest.derivation.cold.resources.rssPeakBytes}`)
      const warm = manifest.derivation.warm.summary
      console.log(`[generate-scale] warm changes ${warm.count}/${warm.expectedSamples}: source-to-file p95 ${warm.sourceToFile.p95Ms} ms (target ${warm.sourceToFile.targetP95Ms} ms); source-to-app ${warm.sourceToApp.status}`)
    }
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => { console.error(`[generate-scale] ${error?.message ?? error}`); process.exitCode = error instanceof OutputRefusal ? 2 : 1 })
}
