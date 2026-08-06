import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { generateKeyPair } from '../src/attestation/sign.mjs'

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-feedback-json-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, '.gitignore'), '.atelier-local/\n')
  return dir
}

// Text patterns match JSON syntax, so a member name written as an escape
// evades them while JSON.parse still yields a usable key. Any attachment that
// parses as JSON is walked structurally as well, the way the release audit
// has always worked.
test('a JSON attachment hiding key material behind escapes is refused', (t) => {
  const dir = workspace(t)
  const { privateKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: 'escape-probe' })
  const escapedMember = `"\\u0064"`
  const file = path.join(dir, 'escaped.json')
  fs.writeFileSync(file, `{"kty":"OKP","crv":"Ed25519",${escapedMember}:"${privateKeyDoc.privateKeyJwk.d}","x":"a"}`)

  const result = run(['create', '--message', 'attaching config', '--context', file], { cwd: dir })

  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /banned value \(jwk-private-key\) at context\.text\.<decoded>\.d/)
  assert.equal(result.stderr.includes(privateKeyDoc.privateKeyJwk.d), false, 'the scalar is never echoed')
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false)
})

test('key material nested in a JSON string inside JSON is still reached', (t) => {
  const dir = workspace(t)
  const { privateKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId: 'nested-probe' })
  const file = path.join(dir, 'nested.json')
  fs.writeFileSync(file, JSON.stringify({ note: JSON.stringify(privateKeyDoc) }))

  const result = run(['create', '--message', 'attaching notes', '--context', file], { cwd: dir })

  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /banned value \(jwk-private-key/)
})

// The patterns must match key material, not documentation about it: the
// project's own attestation doc shows a redacted key file, and a user
// reporting a bug in that doc has to be able to attach it.
test('documentation showing a redacted key example stays attachable', (t) => {
  const dir = workspace(t)
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'attestation.md'), 'utf8')
  const file = path.join(dir, 'attestation-copy.md')
  fs.writeFileSync(file, doc)

  const result = run(['create', '--message', 'the key file section is unclear', '--context', file], { cwd: dir })

  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('an identifier that is short or not scalar-shaped does not fire', (t) => {
  const dir = workspace(t)
  const file = path.join(dir, 'drawing.json')
  // A compact SVG path under a member named d: shorter than any real scalar.
  fs.writeFileSync(file, JSON.stringify({ shapes: [{ d: 'M10L20L30L40L50L60L70' }] }))

  const result = run(['create', '--message', 'attaching a drawing', '--context', file], { cwd: dir })

  assert.equal(result.status, 0, result.stdout + result.stderr)
})
