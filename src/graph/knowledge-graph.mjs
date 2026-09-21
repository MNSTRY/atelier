import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { VALID_AUDIENCES } from '../projection/policy.mjs'
import { generatedProjectionBasenames, generatedProjectionDirectoryBasenames } from '../project/file-class.mjs'
import { gitIgnoreFilter } from '../project/git-ignore.mjs'

export const KNOWLEDGE_GRAPH_SCHEMA = 'mnstry.knowledge-graph@v1'
export const REPO_ACCESS_SCHEMA = 'mnstry.repo-access@v1'
export const SOURCE_SIDECAR_SCHEMA = 'mnstry.source-sidecar@v1'

export const DOC_EXTENSIONS = new Set(['.md', '.html', '.pdf', '.docx'])
export const VALID_RELATION_TYPES = new Set(['related', 'supports', 'supersedes', 'implements', 'depends_on', 'evidences', 'contradicts', 'belongs_to'])
export const VALID_STATUSES = new Set(['active', 'draft', 'archived', 'template'])
export const VALID_KG_TYPES = new Set(['document', 'artifact', 'evidence', 'source', 'index', 'contract', 'guide', 'runbook', 'policy', 'report', 'prototype', 'research', 'decision', 'map', 'manifest', 'html', 'pdf', 'docx'])
export const VALID_SIDECAR_KG_TYPES = new Set(['html', 'pdf', 'docx', 'artifact', 'evidence', 'source', 'prototype', 'research', 'report', 'manifest'])

const SKIP_DIRS = new Set(['.git', '.agents', '.claude', '.github', 'node_modules', 'output', 'uploads', 'scripts', 'lib', ...generatedProjectionDirectoryBasenames()])
// Derived from the kit's file-class declaration, never restated here.
const GENERATED_FILES = generatedProjectionBasenames()
const PRIVATE_AUDIENCES = new Set(['private', 'sensitive'])
const AUDIENCE_READ_RANK = {
  public: 0,
  team: 1,
  operator: 2,
  staff: 2,
  private: 3,
  sensitive: 3,
}

const yamlString = (value) => JSON.stringify(String(value ?? ''))
const relPath = (root, abs) => path.relative(root, abs).split(path.sep).join('/')
const posixJoin = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/')

export const slug = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export const titleCase = (value) =>
  String(value ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase())

export function fallbackId(repoName, rel, ext = path.extname(rel).toLowerCase()) {
  const suffix = ext && ext !== '.md' ? `-${ext.slice(1)}` : ''
  return `${repoName}:${slug(rel)}${suffix}`
}

export function portableText(value) {
  return String(value ?? '')
    .replace(/\/Users\/[^/\s`'")]+/g, '~')
    .replace(/\/home\/[^/\s`'")]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s`'")]+/g, '~')
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item).trim()).filter(Boolean)
}

function uniqueStringArrayErrors(value, label) {
  const errors = []
  if (!Array.isArray(value)) return [`${label} must be a list`]
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${label} must contain non-empty strings`)
      continue
    }
    if (seen.has(item)) errors.push(`${label} must not contain duplicate "${item}"`)
    seen.add(item)
  }
  return errors
}

export function splitFrontmatter(raw) {
  const normalized = String(raw).replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const rest = normalized.slice(4)
  const match = rest.match(/\n---\s*\n/)
  if (!match) return null
  const end = 4 + match.index
  const closeEnd = end + match[0].length
  return {
    yaml: normalized.slice(4, end),
    body: normalized.slice(closeEnd),
  }
}

function parseYamlScalar(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  if (trimmed === '[]') return []
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((part) => parseYamlScalar(part))
      .filter((part) => part !== '')
  }
  return trimmed
}

function nextYamlValue(lines, fromIndex, indent) {
  for (let i = fromIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const nextIndent = raw.match(/^\s*/)[0].length
    if (nextIndent <= indent) return {}
    return raw.trim().startsWith('- ') ? [] : {}
  }
  return {}
}

export function parseYamlSubset(yaml) {
  const root = {}
  const stack = [{ indent: -1, value: root }]
  const lines = yaml.replace(/\t/g, '  ').replace(/\r\n/g, '\n').split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = raw.match(/^\s*/)[0].length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].value

    if (trimmed.startsWith('- ')) {
      if (Array.isArray(parent)) parent.push(parseYamlScalar(trimmed.slice(2)))
      continue
    }

    const match = trimmed.match(/^([^:]+):(.*)$/)
    if (!match) continue
    const key = match[1].trim()
    const valuePart = match[2].trim()
    if (!key || Array.isArray(parent)) continue
    if (valuePart) {
      parent[key] = parseYamlScalar(valuePart)
    } else {
      parent[key] = nextYamlValue(lines, i, indent)
      stack.push({ indent, value: parent[key] })
    }
  }

  return root
}

export function markdownMetadata(raw) {
  const fm = splitFrontmatter(raw)
  return fm ? parseYamlSubset(fm.yaml) : {}
}

function markdownFrontmatterState(raw) {
  const fm = splitFrontmatter(raw)
  if (!fm) return { kind: 'absent', metadata: {} }
  if (!fm.yaml.trim()) return { kind: 'empty', metadata: {} }

  const metadata = parseYamlSubset(fm.yaml)
  const lines = fm.yaml.replace(/\t/g, '  ').replace(/\r\n/g, '\n').split('\n')
  let malformed = false
  const containerIndents = [-1]
  const containerKinds = ['object']
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = rawLine.match(/^\s*/)[0].length
    while (containerIndents.length > 1 && indent <= containerIndents.at(-1)) {
      containerIndents.pop()
      containerKinds.pop()
    }
    if (trimmed.startsWith('- ')) {
      if (containerKinds.at(-1) !== 'array' || !trimmed.slice(2).trim()) malformed = true
      continue
    }
    const match = trimmed.match(/^([^:]+):(.*)$/)
    if (!match || !match[1].trim()) {
      malformed = true
      continue
    }
    if (!match[2].trim()) {
      const next = nextYamlValue(lines, index, indent)
      containerIndents.push(indent)
      containerKinds.push(Array.isArray(next) ? 'array' : 'object')
    }
  }
  return { kind: malformed ? 'malformed' : 'valid', metadata }
}

function relationMap(value) {
  if (!isPlainObject(value)) return {}
  const relations = {}
  for (const [key, items] of Object.entries(value)) {
    // Preserve the original graph command's shorthand while emitting one
    // canonical shape: a scalar Markdown relation is a one-target list.
    relations[key] = Array.isArray(items) ? asStringArray(items) : typeof items === 'string' ? asStringArray([items]) : items
  }
  return relations
}

function extractMarkdownTitle(raw, rel) {
  const body = splitFrontmatter(raw)?.body ?? raw
  const h1 = body.match(/^#\s+(.+?)\s*$/m)
  return h1 ? h1[1].trim() : titleCase(path.basename(rel))
}

function extractMarkdownSummary(raw) {
  const body = splitFrontmatter(raw)?.body ?? raw
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(#|---|>|```|\||[-*]\s|\d+\.)/.test(trimmed)) continue
    return portableText(trimmed.replace(/\s+/g, ' ')).slice(0, 180)
  }
  return ''
}

function decodeHtml(value) {
  return String(value ?? '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
}

function extractHtmlMeta(abs, rel) {
  const html = fs.readFileSync(abs, 'utf8')
  const meta = {}
  const re = /<meta\s+name="([^"]+)"\s+content="([^"]*)"\s*\/?>/gi
  let m
  while ((m = re.exec(html))) meta[m[1]] = decodeHtml(m[2])
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim()
  return {
    title: meta['atelier:title'] || decodeHtml(title || titleCase(path.basename(rel))),
    summary: portableText(meta['atelier:summary'] || ''),
    atelier: {
      section: meta['atelier:section'] || null,
      status: meta['atelier:status'] || null,
      kind: meta['atelier:kind'] || null,
    },
  }
}

export function inferLifecycle(rel) {
  const top = rel.split('/')[0] || ''
  if (top === 'INBOX') return 'inbox'
  if (top === 'WORK IN PROGRESS') return 'work-in-progress'
  if (top === 'REFERENCES') return 'reference'
  if (top === 'ARCHIVE') return 'archive'
  if (top === 'research') return 'research'
  if (top === 'discovery') return 'discovery'
  if (top === 'DESIGN') return 'design'
  if (top === 'APP') return 'app'
  if (top === 'PORTALS') return 'portal'
  if (top === 'WORKSPACE') return 'workspace'
  if (top === 'docs') return 'docs'
  return 'root'
}

export function inferDomain(_repoName, rel) {
  const parts = rel.split('/')
  const top = parts[0] || ''
  if (top === 'DESIGN') return 'design'
  if (top === 'APP') return 'app'
  if (top === 'PORTALS' || top === 'WORKSPACE') return 'prototype'
  if (top === 'research') return 'research'
  if (top === 'discovery') return 'discovery'
  if (top === 'REFERENCES') return parts[1] || 'reference'
  if (top === 'runbooks' || top === 'policies' || top === 'launch' || top === 'staff') return 'operations'
  return 'workstream'
}

export function inferStatus(lifecycle, rel) {
  if (lifecycle === 'archive') return 'archived'
  if (lifecycle === 'inbox' || lifecycle === 'work-in-progress') return 'draft'
  if (/template/i.test(rel)) return 'template'
  return 'active'
}

export function inferTags(repoName, rel, domain, lifecycle) {
  const tags = new Set([repoName, domain, lifecycle])
  for (const part of rel.split('/')) {
    const partSlug = slug(part)
    if (!partSlug || partSlug.length < 3) continue
    if (['readme', 'index', 'authoring'].includes(partSlug)) continue
    if (tags.size >= 10) break
    tags.add(partSlug)
  }
  return [...tags].sort()
}

export function listRepos(workspaceRoot) {
  return fs
    .readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((ent) => ent.isDirectory() && !ent.name.startsWith('.'))
    .map((ent) => path.join(workspaceRoot, ent.name))
    .filter((dir) => fs.existsSync(path.join(dir, '.git')))
    .sort()
}

// Git-ignored paths are machine-local. Counting them makes committed graph
// artifacts differ per machine, which turns every sync tick into a conflict.
export function walkDocuments(dir, root, acc = [], isIgnored = gitIgnoreFilter(root)) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
    const abs = path.join(dir, ent.name)
    const rel = relPath(root, abs)
    if (isIgnored(rel)) continue
    if (ent.isDirectory()) {
      walkDocuments(abs, root, acc, isIgnored)
    } else if (ent.isFile()) {
      // Sidecar-first census: document extensions are always sources; any
      // other file opts in by carrying an adjacent .kg.json sidecar. The
      // sidecar itself is metadata, never a source asset.
      if (ent.name.endsWith('.kg.json')) continue
      if (GENERATED_FILES.has(ent.name)) continue
      const ext = path.extname(ent.name).toLowerCase()
      // Opt-in requires a VISIBLE sidecar. A git-ignored one is machine-local:
      // it would enrol a node that exists in no tracked file, and hand it an
      // audience, on one machine only. Markdown never consults a sidecar.
      const sidecarVisible = ext === '.md' ? false : sidecarIsVisible(abs, root, isIgnored)
      if (!DOC_EXTENSIONS.has(ext) && !sidecarVisible) continue
      acc.push({ abs, rel, ext, sidecarVisible })
    }
  }
  return acc
}

function sidecarIsVisible(abs, root, isIgnored) {
  const sidecar = `${abs}.kg.json`
  return fs.existsSync(sidecar) && !isIgnored(relPath(root, sidecar))
}

// Sidecars that exist on disk but are git-ignored, next to a file the census
// can see: metadata the walk refused. Reported alongside the graph (like
// orphan sidecars) and never inside it, so committed artifacts stay a function
// of tracked state alone.
export function ignoredSourceSidecars(repoName, repoRoot, isIgnored = gitIgnoreFilter(repoRoot)) {
  const found = []
  function visit(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
      const abs = path.join(dir, ent.name)
      const rel = relPath(repoRoot, abs)
      if (ent.isDirectory()) {
        if (!isIgnored(rel)) visit(abs)
        continue
      }
      if (!ent.isFile() || !ent.name.endsWith('.kg.json') || !isIgnored(rel)) continue
      const sourceRel = rel.replace(/\.kg\.json$/, '')
      if (sourceRel.toLowerCase().endsWith('.md')) continue
      if (isIgnored(sourceRel) || !fs.existsSync(path.join(repoRoot, sourceRel))) continue
      found.push({ repo: repoName, path: sourceRel, sidecar: rel })
    }
  }
  visit(repoRoot)
  return found
}

export function walkSidecars(dir, root, acc = [], isIgnored = gitIgnoreFilter(root)) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
    const abs = path.join(dir, ent.name)
    if (isIgnored(relPath(root, abs))) continue
    if (ent.isDirectory()) {
      walkSidecars(abs, root, acc, isIgnored)
    } else if (ent.isFile() && ent.name.endsWith('.kg.json')) {
      acc.push({ abs, rel: relPath(root, abs) })
    }
  }
  return acc
}

function sidecarPath(file) {
  return `${file.abs}.kg.json`
}

function sidecarMetadata(file) {
  const sidecar = sidecarPath(file)
  // The walk already decided whether this sidecar is visible in tracked state.
  // An ignored one is treated as absent, so it can neither describe the asset
  // nor satisfy the demand a document extension makes for a sidecar.
  const exists = file.sidecarVisible === true
  let parsed = null
  let parseError = ''
  if (exists) {
    try {
      parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err)
    }
  }
  return {
    sidecar,
    metadata: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {},
    parseError,
    present: exists,
  }
}

export function validateSourceSidecar(metadata, assetFilename) {
  const errors = []
  if (!isPlainObject(metadata)) return ['sidecar must be a JSON object']

  const allowedRoot = new Set(['schema', 'asset', 'title', 'summary', 'tags', 'kg'])
  for (const key of Object.keys(metadata)) {
    if (!allowedRoot.has(key)) errors.push(`sidecar has unknown property "${key}"`)
  }
  for (const key of allowedRoot) {
    if (!Object.hasOwn(metadata, key)) errors.push(`sidecar must declare ${key}`)
  }

  if (metadata.schema !== SOURCE_SIDECAR_SCHEMA) errors.push(`sidecar must declare schema "${SOURCE_SIDECAR_SCHEMA}"`)
  if (metadata.asset !== assetFilename) errors.push(`sidecar asset "${metadata.asset ?? ''}" must match source filename "${assetFilename}"`)
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) errors.push('sidecar title must be a non-empty string')
  if (typeof metadata.summary !== 'string') errors.push('sidecar summary must be a string')
  errors.push(...uniqueStringArrayErrors(metadata.tags, 'sidecar tags'))

  if (!isPlainObject(metadata.kg)) {
    errors.push('sidecar kg must be an object')
    return errors
  }

  const allowedKg = new Set(['id', 'type', 'domain', 'lifecycle', 'status', 'audience', 'relations'])
  for (const key of Object.keys(metadata.kg)) {
    if (!allowedKg.has(key)) errors.push(`sidecar kg has unknown property "${key}"`)
  }
  for (const key of allowedKg) {
    if (!Object.hasOwn(metadata.kg, key)) errors.push(`sidecar must declare kg.${key}`)
  }

  if (typeof metadata.kg.id !== 'string' || !/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9:._/-]*$/.test(metadata.kg.id)) {
    errors.push('sidecar kg.id must be a stable repo-prefixed id')
  }
  if (!VALID_SIDECAR_KG_TYPES.has(metadata.kg.type)) errors.push(`sidecar kg.type "${metadata.kg.type ?? ''}" is invalid`)
  if (typeof metadata.kg.domain !== 'string' || !metadata.kg.domain.trim()) errors.push('sidecar kg.domain must be a non-empty string')
  if (typeof metadata.kg.lifecycle !== 'string' || !metadata.kg.lifecycle.trim()) errors.push('sidecar kg.lifecycle must be a non-empty string')
  if (!VALID_STATUSES.has(metadata.kg.status)) errors.push(`sidecar kg.status "${metadata.kg.status ?? ''}" is invalid`)
  if (!VALID_AUDIENCES.has(metadata.kg.audience)) errors.push(`sidecar kg.audience "${metadata.kg.audience ?? ''}" is invalid`)
  if (!isPlainObject(metadata.kg.relations)) {
    errors.push('sidecar kg.relations must be an object')
  } else {
    for (const [type, targets] of Object.entries(metadata.kg.relations)) {
      if (!VALID_RELATION_TYPES.has(type)) errors.push(`sidecar kg.relations type "${type}" is invalid`)
      errors.push(...uniqueStringArrayErrors(targets, `sidecar kg.relations.${type}`))
    }
  }

  return errors
}

export function validateRepoAccessConfig(config, repoNames, { configPath = 'repo-access config', externalRepos = [] } = {}) {
  const errors = []
  const external = new Set(externalRepos)
  if (config?.schema !== REPO_ACCESS_SCHEMA) {
    errors.push(`${configPath}: schema must be ${REPO_ACCESS_SCHEMA}`)
  }
  if (!VALID_AUDIENCES.has(config?.defaultReadBoundary)) {
    errors.push(`${configPath}: defaultReadBoundary must be a valid local audience/read-boundary value`)
  }
  if (!isPlainObject(config?.repos)) {
    errors.push(`${configPath}: repos must be an object`)
    return errors
  }

  for (const [repoName, entry] of Object.entries(config.repos)) {
    if (external.has(repoName)) {
      errors.push(`${configPath}: repos.${repoName} is declared kind "external" and must not declare a read boundary`)
      continue
    }
    if (!isPlainObject(entry)) {
      errors.push(`${configPath}: repos.${repoName} must declare readBoundary`)
      continue
    }
    if (!VALID_AUDIENCES.has(entry.readBoundary)) {
      errors.push(`${configPath}: repos.${repoName}.readBoundary must be a valid local audience/read-boundary value`)
    }
  }

  for (const repoName of repoNames) {
    if (external.has(repoName)) continue
    if (!Object.hasOwn(config.repos, repoName)) {
      errors.push(
        `${configPath}: repos.${repoName} must declare readBoundary, or be declared with kind "external" in the project config if it is not an Atelier-managed repo`,
      )
    }
  }

  return errors
}

export function repoReadBoundary(repoAccessConfig, repoName) {
  const entry = repoAccessConfig?.repos?.[repoName]
  if (typeof entry?.readBoundary === 'string' && entry.readBoundary) return entry.readBoundary
  if (typeof repoAccessConfig?.defaultReadBoundary === 'string' && repoAccessConfig.defaultReadBoundary) return repoAccessConfig.defaultReadBoundary
  return 'team'
}

export function loadAtelierCoverage(repoRoot) {
  const manifestPath = path.join(repoRoot, 'atelier.manifest.json')
  const surfaced = new Set()
  const sections = new Map()
  if (!fs.existsSync(manifestPath)) return { surfaced, sections }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    for (const sec of manifest.sections ?? []) {
      for (const item of sec.items ?? []) {
        if (item.source) {
          surfaced.add(item.source)
          sections.set(item.source, sec.id)
        }
      }
    }
    for (const doc of manifest.documents ?? []) {
      if (doc.source) {
        surfaced.add(doc.source)
        sections.set(doc.source, doc.section || 'documents')
      }
    }
  } catch {
    return { surfaced, sections }
  }
  return { surfaced, sections }
}

export function generatedFrontmatter({ id, repoName, rel, title, summary, domain, lifecycle, status, audience, surfaced, tags }) {
  return [
    `title: ${yamlString(title)}`,
    summary ? `summary: ${yamlString(summary)}` : `summary: ""`,
    'kg:',
    `  id: ${yamlString(id || fallbackId(repoName, rel, '.md'))}`,
    '  type: "document"',
    `  repo: ${yamlString(repoName)}`,
    `  path: ${yamlString(rel)}`,
    `  domain: ${yamlString(domain)}`,
    `  lifecycle: ${yamlString(lifecycle)}`,
    `  status: ${yamlString(status)}`,
    `  audience: ${yamlString(audience || 'private')}`,
    `  surfaced: ${surfaced ? 'true' : 'false'}`,
    '  relations:',
    '    related: []',
    '    supports: []',
    '    supersedes: []',
    'tags:',
    ...tags.map((tag) => `  - ${yamlString(tag)}`),
  ].join('\n')
}

// `sourceText`, when given, is the Markdown source already read as UTF-8 text,
// so a caller that holds the bytes does not read the file again.
export function nodeForFile(repoName, repoRoot, coverage, file, repoAccessConfig, sourceText = null) {
  const inferredLifecycle = inferLifecycle(file.rel)
  const inferredDomain = inferDomain(repoName, file.rel)
  const inferredStatus = inferStatus(inferredLifecycle, file.rel)
  const surfaced = coverage.surfaced.has(file.rel)
  let title = titleCase(path.basename(file.rel))
  let summary = ''
  let metadata = {}
  let classification = 'classified'
  let classificationReason = null
  let sidecar = null
  let hasSidecar = false
  let atelier = { section: coverage.sections.get(file.rel) || null, status: null, kind: null }

  if (file.ext === '.md') {
    const raw = typeof sourceText === 'string' ? sourceText : fs.readFileSync(file.abs, 'utf8')
    const frontmatter = markdownFrontmatterState(raw)
    metadata = frontmatter.metadata
    if (frontmatter.kind !== 'valid' || !isPlainObject(metadata.kg)) {
      classification = 'unclassified'
      classificationReason = frontmatter.kind === 'valid' ? 'missing-kg-block' : `${frontmatter.kind}-frontmatter`
      metadata = {}
    }
    title = asString(metadata.title, extractMarkdownTitle(raw, file.rel))
    summary = asString(metadata.summary, extractMarkdownSummary(raw))
  } else if (file.ext === '.html') {
    const meta = extractHtmlMeta(file.abs, file.rel)
    title = meta.title
    summary = meta.summary
    atelier = { ...atelier, ...meta.atelier }
    const sidecarData = sidecarMetadata(file)
    sidecar = relPath(repoRoot, sidecarData.sidecar)
    hasSidecar = sidecarData.present
    metadata = sidecarData.metadata
    if (sidecarData.parseError) metadata = { ...metadata, __parseError: sidecarData.parseError }
    if (metadata.title) title = asString(metadata.title, title)
    if (metadata.summary) summary = portableText(asString(metadata.summary, summary))
  } else {
    const sidecarData = sidecarMetadata(file)
    sidecar = relPath(repoRoot, sidecarData.sidecar)
    hasSidecar = sidecarData.present
    metadata = sidecarData.metadata
    if (sidecarData.parseError) metadata = { ...metadata, __parseError: sidecarData.parseError }
    title = asString(metadata.title, title)
    summary = portableText(asString(metadata.summary, summary))
  }
  summary = portableText(summary)

  const kg = isPlainObject(metadata.kg) ? metadata.kg : {}
  const hasKgBlock = isPlainObject(metadata.kg)
  const hasExplicitKgId = typeof kg.id === 'string' && kg.id.trim() !== ''
  const domain = asString(kg.domain, inferredDomain)
  const lifecycle = asString(kg.lifecycle, inferredLifecycle)
  const status = asString(kg.status, inferredStatus)
  const audience = classification === 'unclassified' ? 'private' : asString(kg.audience, '')
  const frontmatterHasLegacyVisibility = Object.hasOwn(kg, 'visibility')
  const type = asString(kg.type, file.ext === '.md' ? 'document' : file.ext.slice(1))
  const id = asString(kg.id, fallbackId(repoName, file.rel, file.ext))
  const tags = asStringArray(metadata.tags)
  const relations = relationMap(kg.relations)
  const resolvedTags = tags.length ? tags : inferTags(repoName, file.rel, domain, lifecycle)

  return {
    id,
    title,
    summary,
    repo: repoName,
    path: file.rel,
    extension: file.ext.slice(1),
    type: file.ext === '.md' ? 'markdown' : file.ext.slice(1),
    kgType: type,
    domain,
    lifecycle,
    status,
    audience,
    classification,
    ...(classificationReason ? { classificationReason } : {}),
    ...(frontmatterHasLegacyVisibility ? { frontmatterHasLegacyVisibility: true } : {}),
    ...(file.ext === '.md' ? { markdownHasKgBlock: hasKgBlock, markdownHasKgId: hasExplicitKgId } : {}),
    ...(file.ext !== '.md'
      ? {
          sidecar,
          sidecarSchema: asString(metadata.schema, ''),
          sidecarAsset: asString(metadata.asset, ''),
          sidecarSchemaErrors: hasSidecar
            ? [
                ...(metadata.__parseError ? [`sidecar JSON must parse: ${metadata.__parseError}`] : []),
                ...validateSourceSidecar(
                  Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== '__parseError')),
                  path.basename(file.rel),
                ),
              ]
            : [],
          hasSidecar,
          sidecarHasKgId: hasExplicitKgId,
        }
      : {}),
    repoAccess: {
      readBoundary: repoReadBoundary(repoAccessConfig, repoName),
    },
    surfaced,
    atelier,
    tags: resolvedTags,
    relations,
  }
}

// ---------------------------------------------------------------------------
// Ordinary links: Markdown links and wikilinks
// ---------------------------------------------------------------------------

// Link findings are reported beside the graph, never inside a graph artifact,
// so committed graphs stay free of offsets and unresolved-link noise.
export const LINK_DIAGNOSTIC_CODES = Object.freeze([
  'link-target-unresolved',
  'link-target-outside-enrolled-roots',
  'link-target-ambiguous',
  'link-href-malformed',
  'link-source-not-utf8',
])

const MARKDOWN_LINK_RE = /\[[^\]]+\]\(([^)\s#]+)(#[^)]+)?\)/g
const WIKILINK_RE = /\[\[([^[\]|#^]+)([#^][^[\]|]*)?(?:\|[^[\]]*)?\]\]/g

function frontMatterEnd(text) {
  if (!/^---\r?\n/.test(text)) return 0
  const closeRe = /\r?\n---[ \t]*\r?\n/g
  closeRe.lastIndex = 3
  const close = closeRe.exec(text)
  return close ? close.index + close[0].length : 0
}

// Fenced code from `bodyStart` on: the closed blocks, and the fence still open
// when the text ends, if any. The one statement of the fence rules, shared by
// the link scanner and by `unclosedFenceAtEnd`.
function fencedBlocks(text, bodyStart) {
  const ranges = []
  let fence = null
  let offset = bodyStart
  while (offset < text.length) {
    const eol = text.indexOf('\n', offset)
    const next = eol === -1 ? text.length : eol + 1
    const line = text.slice(offset, eol === -1 ? text.length : eol).replace(/\r$/, '')
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        ranges.push([fence.start, next])
        fence = null
      }
    } else {
      const open = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)
      if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
        fence = { char: open[2][0], length: open[2].length, indent: open[1].length, start: offset }
      }
    }
    offset = next
  }
  return { ranges, open: fence }
}

// The fence a Markdown text ends inside, as the link scanner reads it:
// { char, length, indent }, or null when every fence closes. Front matter is
// never read for fences. Anything appended after such a text is code until a
// closing fence of the same character and at least the same length.
export function unclosedFenceAtEnd(raw) {
  const text = String(raw ?? '')
  const { open } = fencedBlocks(text, frontMatterEnd(text))
  return open ? { char: open.char, length: open.length, indent: open.indent } : null
}

// Regions whose text is never read as a link: front matter (known or unknown
// YAML alike), fenced code and inline code. Offsets index the text as read,
// with no newline normalization.
function unscannedRanges(text) {
  const bodyStart = frontMatterEnd(text)
  const fenced = fencedBlocks(text, bodyStart)
  const ranges = bodyStart > 0 ? [[0, bodyStart], ...fenced.ranges] : fenced.ranges
  if (fenced.open) ranges.push([fenced.open.start, text.length])

  // Inline code between the block ranges. A span closes on a backtick run of
  // the same length inside the same paragraph; an unclosed run is plain text.
  const blocks = [...ranges].sort((a, b) => a[0] - b[0])
  let segmentStart = bodyStart
  for (const [blockStart, blockEnd] of [...blocks.filter(([start]) => start >= bodyStart), [text.length, text.length]]) {
    inlineCodeRanges(text, segmentStart, blockStart, ranges)
    segmentStart = Math.max(segmentStart, blockEnd)
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

function inlineCodeRanges(text, from, to, ranges) {
  const runRe = /`+/g
  runRe.lastIndex = from
  let open
  while ((open = runRe.exec(text)) && open.index < to) {
    const blankRe = /\n[ \t]*\r?\n/g
    blankRe.lastIndex = open.index
    const blank = blankRe.exec(text)
    const paragraphEnd = Math.min(to, blank ? blank.index : text.length)
    const closeRe = /`+/g
    closeRe.lastIndex = open.index + open[0].length
    let close
    let closed = false
    while ((close = closeRe.exec(text)) && close.index < paragraphEnd) {
      if (close[0].length !== open[0].length) continue
      ranges.push([open.index, close.index + close[0].length])
      runRe.lastIndex = close.index + close[0].length
      closed = true
      break
    }
    if (!closed) runRe.lastIndex = open.index + open[0].length
  }
}

// Every ordinary link occurrence in one Markdown text, in source order.
// `range` covers the whole construct and `targetRange` the written target, as
// half-open UTF-16 offsets into the text exactly as read; byte offsets are
// added by the resolver once the source is known to round-trip as UTF-8.
export function scanMarkdownLinks(raw) {
  const text = String(raw ?? '')
  const skipped = unscannedRanges(text)
  const overlaps = (ranges, start, end) => ranges.some(([a, b]) => start < b && end > a)
  // A construct is unscanned when it begins inside such a region. Inline code
  // inside a link's own label ([`name`](target)) is an ordinary link.
  const beginsInside = (ranges, start) => ranges.some(([a, b]) => start >= a && start < b)
  const found = []
  const wikiRanges = []

  for (const m of text.matchAll(WIKILINK_RE)) {
    const start = m.index
    const end = start + m[0].length
    if (beginsInside(skipped, start)) continue
    wikiRanges.push([start, end])
    found.push({
      syntax: 'wikilink',
      embed: text[start - 1] === '!',
      href: m[1].trim(),
      fragment: m[2] ?? '',
      range: { start, end },
      targetRange: { start: start + 2, end: start + 2 + m[1].length },
    })
  }

  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const start = m.index
    const end = start + m[0].length
    if (beginsInside(skipped, start) || overlaps(wikiRanges, start, end)) continue
    const targetStart = start + m[0].indexOf('](') + 2
    found.push({
      syntax: 'markdown',
      embed: text[start - 1] === '!',
      href: m[1],
      fragment: m[2] ?? '',
      range: { start, end },
      targetRange: { start: targetStart, end: targetStart + m[1].length },
    })
  }

  return found.sort((a, b) => a.range.start - b.range.start)
}

function addByteOffsets(text, occurrences) {
  const offsets = [...new Set(occurrences.flatMap((item) => [item.range.start, item.range.end, item.targetRange.start, item.targetRange.end]))].sort(
    (a, b) => a - b,
  )
  const bytes = new Map()
  let previous = 0
  let total = 0
  for (const offset of offsets) {
    total += Buffer.byteLength(text.slice(previous, offset), 'utf8')
    bytes.set(offset, total)
    previous = offset
  }
  for (const item of occurrences) {
    for (const range of [item.range, item.targetRange]) {
      range.byteStart = bytes.get(range.start)
      range.byteEnd = bytes.get(range.end)
    }
  }
}

// `pathOf` and `repoNameOf` come from the census keys, so a caller's node
// needs only an id: markdownLinkEdges has always accepted such nodes.
function wikilinkCandidates(target, nodes, pathOf, repoNameOf) {
  if (target.includes('/')) {
    const wanted = new Set([target, `${target}.md`])
    return { by: 'path', nodes: nodes.filter((node) => wanted.has(pathOf.get(node)) || wanted.has(`${repoNameOf.get(node)}/${pathOf.get(node)}`)) }
  }
  const byTitle = nodes.filter((node) => node.title !== undefined && node.title === target)
  const byName = nodes.filter((node) => {
    const base = path.posix.basename(pathOf.get(node))
    return base === target || base.replace(/\.[^.]+$/, '') === target
  })
  const merged = [...new Map([...byTitle, ...byName].map((node) => [node.id, node])).values()]
  return { by: byTitle.length ? 'title' : 'basename', nodes: merged }
}

// Embedded assets: files an embed names that are not documents of the census.
// An asset is a regular file inside an enrolled repository root: never a link
// on disk, never reached through one, never git-ignored, never inside `.git`,
// never Markdown and never a census node.
const assetId = (repoName, rel) => `${repoName}:asset:${rel}`
const insideGitDirectory = (rel) => rel.split('/').includes('.git')
const isMarkdownPath = (rel) => rel.toLowerCase().endsWith('.md')

// `gitIgnoreFilter` lists a fully ignored directory once, so every ancestor of
// a path is tested, not the path alone.
function ignoredAtAnyDepth(isIgnored, rel) {
  const parts = rel.split('/')
  return parts.some((_, index) => isIgnored(parts.slice(0, index + 1).join('/')))
}

// True only for a regular file whose real location is exactly `rel` under the
// real repository root: a link anywhere on the way, or a name that matches
// only because the filesystem folds case, is not this file.
function isRegularFileInside(root, rel) {
  try {
    const abs = path.join(root, rel)
    if (!fs.lstatSync(abs).isFile()) return false
    return relPath(fs.realpathSync.native(root), fs.realpathSync.native(abs)) === rel
  } catch {
    return false
  }
}

// The one resolver for ordinary links across every enrolled repository.
// `repos` is [{ name, root, nodesByPath, isIgnored? }]. A target that is
// absent, outside the census or refused by `isLinkTargetEligible` is reported
// identically and never inspected, so a finding cannot confirm that a withheld
// target exists. `isAssetEligible({ repo, path })` gives embedded assets the
// same rule: a refused asset reads exactly as an absent one.
// The link scan of one Markdown source: its occurrences, with byte offsets
// when the bytes round-trip as UTF-8. A pure function of the bytes, which is
// what lets a builder keep it under the source's content digest.
export function scanMarkdownSource(buffer) {
  const text = buffer.toString('utf8')
  const occurrences = scanMarkdownLinks(text)
  const utf8Exact = Buffer.from(text, 'utf8').equals(buffer)
  if (utf8Exact) addByteOffsets(text, occurrences)
  return { occurrences, utf8Exact }
}

// `scanned` maps a census node to the scan of its source (scanMarkdownSource)
// when the caller already holds it; any other Markdown node is read here.
export function resolveWorkspaceLinks({ repos = [], isLinkTargetEligible = () => true, isAssetEligible = () => true, scanned = null } = {}) {
  const links = []
  const embeds = []
  const diagnostics = []
  const enrolled = repos.map((repo) => ({ ...repo, root: path.resolve(repo.root) }))
  const ownerOf = new Map(enrolled.flatMap((repo) => [...repo.nodesByPath.values()].map((node) => [node, repo])))
  const eligibleNodes = [...ownerOf.keys()].filter((node) => isLinkTargetEligible(node))
  const pathOf = new Map(enrolled.flatMap((repo) => [...repo.nodesByPath].map(([rel, node]) => [node, rel])))
  const repoNameOf = new Map([...ownerOf].map(([node, repo]) => [node, repo.name]))

  const owningRepo = (abs) =>
    enrolled
      .filter((repo) => abs === repo.root || abs.startsWith(`${repo.root}${path.sep}`))
      .sort((a, b) => b.root.length - a.root.length)[0] ?? null

  // One ignore lookup per repository, made only when an embed needs it.
  const ignoreFilters = new Map()
  const ignoredIn = (owner) => {
    if (!ignoreFilters.has(owner)) ignoreFilters.set(owner, owner.isIgnored ?? gitIgnoreFilter(owner.root))
    return ignoreFilters.get(owner)
  }
  // Eligibility is asked before the file is looked at, so a refused asset and
  // an absent one take the same path to the same finding.
  const assetAt = (owner, rel) => {
    if (!rel || rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) return null
    if (owner.nodesByPath.has(rel) || isMarkdownPath(rel) || insideGitDirectory(rel)) return null
    if (isAssetEligible({ repo: owner.name, path: rel }) !== true) return null
    if (ignoredAtAnyDepth(ignoredIn(owner), rel) || !isRegularFileInside(owner.root, rel)) return null
    return { id: assetId(owner.name, rel), repo: owner.name, path: rel, extension: path.posix.extname(rel).slice(1).toLowerCase() }
  }

  // Basename index over every enrolled repository: built once, and only when a
  // bare wikilink embed asks for it. It holds names only; eligibility is tested
  // per candidate when a name is looked up.
  let basenameIndex = null
  const assetsNamed = (name) => {
    if (!basenameIndex) {
      basenameIndex = new Map()
      const roots = new Set(enrolled.map((item) => item.root))
      for (const owner of enrolled) {
        const isIgnored = ignoredIn(owner)
        const visit = (dir) => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.name === '.git') continue
            const abs = path.join(dir, ent.name)
            const rel = relPath(owner.root, abs)
            if (isIgnored(rel)) continue
            // A nested enrolled repository owns its own files.
            if (ent.isDirectory()) {
              if (!roots.has(abs)) visit(abs)
            } else if (ent.isFile() && !isMarkdownPath(rel) && !owner.nodesByPath.has(rel)) {
              if (!basenameIndex.has(ent.name)) basenameIndex.set(ent.name, [])
              basenameIndex.get(ent.name).push({ owner, rel })
            }
          }
        }
        visit(owner.root)
      }
    }
    return (basenameIndex.get(name) ?? []).map(({ owner, rel }) => assetAt(owner, rel)).filter(Boolean)
  }

  // A wikilink embed names an asset by repository-relative path (the source's
  // own repository first, then `<repository>/<path>`), or by bare file name.
  const wikilinkAssets = (repo, target) => {
    if (!target.includes('/')) return { by: 'basename', assets: assetsNamed(target) }
    const wanted = path.posix.normalize(target)
    const candidates = [
      assetAt(repo, wanted),
      ...enrolled.filter((owner) => wanted.startsWith(`${owner.name}/`)).map((owner) => assetAt(owner, wanted.slice(owner.name.length + 1))),
    ].filter(Boolean)
    return { by: 'path', assets: candidates.slice(0, 1) }
  }

  for (const repo of enrolled) {
    for (const [rel, node] of repo.nodesByPath) {
      if (!rel.endsWith('.md') || !isLinkTargetEligible(node)) continue
      const { occurrences, utf8Exact } = scanned?.get(node) ?? scanMarkdownSource(fs.readFileSync(path.join(repo.root, rel)))
      const finding = (code, occurrence, detail, extra = {}) =>
        diagnostics.push({
          severity: 'warning',
          type: code,
          code,
          node: node.id,
          repo: repo.name,
          path: rel,
          ...(occurrence
            ? { syntax: occurrence.syntax, href: portableText(occurrence.href), range: occurrence.range, targetRange: occurrence.targetRange }
            : {}),
          ...extra,
          message: `${repo.name}/${rel}: ${detail}`,
        })

      if (!utf8Exact && occurrences.length) finding('link-source-not-utf8', null, 'source is not valid UTF-8; link byte offsets are withheld')

      for (const occurrence of occurrences) {
        const shown = JSON.stringify(portableText(occurrence.href))
        let targetNode = null
        let asset = null
        let resolvedBy = 'path'

        if (occurrence.syntax === 'wikilink') {
          const candidates = wikilinkCandidates(occurrence.href, eligibleNodes, pathOf, repoNameOf)
          if (candidates.nodes.length > 1) {
            finding('link-target-ambiguous', occurrence, `wikilink ${shown} matches ${candidates.nodes.length} documents; refusing to choose`, {
              candidates: candidates.nodes.map((item) => item.id).sort(),
            })
            continue
          }
          targetNode = candidates.nodes[0] ?? null
          resolvedBy = candidates.by
          if (!targetNode && occurrence.embed) {
            const found = wikilinkAssets(repo, occurrence.href)
            if (found.assets.length > 1) {
              finding('link-target-ambiguous', occurrence, `embed ${shown} matches ${found.assets.length} files; refusing to choose`, {
                candidates: found.assets.map((item) => item.id).sort(),
              })
              continue
            }
            asset = found.assets[0] ?? null
            resolvedBy = found.by
          }
        } else {
          const href = occurrence.href
          if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue
          let decoded
          try {
            decoded = decodeURIComponent(href)
          } catch {
            finding('link-href-malformed', occurrence, `link ${shown} is not valid percent-encoding`)
            continue
          }
          const abs = path.join(repo.root, path.dirname(rel), decoded)
          const owner = owningRepo(abs)
          if (!owner) {
            finding('link-target-outside-enrolled-roots', occurrence, `link ${shown} leaves every enrolled repository`)
            continue
          }
          // A link that climbs above its own repository and comes back in
          // through the checkout's directory name depends on where the
          // repository happens to be checked out. It is not a repository-local
          // link and never was one; only a link into ANOTHER enrolled
          // repository may leave the root.
          const lexical = path.posix.normalize(posixJoin(path.posix.dirname(rel), decoded.split(path.sep).join('/')))
          if (owner === repo && (lexical === '..' || lexical.startsWith('../'))) {
            finding('link-target-outside-enrolled-roots', occurrence, `link ${shown} leaves its repository and re-enters through the checkout path`)
            continue
          }
          const target = relPath(owner.root, abs)
          // Eligibility is tested per candidate, before choosing: a withheld
          // candidate is skipped exactly as an absent one, so it can never
          // shadow an eligible fallback and change the edge set.
          targetNode =
            [target, posixJoin(target, 'README.md'), posixJoin(target, 'index.md')]
              .map((candidate) => owner.nodesByPath.get(candidate))
              .find((candidate) => candidate && isLinkTargetEligible(candidate)) ?? null
          if (!targetNode && occurrence.embed) asset = assetAt(owner, target)
        }

        if (asset) {
          embeds.push({
            source: node.id,
            type: 'embeds_asset',
            asset,
            syntax: occurrence.syntax,
            href: occurrence.href,
            fragment: occurrence.fragment,
            resolvedBy,
            crossRepository: asset.repo !== repo.name,
            sourceRepo: repo.name,
            sourcePath: rel,
            range: occurrence.range,
            targetRange: occurrence.targetRange,
          })
          continue
        }
        if (!targetNode) {
          finding('link-target-unresolved', occurrence, `link ${shown} does not resolve to an enrolled document`)
          continue
        }
        links.push({
          source: node.id,
          target: targetNode.id,
          type: 'links_to',
          syntax: occurrence.syntax,
          embed: occurrence.embed,
          href: occurrence.href,
          fragment: occurrence.fragment,
          resolvedBy,
          crossRepository: ownerOf.get(targetNode) !== repo,
          sourceRepo: repo.name,
          sourcePath: rel,
          targetRepo: ownerOf.get(targetNode).name,
          targetPath: targetNode.path,
          range: occurrence.range,
          targetRange: occurrence.targetRange,
        })
      }
    }
  }

  const order = (item) => `${item.sourceRepo ?? item.repo}/${item.sourcePath ?? item.path}`
  const byPosition = (a, b) => order(a).localeCompare(order(b)) || (a.range?.start ?? -1) - (b.range?.start ?? -1)
  return { links: links.sort(byPosition), embeds: embeds.sort(byPosition), diagnostics: diagnostics.sort(byPosition) }
}

// A repository's own artifact depends on that repository alone: path links
// that stay inside it. Wikilinks and cross-repository links resolve against
// the whole enrolment and belong to the workspace graph only.
function repoLocalLink(link) {
  return !link.crossRepository && link.syntax === 'markdown'
}

const linkEdge = (link) => ({ source: link.source, target: link.target, type: 'links_to' })

export function markdownLinkEdges(repoRoot, nodesByPath) {
  const { links } = resolveWorkspaceLinks({ repos: [{ name: path.basename(repoRoot), root: repoRoot, nodesByPath }] })
  return links.filter(repoLocalLink).map(linkEdge)
}

export function declaredRelationEdges(nodes) {
  const edges = []
  for (const node of nodes) {
    for (const [type, targets] of Object.entries(node.relations ?? {})) {
      if (!Array.isArray(targets)) continue
      for (const target of targets) edges.push({ source: node.id, target, type, declared: true })
    }
  }
  return edges
}

export function uniqueEdges(edges) {
  const seen = new Set()
  const result = []
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.type}\u0000${edge.declared ? 'declared' : 'derived'}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(edge)
  }
  return result
}

export function graphDiagnostics(nodes) {
  const diagnostics = []
  for (const node of nodes) {
    if (node.classification === 'unclassified') {
      diagnostics.push({
        severity: 'warning',
        type: 'unclassified-content',
        code: 'unclassified-content',
        node: node.id,
        repo: node.repo,
        path: node.path,
        audience: node.audience,
        repoAccess: node.repoAccess,
        reason: node.classificationReason,
        message: `${node.repo}/${node.path}: Markdown classification metadata is ${node.classificationReason}; enrolled as private unclassified content`,
      })
    }
    const audienceRank = AUDIENCE_READ_RANK[node.audience]
    const readBoundary = node.repoAccess?.readBoundary
    const readBoundaryRank = AUDIENCE_READ_RANK[readBoundary]
    if (audienceRank == null || readBoundaryRank == null || readBoundaryRank >= audienceRank) continue
    const privateOrSensitive = PRIVATE_AUDIENCES.has(node.audience) && readBoundary !== 'private'
    diagnostics.push({
      severity: 'warning',
      type: privateOrSensitive ? 'private-repo-recommended' : 'repo-read-boundary-wider-than-audience',
      node: node.id,
      repo: node.repo,
      path: node.path,
      audience: node.audience,
      repoAccess: node.repoAccess,
      message: privateOrSensitive
        ? `${node.repo}/${node.path}: audience ${node.audience} is in a ${readBoundary}-readable repo`
        : `${node.repo}/${node.path}: audience ${node.audience} is narrower than ${readBoundary} repository read access`,
    })
  }
  return diagnostics
}

export function activeOrphanSidecars(repoName, repoRoot, files, isIgnored = gitIgnoreFilter(repoRoot)) {
  const indexedPaths = new Set(files.map((file) => file.rel))
  const orphans = []
  for (const sidecar of walkSidecars(repoRoot, repoRoot, [], isIgnored)) {
    const sourceRel = sidecar.rel.replace(/\.kg\.json$/, '')
    if (indexedPaths.has(sourceRel)) continue
    if (fs.existsSync(path.join(repoRoot, sourceRel))) continue
    const metadata = readJsonFile(sidecar.abs, {})
    const status = asString(metadata?.kg?.status, 'active')
    if (status === 'archived' || status === 'template') continue
    orphans.push({ repo: repoName, path: sidecar.rel, source: sourceRel, status })
  }
  return orphans
}

export function validateKnowledgeGraph(nodes, edges, orphanSidecars = [], { externalRelationPrefixes = [], externalRelationIds = [] } = {}) {
  const errors = []
  const seenIds = new Map()
  const allowedExternalPrefixes = new Set(externalRelationPrefixes)
  const allowedExternalIds = new Set(externalRelationIds)

  for (const node of nodes) {
    if (!node.id) errors.push(`${node.repo}/${node.path}: missing kg.id`)
    if (node.extension === 'md' && node.classification !== 'unclassified' && node.markdownHasKgBlock && !node.markdownHasKgId) {
      errors.push(`${node.repo}/${node.path}: kg.id is required in a Markdown kg block`)
    }
    if (node.extension !== 'md' && !node.hasSidecar) {
      errors.push(`${node.repo}/${node.path}: missing non-Markdown sidecar ${node.sidecar || `${node.path}.kg.json`}`)
    }
    if (node.extension !== 'md' && node.hasSidecar) {
      for (const schemaError of node.sidecarSchemaErrors ?? []) {
        errors.push(`${node.repo}/${node.path}: sidecar ${node.sidecar} ${schemaError}`)
      }
    }
    if (seenIds.has(node.id)) {
      errors.push(`duplicate kg.id "${node.id}" in ${seenIds.get(node.id)} and ${node.repo}/${node.path}`)
    } else {
      seenIds.set(node.id, `${node.repo}/${node.path}`)
    }
    if (node.frontmatterHasLegacyVisibility) {
      errors.push(`${node.repo}/${node.path}: kg.visibility is invalid for graph classification; use kg.audience`)
    }
    if (!VALID_AUDIENCES.has(node.audience)) {
      errors.push(`${node.repo}/${node.path}: invalid or missing kg.audience "${node.audience ?? ''}"`)
    }
    if (!VALID_STATUSES.has(node.status)) errors.push(`${node.repo}/${node.path}: invalid kg.status "${node.status}"`)
    if (!VALID_KG_TYPES.has(node.kgType)) errors.push(`${node.repo}/${node.path}: invalid kg.type "${node.kgType}"`)
    for (const [type, targets] of Object.entries(node.relations ?? {})) {
      if (!VALID_RELATION_TYPES.has(type)) errors.push(`${node.repo}/${node.path}: invalid kg.relations type "${type}"`)
      if (!Array.isArray(targets)) {
        errors.push(`${node.repo}/${node.path}: kg.relations.${type} must be a list`)
        continue
      }
      for (const target of targets) {
        if (typeof target !== 'string' || !target.trim()) {
          errors.push(`${node.repo}/${node.path}: kg.relations.${type} contains an empty target`)
        }
      }
    }
  }

  for (const edge of edges) {
    if (!edge.declared) continue
    const externalPrefix = String(edge.target).split(':')[0]
    if (!seenIds.has(edge.target) && !allowedExternalIds.has(edge.target) && !allowedExternalPrefixes.has(externalPrefix)) {
      const sourcePath = seenIds.get(edge.source) || edge.source
      errors.push(`${sourcePath}: declared ${edge.type} target "${edge.target}" was not found`)
    }
  }

  for (const orphan of orphanSidecars) {
    errors.push(`${orphan.repo}/${orphan.path}: active orphan sidecar has no adjacent source ${orphan.source}`)
  }

  return errors
}

// A per-file cache for repeated builds of one workspace: the census node and
// the link scan of every Markdown source, kept under the sha256 of the bytes
// they were derived from together with the per-file inputs that are not in
// the bytes (coverage and the repository's read boundary). Both derivations
// are pure functions of those inputs, so an entry is reused only when a build
// with no cache would compute the same values; a file whose bytes or inputs
// differ is parsed again, and a file no longer in the census leaves the cache.
// Without `observedDigest` every source is read and hashed on every build: the
// cache never trusts a digest it did not compute from the bytes. A caller that
// already observes the sources by digest (the maintenance engine's index: stat
// hint between full reconciliations, every file hashed on a full one) may pass
// `observedDigest(repoName, rel)`, returning `sha256:<hex>` or null. An entry
// whose digest equals the observed one is then reused without opening the
// file; the tradeoff is exactly the observer's: bytes that change under an
// unchanged stat hint are not seen until the observer hashes the file again,
// and until then no view is rebuilt for them either. Any other file is read
// and hashed here as always. Derived, droppable state.
export function createGraphFileCache() {
  return { files: new Map() }
}

function isGraphFileCache(cache) {
  return cache !== null && typeof cache === 'object' && cache.files instanceof Map
}

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

// The Markdown census entry for one file, from the cache under an equal digest
// and equal inputs, or freshly derived. The returned node and scan are clones
// so a caller's changes never reach the cache.
function markdownCensus({ repoName, repoRoot, coverage, file, accessConfig, cache, next, observedDigest }) {
  const inputs = JSON.stringify([coverage.surfaced.has(file.rel), coverage.sections.get(file.rel) || null, repoReadBoundary(accessConfig, repoName)])
  const key = `${repoName}\u0000${file.rel}`
  const cached = cache?.files.get(key)
  const observed = cached && observedDigest ? observedDigest(repoName, file.rel) : null
  let entry
  let read = false
  if (cached && cached.inputs === inputs && typeof observed === 'string' && observed === `sha256:${cached.digest}`) {
    entry = cached
  } else {
    read = true
    const buffer = fs.readFileSync(file.abs)
    const digest = sha256Hex(buffer)
    entry = cached && cached.digest === digest && cached.inputs === inputs
      ? cached
      : { digest, inputs, node: nodeForFile(repoName, repoRoot, coverage, file, accessConfig, buffer.toString('utf8')), scan: scanMarkdownSource(buffer) }
  }
  next?.set(key, entry)
  return { node: structuredClone(entry.node), scan: structuredClone(entry.scan), reused: entry === cached, read }
}

export function buildKnowledgeGraph({
  workspaceRoot,
  repoAccessConfig,
  repoRoots = null,
  repoEntries = null,
  repoAccessConfigPath = 'repo-access config',
  externalRepos = [],
  externalRelationPrefixes = [],
  externalRelationIds = [],
  isLinkTargetEligible = undefined,
  isAssetEligible = undefined,
  fileCache = null,
  observedDigest = null,
} = {}) {
  if (!workspaceRoot) throw new Error('workspaceRoot is required')
  if (fileCache !== null && !isGraphFileCache(fileCache)) throw new Error('fileCache must come from createGraphFileCache')
  if (observedDigest !== null && typeof observedDigest !== 'function') throw new Error('observedDigest must be a function')
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot)
  const external = new Set(externalRepos)
  const discoveredEntries = repoEntries
    ? repoEntries.map((entry) => ({ name: entry.name, path: path.resolve(entry.path) })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    : (repoRoots ? repoRoots.map((repoRoot) => path.resolve(repoRoot)) : listRepos(resolvedWorkspaceRoot))
        .sort()
        .map((repoRoot) => ({ name: path.basename(repoRoot), path: repoRoot }))
  // External repos are acknowledged but never walked: no document census, no
  // sidecar demands, no projection.
  const roots = discoveredEntries.filter((entry) => !external.has(entry.name))
  const repoNames = roots.map((entry) => entry.name)
  const accessConfig = repoAccessConfig ?? {
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: Object.fromEntries(repoNames.map((repoName) => [repoName, { readBoundary: 'team' }])),
  }
  const repoAccessErrors = validateRepoAccessConfig(accessConfig, repoNames, { configPath: repoAccessConfigPath, externalRepos })
  if (repoAccessErrors.length) {
    return {
      ok: false,
      errors: repoAccessErrors,
      repoGraphs: [],
      workspaceGraph: null,
    }
  }

  const workspaceNodes = []
  const workspaceEdges = []
  const workspaceOrphanSidecars = []
  const workspaceIgnoredSidecars = []
  const repoGraphs = []
  const census = []
  const scanned = new Map()
  const nextCache = fileCache ? new Map() : null
  const reuse = { reused: 0, derived: 0, read: 0 }

  for (const entry of roots) {
    const repoRoot = entry.path
    const repoName = entry.name
    // One batched ignore lookup per repo, shared by every walk below.
    const isIgnored = gitIgnoreFilter(repoRoot)
    const files = walkDocuments(repoRoot, repoRoot, [], isIgnored)
    workspaceOrphanSidecars.push(...activeOrphanSidecars(repoName, repoRoot, files, isIgnored))
    workspaceIgnoredSidecars.push(...ignoredSourceSidecars(repoName, repoRoot, isIgnored))
    const coverage = loadAtelierCoverage(repoRoot)
    const nodes = []
    const nodesByPath = new Map()

    for (const file of files) {
      let node
      if (file.ext === '.md') {
        // One read per Markdown source: the census entry and the link scan come from the same bytes.
        const entry = markdownCensus({ repoName, repoRoot, coverage, file, accessConfig, cache: fileCache, next: nextCache, observedDigest })
        node = entry.node
        scanned.set(node, entry.scan)
        reuse[entry.reused ? 'reused' : 'derived'] += 1
        if (entry.read) reuse.read += 1
      } else {
        node = nodeForFile(repoName, repoRoot, coverage, file, accessConfig)
      }
      nodes.push(node)
      nodesByPath.set(file.rel, node)
    }

    census.push({ name: repoName, root: repoRoot, nodes, nodesByPath, isIgnored })
  }
  // The cache holds exactly the Markdown sources of this census, each under the digest this build read.
  if (nextCache) fileCache.files = nextCache

  // Links resolve once, against every enrolled repository together.
  const resolved = resolveWorkspaceLinks({ repos: census, scanned, ...(isLinkTargetEligible ? { isLinkTargetEligible } : {}), ...(isAssetEligible ? { isAssetEligible } : {}) })

  for (const { name: repoName, root: repoRoot, nodes } of census) {
    const localLinks = resolved.links.filter((link) => link.sourceRepo === repoName && repoLocalLink(link))
    const edges = uniqueEdges([...localLinks.map(linkEdge), ...declaredRelationEdges(nodes)])
    const graph = {
      schema: KNOWLEDGE_GRAPH_SCHEMA,
      repo: repoName,
      diagnostics: graphDiagnostics(nodes),
      nodes: nodes.sort((a, b) => a.path.localeCompare(b.path)),
      edges: edges.sort((a, b) => `${a.source}:${a.target}:${a.type}`.localeCompare(`${b.source}:${b.target}:${b.type}`)),
    }
    graph.nodeCount = graph.nodes.length
    graph.edgeCount = graph.edges.length

    repoGraphs.push({ repoName, repoRoot, graph })
    workspaceNodes.push(...graph.nodes)
    workspaceEdges.push(...graph.edges)
  }
  workspaceEdges.push(...resolved.links.filter((link) => !repoLocalLink(link)).map(linkEdge))

  const validationErrors = validateKnowledgeGraph(workspaceNodes, workspaceEdges, workspaceOrphanSidecars, {
    externalRelationPrefixes,
    externalRelationIds,
  })
  const workspaceGraph = {
    schema: KNOWLEDGE_GRAPH_SCHEMA,
    workspace: path.basename(resolvedWorkspaceRoot),
    diagnostics: graphDiagnostics(workspaceNodes),
    nodes: workspaceNodes.sort((a, b) => `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`)),
    edges: uniqueEdges(workspaceEdges).sort((a, b) => `${a.source}:${a.target}:${a.type}`.localeCompare(`${b.source}:${b.target}:${b.type}`)),
  }
  workspaceGraph.nodeCount = workspaceGraph.nodes.length
  workspaceGraph.edgeCount = workspaceGraph.edges.length

  return {
    ok: validationErrors.length === 0,
    errors: validationErrors,
    repoGraphs,
    workspaceGraph,
    orphanSidecars: workspaceOrphanSidecars,
    ignoredSidecars: workspaceIgnoredSidecars,
    resolvedLinks: resolved.links,
    resolvedEmbeds: resolved.embeds,
    linkDiagnostics: resolved.diagnostics,
    // How many Markdown census entries this build derived, how many it reused from the file cache, and how many sources it opened.
    fileCensus: reuse,
  }
}

export function writeKnowledgeGraphs({ repoGraphs = [], workspaceGraph, workspaceGraphPath }) {
  for (const { repoRoot, graph } of repoGraphs) {
    writeJsonFile(path.join(repoRoot, 'knowledge.graph.json'), graph)
  }
  if (workspaceGraphPath && workspaceGraph) writeJsonFile(workspaceGraphPath, workspaceGraph)
}
