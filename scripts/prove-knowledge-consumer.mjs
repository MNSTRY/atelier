// Installed-package proof of the knowledge workspace, through its supported CLI only.
//
// Installs an exact packed tarball into a clean temporary consumer (offline, from a
// warm cache, with no publisher overrides), creates the canonical starter, and runs
// the documented path: check, graph, build, a supported answer, an honest
// abstention, evaluation, a saved session read back from a new process, retry,
// recovery, and an owner correction. The workspace is invented; no person's data,
// provider or network is used. A passing run proves software behaviour for this
// tarball only, not answer quality, cost, or anyone's acceptance.
//
//   ATELIER_CANDIDATE_TARBALL=<file.tgz> [ATELIER_EXPECTED_TARBALL_SHA256=<hex>]
//   [ATELIER_KNOWLEDGE_CONSUMER_OUTPUT=<dir>] node scripts/prove-knowledge-consumer.mjs
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execNpmSync } from './npm-cli.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const tarball = process.env.ATELIER_CANDIDATE_TARBALL ? path.resolve(process.env.ATELIER_CANDIDATE_TARBALL) : null
if (!tarball || !fs.existsSync(tarball)) {
  console.error('prove-knowledge-consumer: set ATELIER_CANDIDATE_TARBALL to an existing packed tarball')
  process.exit(2)
}
const tarballSha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')
if (process.env.ATELIER_EXPECTED_TARBALL_SHA256 && process.env.ATELIER_EXPECTED_TARBALL_SHA256 !== tarballSha256) {
  console.error(`prove-knowledge-consumer: tarball SHA-256 mismatch: expected ${process.env.ATELIER_EXPECTED_TARBALL_SHA256}, got ${tarballSha256}`)
  process.exit(2)
}
const output = path.resolve(process.env.ATELIER_KNOWLEDGE_CONSUMER_OUTPUT || path.join(packageRoot, '.artifacts/knowledge-consumer'))
fs.mkdirSync(output, { recursive: true })

const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-knowledge-consumer-'))
const app = path.join(temp, 'app')
const ws = path.join(temp, 'workspace')
fs.mkdirSync(app)
fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify({ name: 'atelier-knowledge-consumer', private: true, type: 'module' }, null, 2)}\n`)

// The consumer's Git identity is invented, and no inherited GIT_* variable can
// retarget its repository.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 'Consumer Proof',
  GIT_AUTHOR_EMAIL: 'consumer-proof@example.invalid',
  GIT_COMMITTER_NAME: 'Consumer Proof',
  GIT_COMMITTER_EMAIL: 'consumer-proof@example.invalid',
}
const steps = []
const record = (step) => { steps.push(step); return step }
const run = (label, command, args, { cwd = ws, input, expect = 0 } = {}) => {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const step = record({ label, command: [path.basename(command), ...args].join(' '), exit: result.status, expectedExit: expect, ok: result.status === expect })
  if (!step.ok) step.stderr = String(result.stderr || result.error?.message || '').slice(0, 2000)
  return result
}
const parse = (result) => { try { return JSON.parse(result.stdout) } catch { return null } }
const check = (label, condition, detail = null) => record({ label, check: true, ok: Boolean(condition), detail })

// Warm the package's non-dev dependency closure from the lockfile, then install offline.
const lockfile = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-lock.json'), 'utf8'))
const closure = Object.entries(lockfile.packages ?? {})
  .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && entry.version)
  .map(([key, entry]) => `${key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`)
if (closure.length > 0) execNpmSync(['cache', 'add', ...closure], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] })
execNpmSync(['install', tarball, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] })
const installed = JSON.parse(fs.readFileSync(path.join(app, 'node_modules/@mnstry/atelier/package.json'), 'utf8'))
check('installed the packed package', installed.name === '@mnstry/atelier', installed.version)
const atelier = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'atelier.cmd' : 'atelier')

run('init the canonical starter', atelier, ['init', '--template', 'knowledge-workspace', '--target', ws], { cwd: temp })
run('git init', 'git', ['init', '-q'])
run('git add', 'git', ['add', '-A'])
run('git commit', 'git', ['commit', '-q', '-m', 'starter'])
check('knowledge check is structurally valid', parse(run('knowledge check', atelier, ['knowledge', 'check']))?.status === 'structurally-valid')
run('graph', atelier, ['graph'])
run('build', atelier, ['build'])

const question = 'Can the blue telescope be loaned this week?'
const packet = parse(run('context for a supported question', atelier, ['knowledge', 'context', '--question', question]))
const selected = (packet?.sources ?? []).map((source) => source.id)
check('context packet is versioned', packet?.schema === 'atelier-knowledge-context@v1', packet?.schema)
check('the decisive caveat is selected', selected.includes('loan:inspection'), selected)
check('every source matches its digest', (packet?.sources ?? []).length > 0 && packet.sources.every((source) => createHash('sha256').update(source.text).digest('hex') === source.sha256))

const abstained = parse(run('context for an unsupported question', atelier, ['knowledge', 'context', '--question', 'What is the sourdough recipe for the staff picnic?']))
check('an unsupported question selects no evidence', abstained && (abstained.sources ?? []).length === 0, abstained?.status)

check('evaluation report is versioned', parse(run('evaluate the pinned cases', atelier, ['knowledge', 'evaluate']))?.schema === 'atelier-knowledge-evaluation@v1')

const dashboard = parse(run('dashboard', atelier, ['knowledge', 'dashboard']))
const questionId = JSON.parse(fs.readFileSync(path.join(ws, 'knowledge-plan.json'), 'utf8')).questions[0].id
check('dashboard provides a snapshot', Boolean(dashboard?.snapshot))
const startRequest = JSON.stringify({ requestId: randomUUID(), flow: 'apply', questionId, snapshot: dashboard?.snapshot, author: 'consumer-proof' })
const sessionId = parse(run('session start', atelier, ['knowledge', 'session', 'start'], { input: startRequest }))?.record?.id
check('a session started', Boolean(sessionId))
check('retrying the same start returns the same session', Boolean(sessionId) && parse(run('session start retried', atelier, ['knowledge', 'session', 'start'], { input: startRequest }))?.record?.id === sessionId)
const revision = parse(run('session read', atelier, ['knowledge', 'session', 'read'], { input: JSON.stringify({ sessionId }) }))?.state?.revision
const answer = 'Not yet: the inspection record says it has not passed.'
run('session answer', atelier, ['knowledge', 'session', 'event'], { input: JSON.stringify({ sessionId, event: { id: randomUUID(), expectedRevision: revision, type: 'answer', text: answer } }) })
check('the saved answer reads back from a new process', run('session read after the answer', atelier, ['knowledge', 'session', 'read'], { input: JSON.stringify({ sessionId }) }).stdout.includes(answer))
run('session recover', atelier, ['knowledge', 'session', 'recover'], { input: JSON.stringify({ sessionId }) })
check('the session is listed', run('session list', atelier, ['knowledge', 'session', 'list']).stdout.includes(sessionId))

// An owner correction: the source changes and is committed, the graph is rebuilt.
const inspection = path.join(ws, 'records', 'inspection.md')
fs.writeFileSync(inspection, `${fs.readFileSync(inspection, 'utf8')}\nA follow-up inspection is booked for Friday.\n`)
run('commit the owner correction', 'git', ['commit', '-q', '-am', 'owner correction'])
run('graph after the correction', atelier, ['graph'])
run('evaluate reports the stale pins', atelier, ['knowledge', 'evaluate'], { expect: 1 })
const reopened = parse(run('read the earlier session after the correction', atelier, ['knowledge', 'session', 'read'], { input: JSON.stringify({ sessionId }) }))
check('the earlier session keeps its answer', JSON.stringify(reopened ?? {}).includes(answer))
check('the earlier session reports changed sources', reopened?.currency === 'changed', reopened?.currency)
check('the corrected text is served', (parse(run('context after the correction', atelier, ['knowledge', 'context', '--question', question]))?.sources ?? []).some((source) => source.text.includes('booked for Friday')))

const receipt = {
  schema: 'atelier-knowledge-consumer-proof@v1',
  tarball: path.basename(tarball),
  tarballSha256,
  packageVersion: installed.version,
  node: process.version,
  platform: process.platform,
  steps,
  passed: steps.every((step) => step.ok),
}
fs.writeFileSync(path.join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
fs.rmSync(temp, { recursive: true, force: true })
for (const step of steps) if (!step.ok) console.error(`[knowledge:consumer-proof] failed: ${step.label}${step.stderr ? `: ${step.stderr.slice(0, 300)}` : ''}`)
console.log(`[knowledge:consumer-proof] SHA-256 ${tarballSha256}; ${steps.filter((step) => step.ok).length}/${steps.length} steps passed; receipt ${path.join(output, 'receipt.json')}`)
process.exit(receipt.passed ? 0 : 1)
