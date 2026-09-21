#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as harness from '../harnesses/index.mjs'
import { knowledgeGraphProposal, prepareIntakeContribution, prepareKnowledgeImport } from '../knowledge/index.mjs'
import { prepareGitCandidate } from '../build/git.mjs'
import { jsonAt } from '../capabilities/files.mjs'
const HELP = `Usage: atelier harness <command> [options]
knowledge|build append --record FILE --confirm DIGEST [--workspace DIR]
knowledge|build status|export --run ID [--workspace DIR]
knowledge graph --run ID --activation ID --namespace ID [--dependencies FILE] [--workspace DIR]
knowledge reconcile --run ID [--dependencies FILE] [--workspace DIR]
knowledge intake --run ID --attempt ID --title TEXT --term ID [--workspace DIR]
knowledge import --run ID --handoff FILE --history FILE --title TEXT --term ID [--dependencies FILE] [--workspace DIR]
build readiness|coordination --run ID [--dependencies FILE] [--workspace DIR]
build candidate --run ID --artifact FILE --writer FILE [--workspace DIR]
inspect --profile knowledge|build|inquiry --history FILE
validate --profile knowledge|build --record FILE
handoff --profile PROFILE --history FILE --repository ID --subject ID --target-repository ID --target-profile PROFILE --purpose TEXT [--dependencies FILE]
verify --handoff FILE --history FILE [--dependencies FILE]
feedback --profile knowledge|build --history FILE --event FILE
example

History files are complete ledgers; dependencies are explicit repository/profile/records snapshots.
The initial history digest is ${harness.EMPTY_HARNESS_HEAD}.
All output is JSON. Proposals and reported acceptance never authorize execution.
The existing atelier build command remains the workspace projection command.`
const args = process.argv.slice(2), first = args.shift(), profile = ['knowledge', 'build'].includes(first) ? first : null
const command = profile ? args.shift() : first, options = {}
if (['help', '--help', '-h'].includes(first) || args.includes('--help')) { console.log(HELP); process.exit(0) }
const common = { inspect: ['profile', 'history'], validate: ['profile', 'record'], handoff: ['profile', 'history', 'repository', 'subject', 'target-repository', 'target-profile', 'purpose', 'dependencies'], verify: ['handoff', 'history', 'dependencies'], feedback: ['profile', 'history', 'event'], example: [] }
const domain = { append: ['record', 'confirm'], status: ['run'], export: ['run'], graph: ['run', 'activation', 'namespace', 'dependencies'], reconcile: ['run', 'dependencies'], intake: ['run', 'attempt', 'title', 'term'], import: ['run', 'handoff', 'history', 'title', 'term', 'dependencies'], readiness: ['run', 'dependencies'], coordination: ['run', 'dependencies'], candidate: ['run', 'artifact', 'writer'] }
const allowed = profile ? domain[command] : common[command]
const usage = message => { console.error(`${message}\n${HELP}`); process.exit(2) }
if (!allowed || (profile === 'knowledge' && ['readiness', 'coordination', 'candidate'].includes(command)) || (profile === 'build' && ['graph', 'intake', 'import', 'reconcile'].includes(command))) usage('unknown harness command')
for (let i = 0; i < args.length; i++) {
  const key = args[i].startsWith('--') ? args[i].slice(2) : ''
  if (![...allowed, ...(profile ? ['workspace'] : [])].includes(key) || Object.hasOwn(options, key)) usage('unknown or duplicate option')
  const value = args[++i]; if (!value || value.startsWith('--')) usage('option requires a value'); options[key] = value
}
const need = key => { if (!options[key]) usage(`--${key} required`); return options[key] }
const read = file => { const p = path.resolve(file); return jsonAt(fs.realpathSync(path.dirname(p)), path.basename(p)) }
function history(file, selected) {
  const ledger = read(file), p = selected ?? ledger.profile ?? (ledger.schema === 'atelier-inquiry-ledger@v1' ? 'inquiry' : null)
  if (p === 'inquiry') {
    if (ledger.schema !== 'atelier-inquiry-ledger@v1') throw new Error('invalid inquiry ledger')
  } else if (harness.validateHarnessDocument(ledger, p, 'ledger').length) throw new Error('invalid harness ledger')
  const state = harness.inspectHarness(p, ledger.records)
  if (state.head !== ledger.head) throw new Error('history digest mismatch')
  return state.records
}
try {
  let result
  const dependencySnapshots = options.dependencies ? read(options.dependencies) : []
  const workspaceRoot = options.workspace ?? process.cwd()
  if (profile) {
    if (command === 'append') result = harness.appendHarness({ workspaceRoot, profile, record: read(need('record')), confirm: need('confirm') })
    else {
      const state = harness.readHarness({ workspaceRoot, profile, run: need('run') })
      if (command !== 'status' && !state.establishment) throw new Error('harness run missing')
      if (command === 'status') result = state
      if (command === 'export') result = { schema: 'atelier-harness-ledger@v1', profile, records: state.records, head: state.head }
      if (command === 'graph') result = knowledgeGraphProposal(state.records, { namespace: need('namespace'), activationId: need('activation'), dependencySnapshots })
      if (command === 'reconcile') result = harness.reconcileKnowledge(state.records, { dependencySnapshots })
      if (command === 'intake') result = prepareIntakeContribution({ workspaceRoot, records: state.records, attemptId: need('attempt'), title: need('title'), term: need('term') })
      if (command === 'import') result = prepareKnowledgeImport({ records: state.records, handoff: read(need('handoff')), sourceRecords: history(need('history')), title: need('title'), term: need('term'), dependencySnapshots })
      if (command === 'readiness') result = harness.buildReadiness(state.records, { dependencySnapshots })
      if (command === 'coordination') result = harness.buildCoordinationProposal(state.records, { dependencySnapshots })
      if (command === 'candidate') result = prepareGitCandidate({ workspaceRoot, records: state.records, artifact: need('artifact'), writer: read(need('writer')) })
    }
  } else if (command === 'example') result = read(new URL('../../fixtures/harnesses/learning-cycle.json', import.meta.url).pathname)
  else if (command === 'validate') { const errors = harness.validateHarnessDocument(read(need('record')), need('profile')); result = { valid: !errors.length, errors, assurance: 'shape-only' }; if (errors.length) process.exitCode = 1 }
  else if (command === 'inspect') result = harness.inspectHarness(need('profile'), history(need('history'), options.profile))
  else if (command === 'handoff') result = harness.createHarnessHandoff({ profile: need('profile'), repository: need('repository'), records: history(need('history'), options.profile), subjectId: need('subject'), target: { repository: need('target-repository'), profile: need('target-profile'), purpose: need('purpose') }, dependencySnapshots })
  else if (command === 'verify') { const handoff = read(need('handoff')); result = harness.verifyHarnessHandoff({ handoff, records: history(need('history'), handoff.source.profile), dependencySnapshots }) }
  else if (command === 'feedback') result = harness.prepareHarnessFeedback({ ...read(need('event')), profile: need('profile'), records: history(need('history'), options.profile) })
  console.log(JSON.stringify(result, null, 2))
} catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 }
