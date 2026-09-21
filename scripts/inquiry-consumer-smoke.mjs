import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function verifyInstalledInquiry({ installedRoot, consumerRoot }) {
  const api = await import(pathToFileURL(path.join(installedRoot, 'src/inquiry/index.mjs')).href)
  const capabilities = await import(pathToFileURL(path.join(installedRoot, 'src/capabilities/index.mjs')).href)
  const records = JSON.parse(fs.readFileSync(path.join(installedRoot, 'fixtures/inquiry/workshop.json')))
  const sources = ['discovery-harness', 'research-harness'].map(name => path.join(installedRoot, 'fixtures/inquiry-packages', name))
  const releases = sources.map(packageRoot => capabilities.verifyCapabilityRelease({ packageRoot }))
  for (const [index, host] of ['codex-repo-v1', 'claude-repo-v1'].entries()) {
    const root = path.join(consumerRoot, `inquiry-${index}`)
    fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
    const adoption = { schema: 'mnstry.atelier-capability-adoption@v1', id: `inquiry-${index}`, packages: releases.map(r => ({ id: r.package.id, digest: r.digest, mode: 'managed', bindings: [{ skill: 'harness', host, alias: r.package.skills[0].name }], allowedTools: ['atelier-inquiry-v1'], allowedEffects: ['read-workspace', 'write-workspace'] })) }
    const options = { workspaceRoot: root, sources, adoption, availableTools: ['atelier-inquiry-v1'] }
    const plan = capabilities.planCapabilityAdoption(options)
    assert.equal(plan.applyAllowed, true, plan.blockers.join(';'))
    capabilities.applyCapabilityAdoption({ ...options, confirm: plan.planDigest })
    let head = api.EMPTY_INQUIRY_HEAD
    for (const record of records) head = api.appendInquiry({ workspaceRoot: root, record, confirm: head }).head
    const state = api.readInquiry({ workspaceRoot: root, campaign: 'workshop' })
    assert.equal(state.head, head)
    assert.ok(Math.abs(state.assessments['revised-assessment'].probability - 0.25) < 1e-12)
    assert.ok(state.reconsider.some(r => r.id === 'decision-before'))
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(installedRoot, 'bin/atelier.mjs'), 'inquiry', ...args], { cwd: root, encoding: 'utf8' }))
    const exported = cli('export', '--campaign', 'workshop')
    assert.deepEqual(api.validateInquiryDocument(exported, 'ledger'), [])
    const graph = cli('graph', '--campaign', 'workshop', '--namespace', 'consumer')
    assert.equal(graph.canonicalMutation, false)
    assert.ok(graph.files.some(f => f.path === 'decision-after.md'))
    assert.deepEqual(api.validateInquiryDocument(cli('handoff', '--campaign', 'workshop', '--request', 'research'), 'handoff'), [])
  }
  console.log('[consumer:inquiry] two host profiles, immutable campaign replay, withdrawal and portable graph proposal verified; research quality remains unevaluated')
}
