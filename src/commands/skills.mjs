#!/usr/bin/env node

import path from 'node:path'

import {
  applySkillSync,
  auditSkillCatalog,
  buildSkillCandidates,
  planSkillSync,
  recordSkillObservation,
} from '../skills/steward.mjs'

const USAGE = `Usage: atelier skills <subcommand>

Subcommands:
  audit [--root DIR] [--peer DIR] [--json]
      Audit required metadata, bundle safety, relative resources, and peer parity.
      With no roots, audits the bundled Codex and Claude skill surfaces.

  observe --workflow KEY --signal SIGNAL [--skill NAME] [--outcome OUTCOME]
      Append one content-free local observation under ignored .atelier-local state.
      Prompts, transcripts, free-form summaries, and source content are not accepted.

  candidates [--all] [--json]
      Aggregate local observations into evidence-thresholded create, improve,
      reconcile, or retire candidates. This command never edits a skill.

  sync [--source DIR] [--target .agents/skills] [--json]
      Produce a content-bound plan for updating a repo-scoped managed projection.
      Apply only with --apply --confirm PLAN_DIGEST. Source skills are never changed,
      unmanaged collisions and locally drifted managed skills block, and removals are
      moved to ignored quarantine rather than deleted.

Exit codes: 0 clean or applied, 1 findings or blockers, 2 usage error.`

const OPTION_SPEC = {
  root: 'value',
  peer: 'value',
  source: 'value',
  target: 'value',
  workflow: 'value',
  signal: 'value',
  skill: 'value',
  outcome: 'value',
  confirm: 'value',
  json: 'flag',
  all: 'flag',
  apply: 'flag',
  'dry-run': 'flag',
}

function usageError(message) {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

function parseOptions(argv, allowed) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (!arg.startsWith('--')) usageError(`unexpected argument: ${arg}`)
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2)
    if (!allowed.has(rawName) || !(rawName in OPTION_SPEC)) usageError(`unknown option --${rawName}`)
    if (OPTION_SPEC[rawName] === 'flag') {
      if (inline !== undefined) usageError(`--${rawName} does not take a value`)
      options[rawName] = true
      continue
    }
    let value = inline
    if (value === undefined) {
      index += 1
      value = argv[index]
    }
    if (value === undefined || value.startsWith('--')) usageError(`--${rawName} requires a value`)
    options[rawName] = value
  }
  return options
}

function printAudit(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`skills: ${report.summary.skills}; errors: ${report.summary.errors}; warnings: ${report.summary.warnings}`)
  for (const finding of report.findings) {
    console.log(`${finding.severity}: ${finding.code} ${finding.surface}/${finding.skill ?? '-'} ${finding.path}`)
  }
}

function runAudit(argv) {
  const options = parseOptions(argv, new Set(['root', 'peer', 'json']))
  if (options.peer && !options.root) usageError('--peer requires --root')
  const surfaces = options.root
    ? [
        { name: 'source', root: path.resolve(options.root) },
        ...(options.peer ? [{ name: 'peer', root: path.resolve(options.peer) }] : []),
      ]
    : undefined
  const report = auditSkillCatalog({ surfaces, reportRoot: process.cwd() })
  printAudit(report, options.json)
  return (process.exitCode = report.ok ? 0 : 1)
}

function runObserve(argv) {
  const options = parseOptions(argv, new Set(['workflow', 'signal', 'skill', 'outcome', 'json']))
  if (!options.workflow) usageError('--workflow is required')
  if (!options.signal) usageError('--signal is required')
  try {
    const receipt = recordSkillObservation({
      workspaceRoot: process.cwd(),
      workflowKey: options.workflow,
      signal: options.signal,
      skill: options.skill ?? null,
      outcome: options.outcome ?? 'unknown',
    })
    if (options.json) console.log(JSON.stringify(receipt, null, 2))
    else console.log(`recorded ${receipt.observation.signal} for ${receipt.observation.workflowKey} as local observation ${receipt.observation.id}`)
    return (process.exitCode = 0)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

function runCandidates(argv) {
  const options = parseOptions(argv, new Set(['all', 'json']))
  try {
    const report = buildSkillCandidates({ workspaceRoot: process.cwd(), includeInsufficient: Boolean(options.all) })
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else if (!report.candidates.length) console.log('no skill candidates meet the evidence threshold')
    else {
      for (const candidate of report.candidates) {
        console.log(`${candidate.status}: ${candidate.kind} ${candidate.workflowKey}${candidate.skill ? ` (${candidate.skill})` : ''} from ${candidate.evidenceCount} observation(s)`)
      }
    }
    return (process.exitCode = 0)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

function printPlan(plan, json) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  console.log(`plan: ${plan.planDigest}`)
  console.log(`target: ${plan.target.path}`)
  for (const action of plan.actions) console.log(`${action.type}: ${action.name}`)
  for (const blocker of plan.blockers) console.log(`blocker: ${blocker}`)
  if (!plan.actions.length && !plan.blockers.length) console.log('no managed skill changes')
}

function runSync(argv) {
  const options = parseOptions(argv, new Set(['source', 'target', 'confirm', 'json', 'apply', 'dry-run']))
  if (options.apply && options['dry-run']) usageError('--apply and --dry-run are mutually exclusive')
  if (options.confirm && !options.apply) usageError('--confirm requires --apply')
  if (options.apply && !options.confirm) usageError('--apply requires --confirm PLAN_DIGEST')
  const settings = {
    workspaceRoot: process.cwd(),
    sourceRoot: options.source ? path.resolve(options.source) : undefined,
    target: options.target ?? path.join('.agents', 'skills'),
  }
  try {
    if (options.apply) {
      const result = applySkillSync({ ...settings, confirm: options.confirm })
      if (options.json) console.log(JSON.stringify(result, null, 2))
      else {
        console.log(`applied: ${result.plan.planDigest}`)
        for (const quarantined of result.quarantined) console.log(`quarantined: ${quarantined}`)
      }
      return (process.exitCode = 0)
    }
    const plan = planSkillSync(settings)
    printPlan(plan, options.json)
    return (process.exitCode = plan.applyAllowed ? 0 : 1)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

const argv = process.argv.slice(2)
const subcommand = argv[0]
if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  console.log(USAGE)
  process.exit(0)
}
if (subcommand === 'audit' || subcommand === undefined) runAudit(argv.slice(subcommand ? 1 : 0))
else if (subcommand === 'observe') runObserve(argv.slice(1))
else if (subcommand === 'candidates') runCandidates(argv.slice(1))
else if (subcommand === 'sync') runSync(argv.slice(1))
else usageError(`unknown skills subcommand: ${subcommand}`)
