import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applySkillSync,
  auditSkillCatalog,
  buildSkillCandidates,
  parseSkillFrontmatter,
  planSkillSync,
  recordSkillObservation,
  SKILL_SYNC_LOCK_FILE,
  validateSkillStewardDocument,
} from '../src/skills/steward.mjs'

const FIXED_TIME = '2026-08-28T00:00:00.000Z'
const clock = () => FIXED_TIME

test('evidence for separate skills never combines into a promotion', (t) => {
  const root = tempWorkspace(t)
  for (const skill of ['first-work', 'second-work']) recordSkillObservation({ workspaceRoot: root, workflowKey: 'shared.workflow', skill, signal: 'user-correction' })
  assert.deepEqual(buildSkillCandidates({ workspaceRoot: root }).candidates, [])
})

test('sync refuses identical unmanaged skills and deleted managed skills', (t) => {
  const root = tempWorkspace(t)
  const source = path.join(root, 'source')
  writeSkill(source, 'careful-work')
  const target = path.join(root, '.agents', 'skills')
  writeSkill(target, 'careful-work')
  assert.equal(planSkillSync({ workspaceRoot: root, sourceRoot: source }).applyAllowed, false)
  fs.renameSync(path.join(target, 'careful-work'), path.join(root, 'owner-backup'))
  const plan = planSkillSync({ workspaceRoot: root, sourceRoot: source })
  applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: plan.planDigest })
  fs.renameSync(path.join(target, 'careful-work'), path.join(root, 'managed-backup'))
  assert.equal(planSkillSync({ workspaceRoot: root, sourceRoot: source }).applyAllowed, false)
})

test('sync confirmations do not transfer between workspaces and source overlap is refused', (t) => {
  const root = tempWorkspace(t), other = tempWorkspace(t)
  const source = path.join(root, 'source')
  writeSkill(source, 'careful-work')
  const plan = planSkillSync({ workspaceRoot: root, sourceRoot: source })
  assert.throws(() => applySkillSync({ workspaceRoot: other, sourceRoot: source, confirm: plan.planDigest }), /confirmation/)
  assert.throws(() => planSkillSync({ workspaceRoot: root, sourceRoot: source, target: 'source' }), /overlap/)
})

test('private state must be ignored and an occupied operation lock blocks sync', (t) => {
  const root = tempWorkspace(t), source = path.join(root, 'source')
  writeSkill(source, 'careful-work')
  fs.writeFileSync(path.join(root, '.gitignore'), '')
  assert.throws(() => recordSkillObservation({ workspaceRoot: root, workflowKey: 'test.workflow', signal: 'repeated-task' }), /ignored/)
  const plan = planSkillSync({ workspaceRoot: root, sourceRoot: source })
  assert.throws(() => applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: plan.planDigest }), /ignored/)
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.mkdirSync(path.join(root, '.atelier-local', 'skill-steward'), { recursive: true })
  fs.writeFileSync(path.join(root, '.atelier-local', 'skill-steward', '.operation.lock'), '')
  assert.throws(() => applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: plan.planDigest }), /EEXIST/)
  assert.equal(fs.existsSync(path.join(root, '.agents')), false)
})

function tempWorkspace(t, prefix = 'atelier-skill-steward-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function skillText(name, body = `# ${name}\n\nFollow the bounded workflow.\n`) {
  return `---\nname: ${name}\ndescription: Handle the ${name} workflow when its exact trigger applies.\n---\n\n${body}`
}

function writeSkill(surface, name, body) {
  const root = path.join(surface, name)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'SKILL.md'), skillText(name, body))
  return root
}

function action(plan, name) {
  return plan.actions.find((entry) => entry.name === name)
}

test('frontmatter parser accepts the required portable skill metadata', () => {
  const parsed = parseSkillFrontmatter(skillText('careful-work'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.values.name, 'careful-work')
  assert.match(parsed.values.description, /exact trigger/)
  assert.match(parsed.body, /Follow the bounded workflow/)
})

test('catalog audit validates metadata, resources, and byte-identical peer bundles', (t) => {
  const root = tempWorkspace(t)
  const codex = path.join(root, 'skills', 'codex')
  const claude = path.join(root, 'skills', 'claude')
  for (const surface of [codex, claude]) {
    const bundle = writeSkill(surface, 'careful-work', '# Careful work\n\nRead [the checklist](references/checklist.md).\n')
    fs.mkdirSync(path.join(bundle, 'references'))
    fs.writeFileSync(path.join(bundle, 'references', 'checklist.md'), '# Checklist\n')
  }

  const clean = auditSkillCatalog({
    surfaces: [{ name: 'codex', root: codex }, { name: 'claude', root: claude }],
    reportRoot: root,
    clock,
  })
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.summary, { skills: 2, errors: 0, warnings: 0 })
  assert.deepEqual(validateSkillStewardDocument(clean, '#/$defs/auditReport'), [])

  fs.appendFileSync(path.join(claude, 'careful-work', 'SKILL.md'), '\nPeer-only edit.\n')
  const drifted = auditSkillCatalog({
    surfaces: [{ name: 'codex', root: codex }, { name: 'claude', root: claude }],
    reportRoot: root,
    clock,
  })
  assert.equal(drifted.ok, false)
  assert.ok(drifted.findings.some((finding) => finding.code === 'peer-bundle-mismatch'))
})

test('catalog audit fails closed for invalid metadata and escaping resources', (t) => {
  const root = tempWorkspace(t)
  const surface = path.join(root, 'skills')
  const bundle = path.join(surface, 'wrong-directory')
  fs.mkdirSync(bundle, { recursive: true })
  fs.writeFileSync(path.join(bundle, 'SKILL.md'), '---\nname: Different Name\ndescription:\n---\n\nRead [outside](../outside.md).\n')

  const report = auditSkillCatalog({ surfaces: [{ name: 'source', root: surface }], reportRoot: root, clock })
  const codes = new Set(report.findings.map((finding) => finding.code))
  assert.equal(report.ok, false)
  assert.equal(codes.has('name-invalid'), true)
  assert.equal(codes.has('name-directory-mismatch'), true)
  assert.equal(codes.has('description-missing'), true)
  assert.equal(codes.has('reference-escapes-bundle'), true)
})

test('content-free observations become candidates only at fixed evidence thresholds', (t) => {
  const root = tempWorkspace(t)
  recordSkillObservation({ workspaceRoot: root, workflowKey: 'weekly.release', signal: 'repeated-task', outcome: 'success', at: '2026-08-28T00:00:01.000Z' })
  recordSkillObservation({ workspaceRoot: root, workflowKey: 'weekly.release', signal: 'missing-workflow', outcome: 'missing', at: '2026-08-28T00:00:02.000Z' })

  assert.deepEqual(buildSkillCandidates({ workspaceRoot: root, clock }).candidates, [])

  recordSkillObservation({ workspaceRoot: root, workflowKey: 'weekly.release', signal: 'repeated-task', outcome: 'success', at: '2026-08-28T00:00:03.000Z' })
  recordSkillObservation({ workspaceRoot: root, workflowKey: 'existing.review', signal: 'user-correction', skill: 'careful-work', outcome: 'corrected', at: '2026-08-28T00:00:04.000Z' })
  recordSkillObservation({ workspaceRoot: root, workflowKey: 'existing.review', signal: 'user-correction', skill: 'careful-work', outcome: 'corrected', at: '2026-08-28T00:00:05.000Z' })
  recordSkillObservation({ workspaceRoot: root, workflowKey: 'legacy.review', signal: 'superseded-skill', skill: 'legacy-work', outcome: 'missing', at: '2026-08-28T00:00:06.000Z' })
  recordSkillObservation({ workspaceRoot: root, workflowKey: 'legacy.review', signal: 'superseded-skill', skill: 'legacy-work', outcome: 'missing', at: '2026-08-28T00:00:07.000Z' })

  const report = buildSkillCandidates({ workspaceRoot: root, clock })
  assert.deepEqual(report.candidates.map(({ workflowKey, kind, status, skill }) => ({ workflowKey, kind, status, skill })), [
    { workflowKey: 'existing.review', kind: 'improve', status: 'eligible', skill: 'careful-work' },
    { workflowKey: 'legacy.review', kind: 'retire', status: 'eligible', skill: 'legacy-work' },
    { workflowKey: 'weekly.release', kind: 'create', status: 'eligible', skill: null },
  ])
  assert.deepEqual(validateSkillStewardDocument(report, '#/$defs/candidateReport'), [])

  const ledger = fs.readFileSync(path.join(root, '.atelier-local', 'skill-steward', 'observations.ndjson'), 'utf8')
  assert.doesNotMatch(ledger, /prompt|transcript|summary|sourceContent/)
  assert.throws(
    () => recordSkillObservation({ workspaceRoot: root, workflowKey: 'contains spaces', signal: 'repeated-task' }),
    /workflow key is invalid/,
  )
})

test('sync requires the exact current plan and installs a contract-valid managed projection', (t) => {
  const root = tempWorkspace(t)
  const source = path.join(root, 'source')
  writeSkill(source, 'careful-work')

  const plan = planSkillSync({ workspaceRoot: root, sourceRoot: source, clock })
  assert.equal(plan.applyAllowed, true)
  assert.equal(action(plan, 'careful-work').type, 'add')
  assert.deepEqual(validateSkillStewardDocument(plan, '#/$defs/syncPlan'), [])

  assert.throws(
    () => applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: `sha256:${'0'.repeat(64)}`, clock }),
    /exactly match the current plan digest/,
  )
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'careful-work')), false)

  const result = applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: plan.planDigest, clock })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'careful-work', 'SKILL.md')), true)
  const lock = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'skills', SKILL_SYNC_LOCK_FILE), 'utf8'))
  assert.deepEqual(validateSkillStewardDocument(lock, '#/$defs/syncLock'), [])
  assert.deepEqual(lock.skills.map((entry) => entry.name), ['careful-work'])
})

test('sync refuses unmanaged collisions and drift in a managed target', (t) => {
  const unmanagedRoot = tempWorkspace(t, 'atelier-skill-unmanaged-')
  const unmanagedSource = path.join(unmanagedRoot, 'source')
  writeSkill(unmanagedSource, 'careful-work', '# Source\n')
  writeSkill(path.join(unmanagedRoot, '.agents', 'skills'), 'careful-work', '# Local owner\n')
  const unmanaged = planSkillSync({ workspaceRoot: unmanagedRoot, sourceRoot: unmanagedSource, clock })
  assert.equal(unmanaged.applyAllowed, false)
  assert.match(unmanaged.blockers.join('\n'), /not managed by Atelier/)

  const driftRoot = tempWorkspace(t, 'atelier-skill-drift-')
  const driftSource = path.join(driftRoot, 'source')
  writeSkill(driftSource, 'careful-work')
  const initial = planSkillSync({ workspaceRoot: driftRoot, sourceRoot: driftSource, clock })
  applySkillSync({ workspaceRoot: driftRoot, sourceRoot: driftSource, confirm: initial.planDigest, clock })
  fs.appendFileSync(path.join(driftRoot, '.agents', 'skills', 'careful-work', 'SKILL.md'), '\nLocal drift.\n')
  const drifted = planSkillSync({ workspaceRoot: driftRoot, sourceRoot: driftSource, clock })
  assert.equal(drifted.applyAllowed, false)
  assert.match(drifted.blockers.join('\n'), /has local drift/)
})

test('sync revalidates source and target bytes after preparing the confirmed plan', (t) => {
  const sourceChangeRoot = tempWorkspace(t, 'atelier-skill-source-change-')
  const source = path.join(sourceChangeRoot, 'source')
  writeSkill(source, 'careful-work', '# Reviewed source\n')
  const sourcePlan = planSkillSync({ workspaceRoot: sourceChangeRoot, sourceRoot: source, clock })
  let sourceClockCalls = 0
  assert.throws(
    () => applySkillSync({
      workspaceRoot: sourceChangeRoot,
      sourceRoot: source,
      confirm: sourcePlan.planDigest,
      clock: () => {
        sourceClockCalls += 1
        if (sourceClockCalls === 1) fs.writeFileSync(path.join(source, 'careful-work', 'SKILL.md'), skillText('careful-work', '# Late source\n'))
        return FIXED_TIME
      },
    }),
    /confirmation must exactly match|source skill careful-work changed after the confirmed plan was prepared/,
  )
  assert.equal(fs.existsSync(path.join(sourceChangeRoot, '.agents', 'skills', 'careful-work')), false)

  const targetChangeRoot = tempWorkspace(t, 'atelier-skill-target-change-')
  const targetSource = path.join(targetChangeRoot, 'source')
  writeSkill(targetSource, 'careful-work', '# Version one\n')
  const initial = planSkillSync({ workspaceRoot: targetChangeRoot, sourceRoot: targetSource, clock })
  applySkillSync({ workspaceRoot: targetChangeRoot, sourceRoot: targetSource, confirm: initial.planDigest, clock })
  fs.writeFileSync(path.join(targetSource, 'careful-work', 'SKILL.md'), skillText('careful-work', '# Version two\n'))
  const update = planSkillSync({ workspaceRoot: targetChangeRoot, sourceRoot: targetSource, clock })
  let targetClockCalls = 0
  assert.throws(
    () => applySkillSync({
      workspaceRoot: targetChangeRoot,
      sourceRoot: targetSource,
      confirm: update.planDigest,
      clock: () => {
        targetClockCalls += 1
        if (targetClockCalls === 1) fs.appendFileSync(path.join(targetChangeRoot, '.agents', 'skills', 'careful-work', 'SKILL.md'), '\nLate local edit.\n')
        return FIXED_TIME
      },
    }),
    /confirmation must exactly match|target skill careful-work changed after the confirmed plan was prepared/,
  )
  assert.match(fs.readFileSync(path.join(targetChangeRoot, '.agents', 'skills', 'careful-work', 'SKILL.md'), 'utf8'), /Late local edit/)
})

test('sync updates and retires through ignored quarantine without deleting recovery state', (t) => {
  const root = tempWorkspace(t)
  const source = path.join(root, 'source')
  writeSkill(source, 'careful-work', '# Version one\n')
  const first = planSkillSync({ workspaceRoot: root, sourceRoot: source, clock })
  applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: first.planDigest, clock })

  fs.writeFileSync(path.join(source, 'careful-work', 'SKILL.md'), skillText('careful-work', '# Version two\n'))
  const update = planSkillSync({ workspaceRoot: root, sourceRoot: source, clock })
  assert.equal(action(update, 'careful-work').type, 'update')
  const updated = applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: update.planDigest, clock })
  assert.match(fs.readFileSync(path.join(root, '.agents', 'skills', 'careful-work', 'SKILL.md'), 'utf8'), /Version two/)
  assert.equal(updated.quarantined.length, 1)
  assert.match(fs.readFileSync(path.join(root, updated.quarantined[0], 'SKILL.md'), 'utf8'), /Version one/)

  fs.rmSync(path.join(source, 'careful-work'), { recursive: true })
  const retirement = planSkillSync({ workspaceRoot: root, sourceRoot: source, clock })
  assert.equal(action(retirement, 'careful-work').type, 'quarantine')
  const retired = applySkillSync({ workspaceRoot: root, sourceRoot: source, confirm: retirement.planDigest, clock })
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'careful-work')), false)
  assert.equal(retired.quarantined.length, 1)
  assert.match(fs.readFileSync(path.join(root, retired.quarantined[0], 'SKILL.md'), 'utf8'), /Version two/)
})

test('sync target must remain a contained child of the enrolled workspace', (t) => {
  const root = tempWorkspace(t)
  const source = path.join(root, 'source')
  writeSkill(source, 'careful-work')
  assert.throws(
    () => planSkillSync({ workspaceRoot: root, sourceRoot: source, target: path.join('..', 'escaped-skills'), clock }),
    /escapes workspace/,
  )
})
