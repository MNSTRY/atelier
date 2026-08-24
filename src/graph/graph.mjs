import fs from 'node:fs'
import path from 'node:path'
import { commandProject, gitRemoteUrl, loadRepoAccess, readJson, remoteHost, writeJson } from '../project/config.mjs'
import { gitIgnoreFilter } from '../project/git-ignore.mjs'
import { validateSourceSidecar } from './knowledge-graph.mjs'

export const VALID_AUDIENCES = new Set(['private', 'team', 'operator', 'staff', 'public', 'sensitive'])
export const VALID_RELATIONS = new Set(['related', 'supports', 'supersedes', 'implements', 'depends_on', 'evidences', 'contradicts', 'belongs_to'])
const DOC_EXTS = new Set(['.md', '.html', '.pdf', '.docx'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'atelier-output', 'atelier-readers', '.mnstry', '.atelier-local'])

const slug = (value) => String(value ?? '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const relPath = (root, file) => path.relative(root, file).split(path.sep).join('/')

// Sidecar-first census. Document extensions are always sources; any other
// file — json, yaml, csv, binary assets — opts in by carrying an adjacent
// .kg.json sidecar. The sidecar itself is metadata, never a source asset.
//
// Membership asks whether the sidecar is VISIBLE, not whether it happens to
// exist on this disk. A git-ignored sidecar is machine-local: obeying one
// enrolls a node that no tracked file declares — audience and all — so a
// clean checkout builds a different graph than the machine that wrote it.
function isSourceFile(name, sidecarVisible) {
  if (name.endsWith('.kg.json')) return false
  if (DOC_EXTS.has(path.extname(name).toLowerCase())) return true
  return sidecarVisible === true
}

function sidecarIsVisible(abs, root, isIgnored) {
  const sidecar = sidecarFor(abs)
  return fs.existsSync(sidecar) && !isIgnored(relPath(root, sidecar))
}

function walk(dir, root, acc = [], isIgnored = gitIgnoreFilter(root)) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue
    const abs = path.join(dir, ent.name)
    if (isIgnored(relPath(root, abs))) continue
    if (ent.isDirectory()) walk(abs, root, acc, isIgnored)
    if (!ent.isFile() || ent.name.endsWith('.kg.json')) continue
    const ext = path.extname(ent.name).toLowerCase()
    // Markdown carries its own front matter and never consults a sidecar.
    const sidecarVisible = ext === '.md' ? false : sidecarIsVisible(abs, root, isIgnored)
    if (isSourceFile(ent.name, sidecarVisible)) acc.push({ abs, rel: relPath(root, abs), ext, sidecarVisible })
  }
  return acc
}

function splitFrontmatter(raw) {
  const normalized = String(raw).replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return null
  return normalized.slice(4, end)
}

function parseValue(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1)
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}

function setPath(target, keys, value) {
  let cursor = target
  for (const key of keys.slice(0, -1)) {
    cursor[key] ??= {}
    cursor = cursor[key]
  }
  cursor[keys.at(-1)] = value
}

export function parseFrontmatterYaml(yaml) {
  const out = {}
  const lines = String(yaml ?? '').split('\n')
  const stack = [{ indent: -1, value: out, key: null }]
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.match(/^\s*/)[0].length
    const line = raw.trim()
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop()
    const parent = stack.at(-1).value
    if (line.startsWith('- ')) {
      if (!Array.isArray(parent)) continue
      parent.push(parseValue(line.slice(2)))
      continue
    }
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!match) continue
    const [, key, rest] = match
    if (rest === '') {
      parent[key] = nextYamlContainer(lines, index, indent)
      stack.push({ indent, value: parent[key], key })
    } else if (rest === '[]') {
      parent[key] = []
      stack.push({ indent, value: parent[key], key })
    } else {
      parent[key] = parseValue(rest)
    }
  }
  return out
}

function nextYamlContainer(lines, fromIndex, indent) {
  for (let index = fromIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index]
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const nextIndent = raw.match(/^\s*/)[0].length
    if (nextIndent <= indent) return {}
    return raw.trim().startsWith('- ') ? [] : {}
  }
  return {}
}

function normalizeRelations(relations) {
  const out = {}
  if (!relations || typeof relations !== 'object') return out
  for (const [type, targets] of Object.entries(relations)) {
    if (Array.isArray(targets)) out[type] = targets.map(String)
    else if (typeof targets === 'string') out[type] = [targets]
    else out[type] = []
  }
  return out
}

function sidecarFor(file) {
  return `${file}.kg.json`
}

function nodeFromMarkdown(repo, file, errors) {
  const raw = fs.readFileSync(file.abs, 'utf8')
  const fm = splitFrontmatter(raw)
  if (!fm) return null
  const parsed = parseFrontmatterYaml(fm)
  const kg = parsed.kg ?? {}
  if (!kg.id) errors.push(`${repo.name}/${file.rel}: kg.id is required`)
  if (!kg.audience) errors.push(`${repo.name}/${file.rel}: kg.audience is required`)
  if (kg.visibility) errors.push(`${repo.name}/${file.rel}: kg.visibility is invalid; use kg.audience`)
  return {
    id: kg.id || `${repo.name}:${slug(file.rel)}`,
    title: parsed.title || kg.title || path.basename(file.rel, file.ext),
    summary: parsed.summary || '',
    repo: repo.name,
    path: file.rel,
    type: kg.type || 'document',
    status: kg.status || 'active',
    audience: kg.audience || 'private',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    relations: normalizeRelations(kg.relations),
  }
}

function nodeFromSidecar(repo, file, errors) {
  const sidecar = sidecarFor(file.abs)
  // Visibility again, and for the same reason: a git-ignored sidecar must not
  // supply identity, audience, or relations. A document-extension asset whose
  // only sidecar is ignored therefore fails closed with the ordinary
  // missing-sidecar error — the same verdict a clean checkout reaches.
  if (!file.sidecarVisible) {
    errors.push(`${repo.name}/${file.rel}: non-Markdown source requires sidecar ${path.basename(sidecar)}`)
    return null
  }
  const meta = readJson(sidecar)
  for (const error of validateSourceSidecar(meta, path.basename(file.abs))) {
    errors.push(`${repo.name}/${file.rel}: ${error}`)
  }
  const kg = meta.kg ?? {}
  if (!kg.id) errors.push(`${repo.name}/${file.rel}: sidecar kg.id is required`)
  if (!kg.audience) errors.push(`${repo.name}/${file.rel}: sidecar kg.audience is required`)
  if (kg.visibility) errors.push(`${repo.name}/${file.rel}: sidecar kg.visibility is invalid; use kg.audience`)
  return {
    id: kg.id || `${repo.name}:${slug(file.rel)}-${file.ext.slice(1)}`,
    title: meta.title || kg.title || path.basename(file.rel, file.ext),
    summary: meta.summary || '',
    repo: repo.name,
    path: file.rel,
    type: kg.type || file.ext.slice(1),
    status: kg.status || 'active',
    audience: kg.audience || 'private',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    relations: normalizeRelations(kg.relations),
  }
}

export function buildGraph(project) {
  const repoAccess = loadRepoAccess(project)
  const externalRelationPrefixes = new Set(Array.isArray(project.config.graph?.externalRelationPrefixes) ? project.config.graph.externalRelationPrefixes : [])
  const externalRelationIds = new Set(Array.isArray(project.config.graph?.externalRelationIds) ? project.config.graph.externalRelationIds : [])
  const errors = []
  const diagnostics = []
  const nodes = []
  const edges = []
  const external = []

  for (const repo of project.repos) {
    if (repo.external) {
      // Identity acknowledged, nothing walked: the workspace does not own this
      // content and cannot answer for its metadata.
      external.push({ name: repo.name, path: repo.path ?? null, remoteHost: remoteHost(gitRemoteUrl(repo.path)) })
      continue
    }
    if (!repo.name || !repo.path || !fs.existsSync(repo.path)) {
      errors.push(`configured repo is missing or unreadable: ${repo.name ?? '(unnamed)'}`)
      continue
    }
    // One batched ignore lookup per repo, shared by every walk below.
    const isIgnored = gitIgnoreFilter(repo.path)
    for (const file of walk(repo.path, repo.path, [], isIgnored)) {
      // Markdown is the one inline metadata format; every other source is
      // sidecar-described and its own bytes are never read.
      const node = file.ext === '.md' ? nodeFromMarkdown(repo, file, errors) : nodeFromSidecar(repo, file, errors)
      if (!node) continue
      const boundary = repoAccess.repos?.[repo.name]?.readBoundary ?? repo.readBoundary ?? repoAccess.defaultReadBoundary ?? 'team'
      node.repoAccess = { readBoundary: boundary }
      if (['private', 'sensitive'].includes(node.audience) && boundary !== 'private') {
        diagnostics.push({
          severity: 'warning',
          code: 'audience-wider-repo-boundary',
          node: node.id,
          message: `${node.id}: audience ${node.audience} is in a ${boundary}-readable repo`,
        })
      }
      nodes.push(node)
    }
    for (const orphan of findOrphanSidecars(repo.path, isIgnored)) {
      errors.push(`${repo.name}/${orphan}: sidecar has no matching source asset`)
    }
  }

  const ids = new Set()
  for (const node of nodes) {
    if (ids.has(node.id)) errors.push(`duplicate kg.id: ${node.id}`)
    ids.add(node.id)
    if (!VALID_AUDIENCES.has(node.audience)) errors.push(`${node.id}: invalid audience ${node.audience}`)
  }

  for (const node of nodes) {
    for (const [type, targets] of Object.entries(node.relations ?? {})) {
      if (!VALID_RELATIONS.has(type)) errors.push(`${node.id}: invalid relation type ${type}`)
      for (const target of targets) {
        if (!ids.has(target) && !isExternalRelationTarget(target, { externalRelationPrefixes, externalRelationIds })) {
          errors.push(`${node.id}: relation target not found: ${target}`)
        }
        edges.push({ source: node.id, target, type, declared: true })
      }
    }
  }

  return {
    schema: 'mnstry.atelier-knowledge-graph@v1',
    generatedAt: 'deterministic',
    project: path.basename(project.workspaceRoot),
    counts: { nodes: nodes.length, edges: edges.length, diagnostics: diagnostics.length },
    nodes,
    edges,
    diagnostics,
    external: external.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    errors,
  }
}

function isExternalRelationTarget(target, { externalRelationPrefixes, externalRelationIds }) {
  if (externalRelationIds.has(target)) return true
  const prefix = String(target).split(':')[0]
  return externalRelationPrefixes.has(prefix)
}

function findOrphanSidecars(root, isIgnored = gitIgnoreFilter(root)) {
  const orphans = []
  function visit(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue
      const abs = path.join(dir, ent.name)
      if (isIgnored(relPath(root, abs))) continue
      if (ent.isDirectory()) visit(abs)
      else if (ent.isFile() && ent.name.endsWith('.kg.json')) {
        const asset = abs.slice(0, -'.kg.json'.length)
        if (!fs.existsSync(asset)) orphans.push(relPath(root, abs))
      }
    }
  }
  visit(root)
  return orphans
}

// Sidecars that exist on disk but are git-ignored, next to a file the census
// can see. Refused, never obeyed — and never silently: dropping them without a
// word is what let an untracked sidecar mint a public node.
function findIgnoredSidecars(root, isIgnored = gitIgnoreFilter(root)) {
  const found = []
  function visit(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue
      const abs = path.join(dir, ent.name)
      const rel = relPath(root, abs)
      if (ent.isDirectory()) {
        if (!isIgnored(rel)) visit(abs)
        continue
      }
      if (!ent.isFile() || !ent.name.endsWith('.kg.json') || !isIgnored(rel)) continue
      const assetRel = rel.slice(0, -'.kg.json'.length)
      // Nothing was refused if the asset is itself machine-local or absent, and
      // Markdown never reads a sidecar in the first place.
      if (assetRel.toLowerCase().endsWith('.md')) continue
      if (isIgnored(assetRel) || !fs.existsSync(path.join(root, assetRel))) continue
      found.push({ path: assetRel, sidecar: rel })
    }
  }
  visit(root)
  return found
}

// Deliberately NOT part of buildGraph's return value: that object is written
// verbatim to the graph artifact, so a machine-local observation inside it
// would make the artifact differ between a developer's tree and a clean
// checkout — the exact churn the ignore filter exists to prevent. The operator
// hears about the refusal; the shared artifact never does.
export function ignoredSidecarWarnings(project) {
  const warnings = []
  for (const repo of project.repos ?? []) {
    if (repo.external || !repo.name || !repo.path || !fs.existsSync(repo.path)) continue
    for (const found of findIgnoredSidecars(repo.path)) {
      warnings.push({
        severity: 'warning',
        code: 'ignored-sidecar',
        repo: repo.name,
        path: found.path,
        sidecar: found.sidecar,
        message: `${repo.name}/${found.sidecar}: sidecar is git-ignored and was refused; it cannot enroll ${found.path} or describe it`,
      })
    }
  }
  return warnings
}

export function runGraphCommand(argv = process.argv.slice(2)) {
  const check = argv.includes('--check')
  const project = commandProject({ argv })
  const graph = buildGraph(project)
  for (const warning of ignoredSidecarWarnings(project)) console.warn(`warning: ${warning.message}`)
  if (graph.errors.length) {
    console.error(graph.errors.join('\n'))
    process.exit(1)
  }
  if (check) {
    const current = fs.existsSync(project.graphPath) ? fs.readFileSync(project.graphPath, 'utf8') : null
    const next = `${JSON.stringify(graph, null, 2)}\n`
    if (current !== next) {
      console.error(`knowledge graph is stale: ${project.graphPath}`)
      process.exit(1)
    }
  } else {
    writeJson(project.graphPath, graph)
  }
  console.log(`knowledge graph: ${graph.counts.nodes} nodes · ${graph.counts.edges} edges · ${graph.counts.diagnostics} diagnostics`)
  for (const repo of graph.external ?? []) {
    console.log(`external repo (not walked): ${repo.name} → ${repo.remoteHost ?? 'no origin remote'}`)
  }
}
