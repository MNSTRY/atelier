import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = path.join(ROOT, 'src', 'commands', 'feedback.mjs')
const SCHEMA = 'mnstry.atelier-feedback@v1'

// The command module is invoked directly (not through the CLI dispatcher),
// with the package-root env the dispatcher would set. cwd is a temp dir so
// the report lands in a throwaway .atelier-local/, never in the repo.
function run(args, { cwd }) {
  return spawnSync(process.execPath, [COMMAND, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT },
  })
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-feedback-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writtenReport(dir, stdout) {
  const match = stdout.match(/^wrote (\.atelier-local\/feedback\/[0-9a-f]{64}\.json)$/m)
  assert.ok(match, stdout)
  const file = path.join(dir, match[1])
  return { relative: match[1], file, payload: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

test('create writes a clean report locally, says nothing was sent, and check accepts it', (t) => {
  const dir = tempDir(t)
  const result = run(['create', '--message', 'the graph command output ordering surprised me'], { cwd: dir })
  assert.equal(result.status, 0, result.stderr)
  const { relative, file, payload } = writtenReport(dir, result.stdout)
  assert.match(result.stdout, /Nothing was sent anywhere/)
  assert.match(result.stdout, /no send path/)
  assert.match(result.stdout, /issue tracker/)
  assert.equal(payload.schema, SCHEMA)
  assert.equal(payload.createdAt, '1970-01-01T00:00:00.000Z')
  assert.equal(payload.message, 'the graph command output ordering surprised me')
  assert.equal(payload.environment.packageName, '@mnstry/atelier')
  assert.match(payload.environment.packageVersion, /^\d/)
  assert.equal(payload.environment.nodeVersion, process.version)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const check = run(['check', relative], { cwd: dir })
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /ok: no banned key or value patterns matched/)
})

test('create is the default subcommand and --message-file reads the message from a file', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'message.txt'), 'two lines of feedback\nsecond line here\n')
  const result = run(['--message-file', 'message.txt'], { cwd: dir })
  assert.equal(result.status, 0, result.stderr)
  const { payload } = writtenReport(dir, result.stdout)
  assert.equal(payload.message, 'two lines of feedback\nsecond line here\n')
})

test('create refuses a path-shaped message, names label and location only, and writes nothing', (t) => {
  const dir = tempDir(t)
  const result = run(['create', '--message', 'crash details are in /home/sample/project/notes.log today'], { cwd: dir })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /refusing to write/)
  assert.match(result.stderr, /banned value \(absolute-path\) at message/)
  assert.match(result.stderr, /nothing was written/)
  // The matched text itself never appears — labels and locations only.
  assert.ok(!result.stderr.includes('notes.log'), result.stderr)
  assert.ok(!result.stderr.includes('/home/'), result.stderr)
  assert.ok(!result.stdout.includes('wrote'), result.stdout)
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)
})

test('gates are absent unless --include-gates is passed, and nothing else is harvested', (t) => {
  const dir = tempDir(t)
  const result = run(['create', '--message', 'environment stays minimal by default'], { cwd: dir })
  assert.equal(result.status, 0, result.stderr)
  const { payload } = writtenReport(dir, result.stdout)
  assert.ok(!('gates' in payload.environment))
  assert.deepEqual(Object.keys(payload.environment).sort(), ['nodeVersion', 'packageName', 'packageVersion'])
  assert.deepEqual(Object.keys(payload).sort(), ['createdAt', 'environment', 'message', 'schema'])
})

test('--include-gates records local gate names with pass or fail status only', (t) => {
  const dir = tempDir(t)
  const result = run(['create', '--message', 'gate snapshot requested', '--include-gates'], { cwd: dir })
  assert.equal(result.status, 0, result.stderr)
  const { payload } = writtenReport(dir, result.stdout)
  const gates = payload.environment.gates
  assert.deepEqual(
    gates.map((gate) => gate.name),
    ['contract', 'egress-check', 'repo-check', 'migrations-check', 'contract-compat'],
  )
  for (const gate of gates) {
    assert.deepEqual(Object.keys(gate).sort(), ['name', 'status'])
    assert.ok(['pass', 'fail', 'unavailable'].includes(gate.status), gate.status)
  }
})

test('--context attaches a user-chosen file by basename and it is scanned like the rest', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ordering was stable across two runs')
  const clean = run(['create', '--message', 'context attached', '--context', 'notes.txt'], { cwd: dir })
  assert.equal(clean.status, 0, clean.stderr)
  const { payload } = writtenReport(dir, clean.stdout)
  assert.deepEqual(payload.context, { name: 'notes.txt', text: 'ordering was stable across two runs' })

  fs.writeFileSync(path.join(dir, 'leaky.txt'), 'reach me at person@example.com')
  const refused = run(['create', '--message', 'context attached', '--context', 'leaky.txt'], { cwd: dir })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /banned value \(email\) at context\.text/)
  assert.ok(!refused.stderr.includes('example.com'), refused.stderr)
})

test('check flags an existing report whose message carries a banned value', (t) => {
  const dir = tempDir(t)
  const doctored = {
    schema: SCHEMA,
    createdAt: '1970-01-01T00:00:00.000Z',
    message: 'see /home/sample/project/trace.txt',
  }
  fs.writeFileSync(path.join(dir, 'doctored.json'), `${JSON.stringify(doctored, null, 2)}\n`)
  const result = run(['check', 'doctored.json'], { cwd: dir })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /banned value \(absolute-path\) at message/)
  assert.ok(!result.stderr.includes('trace.txt'), result.stderr)
})

test('usage and input errors exit 2', (t) => {
  const dir = tempDir(t)
  assert.equal(run(['create'], { cwd: dir }).status, 2)
  assert.equal(run(['create', '--message', 'a', '--message-file', 'b'], { cwd: dir }).status, 2)
  assert.equal(run(['create', '--nope'], { cwd: dir }).status, 2)
  assert.equal(run(['create', 'stray-positional'], { cwd: dir }).status, 2)
  assert.equal(run(['create', '--message-file', 'missing.txt'], { cwd: dir }).status, 2)
  assert.equal(run(['frobnicate'], { cwd: dir }).status, 2)
  assert.equal(run(['check'], { cwd: dir }).status, 2)
  assert.equal(run(['check', 'missing.json'], { cwd: dir }).status, 2)
  fs.writeFileSync(path.join(dir, 'other.json'), '{"schema":"something-else@v1"}\n')
  assert.equal(run(['check', 'other.json'], { cwd: dir }).status, 2)
})

test('help prints usage with both subcommands and exits 0', (t) => {
  const dir = tempDir(t)
  for (const args of [['--help'], ['help'], ['create', '--help'], ['check', '--help']]) {
    const result = run(args, { cwd: dir })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /feedback <subcommand>/)
    assert.match(result.stdout, /--include-gates/)
    assert.match(result.stdout, /check FILE/)
    assert.match(result.stdout, /no send path/)
  }
})
