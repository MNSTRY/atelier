import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildGraph } from '../graph/graph.mjs'
import { parseYamlSubset, splitFrontmatter } from '../graph/knowledge-graph.mjs'
import { commandProject } from '../project/config.mjs'

// The MNSTRY GraphMark standard (docs/reference/graphmark.md): a mark preserves
// one specific edition of something someone singled out, records who made it,
// who marked it, when and why, and joins it to the knowledge graph as evidence.
// The knowledge graph already proves that a mark's edges resolve. This check
// adds what the graph cannot see: that each record satisfies the mark
// contract, that the marked edition is still on disk or has visibly moved on,
// and that a mark is never more widely visible than what it marks. Pure and
// offline: it reads tracked sources through the graph and writes nothing.

export const GRAPHMARK_CONTRACT = 'atelier-graphmark@v1'
export const GRAPHMARK_TAG = 'graphmark'
export const MARK_STATES = ['marked', 'preserved', 'recorded', 'graph-checked', 'shared', 'accepted']

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

// The nearest enclosing Git repository root (a .git directory or file), or the
// directory itself when none encloses it.
export function gitRoot(dir) {
  const start = path.resolve(dir)
  for (let current = start; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    if (path.dirname(current) === current) return start
  }
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
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

    // The edition: the marked bytes at the moment of marking. markedPath is
    // relative to the Git repository root; where the Atelier repository entry
    // is a declared knowledge folder inside it, a folder-relative path is also
    // accepted. The repository root is tried first.
    let edition = 'intact'
    const bases = [...new Set([gitRoot(repoRoot), path.resolve(repoRoot)])]
    const resolved = bases.map((base) => ({ base, file: path.resolve(base, record.markedPath) }))
    if (resolved.some(({ base, file }) => !file.startsWith(base + path.sep))) {
      errors.push(`${where}: markedPath leaves the repository`)
      continue
    }
    const found = resolved.find(({ file }) => fs.existsSync(file) && fs.statSync(file).isFile())
    const markedFile = (found ?? resolved[0]).file
    if (!found) {
      edition = 'missing'
      errors.push(`${where}: the marked file ${record.markedPath} is gone; restore it or mark its new location with supersedes`)
    } else if (sha256File(markedFile) !== record.markedSha256) {
      edition = 'changed'
      warnings.push(`${where}: ${record.markedPath} has changed since it was marked; the marked edition is the one with SHA-256 ${record.markedSha256} in history`)
    }

    // Audience: a mark is never more widely visible than what it marks.
    const materials = []
    const inFolder = path.relative(path.resolve(repoRoot), markedFile)
    const fileNode = inFolder.startsWith('..') ? null : nodesByRepoPath.get(`${node.repo}\u0000${inFolder.split(path.sep).join('/')}`)
    if (fileNode) materials.push(fileNode)
    for (const target of record.kg.relations.evidences) {
      const targetNode = nodesById.get(target)
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
      warnings.push(`${where}: ${record.markedPath} is not a node in the graph, so its audience could not be compared`)
    }

    marks.push({ id: record.kg.id, path: where, markState: record.markState, edition, audience: record.kg.audience })
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
    console.log('Usage: atelier graphmark check [--json] [--project PATH]\n\nVerify every GraphMark record: the atelier-graphmark@v1 contract, the marked edition and the audience.\nReads tracked sources through the knowledge graph and writes nothing.')
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
    const changed = report.marks.filter((mark) => mark.edition === 'changed').length
    const intact = report.marks.filter((mark) => mark.edition === 'intact').length
    console.log(`graphmark: ${report.marks.length} marks · ${intact} editions intact · ${changed} changed · ${report.errors.length} errors`)
  }
  if (!report.ok) process.exit(1)
}
