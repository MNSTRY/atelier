import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('init writes a workspace .gitignore from the shipped gitignore template', () => {
  // Simulate the installed layout: npm pack strips files named .gitignore, so
  // the published package ships templates/**/gitignore and init renames it on
  // copy. Copy the package surface into a temp dir and run init from there.
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-install-'))
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-init-gitignore-'))
  try {
    for (const entry of ['bin', 'src', 'templates', 'contracts', 'package.json']) {
      fs.cpSync(path.join(ROOT, entry), path.join(install, entry), { recursive: true })
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(install, 'node_modules'), 'dir')
    for (const template of ['private-domain', 'shared-project', 'distribution']) {
      const target = path.join(workspaces, template)
      execFileSync(process.execPath, [path.join(install, 'bin', 'atelier.mjs'), 'init', '--template', template, '--target', target], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const gitignorePath = path.join(target, '.gitignore')
      assert.ok(fs.existsSync(gitignorePath), `${template}: workspace .gitignore missing`)
      const [firstLine] = fs.readFileSync(gitignorePath, 'utf8').split('\n')
      assert.equal(firstLine, '.atelier-local/', `${template}: workspace .gitignore first line`)
      assert.equal(fs.existsSync(path.join(target, 'gitignore')), false, `${template}: literal gitignore must be renamed, not copied`)
    }
  } finally {
    fs.rmSync(install, { recursive: true, force: true })
    fs.rmSync(workspaces, { recursive: true, force: true })
  }
})

test('init renames gitignore only at the template root, not nested files', () => {
  // A file that happens to be named `gitignore` deeper in a template is
  // content, not the npm-pack workaround, and must keep its literal name.
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-install-nested-'))
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-init-nested-gitignore-'))
  try {
    for (const entry of ['bin', 'src', 'templates', 'contracts', 'package.json']) {
      fs.cpSync(path.join(ROOT, entry), path.join(install, entry), { recursive: true })
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(install, 'node_modules'), 'dir')
    const nestedDir = path.join(install, 'templates', 'private-domain-workspace', 'nested-fixture')
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.writeFileSync(path.join(nestedDir, 'gitignore'), 'nested-content\n')
    const target = path.join(workspaces, 'private-domain')
    execFileSync(process.execPath, [path.join(install, 'bin', 'atelier.mjs'), 'init', '--template', 'private-domain', '--target', target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.ok(fs.existsSync(path.join(target, '.gitignore')), 'root gitignore must still be renamed to .gitignore')
    assert.ok(fs.existsSync(path.join(target, 'nested-fixture', 'gitignore')), 'nested gitignore must keep its literal name')
    assert.equal(fs.existsSync(path.join(target, 'nested-fixture', '.gitignore')), false, 'nested gitignore must not be renamed')
  } finally {
    fs.rmSync(install, { recursive: true, force: true })
    fs.rmSync(workspaces, { recursive: true, force: true })
  }
})

test('npm pack ships the template gitignore files', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [manifest] = JSON.parse(output)
  const files = manifest.files.map((file) => file.path)
  for (const template of ['private-domain-workspace', 'shared-project-workspace', 'distribution-workspace']) {
    assert.ok(
      files.includes(`templates/${template}/gitignore`),
      `tarball missing templates/${template}/gitignore — npm pack strips .gitignore, so templates must ship the file as gitignore`,
    )
  }
})
