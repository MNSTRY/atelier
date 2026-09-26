#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as capability from '../capabilities/index.mjs'
import { jsonAt } from '../capabilities/files.mjs'
import { reportCommandFailure } from '../cli/command-failure.mjs'

const USAGE = `Usage: atelier capability <command> [options]

seal --package DIR                     Seal a local package, without overwriting a release.
verify --package DIR [--digest SHA]     Verify all payload bytes; no publisher authentication.
inventory --surfaces FILE              Read only the explicitly listed skill surfaces.
plan --adoption FILE [--source DIR ...] [--tool ID ...] [--notices FILE]
apply --adoption FILE [--source DIR ...] [--tool ID ...] [--notices FILE] --confirm PLAN_DIGEST
status [--session ID]                  Separate installation and caller-reported host evidence.
observe --event FILE                   Record a content-free, version-bound evidence reference.
candidates                            Propose cause-specific review from repeated evidence.
recover [--confirm PLAN_DIGEST]        Preview recovery; exact confirmation restores prior state.
fleet --repo DIR [--repo DIR ...]       Inspect explicitly selected repositories independently.
graph --namespace ID [--audience private|team|public]
                                      Emit draft graph source documents as JSON for review.
profiles                              Show repository host projection profiles and their limits.

All output is JSON. --workspace DIR defaults to the current repository.
No command downloads packages, executes their scripts, probes a host, or grants tool authority.
The --tool values are caller observations of available tools, not permission grants.
Exit codes: 0 success, 1 refusal or blocked plan, 2 usage error.`

const COMMANDS = {
  seal: ['package'], verify: ['package', 'digest'], inventory: ['surfaces'],
  plan: ['adoption', 'source', 'tool', 'notices'], apply: ['adoption', 'source', 'tool', 'notices', 'confirm'],
  status: ['session'], observe: ['event'], candidates: [], recover: ['confirm'],
  fleet: ['repo'], graph: ['namespace', 'audience'], profiles: [],
}
const argv = process.argv.slice(2), command = argv.shift()
if (['--help', '-h', 'help'].includes(command) || argv.includes('--help')) { console.log(USAGE); process.exit(0) }
function usage(message) { console.error(`${message}\n\n${USAGE}`); process.exit(2) }
if (!Object.hasOwn(COMMANDS, command ?? '')) usage('unknown capability command')
const options = {}, repeated = new Set(['source', 'tool', 'repo'])
for (let index = 0; index < argv.length; index += 1) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index])
  if (!match || ![...COMMANDS[command], 'workspace', 'json'].includes(match[1])) usage('unknown capability option')
  const key = match[1]
  if (key === 'json') { if (match[2] !== undefined) usage('--json does not take a value'); continue }
  const value = match[2] ?? argv[++index]
  if (!value || value.startsWith('--')) usage('option requires a value')
  if (repeated.has(key)) (options[key] ??= []).push(value)
  else { if (options[key] !== undefined) usage('duplicate option'); options[key] = value }
}
function required(name) { if (!options[name]) usage(`--${name} is required`); return options[name] }
function read(file) { const absolute = path.resolve(file); return jsonAt(fs.realpathSync(path.dirname(absolute)), path.basename(absolute)) }
const common = { workspaceRoot: options.workspace ?? process.cwd() }
try {
  let result
  if (command === 'seal') result = capability.sealCapabilityRelease({ packageRoot: required('package') })
  if (command === 'verify') result = capability.verifyCapabilityRelease({ packageRoot: required('package'), expectedDigest: options.digest })
  if (command === 'inventory') result = capability.inventorySkillSurfaces({ surfaces: read(required('surfaces')) })
  if (['plan', 'apply'].includes(command)) {
    const settings = { ...common, adoption: read(required('adoption')), sources: options.source ?? [], availableTools: options.tool ?? [], notices: options.notices ? read(options.notices) : [] }
    result = command === 'plan' ? capability.planCapabilityAdoption(settings) : capability.applyCapabilityAdoption({ ...settings, confirm: required('confirm') })
    if (result.applyAllowed === false) process.exitCode = 1
  }
  if (command === 'status') result = capability.capabilityEvidenceStatus({ ...common, session: options.session ?? null })
  if (command === 'observe') result = capability.recordCapabilityEvent({ ...common, event: read(required('event')) })
  if (command === 'candidates') result = capability.capabilityImprovementCandidates(common)
  if (command === 'recover') result = options.confirm ? capability.recoverCapabilityAdoption({ ...common, confirm: options.confirm }) : capability.inspectCapabilityRecovery(common)
  if (command === 'fleet') result = capability.inspectCapabilityFleet({ workspaces: required('repo') })
  if (command === 'graph') result = capability.capabilityGraphSources({ ...common, namespace: required('namespace'), audience: options.audience ?? 'private' })
  if (command === 'profiles') result = capability.HOST_PROFILES
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  reportCommandFailure(error, 'stdout')
}
