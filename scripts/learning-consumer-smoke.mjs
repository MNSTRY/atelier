import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function verifyInstalledLearning({ installedRoot, consumerRoot }) {
  const load = name => import(pathToFileURL(path.join(installedRoot, `src/${name}/index.mjs`)).href)
  const [h, k, b, capability] = await Promise.all(['harnesses', 'knowledge', 'build', 'capabilities'].map(load))
  const fixture = JSON.parse(fs.readFileSync(path.join(installedRoot, 'fixtures/harnesses/learning-cycle.json')))
  const sources = ['knowledge-harness', 'build-harness'].map(name => path.join(installedRoot, 'fixtures/harness-packages', name))
  const releases = sources.map(packageRoot => capability.verifyCapabilityRelease({ packageRoot }))
  const roots = []
  for (const [index, host] of ['codex-repo-v1', 'claude-repo-v1'].entries()) {
    const root = path.join(consumerRoot, `learning-${index}`); roots.push(root)
    fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
    fs.mkdirSync(path.join(root, '.agents/skills/existing'), { recursive: true }); fs.writeFileSync(path.join(root, '.agents/skills/existing/SKILL.md'), 'Existing skill')
    const adoption = { schema: 'mnstry.atelier-capability-adoption@v1', id: `learning-${index}`, packages: releases.map(r => ({ id: r.package.id, digest: r.digest, mode: 'managed', bindings: [{ skill: 'harness', host, alias: r.package.skills[0].name }], allowedTools: ['atelier-harness-v1'], allowedEffects: ['read-workspace', 'write-workspace'] })) }
    const options = { workspaceRoot: root, sources, adoption, availableTools: ['atelier-harness-v1'] }
    const plan = capability.planCapabilityAdoption(options); assert.equal(plan.applyAllowed, true)
    if (process.platform === 'win32') {
      assert.throws(() => capability.applyCapabilityAdoption({ ...options, confirm: plan.planDigest }), /qualified POSIX/)
      for (const profile of ['knowledge', 'build']) assert.throws(() => h.appendHarness({ workspaceRoot: root, profile, record: fixture[profile][0], confirm: h.EMPTY_HARNESS_HEAD }), /qualified POSIX/)
      assert.equal(fs.existsSync(path.join(root, '.atelier-local')), false)
    } else capability.applyCapabilityAdoption({ ...options, confirm: plan.planDigest })
    assert.equal(fs.readFileSync(path.join(root, '.agents/skills/existing/SKILL.md'), 'utf8'), 'Existing skill')
  }
  if (process.platform === 'win32') {
    const dependencies = [{ repository: fixture.knowledge[0].data.repository, profile: 'knowledge', records: fixture.knowledge }]
    assert.equal(h.buildReadiness(fixture.build, { dependencySnapshots: dependencies }).readyReported, true)
    const snapshots = [...dependencies, { repository: fixture.build[0].data.repository, profile: 'build', records: fixture.build }]
    assert.ok(k.knowledgeGraphProposal(fixture.lessons, { namespace: 'lessons', activationId: 'lesson-use', dependencySnapshots: snapshots }).files.length)
    dependencies[0].records = [...fixture.knowledge, fixture.withdrawal]
    assert.equal(h.buildReadiness(fixture.build, { dependencySnapshots: snapshots }).readyReported, false)
    assert.ok(k.reconcileKnowledge(fixture.lessons, { dependencySnapshots: snapshots }).reconsider.some(r => r.id === 'lesson-use'))
    console.log('[consumer:learning] installed plans, pure knowledge/build exchange, correction propagation and no-write refusal passed; Windows persistence is unsupported')
    return
  }
  const append = (root, profile, records) => records.reduce((head, record) => h.appendHarness({ workspaceRoot: root, profile, record, confirm: head }).head, h.EMPTY_HARNESS_HEAD)
  append(roots[0], 'knowledge', fixture.knowledge)
  const repo = roots[1], git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(repo, 'prototype.mjs'), 'export const reminder = {enabled:true, message:"Please return your tools."}\n')
  git(['add', '.']); git(['-c', 'user.name=Synthetic Owner', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Disposable consumer prototype'])
  execFileSync(process.execPath, ['--input-type=module', '-e', 'import {reminder} from "./prototype.mjs"; if(!reminder.enabled || !reminder.message) process.exit(1)'], { cwd: repo })
  const candidate = b.prepareGitCandidate({ workspaceRoot: repo, records: [fixture.build[0]], artifact: 'prototype.mjs', writer: fixture.build[1].data.writer })
  const repin = (records, mutate) => {
    const seen = new Map()
    const walk = value => {
      if (value && typeof value === 'object') {
        if (value.id && value.digest && Object.keys(value).length === 2 && seen.has(value.id)) return h.harnessRef(seen.get(value.id))
        for (const key of Object.keys(value)) value[key] = walk(value[key])
      }
      return value
    }
    return structuredClone(records).map(r => { mutate(r); const result = walk(r); seen.set(r.id, result); return result })
  }
  const build = repin(fixture.build, r => { if (r.kind === 'candidate') r.data = candidate.data })
  append(repo, 'build', build)
  const dependencies = [{ repository: fixture.knowledge[0].data.repository, profile: 'knowledge', records: fixture.knowledge }]
  assert.equal(h.buildReadiness(build, { dependencySnapshots: dependencies }).readyReported, true)
  const handoff = h.createHarnessHandoff({ profile: 'build', repository: build[0].data.repository, records: build, subjectId: 'prototype', target: fixture.buildHandoff.target, dependencySnapshots: dependencies })
  const imported = k.prepareKnowledgeImport({ records: [fixture.lessons[0]], handoff, sourceRecords: build, title: 'Disposable consumer learning', term: 'material', category: 'observation', dependencySnapshots: dependencies })
  const lessons = repin(fixture.lessons, r => { if (r.kind === 'contribution') r.data = imported.data })
  append(roots[0], 'knowledge', lessons)
  const snapshots = [...dependencies, { repository: build[0].data.repository, profile: 'build', records: build }]
  assert.ok(k.knowledgeGraphProposal(lessons, { namespace: 'lessons', activationId: 'lesson-use', dependencySnapshots: snapshots }).files.length)
  const head = h.readHarness({ workspaceRoot: roots[0], profile: 'knowledge', run: fixture.knowledge[0].id }).head
  h.appendHarness({ workspaceRoot: roots[0], profile: 'knowledge', record: fixture.withdrawal, confirm: head })
  snapshots[0].records = h.readHarness({ workspaceRoot: roots[0], profile: 'knowledge', run: fixture.knowledge[0].id }).records
  assert.equal(h.buildReadiness(build, { dependencySnapshots: snapshots }).readyReported, false)
  assert.ok(k.reconcileKnowledge(lessons, { dependencySnapshots: snapshots }).reconsider.some(r => r.id === 'lesson-use'))
  const exported = JSON.parse(execFileSync(process.execPath, [path.join(installedRoot, 'bin/atelier.mjs'), 'harness', 'build', 'export', '--run', build[0].id], { cwd: repo, encoding: 'utf8' }))
  assert.equal(exported.head, h.inspectHarness('build', build).head)
  console.log('[consumer:learning] two repositories and host profiles, actual disposable Git candidate, knowledge/build exchange and correction propagation passed; CI/review/recipient reports remain simulated')
}
