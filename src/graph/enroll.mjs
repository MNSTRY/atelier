import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PRIVATE_AUDIENCES, loadBoundaryPolicy } from '../boundary/policy.mjs'
import { parseProjectOptions } from '../cli/project-options.mjs'
import { AtelierDiagnosticError, commandProject } from '../project/config.mjs'
import { VALID_AUDIENCES } from '../projection/policy.mjs'
import { canonicalGraphOptions } from './graph.mjs'
import { SOURCE_SIDECAR_SCHEMA, buildKnowledgeGraph, validateSourceSidecar } from './knowledge-graph.mjs'

// Document enrollment writes the sidecar the census demands of every
// non-Markdown document that has none: the smallest classification that lets
// `atelier graph` pass, never a judgement about the document. It reads the same
// census as the graph (scope, Git ignore rules and all), writes only where no
// sidecar exists, and never changes a source.

export const DEFAULT_ENROLLMENT_AUDIENCE = 'private'

const AUDIENCE_ORDER = ['private', 'sensitive', 'staff', 'operator', 'team', 'public']
const orderedAudiences = (audiences) => AUDIENCE_ORDER.filter((audience) => audiences.includes(audience))

// The audiences a repository's boundary policy lets a node carry, by the same
// three rules the boundary check applies to every node. Null when the policy
// does not cover the repository, which the boundary check reports on its own.
export function enrollableAudiences(repoPolicy) {
  if (!repoPolicy || typeof repoPolicy !== 'object') return null
  const allowed = Array.isArray(repoPolicy.allowedAudiences) ? repoPolicy.allowedAudiences : []
  const forbidden = Array.isArray(repoPolicy.forbiddenAudiences) ? repoPolicy.forbiddenAudiences : []
  return orderedAudiences(
    allowed.filter((audience) => !forbidden.includes(audience) && !(PRIVATE_AUDIENCES.has(audience) && repoPolicy.kind !== 'private_domain')),
  )
}

export function assertEnrollmentAudience(audience) {
  if (typeof audience === 'string' && VALID_AUDIENCES.has(audience)) return audience
  throw new AtelierDiagnosticError('enroll-audience-invalid', `--audience must be one of ${orderedAudiences([...VALID_AUDIENCES]).join(', ')}`, {
    hint: `Omit --audience to enroll documents as ${DEFAULT_ENROLLMENT_AUDIENCE}.`,
  })
}

// Refuses, before anything is written, an audience the boundary policy would
// reject in any repository that has a document to enroll. A policy in
// legacy-warning mode only warns about placement, and so does not refuse here.
export function assertAudienceAllowed({ policy, repoNames, audience }) {
  if (policy?.mode === 'legacy-warning') return
  for (const repoName of repoNames) {
    const repoPolicy = policy?.repos && Object.hasOwn(policy.repos, repoName) ? policy.repos[repoName] : null
    const allowed = enrollableAudiences(repoPolicy)
    if (!allowed || allowed.includes(audience)) continue
    // The message names the allowed audiences itself: adopt prints only the
    // message of a refusal, not its hint.
    const kind = typeof repoPolicy.kind === 'string' ? `${repoPolicy.kind.replaceAll('_', ' ')} ` : ''
    const allows = allowed.length ? `it allows ${allowed.join(', ')}` : 'it allows no audience there'
    throw new AtelierDiagnosticError(
      'enroll-audience-not-allowed',
      `the boundary policy does not allow audience ${audience} in ${kind}repository ${repoName}; ${allows}`,
      {
        hint: allowed.length
          ? 'Pass --audience with one of the audiences it allows.'
          : 'Review boundary-policy.v1.json before enrolling documents in that repository.',
      },
    )
  }
}

const idSegment = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const pathSegment = (rel) =>
  String(rel)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+([./])/g, '$1')
    .replace(/([./])-+/g, '$1')
    .replace(/-{2,}/g, '-')

const shortDigest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8)

// `<repo>:asset:<path>` keeps the source's folders and file name readable in
// the id. Two documents whose paths fold to one id (case, spaces) each get a
// digest of their exact path, as does one whose id is already taken, so the
// result does not depend on the order documents are found in.
function assignIds(wanted, taken) {
  const bases = wanted.map((item) => `${idSegment(item.repo) || 'repo'}:asset:${pathSegment(item.path)}`)
  const counts = new Map()
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1)
  const used = new Set(taken)
  return wanted.map((item, index) => {
    const base = bases[index]
    const id = counts.get(base) > 1 || used.has(base) ? `${base}-${shortDigest(`${item.repo}/${item.path}`)}` : base
    if (used.has(id)) throw new Error('document enrollment could not derive a unique kg.id')
    used.add(id)
    return id
  })
}

function sidecarDocument(node, id, audience) {
  return {
    schema: SOURCE_SIDECAR_SCHEMA,
    asset: path.posix.basename(node.path),
    title: node.title || path.posix.basename(node.path),
    summary: '',
    tags: [],
    kg: {
      id,
      type: node.extension,
      domain: node.domain,
      lifecycle: node.lifecycle,
      status: node.status,
      audience,
      relations: {},
    },
  }
}

// What enrollment would write, and what it leaves alone. `policy` defaults to
// the project's boundary policy; a missing or unreadable one is not consulted,
// since the graph itself does not need it.
export function planDocumentEnrollment(project, { audience = DEFAULT_ENROLLMENT_AUDIENCE, policy = undefined } = {}) {
  assertEnrollmentAudience(audience)
  const { options } = canonicalGraphOptions(project)
  const result = buildKnowledgeGraph(options)
  if (!result.workspaceGraph) {
    throw new AtelierDiagnosticError('enroll-census-unavailable', 'the knowledge graph census could not run, so no document was enrolled', {
      hint: 'Run atelier graph with the same --project path to see why, fix that, then retry.',
    })
  }
  const roots = new Map(options.repoEntries.map((entry) => [entry.name, entry.path]))
  const nodes = result.workspaceGraph.nodes
  // Code-point order, so the report reads the same under every locale.
  const byPath = (a, b) => (`${a.repo}/${a.path}` < `${b.repo}/${b.path}` ? -1 : 1)
  const demanded = nodes.filter((node) => node.extension !== 'md' && !node.hasSidecar).sort(byPath)

  const wanted = []
  const skipped = []
  for (const node of demanded) {
    const sidecar = `${node.path}.kg.json`
    const target = path.join(roots.get(node.repo), ...sidecar.split('/'))
    const existing = fs.lstatSync(target, { throwIfNoEntry: false })
    // A sidecar that exists but is not visible to the census is Git-ignored,
    // or is a link or folder. Either way it is someone's, and stays as it is.
    if (existing) {
      skipped.push({ repo: node.repo, path: node.path, sidecar, reason: existing.isFile() ? 'sidecar-ignored' : 'sidecar-not-a-file' })
      continue
    }
    wanted.push({ repo: node.repo, path: node.path, sidecar, target, node })
  }

  if (wanted.length) {
    const loaded = policy === undefined ? loadBoundaryPolicy(project) : { ok: Boolean(policy), policy }
    if (loaded.ok) assertAudienceAllowed({ policy: loaded.policy, repoNames: [...new Set(wanted.map((item) => item.repo))], audience })
  }

  const enrolling = new Set(wanted.map((item) => item.node))
  const ids = assignIds(wanted, nodes.filter((node) => !enrolling.has(node)).map((node) => node.id))
  const enroll = wanted.map((item, index) => {
    const document = sidecarDocument(item.node, ids[index], audience)
    const errors = validateSourceSidecar(document, document.asset)
    if (errors.length) throw new Error(`document enrollment built an invalid sidecar: ${errors.join('; ')}`)
    return { repo: item.repo, path: item.path, sidecar: item.sidecar, target: item.target, id: ids[index], document }
  })
  return { audience, enroll, skipped }
}

// Writes each planned sidecar with an exclusive create, so a file, link or
// folder that appeared since the plan is never replaced or followed; it is
// reported as skipped instead. Sources are never opened.
export function writeDocumentEnrollment(plan) {
  const written = []
  const skipped = [...plan.skipped]
  for (const item of plan.enroll) {
    try {
      fs.writeFileSync(item.target, `${JSON.stringify(item.document, null, 2)}\n`, { flag: 'wx' })
      written.push(item)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      skipped.push({ repo: item.repo, path: item.path, sidecar: item.sidecar, reason: 'sidecar-exists' })
    }
  }
  return { audience: plan.audience, written, skipped }
}

const SKIP_REASONS = {
  'sidecar-ignored': 'a sidecar exists but Git ignores it',
  'sidecar-not-a-file': 'a link or folder has the sidecar name',
  'sidecar-exists': 'a sidecar appeared while enrolling',
}

export function enrollmentReport({ written = [], skipped = [], audience, dryRun = false }) {
  return {
    ok: true,
    command: 'enroll documents',
    dryRun,
    audience,
    enrolled: written.map((item) => ({ repo: item.repo, path: item.path, sidecar: item.sidecar, id: item.id })),
    skipped: skipped.map((item) => ({ repo: item.repo, path: item.path, sidecar: item.sidecar, reason: item.reason })),
  }
}

function printReport(report) {
  const count = report.enrolled.length
  const noun = count === 1 ? 'document' : 'documents'
  if (count === 0) console.log('No document needs a sidecar.')
  else console.log(`${report.dryRun ? 'Would enroll' : 'Enrolled'} ${count} ${noun} with ${report.audience} sidecars:`)
  for (const item of report.enrolled) console.log(`  ${item.repo}/${item.sidecar}`)
  if (report.skipped.length) {
    console.log(`Left ${report.skipped.length} unchanged; the graph still needs a sidecar for each:`)
    for (const item of report.skipped) console.log(`  ${item.repo}/${item.path}: ${SKIP_REASONS[item.reason] ?? item.reason}`)
  }
  if (count && !report.dryRun) {
    console.log('Next: review the sidecars (title, audience), then run atelier graph with the same --project path.')
  }
}

const usage = () =>
  new AtelierDiagnosticError('usage', 'enroll has one subcommand, documents', {
    hint: 'Run atelier enroll documents [--audience private] [--dry-run] [--json] [--project ./atelier.project.json].',
  })

export function parseEnrollArgs(argv = []) {
  const { remaining } = parseProjectOptions(argv)
  const args = { subcommand: null, audience: DEFAULT_ENROLLMENT_AUDIENCE, dryRun: false, json: false }
  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--json') args.json = true
    else if (arg === '--audience') args.audience = remaining[++index]
    else if (arg.startsWith('--audience=')) args.audience = arg.slice('--audience='.length)
    else if (!arg.startsWith('-') && args.subcommand === null) args.subcommand = arg
    else throw usage()
  }
  if (args.subcommand !== 'documents') throw usage()
  assertEnrollmentAudience(args.audience)
  return args
}

export function runEnrollCommand(argv = process.argv.slice(2)) {
  const args = parseEnrollArgs(argv)
  const project = commandProject({ argv })
  const plan = planDocumentEnrollment(project, { audience: args.audience })
  const outcome = args.dryRun ? { audience: plan.audience, written: plan.enroll, skipped: plan.skipped } : writeDocumentEnrollment(plan)
  const report = enrollmentReport({ ...outcome, dryRun: args.dryRun })
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
}
