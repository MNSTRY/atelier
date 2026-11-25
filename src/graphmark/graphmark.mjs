import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildGraph } from '../graph/graph.mjs'
import { parseYamlSubset, splitFrontmatter } from '../graph/knowledge-graph.mjs'
import { commandProject } from '../project/config.mjs'

// The MNSTRY GraphMark standard (docs/reference/graphmark.md): a mark points at
// a specific part of a specific, recoverable edition of something someone
// singled out, records who made it, who marked it, when and why, and joins it
// to the knowledge graph as evidence. Its target is an evidence-navigation
// exact source reference (evidenceRef). The knowledge graph already proves
// that a mark's edges resolve. This check adds what the graph cannot see: the
// record contract, that the marked edition can be recovered from Git, that the
// selector names something inside it, whether the file has changed since, and
// that a mark is never more widely visible than what it marks. Offline: it
// reads tracked sources and Git objects and writes nothing.

export const GRAPHMARK_CONTRACT = 'atelier-graphmark@v1'
export const GRAPHMARK_TAG = 'graphmark'
export const MARK_STATES = ['marked', 'preserved', 'recorded', 'graph-checked', 'shared', 'accepted']
export const SELECTOR_TYPES = ['whole', 'lines', 'text-quote']

// Read rank, as the knowledge graph ranks audiences for read boundaries.
const AUDIENCE_READ_RANK = { public: 0, team: 1, operator: 2, staff: 2, private: 3, sensitive: 3 }

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-graphmark.v1.schema.json', import.meta.url), 'utf8'))
let compiled = null
function contractValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    compiled = ajv.compile(schema)
  }
  return compiled
}

// Validate one mark record's front matter against atelier-graphmark@v1.
export function validateMarkRecord(frontMatter) {
  const validate = contractValidator()
  const ok = validate(frontMatter)
  const errors = ok ? [] : validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`)
  return { ok, errors }
}

// Read a Markdown mark record's front matter with the graph's own reader.
export function readMarkRecord(raw) {
  const split = splitFrontmatter(raw)
  return split ? parseYamlSubset(split.yaml) : null
}

// The nearest enclosing Git repository root (a .git directory or file), or
// null when none encloses the directory.
export function gitRoot(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    if (path.dirname(current) === current) return null
  }
}

export const contentDigest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`

// The bytes of `objectPath` at `revision` in the repository at `root`, or
// null when the revision or the path is not in its history.
function gitBlob(root, revision, objectPath) {
  if (!root || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(revision)) return null
  try {
    return execFileSync('git', ['-C', root, 'cat-file', 'blob', `${revision}:${objectPath}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

const toPosix = (value) => value.split(path.sep).join('/')
const inside = (base, file) => file === base || file.startsWith(base + path.sep)

// Check that the selector names something inside the edition's text.
function checkSelector(selector, text) {
  if (!SELECTOR_TYPES.includes(selector.type)) return { warning: `selector type "${selector.type}" is not verified by this check` }
  if (selector.version !== '1') return { warning: `selector ${selector.type} version "${selector.version}" is not verified by this check` }
  if (selector.type === 'whole') return {}
  if (selector.type === 'lines') {
    const match = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(selector.value)
    if (!match) return { error: `selector lines "${selector.value}" must be N or N-M (1-based, inclusive)` }
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    if (end < start || end > count) return { error: `selector lines ${selector.value} fall outside the marked edition (${count} lines)` }
    return {}
  }
  const occurrences = text.split(selector.value).length - 1
  if (occurrences === 0) return { error: 'selector text-quote is not in the marked edition' }
  if (occurrences > 1) return { warning: `selector text-quote occurs ${occurrences} times in the marked edition; it is ambiguous` }
  return {}
}

// Check every mark in a built graph. `repoRoots` maps a graph repo name to its
// directory. Returns { ok, marks, errors, warnings }; ok is false on any error.
export function checkGraphmarksInGraph(graph, repoRoots) {
  const errors = []
  const warnings = []
  const marks = []
  if (graph.errors?.length) {
    return { ok: false, marks, errors: graph.errors.map((error) => `knowledge graph: ${error}`), warnings }
  }
  const nodesByRepoPath = new Map(graph.nodes.map((node) => [`${node.repo}\u0000${node.path}`, node]))
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  // Every Markdown node tagged graphmark is a mark record, except the marks index itself (kg type index).
  const candidates = graph.nodes.filter((node) => Array.isArray(node.tags) && node.tags.includes(GRAPHMARK_TAG) && node.type !== 'index' && /\.md$/i.test(node.path ?? ''))

  for (const node of candidates) {
    const where = `${node.repo}/${node.path}`
    const repoRoot = repoRoots.get(node.repo)
    if (!repoRoot) {
      errors.push(`${where}: repository is not readable from this project`)
      continue
    }
    const record = readMarkRecord(fs.readFileSync(path.join(repoRoot, node.path), 'utf8'))
    if (!record) {
      errors.push(`${where}: tagged ${GRAPHMARK_TAG} but has no front matter; a mark exists only when its record is written`)
      continue
    }
    const contract = validateMarkRecord(record)
    if (!contract.ok) {
      for (const error of contract.errors) errors.push(`${where}: ${GRAPHMARK_CONTRACT} ${error}`)
      continue
    }
    const { target } = record
    if (target.owner !== node.repo) {
      errors.push(`${where}: target owner "${target.owner}" is not this repository "${node.repo}"; a mark lives in the repository that owns what it marks`)
      continue
    }

    // Resolve the object: from the Git repository root first, then from the
    // repository entry's folder when that folder sits inside the repository.
    const folder = path.resolve(repoRoot)
    const root = gitRoot(folder)
    const bases = [...new Set([root, folder].filter(Boolean))]
    const candidatesForObject = bases.map((base) => path.resolve(base, target.objectId))
    if (bases.some((base, index) => !inside(base, candidatesForObject[index]))) {
      errors.push(`${where}: target objectId leaves the repository`)
      continue
    }
    const atPath = (file) => (root ? toPosix(path.relative(root, file)) : null)
    const objectFile =
      candidatesForObject.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ??
      candidatesForObject.find((file) => gitBlob(root, 'HEAD', atPath(file))) ??
      candidatesForObject[0]
    const objectInGit = atPath(objectFile)

    // The edition: the object's bytes with target.contentDigest. Preserved
    // means recoverable from Git, at target.revision or else at HEAD.
    const revisionBytes = gitBlob(root, target.revision, objectInGit)
    const headBytes = gitBlob(root, 'HEAD', objectInGit)
    const currentBytes = fs.existsSync(objectFile) && fs.statSync(objectFile).isFile() ? fs.readFileSync(objectFile) : null
    const atRevision = revisionBytes ? contentDigest(revisionBytes) === target.contentDigest : null
    const atHead = headBytes ? contentDigest(headBytes) === target.contentDigest : false
    const current = currentBytes ? contentDigest(currentBytes) === target.contentDigest : false
    const where2 = `${where}: ${target.objectId}`

    let edition
    let editionBytes = null
    if (atRevision) editionBytes = revisionBytes
    else if (atHead) editionBytes = headBytes
    if (!editionBytes) {
      edition = 'unrecoverable'
      const why = atRevision === false ? `revision ${target.revision} holds different bytes` : `revision ${target.revision} does not hold it in this repository's history`
      errors.push(current
        ? `${where2}: the marked edition exists only in the working tree (${why}); commit it and record that commit as target.revision`
        : `${where2}: the marked edition is not recoverable: ${why}, and HEAD does not hold it either`)
    } else {
      if (!atRevision) {
        warnings.push(`${where2}: ${atRevision === false ? `revision ${target.revision} holds different bytes` : `revision ${target.revision} is not in this repository's history`}; the edition is held at HEAD. Record the commit that holds it as target.revision`)
      }
      const recover = `git cat-file blob ${atRevision ? target.revision : 'HEAD'}:${objectInGit}`
      if (current) edition = 'intact'
      else if (currentBytes) {
        edition = 'changed'
        warnings.push(`${where2}: has changed since it was marked; the marked edition is recoverable with \`${recover}\``)
      } else {
        edition = 'removed'
        warnings.push(`${where2}: is no longer in the working tree; the marked edition is recoverable with \`${recover}\``)
      }
      const selected = checkSelector(target.selector, editionBytes.toString('utf8'))
      if (selected.error) errors.push(`${where2}: ${selected.error}`)
      if (selected.warning) warnings.push(`${where2}: ${selected.warning}`)
      if (!selected.error && edition === 'changed' && target.selector.type === 'text-quote' && !currentBytes.toString('utf8').includes(target.selector.value)) {
        warnings.push(`${where2}: the marked quote is no longer in the current file`)
      }
    }

    // Audience: a mark is never more widely visible than what it marks.
    const materials = []
    const inFolder = path.relative(folder, objectFile)
    const fileNode = inFolder.startsWith('..') ? null : nodesByRepoPath.get(`${node.repo}\u0000${toPosix(inFolder)}`)
    if (fileNode) materials.push(fileNode)
    for (const targetId of record.kg.relations.evidences) {
      const targetNode = nodesById.get(targetId)
      if (targetNode && !materials.includes(targetNode)) materials.push(targetNode)
    }
    const markRank = AUDIENCE_READ_RANK[record.kg.audience]
    for (const material of materials) {
      const materialRank = AUDIENCE_READ_RANK[material.audience]
      if (materialRank != null && markRank != null && markRank < materialRank) {
        errors.push(`${where}: the mark's audience "${record.kg.audience}" is wider than "${material.audience}" of ${material.id}; a mark is never more widely visible than what it marks`)
      }
    }
    if (!fileNode) {
      warnings.push(`${where2}: is not a node in the graph, so its audience could not be compared`)
    }

    marks.push({ id: record.kg.id, path: where, markState: record.markState, edition, selector: target.selector.type, audience: record.kg.audience })
  }

  return { ok: errors.length === 0, marks, errors, warnings }
}

// Build the project's graph and check its marks.
export function checkGraphmarks(project) {
  const graph = buildGraph(project)
  const repoRoots = new Map((project.repos ?? []).filter((repo) => repo.name && repo.path).map((repo) => [repo.name, repo.path]))
  return checkGraphmarksInGraph(graph, repoRoots)
}

export function runGraphmarkCommand(argv = process.argv.slice(2)) {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check'
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: atelier graphmark check [--json] [--project PATH]\n\nVerify every GraphMark record: the atelier-graphmark@v1 contract, that the marked edition is recoverable from Git, the selector, and the audience.\nReads tracked sources and Git objects and writes nothing.')
    return
  }
  if (sub !== 'check') {
    console.error(`unknown graphmark subcommand: ${sub}`)
    process.exit(2)
  }
  const rest = argv[0] === sub ? argv.slice(1) : argv
  const json = rest.includes('--json')
  const project = commandProject({ argv: rest.filter((arg) => arg !== '--json') })
  const report = checkGraphmarks(project)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const warning of report.warnings) console.warn(`warning: ${warning}`)
    for (const error of report.errors) console.error(error)
    const count = (state) => report.marks.filter((mark) => mark.edition === state).length
    console.log(`graphmark: ${report.marks.length} marks · ${count('intact')} intact · ${count('changed')} changed · ${count('removed')} removed · ${report.errors.length} errors`)
  }
  if (!report.ok) process.exit(1)
}
