import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { generateKeyPair } from '../src/attestation/sign.mjs'
import { MAX_INPUT_FILE_BYTES, runFeedbackCommand } from '../src/support/feedback-report.mjs'
import { BANNED_VALUE_PATTERNS } from '../src/support/support-bundle.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = path.join(ROOT, 'src', 'commands', 'feedback.mjs')

function run(args, { cwd }) {
  return spawnSync(process.execPath, [COMMAND, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT },
  })
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-feedback-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // The warning about an unignored report location is not what these tests
  // are about, so the workspace ignores local state the way a real one does.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.atelier-local/\n')
  return dir
}

// The kit writes its own signing keys as JWK, never PEM, so the PEM patterns
// never saw the one key format atelier itself produces — and the file lands
// in the working directory under a predictable name, which is exactly where
// a user runs feedback.
test('a JWK signing key attached as context is refused, not embedded', (t) => {
  const dir = workspace(t)
  const { privateKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: 'feedback-scan-probe' })
  const keyFile = path.join(dir, 'atelier-attestation-key.local.json')
  fs.writeFileSync(keyFile, `${JSON.stringify(privateKeyDoc, null, 2)}\n`)

  const result = run(['create', '--message', 'attaching my key file by mistake', '--context', keyFile], { cwd: dir })

  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /banned value \(jwk-private-key(-document)?\) at context/)
  // Log-safety: the scalar itself never appears in the refusal.
  assert.equal(result.stderr.includes(privateKeyDoc.privateKeyJwk.d), false)
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false, 'nothing may be written')
})

test('the private scalar and the wrapper member are both banned values', () => {
  const { privateKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: 'pattern-probe' })
  const serialized = JSON.stringify(privateKeyDoc)
  const scalar = BANNED_VALUE_PATTERNS.find((entry) => entry.type === 'jwk-private-key')
  const wrapper = BANNED_VALUE_PATTERNS.find((entry) => entry.type === 'jwk-private-key-document')

  assert.ok(scalar, 'the private scalar pattern must exist')
  assert.ok(wrapper, 'the wrapper-member pattern must exist')
  assert.equal(scalar.re.test(serialized), true)
  assert.equal(wrapper.re.test(serialized), true)
  // A public key document carries no private half and must stay clean.
  const { publicKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: 'public-probe' })
  const publicSerialized = JSON.stringify(publicKeyDoc)
  assert.equal(scalar.re.test(publicSerialized), false)
  assert.equal(wrapper.re.test(publicSerialized), false)
})

// The size cap is checked on the buffer readFileSync returns, which never
// returns for a character device or a FIFO.
test('a non-regular file is refused before it is read', (t) => {
  const dir = workspace(t)
  const fifo = path.join(dir, 'pipe')
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
  if (made.status !== 0) {
    t.skip('mkfifo unavailable on this platform')
    return
  }
  try {
    if (!fs.lstatSync(fifo).isFIFO()) {
      t.skip('mkfifo did not create a FIFO on this platform')
      return
    }
  } catch {
    t.skip('mkfifo did not create a readable directory entry on this platform')
    return
  }

  const result = run(['create', '--message', 'note', '--context', fifo], { cwd: dir })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /not a regular file/)
})

test('an oversized --message is refused the way an oversized file is', (t) => {
  const dir = workspace(t)
  const huge = 'a'.repeat(MAX_INPUT_FILE_BYTES + 1)

  const result = run(['create', '--message', huge], { cwd: dir })

  // Linux caps a single argv entry at MAX_ARG_STRLEN (32 pages = 128 KiB),
  // which is below MAX_INPUT_FILE_BYTES, so execve refuses the spawn before
  // the CLI can refuse the message. macOS has no per-argument cap and reaches
  // the CLI's own guard. Both are refusals, so assert the guarantee that holds
  // either way — nothing is written — and assert the CLI's specific refusal
  // only when the process actually ran. The guard itself is covered on every
  // platform by the direct assertion below, which needs no spawn.
  if (result.error) {
    assert.equal(result.status, null)
  } else {
    assert.equal(result.status, 2)
    assert.match(result.stderr, /--message is longer than the \d+ byte limit/)
  }
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)
})

test('the oversized-message guard holds without spawning a process', (t) => {
  // Platform-independent cover for the case above: on Linux the CLI can never
  // be handed an oversized --message, so the spawn test cannot exercise the
  // guard there. This calls the command directly. It reports refusal by
  // returning 2 and writing to stderr, so capture stderr rather than expecting
  // a throw.
  const dir = workspace(t)
  const huge = 'a'.repeat(MAX_INPUT_FILE_BYTES + 1)
  const errors = []
  const originalError = console.error
  const originalCwd = process.cwd()
  let status
  try {
    console.error = (...args) => errors.push(args.join(' '))
    process.chdir(dir)
    status = runFeedbackCommand(['create', '--message', huge])
  } finally {
    console.error = originalError
    process.chdir(originalCwd)
  }

  assert.equal(status, 2)
  assert.match(errors.join('\n'), /--message is longer than the \d+ byte limit/)
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)
})
