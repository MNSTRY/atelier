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
// record contract, that the target lies in the mark's own repository, that
// the marked edition is held by a commit reachable from a branch, a tag or
// HEAD, that the selector names something inside it, whether the file has
// changed since, and that a mark is never more widely visible than what it
// marks. Offline: it reads tracked sources and Git objects and writes nothing.

export const GRAPHMARK_CONTRACT = 'atelier-graphmark@v1'
export const GRAPHMARK_TAG = 'graphmark'
export const MARK_STATES = ['marked', 'preserved', 'recorded', 'graph-checked', 'shared', 'accepted']
export const SELECTOR_TYPES = ['whole', 'lines', 'text-quote']
const CLAIMS_VERIFIED_EDITION = new Set(['graph-checked', 'shared', 'accepted'])

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

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

// Resolve a revision to a commit and say whether shared history holds it: a
// commit reachable from HEAD or from a branch, tag or remote branch. The stash
// and unreachable objects do not count.
export function resolveRevision(root, revision) {
  if (!root || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(revision) || /(^|\/)stash$/.test(revision)) return null
  const out = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`])
  const commit = out?.toString('utf8').trim()
  if (!commit) return null
  const reachable =
    git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']) !== null ||
    Boolean(git(root, ['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'])?.toString('utf8').trim())
  return { commit, reachable, exact: revision === commit }
}

// The bytes of a regular file at `commit:objectPath`, or null when the commit
// does not hold one there (a symbolic link or submodule is not a file).
function blobAt(root, commit, objectPath) {
  const entry = git(root, ['ls-tree', '-z', '--end-of-options', commit, '--', objectPath])?.toString('utf8')
  if (!entry) return null
  const mode = entry.split(' ')[0]
  if (mode !== '100644' && mode !== '100755') return { symlink: mode === '120000' }
  const bytes = git(root, ['cat-file', 'blob', `${commit}:${objectPath}`])
  return bytes ? { bytes } : null
}

// Working-tree bytes of a tracked regular file, never through a symbolic link.
function trackedBytes(root, file, objectPath) {
  if (git(root, ['ls-files', '--error-unmatch', '--', objectPath]) === null) return null
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() ? fs.readFileSync(file) : null
  } catch {
    return null
  }
}

const toPosix = (value) => value.split(path.sep).join('/')
const inside = (base, file) => file === base || file.startsWith(base + path.sep)

// The selector must be one the standard defines, and name something inside
// the edition's text.
export function selectorProblem(selector) {
  if (!SELECTOR_TYPES.includes(selector.type)) return `selector type "${selector.type}" is not one of ${SELECTOR_TYPES.join(', ')}`
  if (selector.version !== '1') return `selector ${selector.type} version "${selector.version}" is not 1`
  if (selector.type === 'whole' && selector.value !== '*') return 'selector whole must have the value "*"'
  if (selector.type === 'lines' && !/^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.test(selector.value)) return `selector lines "${selector.value}" must be N or N-M (1-based, inclusive)`
  return null
}

function checkSelector(selector, text) {
  if (selector.type === 'whole') return {}
  if (selector.type === 'lines') {
    const [, startText, endText] = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(selector.value)
    const start = Number(startText)
    const end = Number(endText ?? startText)
    const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    if (end < start || end > count) return { error: `selector lines ${selector.value} fall outside the marked edition (${count} lines)` }
    return {}
  }
  const occurrences = text.split(selector.value).length - 1
  if (occurrences === 0) return { error: 'selector text-quote is not in the marked edition' }
  if (occurrences > 1) return { warning: `selector text-quote occurs ${occurrences} times in the marked edition; it is ambiguous` }
  return {}
}

// Check every mark in a built graph. `repoRoots` maps every configured repo
// name to its directory. Returns { ok, marks, errors, warnings }.
export function checkGraphmarksInGraph(graph, repoRoots) {
  const errors = []
  const warnings = []
  const marks = []
  if (graph.errors?.length) {
    return { ok: false, marks, errors: graph.errors.map((error) => `knowledge graph: ${error}`), warnings }
  }
  const folders = new Map([...repoRoots].map(([name, dir]) => [name, path.resolve(dir)]))
  const nodesByFile = new Map(graph.nodes.filter((node) => folders.has(node.repo)).map((node) => [path.resolve(folders.get(node.repo), node.path), node]))
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  // Every Markdown node tagged graphmark is a mark record, except a marks index (kg type index).
  const candidates = graph.nodes.filter((node) => Array.isArray(node.tags) && node.tags.includes(GRAPHMARK_TAG) && node.type !== 'index' && /\.md$/i.test(node.path ?? ''))

  for (const node of candidates) {
    const where = `${node.repo}/${node.path}`
    const folder = folders.get(node.repo)
    if (!folder) {
      errors.push(`${where}: repository is not readable from this project`)
      continue
    }
    const record = readMarkRecord(fs.readFileSync(path.join(folder, node.path), 'utf8'))
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
    const at = `${where}: ${target.objectId}`
    if (target.owner !== node.repo) {
      errors.push(`${where}: target owner "${target.owner}" is not this repository "${node.repo}"; a mark lives in the repository that owns what it marks`)
      continue
    }
    const selectorError = selectorProblem(target.selector)
    if (selectorError) {
      errors.push(`${at}: ${selectorError}`)
      continue
    }
    for (const index of record.kg.relations.belongs_to) {
      if (nodesById.get(index)?.type !== 'index') errors.push(`${where}: belongs_to ${index} is not a marks index (kg type index)`)
    }

    // Resolve the object: from the Git repository root, or from the repository
    // entry's folder when that folder sits inside it.
    const root = gitRoot(folder)
    if (!root) {
      errors.push(`${at}: the repository is not under Git, so no edition can be recovered`)
      continue
    }
    const forms = [...new Set([root, folder])].map((base) => {
      const file = path.resolve(base, target.objectId)
      return { base, file, objectPath: toPosix(path.relative(root, file)) }
    })
    if (forms.some(({ base, file }) => !inside(base, file) || file === base)) {
      errors.push(`${at}: target objectId leaves the repository`)
      continue
    }
    if (forms.some(({ objectPath }) => objectPath === '.git' || objectPath.startsWith('.git/'))) {
      errors.push(`${at}: target objectId points into .git`)
      continue
    }

    // The edition: bytes with target.contentDigest, held by a reachable commit
    // at target.revision, or else at HEAD. Try every path form against
    // history, so a removed or renamed file still resolves.
    const revision = resolveRevision(root, target.revision)
    const head = resolveRevision(root, 'HEAD')
    const lookups = forms.map((form) => {
      const atRev = revision?.reachable ? blobAt(root, revision.commit, form.objectPath) : null
      const atHead = head ? blobAt(root, head.commit, form.objectPath) : null
      return {
        ...form,
        atRev, atHead,
        revMatch: Boolean(atRev?.bytes) && contentDigest(atRev.bytes) === target.contentDigest,
        headMatch: Boolean(atHead?.bytes) && contentDigest(atHead.bytes) === target.contentDigest,
        current: trackedBytes(root, form.file, form.objectPath),
      }
    })
    const chosen = lookups.find((form) => form.revMatch) ?? lookups.find((form) => form.headMatch) ?? lookups.find((form) => form.current) ?? lookups[0]

    // A target must lie with its owner, not in another configured repository.
    const foreign = [...folders].find(([name, dir]) => name !== node.repo && inside(dir, chosen.file) && !inside(dir, folder))
    if (foreign) {
      errors.push(`${at}: lies in repository "${foreign[0]}", not in "${node.repo}"; mark it in the repository that owns it`)
      continue
    }
    if (chosen.atRev?.symlink || chosen.atHead?.symlink) {
      errors.push(`${at}: is a symbolic link; mark the file it points to`)
      continue
    }

    const current = chosen.current ? contentDigest(chosen.current) === target.contentDigest : false
    const revisionStatus = !revision
      ? `revision ${target.revision} is not a commit in this repository`
      : !revision.reachable
        ? `revision ${target.revision} is not reachable from HEAD or any branch or tag`
        : chosen.atRev?.bytes
          ? `revision ${target.revision} holds different bytes`
          : `revision ${target.revision} does not hold ${target.objectId}`
    let edition
    let editionBytes = null
    if (chosen.revMatch) editionBytes = chosen.atRev.bytes
    else if (chosen.headMatch) editionBytes = chosen.atHead.bytes
    if (!editionBytes) {
      edition = 'unrecoverable'
      errors.push(current
        ? `${at}: the marked edition exists only in the working tree (${revisionStatus}); commit it and record that commit as target.revision`
        : `${at}: the marked edition is not recoverable: ${revisionStatus}, and HEAD does not hold it either`)
    } else {
      if (!chosen.revMatch) warnings.push(`${at}: ${revisionStatus}; the edition is held at HEAD. Record the commit that holds it as target.revision`)
      else if (!revision.exact) warnings.push(`${at}: revision ${target.revision} is a name or an abbreviation; record the full commit id ${revision.commit}`)
      if (!chosen.revMatch && CLAIMS_VERIFIED_EDITION.has(record.markState)) {
        warnings.push(`${where}: markState "${record.markState}" claims a verified edition, but target.revision does not hold it`)
      }
      const recover = `git cat-file blob ${chosen.revMatch ? revision.commit : 'HEAD'}:${chosen.objectPath}`
      if (current) edition = 'intact'
      else if (chosen.current) {
        edition = 'changed'
        warnings.push(`${at}: has changed since it was marked; the marked edition is recoverable with \`${recover}\``)
      } else {
        edition = 'removed'
        warnings.push(`${at}: is no longer in the working tree; the marked edition is recoverable with \`${recover}\``)
      }
      const selected = checkSelector(target.selector, editionBytes.toString('utf8'))
      if (selected.error) errors.push(`${at}: ${selected.error}`)
      if (selected.warning) warnings.push(`${at}: ${selected.warning}`)
      if (!selected.error && edition === 'changed' && target.selector.type === 'text-quote' && !chosen.current.toString('utf8').includes(target.selector.value)) {
        warnings.push(`${at}: the marked quote is no longer in the current file`)
      }
    }

    // Audience: a mark is never more widely visible than what it marks. A
    // marked file that is not a graph node is held to its repository's read
    // boundary, the widest audience it can already have.
    const materials = []
    const fileNode = nodesByFile.get(chosen.file)
    if (fileNode) materials.push({ id: fileNode.id, audience: fileNode.audience })
    else materials.push({ id: `${target.objectId} (the repository's read boundary)`, audience: node.repoAccess?.readBoundary ?? 'private' })
    for (const targetId of record.kg.relations.evidences) {
      const targetNode = nodesById.get(targetId)
      if (targetNode) materials.push({ id: targetNode.id, audience: targetNode.audience })
    }
    const markRank = AUDIENCE_READ_RANK[record.kg.audience]
    for (const material of materials) {
      const materialRank = AUDIENCE_READ_RANK[material.audience]
      if (materialRank != null && markRank != null && markRank < materialRank) {
        errors.push(`${where}: the mark's audience "${record.kg.audience}" is wider than "${material.audience}" of ${material.id}; a mark is never more widely visible than what it marks`)
      }
    }

    marks.push({ id: record.kg.id, path: where, markState: record.markState, edition, selector: target.selector.type, audience: record.kg.audience })
  }

  return { ok: errors.length === 0, marks, errors, warnings }
}

// Build the project's graph and check its marks.
export function checkGraphmarks(project) {
  const graph = buildGraph(project)
  const repoRoots = new Map((project.repos ?? []).filter((repo) => repo.name && repo.path && !repo.external).map((repo) => [repo.name, repo.path]))
  return checkGraphmarksInGraph(graph, repoRoots)
}

const USAGE = 'Usage: atelier graphmark check [--json] [--project PATH]\n\nVerify every GraphMark record: the atelier-graphmark@v1 contract, that the target lies in its own repository, that the marked edition is held by a reachable commit, the selector, and the audience.\nReads tracked sources and Git objects and writes nothing.'

export function runGraphmarkCommand(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check'
  if (sub !== 'check') {
    console.error(`unknown graphmark subcommand: ${sub}\n\n${USAGE}`)
    process.exit(2)
  }
  const rest = argv[0] === sub ? argv.slice(1) : argv
  const projectArgs = []
  let json = false
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--json') json = true
    else if (rest[i] === '--project' && i + 1 < rest.length) projectArgs.push(rest[i], rest[(i += 1)])
    else if (rest[i].startsWith('--project=')) projectArgs.push(rest[i])
    else {
      console.error(`unknown option: ${rest[i]}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  const project = commandProject({ argv: projectArgs })
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
