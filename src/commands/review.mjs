#!/usr/bin/env node
import path from 'node:path'
import { parseProjectOptions } from '../cli/project-options.mjs'
import { commandProject, parseArgs, readJson } from '../project/config.mjs'
import {
  loadExtensionPacks,
  createProtocolRegistry,
} from '../extension-packs/loader.mjs'
import { runProtocol } from '../readiness-protocols/runtime.mjs'
import { recordReviewEvidence } from '../readiness-protocols/evidence.mjs'
import { createReviewStore } from '../collaboration/review-store.mjs'
import {
  inspectPackLifecycle,
  planPackLifecycleMigration,
} from '../extension-packs/lifecycle.mjs'
import {
  prepareInspectionBundle,
  writeInspectionBundle,
  readInspectionBundle,
} from '../collaboration/inspection-bundle.mjs'

const argv = process.argv.slice(2)
const remaining = parseProjectOptions(argv).remaining
const subcommand = remaining[0]
const specs = {
  run: { answers: 'value' },
  history: {},
  handoff: {},
  packs: { 'migration-plan': 'flag' },
  export: {
    runs: 'value',
    responses: 'value',
    denylist: 'value',
    write: 'flag',
    out: 'value',
  },
  inspect: {},
}
if (!Object.hasOwn(specs, subcommand ?? ''))
  throw new Error(
    'Usage: atelier review run|history|handoff|packs|export|inspect',
  )
const positional = []
for (let i = 1; i < remaining.length; i++) {
  const arg = remaining[i]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const name = arg.slice(2).split('=')[0],
    kind = specs[subcommand][name]
  if (!Object.hasOwn(specs[subcommand], name))
    throw new Error('unknown review option')
  if (kind === 'flag') {
    if (arg.includes('='))
      throw new Error('review flag does not accept a value')
    continue
  }
  const value = arg.includes('=')
    ? arg.slice(arg.indexOf('=') + 1)
    : remaining[++i]
  if (!value || value.startsWith('--'))
    throw new Error('review option requires a value')
}
if (
  positional.length !==
  (['run', 'handoff', 'inspect'].includes(subcommand) ? 1 : 0)
)
  throw new Error('incorrect review arguments')
const args = parseArgs(argv)
const project = args._[0] === 'inspect' ? null : commandProject({ argv })
let result
if (args._[0] === 'run') {
  const registry = createProtocolRegistry({
    packs: loadExtensionPacks(project).packs,
  })
  const answers = args.answers ? readJson(path.resolve(args.answers)) : {}
  const { run } = runProtocol(project, args._[1], {
    answers,
    write: false,
    createProposal: false,
    registry,
  })
  const bound = recordReviewEvidence(project, run)
  result = {
    ok: true,
    runId: run.runId,
    evidenceDigest: bound.snapshot.digest,
    inputCompleteness: run.score,
    blockers: run.blockers,
    confidence: 'not-calibrated',
    next: 'Run atelier dev --review with this project, then open /review.',
  }
} else if (args._[0] === 'inspect')
  result = readInspectionBundle(path.resolve(args._[1]))
else if (args._[0] === 'export') {
  const denylistDocument = process.env.ATELIER_DENYLIST_JSON
    ? JSON.parse(process.env.ATELIER_DENYLIST_JSON)
    : args.denylist
    ? readJson(path.resolve(args.denylist))
    : null
  const bundle = prepareInspectionBundle(
    project,
    String(args.runs ?? '')
      .split(',')
      .filter(Boolean),
    {
      denylistDocument,
      responseIds: String(args.responses ?? '')
        .split(',')
        .filter(Boolean),
    },
  )
  if (args.write) {
    if (!args.out) throw new Error('--out is required for --write')
    writeInspectionBundle(path.resolve(args.out), bundle)
  }
  result = {
    ok: true,
    purpose: bundle.purpose,
    written: Boolean(args.write),
    digest: bundle.digest,
    members: bundle.members.map((member) => ({
      id: member.id,
      bytes: member.bytes,
      digest: member.digest,
    })),
    responses: bundle.responses.map((record) => ({
      id: record.input.requestId,
      digest: record.inputDigest,
    })),
    notice:
      'Inspection only; no approval transfer. Export requires --write --out FILE.',
  }
} else if (args._[0] === 'packs')
  result = (
    args['migration-plan'] ? planPackLifecycleMigration : inspectPackLifecycle
  )(project, loadExtensionPacks(project).packs)
else if (args._[0] === 'handoff')
  result = createReviewStore(project).handoff(args._[1])
else if (args._[0] === 'history') result = createReviewStore(project).records()
else
  throw new Error(
    'Usage: atelier review run PROTOCOL --answers FILE | history | handoff REQUEST_ID | packs | export --runs ID [--responses ID] [--write --out FILE] | inspect FILE [--project PATH]',
  )
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.ok ? 0 : 1
