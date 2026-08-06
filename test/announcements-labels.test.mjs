import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, signDocument } from '../src/attestation/sign.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = path.join(ROOT, 'src', 'commands', 'announcements.mjs')
const SEED = path.join(ROOT, 'announcements', '2026-08-06-announcements-channel.v1.json')

// Control sequences are built at runtime: a literal escape byte in a tracked
// file is exactly what the disclosure sweep exists to find.
const ESC = String.fromCharCode(27)
const ERASE_LINE = `${ESC}[2K`
const CURSOR_UP = `${ESC}[A`

function run(args, { cwd = ROOT } = {}) {
  return spawnSync(process.execPath, [COMMAND, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT },
  })
}

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function plantWithKeyId(t, prefix, keyId) {
  const dir = tmpdir(t, prefix)
  const doc = JSON.parse(fs.readFileSync(SEED, 'utf8'))
  doc.signature = { ...doc.signature, keyId }
  fs.writeFileSync(path.join(dir, 'planted.v1.json'), `${JSON.stringify(doc, null, 2)}\n`)
  return dir
}

// The keyId travels with the key, so a hostile tree chooses it. Left raw it
// carries terminal control sequences: erase-line clears the current row and
// cursor-up steps over the "!! UNVERIFIED" warning, so the attacker's own
// text overwrites the warning with something shaped like a genuine listing.
test('a keyId carrying terminal control sequences cannot forge listing output', (t) => {
  const forgedListing = 'announcement:2026-08-06:trusted  2026-08-06  Verified MNSTRY notice'
  const dir = plantWithKeyId(t, 'atelier-announce-ansi-', `x${ERASE_LINE}${CURSOR_UP}${forgedListing}`)

  const result = run(['list', '--dir', dir])
  const output = result.stdout + result.stderr

  assert.equal(result.status, 1)
  assert.match(output, /!! UNVERIFIED planted\.v1\.json/)
  assert.equal(output.includes(ESC), false, 'no escape byte may reach the terminal')
  // What remains is inert: without the escape byte the bracket text is
  // ordinary characters, so the operator still sees the claim that was made
  // and the warning line above it cannot be erased.
  assert.match(output, /signature keyId x\?\[2K\?\[A/)
  assert.equal(output.split('\n')[0].startsWith('key: '), true)
})

test('a keyId carrying a newline cannot inject a second key-identity line', (t) => {
  const forgedHeader = 'key: announcements/keys/mnstry-announcements.public.v1.json (keyId mnstry-announcements-2026, committed default key)'
  const dir = plantWithKeyId(t, 'atelier-announce-newline-', `x\n${forgedHeader}`)

  const result = run(['list', '--dir', dir])
  const headerLines = (result.stdout + result.stderr).split('\n').filter((line) => line.startsWith('key: '))

  assert.equal(result.status, 1)
  assert.equal(headerLines.length, 1, 'exactly one key-identity line, the real one')
})

test('an oversized keyId is capped rather than flooding the output', (t) => {
  const dir = plantWithKeyId(t, 'atelier-announce-longkey-', 'A'.repeat(5000))

  const result = run(['list', '--dir', dir])

  assert.equal(result.status, 1)
  assert.equal(/A{200,}/.test(result.stdout + result.stderr), false, 'the label must be capped')
})

// Finding 8 was closed for list only. show is the one subcommand that prints
// attacker-authored content, so it needs the anchor disclosure most.
test('verify and show name the key they trusted, including a non-default one', (t) => {
  const dir = tmpdir(t, 'atelier-announce-anchor-')
  const keyId = 'mnstry-announcements-2026'
  const { privateKeyDoc, publicKeyDoc } = generateKeyPair({ algorithm: 'ed25519', keyId })
  const forged = signDocument({
    schema: 'mnstry.announcement@v1',
    announcementId: 'announcement:2026-08-07:urgent-rotate',
    publishedAt: '2026-08-07',
    title: 'URGENT: rotate your keys',
    body: 'Rotate immediately.\n',
    signature: null,
  }, { privateKey: privateKeyDoc.privateKeyJwk, keyId, algorithm: 'ed25519' })
  const file = path.join(dir, 'forged.v1.json')
  const keyFile = path.join(dir, 'attacker.public.v1.json')
  fs.writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`)
  fs.writeFileSync(keyFile, `${JSON.stringify(publicKeyDoc, null, 2)}\n`)

  const verified = run(['verify', file, '--public-key', keyFile])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /explicit --public-key, not the committed default key/)

  const shown = run(['show', file, '--public-key', keyFile])
  assert.equal(shown.status, 0, shown.stderr)
  const [firstLine] = shown.stdout.split('\n')
  assert.match(firstLine, /^key: /, 'the anchor prints before any attacker-authored content')
  assert.match(firstLine, /explicit --public-key, not the committed default key/)

  const json = run(['verify', SEED, '--json'])
  assert.equal(json.status, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.valid, true)
  assert.equal(report.key, 'announcements/keys/mnstry-announcements.public.v1.json')
  assert.equal(report.keyId, 'mnstry-announcements-2026')
  assert.equal(report.explicitKey, false)
})
