import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function run(args, cwd = ROOT) {
  return execFileSync(process.execPath, [path.join(ROOT, 'bin', 'atelier.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('atelier is the primary CLI and mnstry-atelier remains a compatible alias', () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  assert.equal(run(['--version']).trim(), version)
  const legacy = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'mnstry-atelier.mjs'), '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(legacy.trim(), version)
  assert.match(run(['--help']), /Usage:\n  atelier <command>/)
})

test('subcommand help does not initialize or mutate the current directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-cli-help-'))
  const output = run(['init', '--help'], dir)
  assert.match(output, /Usage: atelier init/)
  assert.equal(fs.existsSync(path.join(dir, 'atelier.project.json')), false)
  assert.equal(fs.existsSync(path.join(dir, 'atelier.lock.json')), false)
})
