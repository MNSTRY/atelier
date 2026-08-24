import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureLocalState } from '../src/project/config.mjs'

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

test('local-state ignore detection follows Git identity across an aliased checkout path', (t) => {
  const parent = tempDir(t)
  const real = path.join(parent, 'real-checkout')
  const alias = path.join(parent, 'checkout-alias')
  fs.mkdirSync(real)
  spawnSync('git', ['init', '--quiet'], { cwd: real, encoding: 'utf8' })
  fs.writeFileSync(path.join(real, '.gitignore'), '.atelier-local/\n')
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')

  const report = ensureLocalState({ configDir: alias })

  assert.equal(report.ignored, true)
  assert.deepEqual(report.warnings, [])
  assert.equal(fs.existsSync(path.join(alias, '.atelier-local')), false, 'the ignore probe must not create local state')
})

// PEM headers are assembled at runtime and never written as literals: the
// repo-wide disclosure checker scans every tracked file for exactly this shape,
// so a literal here would make this test file its own finding.
const DASHES = '-'.repeat(5)
const pemLine = (keyword, words) => `${DASHES}${[keyword, ...words].join(' ')}${DASHES}`
const pemHeader = (...words) => pemLine('BEGIN', words)
const pemFooter = (...words) => pemLine('END', words)

// The plaintext prefix every ssh-keygen key starts with, base64-encoded. It is
// key-file shaped but carries no key material, and on its own it matches no
// banned pattern — which is what makes it a usable control below.
const OPENSSH_BODY = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB'

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
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
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

test('--context carrying an ssh-keygen private key is refused, not embedded', (t) => {
  // Reviewer demo: the private-key pattern required exactly one word between
  // BEGIN and KEY, so a real ed25519 key attached with --context passed the
  // scan and was written into the report byte for byte, under a message that
  // pointed at the public issue tracker.
  const dir = tempDir(t)
  const key = [
    pemHeader('OPENSSH', 'PRIVATE', 'KEY'),
    OPENSSH_BODY,
    pemFooter('OPENSSH', 'PRIVATE', 'KEY'),
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'id_ed25519'), `${key}\n`)
  const refused = run(['create', '--message', 'attaching what I was working with', '--context', 'id_ed25519'], { cwd: dir })
  assert.equal(refused.status, 1, refused.stderr)
  assert.match(refused.stderr, /refusing to write/)
  assert.match(refused.stderr, /banned value \(private-key\) at context\.text/)
  assert.match(refused.stderr, /nothing was written/)
  // Log-safety: label and location only — never the header and never the body.
  assert.ok(!refused.stderr.includes(OPENSSH_BODY), refused.stderr)
  assert.ok(!refused.stderr.includes('OPENSSH'), refused.stderr)
  assert.ok(!refused.stdout.includes('wrote'), refused.stdout)
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)

  // Control: the same file without the header line is clean, so the refusal
  // above came from the header rather than from anything else in the file.
  fs.writeFileSync(path.join(dir, 'body-only.txt'), `${OPENSSH_BODY}\n`)
  const clean = run(['create', '--message', 'attaching what I was working with', '--context', 'body-only.txt'], { cwd: dir })
  assert.equal(clean.status, 0, clean.stderr)
})

test('every real PEM private-key header form is refused, not only bare PKCS#8', (t) => {
  const dir = tempDir(t)
  const forms = [
    ['OPENSSH', 'PRIVATE', 'KEY'],
    ['RSA', 'PRIVATE', 'KEY'],
    ['EC', 'PRIVATE', 'KEY'],
    ['DSA', 'PRIVATE', 'KEY'],
    ['ENCRYPTED', 'PRIVATE', 'KEY'],
    ['PGP', 'PRIVATE', 'KEY', 'BLOCK'],
    ['PRIVATE', 'KEY'],
  ]
  for (const words of forms) {
    fs.writeFileSync(path.join(dir, 'attached.txt'), `${pemHeader(...words)}\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo\n`)
    const result = run(['create', '--message', 'attached the wrong file', '--context', 'attached.txt'], { cwd: dir })
    const label = words.join(' ')
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /banned value \(private-key\) at context\.text/, label)
  }
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)
})

test('an oversized context file is refused before anything is embedded', (t) => {
  const dir = tempDir(t)
  const cap = 256 * 1024
  fs.writeFileSync(path.join(dir, 'huge.log'), 'x'.repeat(cap + 1))
  const refused = run(['create', '--message', 'attaching the whole log', '--context', 'huge.log'], { cwd: dir })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, new RegExp(`${cap + 1} bytes and the limit is ${cap} bytes`))
  assert.match(refused.stderr, /nothing was embedded/)
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)

  // Exactly at the cap still goes through: the refusal is the cap itself, not
  // large-ish attachments in general.
  fs.writeFileSync(path.join(dir, 'at-cap.log'), 'x'.repeat(cap))
  const accepted = run(['create', '--message', 'attaching a trimmed log', '--context', 'at-cap.log'], { cwd: dir })
  assert.equal(accepted.status, 0, accepted.stderr)
  const { payload } = writtenReport(dir, accepted.stdout)
  assert.equal(payload.context.text.length, cap)
})

test('a binary or non-UTF-8 context file is refused rather than embedded', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'core.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]))
  const nul = run(['create', '--message', 'attached a binary by mistake', '--context', 'core.bin'], { cwd: dir })
  assert.equal(nul.status, 2)
  assert.match(nul.stderr, /NUL bytes/)
  assert.match(nul.stderr, /nothing was embedded/)

  fs.writeFileSync(path.join(dir, 'legacy.txt'), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]))
  const lossy = run(['create', '--message', 'attached a non-utf8 file', '--context', 'legacy.txt'], { cwd: dir })
  assert.equal(lossy.status, 2)
  assert.match(lossy.stderr, /not valid UTF-8/)
  assert.match(lossy.stderr, /nothing was embedded/)
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)
})

test('a report landing where the local state directory is not ignored warns loudly', (t) => {
  const dir = tempDir(t)
  spawnSync('git', ['init', '--quiet'], { cwd: dir, encoding: 'utf8' })
  const warned = run(['create', '--message', 'writing inside a checkout that tracks everything'], { cwd: dir })
  assert.equal(warned.status, 0, warned.stderr)
  writtenReport(dir, warned.stdout)
  assert.match(warned.stderr, /not ignored/)
  assert.match(warned.stderr, /could publish your own words/)
  // The warning names the directory, never the machine path it resolved to.
  assert.ok(!warned.stderr.includes(dir), warned.stderr)

  fs.writeFileSync(path.join(dir, '.gitignore'), '.atelier-local/\n')
  const quiet = run(['create', '--message', 'writing where local state is ignored'], { cwd: dir })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.equal(quiet.stderr, '')
})

test('the success message reads as a backstop, not as clearance to share', (t) => {
  const dir = tempDir(t)
  const result = run(['create', '--message', 'the ordering surprised me'], { cwd: dir })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Nothing was sent anywhere/)
  assert.match(result.stdout, /backstop, not a guarantee/)
  assert.match(result.stdout, /does not mean the file is safe to publish/)
  assert.match(result.stdout, /Read the whole file yourself before you share it/)
  assert.match(result.stdout, /bugs field/)
  // No sentence may read as clearance, so nothing declares the report clean or
  // safe to send.
  assert.doesNotMatch(result.stdout, /safe to share|is clean|no sensitive/i)
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
