import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { capabilityWriteTest } from './helpers/capability-write.mjs'
import * as capability from '../src/capabilities/index.mjs'
import { impeccableResources } from '../src/impeccable/index.mjs'

const packageRoot = fileURLToPath(new URL('../templates/impeccable-capability/', import.meta.url))

test('Impeccable template retains sealed command closure and distributable licenses', () => {
  const release = capability.verifyCapabilityRelease({ packageRoot })
  assert.equal(release.package.id, 'mnstry/impeccable')
  assert.deepEqual(release.package.requirements, { tools: [], effects: ['read-workspace'] })
  assert.equal(release.files.some(file => /\/(scripts|agents|hooks)\//.test(file.path)), false)
  const skill = path.join(packageRoot, 'skills/governed-impeccable')
  const resources = JSON.parse(fs.readFileSync(path.join(skill, 'references/resources.json'), 'utf8'))
  assert.deepEqual(resources, impeccableResources())
  const routing = fs.readFileSync(path.join(skill, 'references/commands.md'), 'utf8')
  for (const command of resources.commands) {
    assert.ok(fs.statSync(path.join(skill, 'references/upstream/reference', command + '.md')).size > 0)
    assert.ok(routing.includes('| ' + command + ' |'))
  }
  for (const [local, publisher] of [['apache-2.0.md', 'LICENSE.md'], ['upstream-notice.md', 'NOTICE.md'], ['platform-design-skills-mit.md', 'LICENSE-platform-design-skills.md']]) {
    assert.equal(fs.readFileSync(path.join(skill, 'references/licenses', local), 'utf8'), fs.readFileSync(path.join(packageRoot, publisher), 'utf8'))
  }
})

capabilityWriteTest('Impeccable adoption preserves incumbent skills, refuses drift and recovers managed files', t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-impeccable-')))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const workspaceRoot = path.join(scratch, 'repository')
  fs.mkdirSync(workspaceRoot)
  execFileSync('git', ['init', '-q', workspaceRoot])
  fs.writeFileSync(path.join(workspaceRoot, '.gitignore'), '.atelier-local/\n')
  const incumbent = '---\nname: impeccable\ndescription: Synthetic incumbent.\n---\n\nExisting guidance.\n'
  for (const host of ['.agents', '.claude']) {
    const directory = path.join(workspaceRoot, host, 'skills/impeccable')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'SKILL.md'), incumbent)
  }
  const release = capability.verifyCapabilityRelease({ packageRoot })
  const settings = mode => ({ workspaceRoot, sources: mode === 'retired' ? [] : [packageRoot], adoption: {
    schema: 'mnstry.atelier-capability-adoption@v1', id: 'synthetic-design-consumer', packages: [{
      id: release.package.id, digest: release.digest, mode,
      bindings: mode === 'retired' ? [] : ['codex-repo-v1', 'claude-repo-v1'].map(host => ({ skill: 'governed-impeccable', host, alias: 'design-guidance' })),
      allowedTools: [], allowedEffects: ['read-workspace'],
    }],
  } })
  const apply = mode => {
    const options = settings(mode)
    const plan = capability.planCapabilityAdoption(options)
    assert.equal(plan.applyAllowed, true, plan.blockers.join('; '))
    return capability.applyCapabilityAdoption({ ...options, confirm: plan.planDigest })
  }
  const denied = settings('managed')
  denied.adoption.packages[0].allowedEffects = []
  assert.match(capability.planCapabilityAdoption(denied).blockers.join(' '), /effect-not-admitted/)
  apply('managed')
  assert.equal(apply('managed').changed, false)
  const evidence = capability.capabilityEvidenceStatus({ workspaceRoot, session: 'synthetic-session' })
  for (const binding of evidence.packages[0].bindings) {
    assert.equal(binding.hostObserved, 'unknown')
    assert.equal(binding.exercised, 'unknown')
  }
  const skillPath = path.join(workspaceRoot, '.agents/skills/design-guidance/SKILL.md')
  const original = fs.readFileSync(skillPath, 'utf8')
  assert.match(original, /^name: design-guidance$/m)
  fs.appendFileSync(skillPath, '\nSynthetic local customization.\n')
  assert.match(capability.planCapabilityAdoption(settings('managed')).blockers.join(' '), /local-drift/)
  apply('customized')
  assert.equal(capability.planCapabilityAdoption(settings('retired')).applyAllowed, false)
  fs.writeFileSync(skillPath, original)
  apply('managed')
  const retired = apply('retired')
  for (const host of ['.agents', '.claude']) {
    assert.equal(fs.existsSync(path.join(workspaceRoot, host, 'skills/design-guidance')), false)
    assert.equal(fs.readFileSync(path.join(workspaceRoot, host, 'skills/impeccable/SKILL.md'), 'utf8'), incumbent)
    assert.ok(fs.statSync(path.join(workspaceRoot, retired.quarantine, host, 'skills/design-guidance/SKILL.md')).size > 0)
    assert.equal(fs.readFileSync(path.join(workspaceRoot, retired.quarantine, host, 'skills/design-guidance/references/licenses/apache-2.0.md'), 'utf8'), fs.readFileSync(path.join(packageRoot, 'LICENSE.md'), 'utf8'))
  }
  const changed = path.join(scratch, 'changed-package')
  fs.cpSync(packageRoot, changed, { recursive: true })
  fs.appendFileSync(path.join(changed, 'skills/governed-impeccable/references/commands.md'), '\nChanged.\n')
  assert.throws(() => capability.verifyCapabilityRelease({ packageRoot: changed }), /integrity mismatch/)
})

test('sealed Impeccable bytes survive a Git checkout with automatic CRLF conversion enabled', t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-impeccable-checkout-')))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', scratch])
  fs.copyFileSync(new URL('../.gitattributes', import.meta.url), path.join(scratch, '.gitattributes'))
  const copied = path.join(scratch, 'templates/impeccable-capability')
  fs.mkdirSync(path.dirname(copied), { recursive: true })
  fs.cpSync(packageRoot, copied, { recursive: true })
  execFileSync('git', ['-c', 'core.autocrlf=true', 'add', '--', '.gitattributes', 'templates/impeccable-capability'], { cwd: scratch })
  fs.rmSync(copied, { recursive: true })
  execFileSync('git', ['-c', 'core.autocrlf=true', 'checkout-index', '--all', '--force'], { cwd: scratch })
  const checked = capability.verifyCapabilityRelease({ packageRoot: copied })
  const original = capability.verifyCapabilityRelease({ packageRoot })
  assert.equal(checked.digest, original.digest)
})
