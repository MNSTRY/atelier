import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { commandProject } from '../src/project/config.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INIT = path.join(ROOT, 'src', 'commands', 'init.mjs')

// The init command module is invoked directly (not through the CLI wrapper) so
// these tests stay independent of command-map wiring.
function runInit(args) {
  return execFileSync(process.execPath, [INIT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('init rejects an unknown template with exit 1 and creates nothing', () => {
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-init-unknown-'))
  const target = path.join(workspaces, 'workspace')
  try {
    let error = null
    try {
      runInit(['--template', 'bogus-template', '--target', target])
    } catch (caught) {
      error = caught
    }
    assert.ok(error, 'init must fail for an unknown template')
    assert.equal(error.status, 1, 'unknown template must exit 1')
    assert.match(String(error.stderr), /Unknown template: bogus-template\. Valid templates: private-domain, shared-project, sample-workspace, distribution\./)
    assert.equal(fs.existsSync(target), false, 'unknown template must not create the target directory')
  } finally {
    fs.rmSync(workspaces, { recursive: true, force: true })
  }
})

test('init without a template still writes the blank scaffold', () => {
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-init-blank-'))
  const target = path.join(workspaces, 'workspace')
  try {
    const output = runInit(['--target', target])
    assert.match(output, /created Atelier project scaffold at /)
    assert.ok(fs.existsSync(path.join(target, 'atelier.project.json')), 'blank scaffold must write atelier.project.json')
    const lock = JSON.parse(fs.readFileSync(path.join(target, 'atelier.lock.json'), 'utf8'))
    assert.equal(lock.template.id, 'default')
  } finally {
    fs.rmSync(workspaces, { recursive: true, force: true })
  }
})

test('init --template distribution writes the branded ext block, lock, and attribution', () => {
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-init-distribution-'))
  const target = path.join(workspaces, 'workspace')
  try {
    const output = runInit(['--template', 'distribution', '--target', target])
    assert.match(output, /created distribution Atelier workspace at /)

    const config = JSON.parse(fs.readFileSync(path.join(target, 'atelier.project.json'), 'utf8'))
    const distribution = config.ext?.['mnstry.atelier']?.distribution
    assert.ok(distribution, 'template config must carry ext["mnstry.atelier"].distribution')
    assert.equal(distribution.name, 'Example Distribution')
    assert.equal(distribution.eyebrow, 'distribution projection')

    const lock = JSON.parse(fs.readFileSync(path.join(target, 'atelier.lock.json'), 'utf8'))
    assert.equal(lock.template.id, 'distribution')

    const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8')
    assert.ok(readme.includes('powered by MNSTRY Atelier'), 'template README must carry the exact attribution byte string')

    const gitignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8')
    assert.ok(gitignore.split('\n').includes('atelier-attestation-key.local.json'), 'template .gitignore must ignore the local attestation signing key')

    // Boundary personalization must have run unchanged on the cloned policy.
    const policy = JSON.parse(fs.readFileSync(path.join(target, 'boundary-policy.v1.json'), 'utf8'))
    assert.equal(Object.keys(policy.actors).length, 1)
    assert.ok(!JSON.stringify(policy.actors).includes('USER_GITHUB_LOGIN_PLACEHOLDER'), 'placeholder actor login must be personalized')
  } finally {
    fs.rmSync(workspaces, { recursive: true, force: true })
  }
})

test('distribution template config passes the fail-closed project validator', () => {
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-init-distribution-validate-'))
  const target = path.join(workspaces, 'workspace')
  try {
    runInit(['--template', 'distribution', '--target', target])
    const projectPath = path.join(target, 'atelier.project.json')
    // commandProject is the fail-closed CLI entry: it throws on any document
    // validation error, so a clean return proves the template config is legal.
    const project = commandProject({ argv: ['--project', projectPath], cwd: target })
    assert.equal(project.config.ext['mnstry.atelier'].distribution.name, 'Example Distribution')
  } finally {
    fs.rmSync(workspaces, { recursive: true, force: true })
  }
})
