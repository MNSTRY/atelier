import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Runs in the already-installed bare consumer and its disposable linked
// worktree. Reuses the same transaction APIs for the first and later adoption.
async function templateUpgradeJourney(installedRoot, source, root) {
  const { default: assert } = await import('node:assert/strict')
  const { default: fs } = await import('node:fs')
  const { default: path } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { resolveProjectConfig } = await import('@mnstry/atelier/project')
  const { prepareTemplateUpgrade, explainSavedUpgrade, applySavedUpgrade, upgradeOperationStatus, recoverUpgradeDryRun } = await import('@mnstry/atelier/upgrade')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const put = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n')
  const read = file => fs.readFileSync(path.join(root, file))
  const doc = file => JSON.parse(read(file))
  const commit = message => { git(root, 'add', '-A'); git(root, 'commit', '-m', message) }
  const initialSourceHead = git(source, 'rev-parse', 'HEAD'), originalSource = read('seed.md')
  const profile = JSON.parse(fs.readFileSync(path.join(installedRoot, 'fixtures/templates/local-library.v1.json')))
  const lock = doc('atelier.lock.json')
  lock.ext = { 'sample.notes': { retain: true } }
  lock.template.ext = { 'sample.notes': { local: true } }
  put('atelier.lock.json', lock)
  put('next-profile.json', profile)
  put('next-selection.json', { projectRef: 'sample.workshop', roleNodeIds: { items: ['workspace:seed'] }, target: 'local' })
  put('atelier.adoption-policy.json', { schema: 'mnstry.atelier-adoption-policy@v2', enabled: true, participant: 'local-template-profile@1', mode: 'manual-exact-plan', maxAgeSeconds: 86400, recoveryCoverage: 'local-only', allowedEffects: ['template-adoption', 'lock-and-projections', 'git-commit'] })
  commit('Enroll synthetic template')
  const project = resolveProjectConfig({ cwd: root, argv: ['--project', path.join(root, 'atelier.project.json')], env: {}, writeLocalState: false })
  const prepare = () => prepareTemplateUpgrade({ project, profileFile: 'next-profile.json', selectionFile: 'next-selection.json' })
  const apply = prepared => applySavedUpgrade({ project, planFile: prepared.savedPlan, confirm: prepared.plan.digest })
  const initial = prepare(), head = git(root, 'rev-parse', 'HEAD')
  assert.equal(initial.plan.schema, 'mnstry.atelier-upgrade-plan@v3')
  assert.equal(fs.existsSync(path.join(root, 'atelier-template')), false)
  const explanation = explainSavedUpgrade({ project, planFile: initial.savedPlan })
  assert.equal(explanation.bindingsCurrent, true)
  assert.equal(explanation.consent.applicationAuthorized, false)
  assert.equal(explanation.participant, 'local-template-profile@1')
  const result = apply(initial)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.activated, false)
  assert.equal(git(root, 'rev-parse', 'HEAD^'), head)
  assert.equal(upgradeOperationStatus({ project, operationId: result.operationId }).status, 'completed')
  assert.deepEqual(read('seed.md'), originalSource)
  assert.deepEqual(doc('atelier.lock.json').ext, lock.ext)
  assert.deepEqual(doc('atelier.lock.json').template.ext, lock.template.ext)
  assert.throws(() => apply(initial))
  const firstAdoption = read('atelier-template/adoption.json')
  const firstBinding = doc('atelier-output/template-binding.json').bindingRef

  // The person changes canonical source and the selected inert profile. The
  // installed transaction regenerates projections without rewriting that source.
  profile.version = '1.1.0'; profile.purpose = 'An updated invented reading shelf.'
  put('next-profile.json', profile)
  fs.appendFileSync(path.join(root, 'seed.md'), '\nA newly observed paper shape.\n')
  commit('Update synthetic template and source')
  const editedSource = read('seed.md'), second = prepare(), updated = apply(second)
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.deepEqual(read('seed.md'), editedSource)
  assert.deepEqual(read('atelier-template/history/' + second.plan.participant.previousAdoptionDigest.slice(7) + '.json'), firstAdoption)
  assert.equal(doc('atelier.lock.json').template.version, '1.1.0')
  assert.deepEqual(doc('atelier.lock.json').ext, lock.ext)
  assert.deepEqual(doc('atelier.lock.json').template.ext, lock.template.ext)
  assert.deepEqual(doc('atelier.lock.json').appliedMigrations, lock.appliedMigrations)
  assert.notDeepEqual(doc('atelier-output/template-binding.json').bindingRef, firstBinding)
  assert.match(read('atelier-output/template.html').toString(), /updated invented reading shelf/)
  assert.match(read('atelier-output/template.html').toString(), /newly observed paper shape/)
  assert.equal(git(root, 'status', '--porcelain'), '')
  const recovery = recoverUpgradeDryRun({ project, operationId: updated.operationId })
  assert.equal(recovery.mutation, false)
  assert.equal(recovery.requiresNewConfirmation, true)
  assert.equal(git(source, 'rev-parse', 'HEAD'), initialSourceHead)
  const installed = read('atelier-template/profile.json')
  fs.appendFileSync(path.join(root, 'atelier-template/profile.json'), '\n')
  commit('Customize synthetic managed file')
  assert.throws(prepare, /managed preimage/)
  assert.deepEqual(read('atelier-template/profile.json'), Buffer.concat([installed, Buffer.from('\n')]))
  assert.deepEqual(read('seed.md'), editedSource)
  console.log('[consumer:template-upgrade] installed first adoption, update, preserved customization/history/source, stale managed-file refusal and recovery inspection passed; no merge, release or host activation')
}

export function verifyInstalledTemplateUpgrade({ installedRoot, consumerRoot, source, root, env }) {
  const script = path.join(consumerRoot, 'template-upgrade-smoke.mjs')
  fs.writeFileSync(script, `${templateUpgradeJourney.toString()}\nawait templateUpgradeJourney(${JSON.stringify(installedRoot)}, ${JSON.stringify(source)}, ${JSON.stringify(root)})\n`)
  process.stdout.write(execFileSync(process.execPath, [script], { cwd: consumerRoot, env, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }))
}
