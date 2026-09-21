import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function verifyInstalledCapabilities({ installedRoot, consumerRoot }) {
  const api = await import(pathToFileURL(path.join(installedRoot, 'src/capabilities/index.mjs')).href)
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
  console.log('[consumer:capabilities] two packages, two repositories and two host projections verified; host execution remains unobserved')
}
