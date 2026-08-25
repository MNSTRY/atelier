import fs from 'node:fs'
import path from 'node:path'
import { commandProject, gitRemoteUrl, loadRepoAccess, remoteHost, writeJson } from '../project/config.mjs'
import { VALID_AUDIENCES as PROJECTION_AUDIENCES } from '../projection/policy.mjs'
import {
  REPO_ACCESS_SCHEMA,
  VALID_RELATION_TYPES,
  buildKnowledgeGraph,
  parseYamlSubset,
} from './knowledge-graph.mjs'

// Compatibility exports. Parsing, census, validation, and diagnostics all live
// in knowledge-graph.mjs; this module only projects its canonical result into
// the long-standing `atelier graph` artifact shape.
export const VALID_AUDIENCES = PROJECTION_AUDIENCES
export const VALID_RELATIONS = VALID_RELATION_TYPES
export const parseFrontmatterYaml = parseYamlSubset

function canonicalInput(project) {
  const loadedAccess = loadRepoAccess(project)
  const managed = []
  const missing = []
  const accessRepos = {}

  for (const repo of project.repos ?? []) {
    if (repo.external) continue
    if (!repo.name || !repo.path || !fs.existsSync(repo.path)) {
      missing.push(`configured repo is missing or unreadable: ${repo.name ?? '(unnamed)'}`)
      continue
    }
    managed.push({ name: repo.name, path: repo.path })
    accessRepos[repo.name] = {
      readBoundary:
        loadedAccess.repos?.[repo.name]?.readBoundary ?? repo.readBoundary ?? loadedAccess.defaultReadBoundary ?? 'team',
    }
  }

  return {
    missing,
    options: {
      workspaceRoot: project.workspaceRoot,
      repoEntries: managed,
      repoAccessConfig: {
        schema: REPO_ACCESS_SCHEMA,
        defaultReadBoundary: loadedAccess.defaultReadBoundary ?? 'team',
        repos: accessRepos,
      },
      repoAccessConfigPath: project.repoAccessPath,
      externalRelationPrefixes: Array.isArray(project.config.graph?.externalRelationPrefixes)
        ? project.config.graph.externalRelationPrefixes
        : [],
      externalRelationIds: Array.isArray(project.config.graph?.externalRelationIds) ? project.config.graph.externalRelationIds : [],
    },
  }
}

function compatibilityError(message) {
  return String(message)
    .replace(': missing non-Markdown sidecar ', ': non-Markdown source requires sidecar ')
    .replace(/: active orphan sidecar has no adjacent source .+$/, ': sidecar has no matching source asset')
}

function compatibilityNode(node) {
  return {
    id: node.id,
    title: node.title,
    summary: node.summary,
    repo: node.repo,
    path: node.path,
    type: node.kgType,
    status: node.status,
    audience: node.audience,
    ...(node.classification === 'unclassified'
      ? { classification: 'unclassified', classificationReason: node.classificationReason }
      : {}),
    tags: node.tags,
    relations: node.relations,
    repoAccess: node.repoAccess,
  }
}

function compatibilityDiagnostic(diagnostic) {
  if (diagnostic.code === 'unclassified-content') return diagnostic
  return {
    severity: diagnostic.severity,
    code: 'audience-wider-repo-boundary',
    node: diagnostic.node,
    message: diagnostic.message,
  }
}

function externalRepos(project) {
  return (project.repos ?? [])
    .filter((repo) => repo.external)
    .map((repo) => ({
      name: repo.name,
      path: repo.path ?? null,
      remoteHost: remoteHost(gitRemoteUrl(repo.path)),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function canonicalBuild(project) {
  const input = canonicalInput(project)
  const result = buildKnowledgeGraph(input.options)
  return { input, result }
}

export function buildGraph(project) {
  const { input, result } = canonicalBuild(project)
  const canonical = result.workspaceGraph ?? { nodes: [], edges: [], diagnostics: [] }
  const nodes = canonical.nodes.map(compatibilityNode)
  // The legacy artifact exposes declared relations only. Derived Markdown-link
  // edges remain available from buildKnowledgeGraph without changing this API.
  const edges = canonical.edges.filter((edge) => edge.declared === true)
  const diagnostics = canonical.diagnostics.map(compatibilityDiagnostic)
  const errors = [...input.missing, ...result.errors.map(compatibilityError)]

  return {
    schema: 'mnstry.atelier-knowledge-graph@v1',
    generatedAt: 'deterministic',
    project: path.basename(project.workspaceRoot),
    counts: { nodes: nodes.length, edges: edges.length, diagnostics: diagnostics.length },
    nodes,
    edges,
    diagnostics,
    external: externalRepos(project),
    errors,
  }
}

// Machine-local ignored-sidecar observations stay outside generated artifacts.
export function ignoredSidecarWarnings(project) {
  const { result } = canonicalBuild(project)
  return (result.ignoredSidecars ?? []).map((found) => ({
    severity: 'warning',
    code: 'ignored-sidecar',
    repo: found.repo,
    path: found.path,
    sidecar: found.sidecar,
    message: `${found.repo}/${found.sidecar}: sidecar is git-ignored and was refused; it cannot enroll ${found.path} or describe it`,
  }))
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
