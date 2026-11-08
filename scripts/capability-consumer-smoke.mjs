import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function verifyInstalledCapabilities({ installedRoot, consumerRoot }) {
  const api = await import(pathToFileURL(path.join(installedRoot, 'src/capabilities/index.mjs')).href)
  verifyInstalledImpeccable(api, installedRoot)
  const fixtureRoot = path.join(installedRoot, 'fixtures/capability-packages')
  const adoption = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'adoption.example.json'), 'utf8'))
  const sources = ['evidence-review', 'research'].map(name => path.join(fixtureRoot, name))
  for (const packageRoot of sources) api.verifyCapabilityRelease({ packageRoot })
  const workspaces = []
  for (const name of ['first', 'second']) {
    const workspaceRoot = path.join(consumerRoot, `capability-${name}`)
    fs.mkdirSync(workspaceRoot)
    execFileSync('git', ['init', '--quiet', workspaceRoot])
    fs.writeFileSync(path.join(workspaceRoot, '.gitignore'), '.atelier-local/\n')
    const settings = { workspaceRoot, adoption: { ...adoption, id: `consumer-${name}` }, sources }
    const plan = api.planCapabilityAdoption(settings)
    assert.equal(plan.applyAllowed, true, plan.blockers.join('; '))
    if (process.platform === 'win32') {
      assert.throws(() => api.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest }), /qualified POSIX/)
      for (const name of ['.atelier-local', '.agents', '.claude']) assert.equal(fs.existsSync(path.join(workspaceRoot, name)), false)
      workspaces.push(workspaceRoot)
      continue
    }
    api.applyCapabilityAdoption({ ...settings, confirm: plan.planDigest })
    const status = api.capabilityEvidenceStatus({ workspaceRoot })
    assert.equal(status.packages.flatMap(item => item.bindings).length, 8)
    assert.ok(status.packages.every(item => item.bindings.every(binding => binding.installed === 'current' && binding.hostObserved === 'unknown')))
    assert.ok(fs.existsSync(path.join(workspaceRoot, '.agents/skills/research-plan/references/inquiries.md')))
    const cli = execFileSync(process.execPath, [path.join(installedRoot, 'bin/atelier.mjs'), 'capability', 'status'], { cwd: workspaceRoot, encoding: 'utf8' })
    assert.equal(JSON.parse(cli).enrollment, `consumer-${name}`)
    workspaces.push(workspaceRoot)
  }
  assert.equal(api.inspectCapabilityFleet({ workspaces }).repositories.length, 2)
  if (process.platform === 'win32') console.log('[consumer:capabilities] sealed packages, read-only plans/fleet and refusal before adoption writes verified; Windows adoption is unsupported')
  else console.log('[consumer:capabilities] two packages, two repositories and two host projections verified; host execution remains unobserved')
}

function verifyInstalledImpeccable(api, installedRoot) {
  const packageRoot = path.join(installedRoot, 'templates/impeccable-capability')
  const release = api.verifyCapabilityRelease({ packageRoot })
  assert.equal(release.package.id, 'mnstry/impeccable')
  assert.equal(release.package.version, '0.1.0-preview.5')
  const discovered = JSON.parse(execFileSync(process.execPath, [path.join(installedRoot, 'bin/atelier.mjs'), 'architecture', 'entry', 'Impeccable'], { encoding: 'utf8' }))
  assert.equal(discovered.id, release.package.capabilities[0].id)
  assert.equal(discovered.label, release.package.title)
  assert.equal(discovered.kind, 'capability')
  const skillRoot = path.join(packageRoot, 'skills/governed-impeccable')
  const resources = JSON.parse(fs.readFileSync(path.join(skillRoot, 'references/resources.json'), 'utf8'))
  assert.equal(resources.commands.length, 24)
  assert.equal(resources.rules.length, 62)
  for (const command of resources.commands) {
    assert.ok(fs.existsSync(path.join(skillRoot, 'references/upstream/reference', command + '.md')))
  }
  for (const license of ['apache-2.0.md', 'upstream-notice.md', 'platform-design-skills-mit.md']) {
    assert.ok(fs.statSync(path.join(skillRoot, 'references/licenses', license)).size > 0)
  }
  console.log('[consumer:impeccable] sealed guidance template, command closure and projected licenses verified; host behavior remains unobserved')
}
