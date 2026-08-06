#!/usr/bin/env node
// atelier feedback create|check
//
// Assembles a LOCAL feedback report on the support-bundle chassis. The kit
// has no send path — that absence is the consent design: the report is
// written to ignored local state, the user inspects it, and transmitting it
// anywhere is always the user's own explicit act.
//
// The payload is the user's own words plus a deliberately tiny environment
// block (package name and version, Node.js version, and — only when
// --include-gates is passed — local gate names with pass or fail status).
// Before anything is written the whole report is walked with the banned key
// and value patterns imported from the support-bundle chassis; any match
// refuses the write. Log-safety contract: refusals name the pattern label
// and the report location only, never the matched text.
//
// That scan is a backstop, not clearance to share: it matches known patterns
// only, so the success path says so plainly and asks the user to read the
// file. File inputs are bounded before they are embedded — at most
// MAX_INPUT_FILE_BYTES, valid UTF-8 only — so an accidental `--context` of an
// archive, dump, or key file is refused rather than copied into the report.
//
// Exit codes: 0 report written (or check clean), 1 the scan matched
// (nothing written) or a checked report failed the scan, 2 usage or input
// error (including an oversized or non-UTF-8 input file).

import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLocalState, LOCAL_STATE_DIR } from '../project/config.mjs'
import { BANNED_KEY_PATTERNS, BANNED_VALUE_PATTERNS } from './support-bundle.mjs'

export const FEEDBACK_REPORT_SCHEMA = 'mnstry.atelier-feedback@v1'

// An attached file is an excerpt a human will read, not an archive. The cap
// bounds what can be embedded and what the scan has to walk, and it makes the
// accidental `--context` of a database dump, core file, or whole log a refusal
// instead of a silent copy into the report.
export const MAX_INPUT_FILE_BYTES = 256 * 1024

// Gate names use dashes rather than the npm-script colon form on purpose:
// a colon-joined identifier is exactly the shape the chassis kg-node-id
// banned-value pattern refuses, and the report must pass its own scan.
export const LOCAL_GATES = [
  { name: 'contract', entry: 'src/check-atelier-export-contract.mjs', args: [] },
  { name: 'egress-check', entry: 'bin/atelier.mjs', args: ['egress', 'check'] },
  { name: 'repo-check', entry: 'scripts/check-repo-disclosure.mjs', args: [] },
  { name: 'migrations-check', entry: 'scripts/check-breaking-migrations.mjs', args: [] },
  { name: 'contract-compat', entry: 'scripts/check-contract-compat.mjs', args: [] },
]

const USAGE = `Usage: atelier feedback <subcommand>

Subcommands:
  create --message TEXT | --message-file PATH [--context FILE] [--include-gates]
      Assemble a local feedback report from your own words and write it to
      ${LOCAL_STATE_DIR}/feedback/<hash>.json (mode 0600). This is the
      default subcommand. The report is first walked with the support-bundle
      banned key and value patterns; if anything matches, nothing is written
      and the refusal names the pattern label and location only.

      --message TEXT       the feedback message itself
      --message-file PATH  read the feedback message from a file
      --context FILE       attach one user-chosen file (scanned like the rest)
      --include-gates      record local gate names with pass or fail status

      Files read by --message-file and --context must be valid UTF-8 text of
      at most ${MAX_INPUT_FILE_BYTES} bytes; anything larger or binary is
      refused rather than embedded.

  check FILE
      Re-run the banned key and value scan over an existing feedback report.

Beyond your own words the report records only the package name and version
and the Node.js version, plus local gate names with pass or fail status when
--include-gates is passed. Nothing is ever sent: this kit has no send path,
so sharing the file is always your own explicit act.

The scan is a backstop against an obvious mistake, not a guarantee: it matches
known patterns only. Read the report yourself before you share it anywhere.

Exit codes: 0 report written or check clean, 1 the scan matched (nothing
written), 2 usage or input error.`

class UsageError extends Error {}

export function resolvePackageRoot() {
  return process.env.MNSTRY_ATELIER_PACKAGE_ROOT || fileURLToPath(new URL('../..', import.meta.url))
}

// Same stable-serialization shape as the chassis hashPayload (which is not
// exported); sorted keys keep the report hash independent of assembly order.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

export function feedbackReportHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex')
}

// Same walk shape as the chassis validator; the pattern lists themselves are
// imported from the chassis, never copied. Findings carry the pattern label
// and dotted location only — never the matched text.
export function scanFeedbackReport(payload) {
  const findings = []
  const visit = (value, parts) => {
    const key = parts.at(-1) || ''
    const location = parts.join('.') || '<root>'
    if (key && BANNED_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      findings.push(`banned key at ${location}`)
    }
    if (typeof value === 'string') {
      for (const { type, re } of BANNED_VALUE_PATTERNS) {
        if (re.test(value)) findings.push(`banned value (${type}) at ${location}`)
      }
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...parts, String(index)]))
    } else if (value && typeof value === 'object') {
      for (const [childKey, item] of Object.entries(value)) visit(item, [...parts, childKey])
    }
  }
  visit(payload, [])
  return findings
}

function runLocalGate(gate, packageRoot) {
  const entry = path.join(packageRoot, gate.entry)
  if (!fs.existsSync(entry)) return { name: gate.name, status: 'unavailable' }
  // Gate output is discarded on purpose: the report carries names and pass
  // or fail status only, never gate output.
  const result = spawnSync(process.execPath, [entry, ...gate.args], {
    cwd: packageRoot,
    stdio: 'ignore',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: packageRoot },
  })
  return { name: gate.name, status: result.status === 0 ? 'pass' : 'fail' }
}

export function collectEnvironment({ includeGates = false, packageRoot = resolvePackageRoot() } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const environment = {
    packageName: String(pkg.name || 'unknown'),
    packageVersion: String(pkg.version || 'unknown'),
    nodeVersion: process.version,
  }
  if (includeGates) {
    environment.gates = LOCAL_GATES.map((gate) => runLocalGate(gate, packageRoot))
  }
  return environment
}

export function buildFeedbackReport({
  message,
  context = null,
  environment = null,
  // Deterministic on purpose, matching the chassis: wall-clock timestamps
  // are machine metadata the report does not need to carry.
  createdAt = new Date(0).toISOString(),
} = {}) {
  const payload = { schema: FEEDBACK_REPORT_SCHEMA, createdAt, message }
  if (context) payload.context = context
  if (environment) payload.environment = environment
  return payload
}

export function writeFeedbackReport(payload, { baseDir = process.cwd() } = {}) {
  const relative = path.join(LOCAL_STATE_DIR, 'feedback', `${feedbackReportHash(payload)}.json`)
  const file = path.join(baseDir, relative)
  // "Local state" is only local if the directory it lands in is ignored, and
  // feedback writes wherever the user happens to stand rather than in a
  // configured workspace. Same git check-ignore test the project chassis runs
  // (ensureLocalState), warned about here because this caller has no config to
  // have run it. Warnings name the directory only, never the machine path.
  const localState = ensureLocalState({ configDir: baseDir })
  for (const warning of localState.warnings) console.error(`[atelier-feedback] warning: ${warning}`)
  if (!localState.ignored) {
    console.error(
      '[atelier-feedback] warning: the report is landing inside a checkout that would track it, so a later commit could publish your own words and any attached context',
    )
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  // The mode option only applies on creation; re-writing the same report
  // must still leave the file user read/write only.
  fs.chmodSync(file, 0o600)
  return relative
}

// Reads user-chosen input as text, with two refusals rather than a best-effort
// embed: anything over the cap, and anything that is not valid UTF-8. Binary
// input has no business in a report a human is expected to read before sharing,
// and a lossy decode would put replacement characters (and whatever survived
// the decode) into the payload while the scan patterns, all text-shaped, walk
// straight past the bytes that matter.
function readTextFile(label, file) {
  // Character devices and FIFOs never return from readFileSync, so the
  // post-read cap below can never fire for them: refuse anything that is not
  // a regular file, and refuse an oversized one before reading it. The
  // post-read check stays — it is what makes the size bound race-free.
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new UsageError(`could not read ${label}: ${file}`)
  }
  if (!stat.isFile()) {
    throw new UsageError(`${label} is not a regular file, so nothing was embedded: ${file}`)
  }
  if (stat.size > MAX_INPUT_FILE_BYTES) {
    throw new UsageError(
      `${label} is ${stat.size} bytes and the limit is ${MAX_INPUT_FILE_BYTES} bytes (${MAX_INPUT_FILE_BYTES / 1024} KiB); nothing was embedded. Attach a trimmed excerpt instead: ${file}`,
    )
  }
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch {
    // The path is echoed exactly as the user typed it — their own input,
    // never a resolved machine-local path.
    throw new UsageError(`could not read ${label}: ${file}`)
  }
  if (buffer.byteLength > MAX_INPUT_FILE_BYTES) {
    throw new UsageError(
      `${label} is ${buffer.byteLength} bytes and the limit is ${MAX_INPUT_FILE_BYTES} bytes (${MAX_INPUT_FILE_BYTES / 1024} KiB); nothing was embedded. Attach a trimmed excerpt instead: ${file}`,
    )
  }
  if (buffer.includes(0)) {
    throw new UsageError(`${label} contains NUL bytes, so it is not UTF-8 text; nothing was embedded: ${file}`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new UsageError(`${label} is not valid UTF-8 text; nothing was embedded: ${file}`)
  }
}

const CREATE_OPTION_SPEC = { message: 'value', 'message-file': 'value', context: 'value', 'include-gates': 'flag' }
const CREATE_OPTION_KEYS = { message: 'message', 'message-file': 'messageFile', context: 'context' }

function parseCreateOptions(argv) {
  const options = { message: null, messageFile: null, context: null, includeGates: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      return options
    }
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const kind = CREATE_OPTION_SPEC[name]
    if (!kind) throw new UsageError(`unknown option --${name}`)
    if (kind === 'flag') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`)
      options.includeGates = true
      continue
    }
    let value
    if (eq !== -1) {
      value = arg.slice(eq + 1)
    } else {
      i += 1
      value = argv[i]
      if (value === undefined) throw new UsageError(`--${name} requires a value`)
    }
    options[CREATE_OPTION_KEYS[name]] = value
  }
  return options
}

function shareHint(packageRoot = resolvePackageRoot()) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url
    if (bugs) return ` (the package.json bugs field points at ${bugs})`
  } catch {
    // Fall through to the generic hint.
  }
  return " (see the bugs field in this package's package.json)"
}

function runCreate(argv) {
  const options = parseCreateOptions(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if ((options.message === null) === (options.messageFile === null)) {
    throw new UsageError('create requires exactly one of --message or --message-file')
  }
  const message = options.message ?? readTextFile('--message-file', options.messageFile)
  if (!message.trim()) throw new UsageError('the feedback message must not be empty')
  // --message arrives through argv rather than a file, so the file reader's
  // bound never saw it; the same payload reaches the same scan either way.
  if (Buffer.byteLength(message, 'utf8') > MAX_INPUT_FILE_BYTES) {
    throw new UsageError(
      `--message is longer than the ${MAX_INPUT_FILE_BYTES} byte limit (${MAX_INPUT_FILE_BYTES / 1024} KiB); nothing was written. Use --message-file with a trimmed excerpt instead.`,
    )
  }
  const context = options.context === null
    ? null
    : { name: path.basename(options.context), text: readTextFile('--context', options.context) }
  const environment = collectEnvironment({ includeGates: options.includeGates })
  const payload = buildFeedbackReport({ message, context, environment })
  const findings = scanFeedbackReport(payload)
  if (findings.length) {
    console.error('[atelier-feedback] refusing to write: the report matched local disclosure patterns')
    for (const finding of findings) console.error(`[atelier-feedback] ${finding}`)
    console.error('[atelier-feedback] nothing was written; edit the flagged part and retry')
    return 1
  }
  const relative = writeFeedbackReport(payload)
  console.log(`wrote ${relative}`)
  console.log('This report stayed on this machine. Nothing was sent anywhere; this kit has no send path.')
  // Deliberately not a clearance: a clean scan means no known pattern matched,
  // which is a backstop against an obvious mistake and nothing more. Whether
  // the contents are safe to publish is a judgement only the person who wrote
  // them can make, on the actual file.
  console.log('The scan that just passed is a backstop, not a guarantee: it matches known patterns only, so a clean run does not mean the file is safe to publish.')
  console.log(`Read the whole file yourself before you share it. Attaching it to the project issue tracker publishes it${shareHint()}.`)
  return 0
}

function runCheck(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE)
    return 0
  }
  const file = argv[0]
  if (!file || file.startsWith('--')) throw new UsageError('check requires a report file path')
  if (argv.length > 1) throw new UsageError(`unexpected argument: ${argv[1]}`)
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new UsageError(`could not read a JSON report at ${file}`)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schema !== FEEDBACK_REPORT_SCHEMA) {
    throw new UsageError(`not a feedback report (expected schema ${FEEDBACK_REPORT_SCHEMA})`)
  }
  const findings = scanFeedbackReport(payload)
  if (findings.length) {
    for (const finding of findings) console.error(`[atelier-feedback] ${finding}`)
    return 1
  }
  console.log(`${file} ok: no banned key or value patterns matched`)
  return 0
}

export function runFeedbackCommand(argv = process.argv.slice(2)) {
  try {
    const first = argv[0]
    if (first === '--help' || first === '-h' || first === 'help') {
      console.log(USAGE)
      return 0
    }
    if (first === 'create') return runCreate(argv.slice(1))
    if (first === 'check') return runCheck(argv.slice(1))
    if (first === undefined || first.startsWith('--')) return runCreate(argv)
    throw new UsageError(`unknown feedback subcommand: ${first}`)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[atelier-feedback] ${error.message}`)
      console.error('')
      console.error(USAGE)
      return 2
    }
    console.error(`[atelier-feedback] ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = runFeedbackCommand()
}
