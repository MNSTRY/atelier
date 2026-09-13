import fs from 'node:fs'
import { BASE_MIGRATIONS } from '../upgrade/upgrade.mjs'
import { validReviewArtifact } from '../collaboration/review-contracts.mjs'
import { fileURLToPath } from 'node:url'
import { readBoundedSource } from '../readiness-protocols/source-read.mjs'

const rootVersion = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    'utf8',
  ),
).version

export function inspectPackLifecycle(project, packs) {
  const declared =
    project.config.ext?.['mnstry.atelier']?.extensionPackLifecycle
  if (!declared)
    return {
      ok: packs.length === 0,
      schema: 'atelier-pack-lifecycle-report@v1',
      rootVersion,
      entries: packs.map((pack) => ({
        id: pack.id,
        status: 'legacy-unqualified',
        admitted: false,
      })),
      errors: packs.length
        ? [
            'extension-pack lifecycle declaration required for evidence-bound review',
          ]
        : [],
    }
  let policy
  try {
    policy = JSON.parse(readBoundedSource(project.configDir, declared).text)
  } catch {
    return {
      ok: false,
      errors: ['lifecycle declaration unavailable or unsafe'],
    }
  }
  if (
    !validReviewArtifact('lifecycle', policy) ||
    policy.schema !== 'atelier-pack-lifecycle@v1' ||
    !Array.isArray(policy.packs) ||
    policy.packs.length > 100 ||
    Object.keys(policy).some(
      (key) => !['schema', 'packs', 'ext', 'contractVersion'].includes(key),
    )
  )
    return { ok: false, errors: ['invalid lifecycle declaration'] }
  const ids = new Set(),
    errors = []
  for (const entry of policy.packs) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      ids.has(entry.id) ||
      !Array.isArray(entry.compatibleRootVersions) ||
      !entry.compatibleRootVersions.length ||
      entry.compatibleRootVersions.some(
        (version) => typeof version !== 'string',
      ) ||
      !['active', 'deprecated', 'retired'].includes(entry.status) ||
      typeof entry.version !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.digest ?? '') ||
      Object.keys(entry).some(
        (key) =>
          ![
            'id',
            'version',
            'digest',
            'compatibleRootVersions',
            'status',
            'replacement',
            'migrationId',
            'ext',
          ].includes(key),
      )
    )
      errors.push('invalid or duplicate lifecycle pack entry')
    if (
      entry?.migrationId &&
      !BASE_MIGRATIONS.some(
        (migration) =>
          migration.id === entry.migrationId &&
          migration.class === 'extension_pack' &&
          migration.active !== false,
      )
    )
      errors.push('unknown pack migration; owner migration unavailable')
    ids.add(entry?.id)
  }
  const entries = packs.map((pack) => {
    const entry = policy.packs.find((item) => item?.id === pack.id)
    const admitted = Boolean(
      entry &&
        entry.version === pack.version &&
        entry.digest === pack.digest &&
        entry.compatibleRootVersions?.includes(rootVersion) &&
        entry.status !== 'retired',
    )
    if (!admitted)
      errors.push(`pack ${pack.id} is not qualified for new execution`)
    return {
      id: pack.id,
      status: entry?.status ?? 'legacy-unqualified',
      admitted,
      replacement: entry?.replacement ?? null,
      migrationId: entry?.migrationId ?? null,
    }
  })
  return {
    ok: errors.length === 0,
    schema: 'atelier-pack-lifecycle-report@v1',
    rootVersion,
    entries,
    errors,
    policy,
  }
}

// This report names the existing data-only upgrade operation. It neither
// changes declarations nor admits a replacement; the source owner applies it.
export function planPackLifecycleMigration(project, packs) {
  const report = inspectPackLifecycle(project, packs)
  const migration = BASE_MIGRATIONS.find(
    (entry) => entry.class === 'extension_pack' && entry.active !== false,
  )
  return {
    ok: report.ok,
    schema: 'atelier-pack-migration-plan@v1',
    dryRun: true,
    writes: false,
    current: report,
    migration: migration
      ? {
          id: migration.id,
          files: migration.files,
          requiredPostChecks: migration.requiredPostChecks,
          authority: migration.authority,
        }
      : null,
    steps: [
      'Retain the prior package, pack declarations, lock and historical records.',
      'Review replacement term and protocol meanings in the source owner workflow.',
      'Update the declared version, digest and exact compatible root versions together.',
      'Use the existing upgrade migration to verify and refresh the lock after owner review.',
      'Create a new evidence-bound run; old runs retain their original meaning.',
    ],
    rollback:
      'Restore the prior declarations, package and lock together. Retain contribution and evidence history.',
  }
}
