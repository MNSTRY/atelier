import fs from 'node:fs'
import path from 'node:path'
import { bundledReadinessProtocols } from '../readiness-protocols/bundled-pack.mjs'
import { createProtocolRegistry, loadExtensionPacks } from '../extension-packs/loader.mjs'
import {
  buildReadinessExportDryRun,
  buildTenantPacket,
  runProtocol,
  summarizeReadinessJourney,
  writeTenantPacket,
} from '../readiness-protocols/runtime.mjs'
import { PROJECT_CONFIG_ENV, commandProject, parseArgs, projectConfigArg, readJson, writeJson } from '../project/config.mjs'

export const ATELIER_READINESS_SCHEMA = 'mnstry.atelier-readiness@v1'

export function summarizeGraph(graph, { path: graphPath = null, expectedSchema = 'mnstry.knowledge-graph@v1' } = {}) {
  const diagnostics = Array.isArray(graph?.diagnostics) ? graph.diagnostics : []
  return {
    ok: graph?.schema === expectedSchema,
    path: graphPath,
    schema: graph?.schema ?? null,
    nodes: graph?.nodeCount ?? graph?.counts?.nodes ?? graph?.nodes?.length ?? 0,
    edges: graph?.edgeCount ?? graph?.counts?.edges ?? graph?.edges?.length ?? 0,
    diagnostics: diagnostics.length || graph?.counts?.diagnostics || 0,
    privateRepoRecommended: diagnostics.filter((item) => item.type === 'private-repo-recommended').length,
  }
}

export function summarizeProjection(projection, { path: projectionPath = null, expectedSchema = 'mnstry.alignment-projection@v1' } = {}) {
  return {
    ok: projection?.schema === expectedSchema,
    path: projectionPath,
    schema: projection?.schema ?? null,
    generatedAt: projection?.generatedAt ?? null,
    graphNodes: projection?.summary?.graphNodes ?? 0,
    graphEdges: projection?.summary?.graphEdges ?? 0,
    alignmentNodes: projection?.summary?.alignmentNodes ?? 0,
    alignmentEdges: projection?.summary?.alignmentEdges ?? 0,
    gaps: projection?.summary?.gaps ?? 0,
    diagnostics: projection?.summary?.diagnostics ?? 0,
  }
}

function buildPackageReadiness({
  generatedAt = new Date().toISOString(),
  workspace = {},
  graph,
  graphPath = null,
  projection,
  projectionPath = null,
  contracts = [],
  kitManifest = null,
  runtimeDryRun = { ok: false },
  supportBundle = {
    states: ['none', 'support_bundle'],
    sendPath: false,
    background: false,
    telemetry: 'none',
    hashableDryRun: true,
  },
  analysis = {
    ok: true,
    enabled: false,
    defaultEnabled: false,
    manifestPath: null,
    manifestPresent: false,
    authority: 'optional-local-claim-only',
  },
  checks = [],
  acceptedBoundary = 'extractable-kit',
} = {}) {
  const graphSummary = summarizeGraph(graph, { path: graphPath })
  const projectionSummary = summarizeProjection(projection, { path: projectionPath })
  const normalizedContracts = contracts.map((contract) => ({
    path: contract.path,
    present: Boolean(contract.present),
  }))
  const normalizedKitManifest = {
    ok: kitManifest?.ok === true,
    path: kitManifest?.path ?? null,
    schema: kitManifest?.schema ?? null,
    kernel: kitManifest?.kernel ?? null,
    sourceDialect: kitManifest?.sourceDialect ?? null,
    exportContract: kitManifest?.exportContract ?? null,
    extensionPacks: Array.isArray(kitManifest?.extensionPacks) ? kitManifest.extensionPacks.length : kitManifest?.extensionPacks ?? 0,
    telemetry: kitManifest?.telemetry ?? null,
  }
  const blockers = []
  const warnings = []

  if (!graphSummary.ok) blockers.push('knowledge-graph-missing-or-invalid')
  if (!projectionSummary.ok) blockers.push('alignment-projection-missing-or-invalid')
  if (!runtimeDryRun?.ok) blockers.push('runtime-dry-run-missing')
  if (!normalizedKitManifest.ok) blockers.push('kit-manifest-missing-or-invalid')
  for (const contract of normalizedContracts) {
    if (!contract.present) blockers.push(`missing-contract:${contract.path}`)
  }
  for (const check of checks) {
    if (!check.ok) blockers.push(`live-check-failed:${check.label}`)
  }
  if (graphSummary.privateRepoRecommended > 0) warnings.push('private-or-sensitive-nodes-in-team-readable-repos')
  if (!analysis?.enabled) warnings.push('analysis-disabled-by-default')

  return {
    schema: ATELIER_READINESS_SCHEMA,
    generatedAt,
    workspace: {
      root: workspace.root ?? null,
      repoOpsHead: workspace.repoOpsHead ?? null,
    },
    acceptedBoundary,
    ready: blockers.length === 0,
    blockers,
    warnings,
    graph: graphSummary,
    alignment: projectionSummary,
    contracts: normalizedContracts,
    kitManifest: normalizedKitManifest,
    runtimeDryRun,
    supportBundle,
    analysis,
    checks,
  }
}

function buildProjectReadiness({ project, graph = null } = {}) {
  const loadedGraph = graph || (fs.existsSync(project.graphPath) ? readJson(project.graphPath) : null)
  const projectionEntry = path.join(project.outputRoot, 'index.html')
  const manifest = path.join(project.outputRoot, 'atelier.manifest.json')
  const blockers = []
  const warnings = []
  if (!loadedGraph || loadedGraph.schema !== 'mnstry.atelier-knowledge-graph@v1') blockers.push('knowledge-graph-missing-or-invalid')
  if (!fs.existsSync(projectionEntry)) blockers.push('project-projection-missing')
  if (!fs.existsSync(manifest)) blockers.push('project-manifest-missing')
  if (Array.isArray(loadedGraph?.errors) && loadedGraph.errors.length) blockers.push('knowledge-graph-errors-present')
  if (Array.isArray(loadedGraph?.diagnostics) && loadedGraph.diagnostics.length) warnings.push('graph-diagnostics-present')
  return {
    schema: ATELIER_READINESS_SCHEMA,
    generatedAt: 'deterministic',
    project: project.config.name || path.basename(project.workspaceRoot),
    ready: blockers.length === 0,
    blockers,
    warnings,
    graph: {
      path: project.graphPath,
      nodes: loadedGraph?.counts?.nodes ?? loadedGraph?.nodes?.length ?? 0,
      edges: loadedGraph?.counts?.edges ?? loadedGraph?.edges?.length ?? 0,
      diagnostics: loadedGraph?.counts?.diagnostics ?? loadedGraph?.diagnostics?.length ?? 0,
    },
    projection: {
      outputRoot: project.outputRoot,
      entry: projectionEntry,
    },
    support: {
      telemetry: 'none',
      sendPath: false,
      background: false,
    },
    analysis: {
      enabled: false,
      authority: 'claim-only',
    },
    tenantReadiness: summarizeReadinessJourney(project),
  }
}

export function buildReadiness(options = {}) {
  if (options.project) return buildProjectReadiness(options)
  return buildPackageReadiness(options)
}

export function stableReadinessForCheck(value) {
  return {
    ...value,
    generatedAt: null,
    workspace: {
      ...value.workspace,
      repoOpsHead: null,
    },
    runtimeDryRun: value.runtimeDryRun
      ? {
          ...value.runtimeDryRun,
          root: null,
          rootSource: null,
        }
      : value.runtimeDryRun,
    checks: Array.isArray(value.checks)
      ? value.checks.map((check) => check?.label === 'runtime dry-run consumer passes'
        ? { ...check, cwd: null }
        : check)
      : value.checks,
  }
}

// Loads declared extension packs (fail closed: any pack error throws before a
// protocol becomes resolvable) and composes the explicit registry. Projects
// with no declared packs get a bundled-only registry.
function projectRegistry(project) {
  const { packs } = loadExtensionPacks(project)
  return createProtocolRegistry({ packs })
}

export function runReadinessCommand(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  const subcommand = parsed._[0]
  if (subcommand === 'protocols') {
    const detail = parsed.json === true || parsed.format === 'json'
    // Bundled-only by default; an explicit --project PATH / --project-config=PATH
    // argument OR the MNSTRY_ATELIER_PROJECT_CONFIG env var loads that
    // project's extension packs and lists their protocols with a source
    // marker. A bare invocation with neither never auto-detects the cwd.
    const envConfig = process.env[PROJECT_CONFIG_ENV]
    const projectAware = projectConfigArg(argv) !== null
      || (typeof envConfig === 'string' && envConfig.trim() !== '')
    const entries = bundledReadinessProtocols.map((protocol) => ({ protocol, source: null }))
    if (projectAware) {
      const project = commandProject({ argv })
      const registry = projectRegistry(project)
      for (const pack of registry.packs) {
        for (const record of pack.protocols ?? []) {
          entries.push({ protocol: record.protocol, source: pack.id })
        }
      }
    }
    if (detail) {
      console.log(`${JSON.stringify({
        schema: 'mnstry.readiness-protocol-list@v1',
        protocols: entries.map(({ protocol, source }) => (source ? { ...protocol, source } : protocol)),
      }, null, 2)}\n`)
    } else {
      console.log('MNSTRY readiness protocols')
      for (const { protocol, source } of entries) {
        console.log(`- ${protocol.id}: ${protocol.title}${source ? ` (source: ${source})` : ''}`)
      }
    }
    return
  }

  if (subcommand === 'journey') {
    const project = commandProject({ argv })
    const journey = summarizeReadinessJourney(project, { registry: projectRegistry(project) })
    console.log(`${JSON.stringify(journey, null, 2)}\n`)
    return
  }

  if (subcommand === 'run') {
    const project = commandProject({ argv })
    const protocolId = parsed._[1]
    if (!protocolId) throw new Error('readiness run requires a protocol id')
    const answers = parsed.answers ? readJson(path.resolve(process.cwd(), parsed.answers)) : {}
    const result = runProtocol(project, protocolId, {
      answers,
      write: parsed.write !== false,
      createProposal: parsed.proposal !== false && parsed['no-proposal'] !== true,
      registry: projectRegistry(project),
    })
    console.log(`${JSON.stringify({
      ok: result.run.blockers.length === 0,
      protocolId: result.run.protocolId,
      runId: result.run.runId,
      status: result.run.status,
      score: result.run.score,
      blockers: result.run.blockers,
      warnings: result.run.warnings,
      claims: result.run.claims.map((claim) => claim.claimId),
      runPath: result.file,
      proposal: result.proposal?.record?.proposal?.id ?? null,
    }, null, 2)}\n`)
    if (result.run.blockers.length) process.exitCode = 1
    return
  }

  if (subcommand === 'packet') {
    const project = commandProject({ argv })
    const packet = buildTenantPacket(project, { registry: projectRegistry(project) })
    const file = writeTenantPacket(project, packet)
    console.log(`${JSON.stringify({
      ok: true,
      path: file,
      packet,
    }, null, 2)}\n`)
    return
  }

  if (subcommand === 'export') {
    if (!argv.includes('--dry-run')) throw new Error('readiness export only supports --dry-run')
    const project = commandProject({ argv })
    const report = buildReadinessExportDryRun(project, { registry: projectRegistry(project) })
    console.log(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.accepted) process.exitCode = 1
    return
  }

  const check = argv.includes('--check')
  const project = commandProject({ argv })
  const readiness = buildReadiness({ project })
  const next = `${JSON.stringify(readiness, null, 2)}\n`
  if (check) {
    const current = fs.existsSync(project.readinessPath) ? fs.readFileSync(project.readinessPath, 'utf8') : null
    if (current !== next) {
      console.error(`readiness is stale: ${project.readinessPath}`)
      process.exit(1)
    }
  } else {
    writeJson(project.readinessPath, readiness)
  }
  if (!readiness.ready) {
    console.error(readiness.blockers.join('\n'))
    process.exit(1)
  }
  console.log(`readiness: ready · ${readiness.blockers.length} blockers · ${readiness.warnings.length} warnings`)
}
