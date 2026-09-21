#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as inquiry from '../inquiry/index.mjs'
import { jsonAt } from '../capabilities/files.mjs'

const USAGE = `Usage: atelier inquiry <command> [options]
validate --record FILE                 Validate a single record's shape only.
inspect --history FILE                 Replay an exported ledger, checking all references.
append --record FILE --confirm DIGEST  Append to ignored repository campaign history.
status --campaign ID                   Show assessments and reconsideration needs.
handoff --campaign ID --request ID     Emit a portable research request and full prompt.
graph --campaign ID --namespace ID     Emit draft sources and relation proposals as JSON.
feedback --campaign ID --record ID     Prepare a version-bound Skill Steward observation.
export --campaign ID                   Export the complete local ledger, including captures.
example                               Print synthetic records for a complete local journey.
lenses                                List optional conceptual inquiry methods.

--workspace DIR defaults to the current repository. Output is JSON.
The initial history digest is ${inquiry.EMPTY_INQUIRY_HEAD}.
Append requires a Git root with ignored .atelier-local/ state on POSIX.
Output may contain private source content; choose its destination deliberately.
No command runs research providers, grants authority, or promotes graph changes.
Exit codes: 0 success, 1 refusal, 2 usage error.`
const commands = { validate: ['record'], inspect: ['history'], append: ['record', 'confirm'], status: ['campaign'], handoff: ['campaign', 'request'], graph: ['campaign', 'namespace'], feedback: ['campaign', 'record'], export: ['campaign'], example: [], lenses: [] }
const argv = process.argv.slice(2), command = argv.shift(), options = {}
function usage(message) { console.error(`${message}\n\n${USAGE}`); process.exit(2) }
if (['help', '--help', '-h'].includes(command) || argv.includes('--help')) { console.log(USAGE); process.exit(0) }
if (!Object.hasOwn(commands, command ?? '')) usage('unknown inquiry command')
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].startsWith('--') ? argv[i].slice(2) : ''
  if (![...commands[command], 'workspace'].includes(key) || Object.hasOwn(options, key)) usage('unknown or duplicate inquiry option')
  const value = argv[++i]
  if (!value || value.startsWith('--')) usage('inquiry option requires a value')
  options[key] = value
}
const requireOption = key => { if (!options[key]) usage(`--${key} is required`); return options[key] }
const read = file => { const p = path.resolve(file); return jsonAt(fs.realpathSync(path.dirname(p)), path.basename(p)) }
try {
  let result
  const workspaceRoot = options.workspace ?? process.cwd()
  if (command === 'validate') { const errors = inquiry.validateInquiryDocument(read(requireOption('record'))); result = { valid: errors.length === 0, errors, assurance: 'shape-only' }; if (errors.length) process.exitCode = 1 }
  else if (command === 'inspect') {
    const ledger = read(requireOption('history'))
    const errors = inquiry.validateInquiryDocument(ledger, 'ledger')
    if (errors.length) throw new Error('invalid inquiry ledger')
    result = inquiry.inspectInquiry(ledger.records)
    if (result.head !== ledger.head) throw new Error('inquiry history digest mismatch')
  }
  else if (command === 'append') result = inquiry.appendInquiry({ workspaceRoot, record: read(requireOption('record')), confirm: requireOption('confirm') })
  else if (command === 'example') result = JSON.parse(fs.readFileSync(new URL('../../fixtures/inquiry/workshop.json', import.meta.url), 'utf8'))
  else if (command === 'lenses') result = inquiry.INQUIRY_LENSES
  else {
    const state = inquiry.readInquiry({ workspaceRoot, campaign: requireOption('campaign') })
    if (command === 'status') result = state
    if (command === 'handoff') result = inquiry.researchHandoff(state.records, requireOption('request'))
    if (command === 'graph') result = inquiry.inquiryGraphProposal(state.records, { namespace: requireOption('namespace') })
    if (command === 'feedback') result = inquiry.inquiryStewardObservation(state.records, requireOption('record'))
    if (command === 'export') {
      if (!state.campaign) throw new Error('inquiry campaign does not exist')
      result = { schema: 'atelier-inquiry-ledger@v1', records: state.records, head: state.head }
    }
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 }
