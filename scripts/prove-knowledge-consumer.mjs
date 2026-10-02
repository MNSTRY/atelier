// Installed-package proof of the knowledge workspace, through its supported CLI only.
//
// Installs an exact packed tarball into a clean temporary consumer with no publisher
// overrides, creates the canonical starter, and checks the documented CLI paths:
// context for an answerable question selects its caveat source, an unsupported
// question abstains, evaluation runs, a recorded answer is saved as a private draft
// and read back from a new process, a retried start returns the same session, and
// an owner correction is reported. The workspace is invented; no person's data or
// provider is used. A passing run shows that these paths work for this tarball
// only, not answer quality, cost, or anyone's acceptance.
//
// The install and every CLI step run offline: npm resolves the package's locked
// dependency closure from the local npm cache with --offline. A cold cache refuses
// before anything is installed. Set ATELIER_KNOWLEDGE_CONSUMER_BOOTSTRAP=1 to allow
// one declared step that first fetches the locked closure from the registry; the
// receipt records whether it ran. The installed CLI runs through the current Node
// (process.execPath) on every platform, with its own empty home and configuration
// folders. The tarball's bytes are read once: the hashed bytes are the installed
// bytes. The receipt lists the installed dependency tree (name@version) and any
// problems npm ls reports, and every entry must lie within the locked closure. Any earlier receipt is removed before the inputs are checked. Refusals
// before the temporary consumer exists (missing tarball, digest mismatch, lockfile,
// bootstrap or cache failures) exit non-zero and leave no receipt; after that, a
// failed step or an unexpected stop writes passed: false. Failure text in the
// receipt replaces known local roots with placeholders.
//
//   ATELIER_CANDIDATE_TARBALL=<file.tgz> [ATELIER_EXPECTED_TARBALL_SHA256=<hex>]
//   [ATELIER_KNOWLEDGE_CONSUMER_BOOTSTRAP=1] [ATELIER_KNOWLEDGE_CONSUMER_OUTPUT=<dir>]
//   node scripts/prove-knowledge-consumer.mjs
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execNpmSync } from './npm-cli.mjs'

const STEP_TIMEOUT_MS = 120000
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const output = path.resolve(process.env.ATELIER_KNOWLEDGE_CONSUMER_OUTPUT || path.join(packageRoot, '.artifacts/knowledge-consumer'))
const receiptFile = path.join(output, 'receipt.json')
fs.mkdirSync(output, { recursive: true })
// A receipt from an earlier run must never survive to describe this one, including
// a run refused below for a missing tarball, a digest mismatch or a cold cache.
fs.rmSync(receiptFile, { force: true })
const tarball = process.env.ATELIER_CANDIDATE_TARBALL ? path.resolve(process.env.ATELIER_CANDIDATE_TARBALL) : null
if (!tarball || !fs.existsSync(tarball)) {
  console.error('prove-knowledge-consumer: set ATELIER_CANDIDATE_TARBALL to an existing packed tarball')
  process.exit(2)
}
// Read once: these exact bytes are hashed, copied into the consumer and installed.
const tarballBytes = fs.readFileSync(tarball)
const tarballSha256 = createHash('sha256').update(tarballBytes).digest('hex')
if (process.env.ATELIER_EXPECTED_TARBALL_SHA256 && process.env.ATELIER_EXPECTED_TARBALL_SHA256 !== tarballSha256) {
  console.error(`prove-knowledge-consumer: tarball SHA-256 mismatch: expected ${process.env.ATELIER_EXPECTED_TARBALL_SHA256}, got ${tarballSha256}`)
  process.exit(2)
}
// The package's non-dev dependency closure, from the lockfile.
const lockfile = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-lock.json'), 'utf8'))
const closure = Object.entries(lockfile.packages ?? {})
  .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && entry.version)
  .map(([key, entry]) => `${key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`)
// Optional, declared network step: fetch the locked closure into the cache.
const bootstrap = process.env.ATELIER_KNOWLEDGE_CONSUMER_BOOTSTRAP === '1'
const npmOptions = { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: STEP_TIMEOUT_MS }
if (bootstrap && closure.length > 0) execNpmSync(['cache', 'add', ...closure], npmOptions)
// From here on nothing reaches the network: the closure must already be cached.
if (closure.length > 0) {
  try {
    // An explicit log level keeps npm's ENOTCACHED visible under a silenced caller.
    execNpmSync(['cache', 'add', '--offline', '--loglevel=error', ...closure], npmOptions)
  } catch (error) {
    // Only npm's ENOTCACHED is a cold cache; anything else is reported as itself.
    if (/ENOTCACHED/.test(String(error?.stderr ?? ''))) console.error('prove-knowledge-consumer: the locked dependency closure is not in the npm cache; set ATELIER_KNOWLEDGE_CONSUMER_BOOTSTRAP=1 for one declared registry fetch')
    else console.error(`prove-knowledge-consumer: the offline npm cache check failed (not a cold cache): ${error?.code ?? error?.status ?? 'unknown'}`)
    process.exit(2)
  }
}

const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-knowledge-consumer-'))
const app = path.join(temp, 'app')
const ws = path.join(temp, 'workspace')
const emptyGitConfig = path.join(temp, 'gitconfig')
const home = path.join(temp, 'home')
const xdgConfig = path.join(temp, 'xdg-config')
// The consumer's Git identity is invented and no inherited GIT_* variable can
// retarget its repository. The proof's own Git steps read neither global nor system
// configuration. The installed CLI removes GIT_* from its own Git calls, which also
// drops GIT_CONFIG_NOSYSTEM: those calls get an empty global configuration (the
// home and XDG folders below are empty temporary folders) but may still read the
// host's system Git configuration.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdgConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_AUTHOR_NAME: 'Consumer Proof',
  GIT_AUTHOR_EMAIL: 'consumer-proof@example.invalid',
  GIT_COMMITTER_NAME: 'Consumer Proof',
  GIT_COMMITTER_EMAIL: 'consumer-proof@example.invalid',
}
// Failure text can name local locations; the receipt names placeholders instead.
const locations = [[temp, '<temp>'], [path.dirname(tarball), '<tarball-dir>'], [packageRoot.replace(/[\\/]$/, ''), '<package-root>'], [fs.realpathSync(os.tmpdir()), '<tmp>'], [os.tmpdir(), '<tmp>'], [os.homedir(), '<home>']]
  .filter(([location]) => location && location.length > 1)
  .sort(([a], [b]) => b.length - a.length)
const redact = (text) => locations.reduce((value, [location, label]) => value.split(location).join(label), String(text))
const steps = []
let unexpected = null
let installedVersion = null
let installedClosure = null
const record = (step) => { steps.push(step); return step }
const run = (label, command, args, { cwd = ws, input, expect = 0 } = {}) => {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
  // Absolute paths are shortened to their base names so the receipt names no temporary location.
  const shown = [command, ...args].map((arg) => (path.isAbsolute(String(arg)) ? path.basename(String(arg)) : arg))
  const step = record({ label, command: shown.join(' '), exit: result.status, expectedExit: expect, ok: result.status === expect })
  if (!step.ok) step.stderr = redact(result.stderr || result.error?.message || '').slice(0, 2000)
  return { ...result, stdout: result.stdout ?? '' }
}
const parse = (result) => { try { return JSON.parse(result.stdout) } catch { return null } }
const check = (label, condition, detail = null) => record({ label, check: true, ok: Boolean(condition), detail })

try {
  fs.writeFileSync(emptyGitConfig, '')
  fs.mkdirSync(home)
  fs.mkdirSync(xdgConfig)
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify({ name: 'atelier-knowledge-consumer', private: true, type: 'module' }, null, 2)}\n`)
  const candidate = path.join(temp, 'candidate.tgz')
  fs.writeFileSync(candidate, tarballBytes)
  check('the installed bytes are the hashed tarball', createHash('sha256').update(fs.readFileSync(candidate)).digest('hex') === tarballSha256)
  execNpmSync(['install', candidate, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { ...npmOptions, cwd: app })
  // Record what npm actually resolved and require it to lie within the locked closure.
  let tree
  try { tree = JSON.parse(execNpmSync(['ls', '--all', '--json', '--offline'], { ...npmOptions, cwd: app, encoding: 'utf8' })) }
  catch (error) { tree = JSON.parse(String(error?.stdout || '{}')) }
  const resolved = new Set()
  const walk = (dependencies = {}) => { for (const [name, node] of Object.entries(dependencies)) { if (node?.version) resolved.add(`${name}@${node.version}`); walk(node?.dependencies) } }
  walk(tree?.dependencies?.['@mnstry/atelier']?.dependencies)
  const locked = new Set(closure)
  installedClosure = { resolved: [...resolved].sort(), outsideLock: [...resolved].filter((spec) => !locked.has(spec)).sort(), npmProblems: Array.isArray(tree?.problems) ? tree.problems.map((problem) => redact(problem).slice(0, 500)) : [] }
  check('the installed dependency tree lies within the locked closure', resolved.size > 0 && installedClosure.outsideLock.length === 0, installedClosure)
  const installedRoot = path.join(app, 'node_modules', '@mnstry', 'atelier')
  const installed = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'))
  installedVersion = installed.version
  check('installed the packed package', installed.name === '@mnstry/atelier', installed.version)
  // Run the installed CLI entry with this Node on every platform (no .cmd shim, no PATH node).
  const bin = typeof installed.bin === 'string' ? installed.bin : installed.bin?.atelier
  const entry = path.join(installedRoot, bin)
  const atelier = (label, args, options = {}) => run(label, process.execPath, [entry, ...args], options)

  atelier('init the canonical starter', ['init', '--template', 'knowledge-workspace', '--target', ws], { cwd: temp })
  run('git init', 'git', ['init', '-q'])
  run('git add', 'git', ['add', '-A'])
  run('git commit', 'git', ['commit', '-q', '-m', 'starter'])
  check('knowledge check is structurally valid', parse(atelier('knowledge check', ['knowledge', 'check']))?.status === 'structurally-valid')
  atelier('graph', ['graph'])
  atelier('build', ['build'])

  const question = 'Can the blue telescope be loaned this week?'
  const packet = parse(atelier('context for an answerable question', ['knowledge', 'context', '--question', question]))
  const selected = (packet?.sources ?? []).map((source) => source.id)
  check('context packet is versioned', packet?.schema === 'atelier-knowledge-context@v1', packet?.schema)
  check('context for an answerable question selects its caveat source', selected.includes('loan:inspection'), selected)
  check('every source matches its digest', (packet?.sources ?? []).length > 0 && packet.sources.every((source) => createHash('sha256').update(source.text).digest('hex') === source.sha256))

  // The product's own abstention rule: no sources, no candidates and no omissions.
  const abstained = parse(atelier('context for an unsupported question', ['knowledge', 'context', '--question', 'What is the sourdough recipe for the staff picnic?']))
  check('an unsupported question abstains with no sources, candidates or omissions',
    abstained?.status === 'needs-evidence' && (abstained.sources ?? []).length === 0 && abstained.coverage?.candidates === 0 && abstained.coverage?.omitted === 0,
    { status: abstained?.status, coverage: abstained?.coverage })

  const report = parse(atelier('evaluate the pinned cases', ['knowledge', 'evaluate']))
  check('evaluation report is versioned', report?.schema === 'atelier-knowledge-evaluation@v1')

  const dashboard = parse(atelier('dashboard', ['knowledge', 'dashboard']))
  const questionId = JSON.parse(fs.readFileSync(path.join(ws, 'knowledge-plan.json'), 'utf8')).questions[0].id
  check('dashboard provides a snapshot', Boolean(dashboard?.snapshot))
  const startRequest = JSON.stringify({ requestId: randomUUID(), flow: 'apply', questionId, snapshot: dashboard?.snapshot, author: 'consumer-proof' })
  const sessionId = parse(atelier('session start', ['knowledge', 'session', 'start'], { input: startRequest }))?.record?.id
  check('a session started', Boolean(sessionId))
  check('retrying the same start returns the same session', Boolean(sessionId) && parse(atelier('session start retried', ['knowledge', 'session', 'start'], { input: startRequest }))?.record?.id === sessionId)
  const revision = parse(atelier('session read', ['knowledge', 'session', 'read'], { input: JSON.stringify({ sessionId }) }))?.state?.revision
  const answer = 'Not yet: the inspection record says it has not passed.'
  const recorded = parse(atelier('record an answer', ['knowledge', 'session', 'event'], { input: JSON.stringify({ sessionId, event: { id: randomUUID(), expectedRevision: revision, type: 'answer', text: answer } }) }))
  check('a recorded answer is an unsaved draft', recorded?.state?.phase === 'draft' && recorded.state.saved?.length === 0, recorded?.state?.phase)
  atelier('save the private draft', ['knowledge', 'session', 'event'], { input: JSON.stringify({ sessionId, event: { id: randomUUID(), expectedRevision: recorded?.state?.revision, type: 'save' } }) })
  const saved = parse(atelier('session read after saving', ['knowledge', 'session', 'read'], { input: JSON.stringify({ sessionId }) }))?.state
  check('the saved draft and its receipt read back from a new process',
    saved?.phase === 'saved' && saved.saved?.length === 1 && saved.saved[0].text === answer &&
      saved.saved[0].receipt?.sessionId === sessionId && /^[0-9a-f]{64}$/.test(saved.saved[0].receipt?.valueDigest ?? ''),
    { phase: saved?.phase, saved: saved?.saved?.length })
  check('the session is listed', atelier('session list', ['knowledge', 'session', 'list']).stdout.includes(sessionId))

  // An owner correction: the source changes and is committed, the graph is rebuilt.
  const inspection = path.join(ws, 'records', 'inspection.md')
  fs.writeFileSync(inspection, `${fs.readFileSync(inspection, 'utf8')}\nA follow-up inspection is booked for Friday.\n`)
  run('commit the owner correction', 'git', ['commit', '-q', '-am', 'owner correction'])
  atelier('graph after the correction', ['graph'])
  const stale = parse(atelier('evaluate after the correction', ['knowledge', 'evaluate'], { expect: 1 }))
  check('the corrected source is reported stale by evaluation',
    stale?.schema === 'atelier-knowledge-evaluation@v1' && (stale.cases ?? []).some((c) => (c.runs?.graph?.stale ?? []).includes('loan:inspection')))
  const reopened = parse(atelier('read the earlier session after the correction', ['knowledge', 'session', 'read'], { input: JSON.stringify({ sessionId }) }))
  check('the earlier session keeps its saved draft', reopened?.state?.saved?.[0]?.text === answer)
  check('the earlier session reports changed sources', reopened?.currency === 'changed', reopened?.currency)
  check('the corrected text is served', (parse(atelier('context after the correction', ['knowledge', 'context', '--question', question]))?.sources ?? []).some((source) => source.text.includes('booked for Friday')))
} catch (error) {
  unexpected = redact(error?.message ?? error).slice(0, 2000)
} finally {
  const receipt = {
    schema: 'atelier-knowledge-consumer-proof@v1',
    tarball: path.basename(tarball),
    tarballSha256,
    packageVersion: installedVersion,
    installedClosure,
    node: process.version,
    platform: process.platform,
    network: bootstrap ? 'bootstrap-registry-fetch-then-offline' : 'offline',
    steps,
    unexpected,
    passed: unexpected === null && steps.length > 0 && steps.every((step) => step.ok),
  }
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  fs.rmSync(temp, { recursive: true, force: true })
  for (const step of steps) if (!step.ok) console.error(`[knowledge:consumer-proof] failed: ${step.label}${step.stderr ? `: ${step.stderr.slice(0, 300)}` : ''}`)
  if (unexpected) console.error(`[knowledge:consumer-proof] stopped unexpectedly: ${unexpected}`)
  console.log(`[knowledge:consumer-proof] SHA-256 ${tarballSha256}; ${steps.filter((step) => step.ok).length}/${steps.length} steps passed; receipt ${receiptFile}`)
  process.exitCode = receipt.passed ? 0 : 1
}
