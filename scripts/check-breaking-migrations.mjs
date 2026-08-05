#!/usr/bin/env node

// Reconciles CHANGELOG **Breaking:** entries against the maintainer-reviewed
// breaking-changes map and the migration registry, so no breaking change ships
// without either an active breaking migration or a recorded exemption.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BASE_MIGRATIONS, validateMigrationRecord } from '../src/upgrade/upgrade.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export function parseChangelogListItems(changelog) {
  const items = []
  let current = null
  let inFence = false
  for (const line of changelog.split('\n')) {
    // Lines inside ``` fences are code, not bullets or continuations.
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*[-*]\s+/.test(line)) {
      if (current !== null) items.push(current)
      current = line.replace(/^\s*[-*]\s+/, '').trimEnd()
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`
    } else {
      if (current !== null) items.push(current)
      current = null
    }
  }
  if (current !== null) items.push(current)
  return items
}

export function parseBreakingEntries(changelog) {
  return parseChangelogListItems(changelog).filter((item) => /\*\*Breaking:\*\*/.test(item))
}

function excerpt(text, limit = 72) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export function checkBreakingMigrations({ changelog, map, migrations = BASE_MIGRATIONS, epochArmed = false } = {}) {
  const problems = []
  const entries = Array.isArray(map?.entries) ? map.entries : []
  const breaking = parseBreakingEntries(changelog ?? '')

  // (e) the migration registry itself must re-validate
  for (const migration of migrations) {
    for (const message of validateMigrationRecord(migration)) {
      problems.push(`registry: ${migration?.id ?? '(unknown migration)'}: ${message}`)
    }
  }

  // per-entry shape, (c) migration dispositions, (f) exemption provenance
  entries.forEach((entry, index) => {
    const label = typeof entry?.match === 'string' && entry.match.trim()
      ? `map entry "${entry.match}"`
      : `map entry #${index + 1}`
    if (typeof entry?.match !== 'string' || !entry.match.trim()) {
      problems.push(`${label} must declare a non-empty match substring`)
    }
    if (entry?.disposition === 'exempt') {
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`${label} is exempt but has no reason`)
      if (typeof entry.date !== 'string' || !entry.date.trim()) problems.push(`${label} is exempt but has no date`)
      // Once the compat epoch is armed, external consumers exist by
      // assumption: exemption stops being the default reflex and needs a
      // named reviewer on the record.
      if (epochArmed && (typeof entry.reviewer !== 'string' || !entry.reviewer.trim())) {
        problems.push(`${label} is exempt but the epoch is armed and no reviewer is recorded`)
      }
    } else if (entry?.disposition === 'migration') {
      const named = migrations.find((migration) => migration.id === entry.migration)
      if (!named) {
        problems.push(`${label} names migration "${entry.migration}" which is not in the registry`)
      } else {
        if (named.class !== 'breaking') problems.push(`${label} names migration "${entry.migration}" whose class is "${named.class}", not "breaking"`)
        if (named.active === false) problems.push(`${label} names migration "${entry.migration}" which is inactive`)
      }
    } else {
      problems.push(`${label} has unrecognized disposition "${entry?.disposition}"`)
    }
  })

  const usableEntries = entries.filter((entry) => typeof entry?.match === 'string' && entry.match.trim())

  // (a) every breaking changelog entry resolves to exactly one map entry
  for (const bullet of breaking) {
    const matched = usableEntries.filter((entry) => bullet.includes(entry.match))
    if (matched.length === 0) {
      problems.push(`breaking changelog entry has no map entry: "${excerpt(bullet)}"`)
    } else if (matched.length > 1) {
      problems.push(`breaking changelog entry matches ${matched.length} map entries: "${excerpt(bullet)}"`)
    }
  }

  // (b) every map entry resolves to exactly one breaking changelog entry
  for (const entry of usableEntries) {
    const matched = breaking.filter((bullet) => bullet.includes(entry.match))
    if (matched.length === 0) {
      problems.push(`stale map entry "${entry.match}" matches no breaking changelog entry`)
    } else if (matched.length > 1) {
      problems.push(`map entry "${entry.match}" matches ${matched.length} breaking changelog entries`)
    }
  }

  // (d) every active breaking migration is accounted for by the map
  const referenced = new Set(
    entries.filter((entry) => entry?.disposition === 'migration').map((entry) => entry.migration),
  )
  for (const migration of migrations) {
    if (migration.class === 'breaking' && migration.active !== false && !referenced.has(migration.id)) {
      problems.push(`active breaking migration ${migration.id} is not referenced by any map entry`)
    }
  }

  return { ok: problems.length === 0, problems }
}

function readOrExit(filePath, label) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    console.error(`[migrations:check] cannot read ${label}: ${error.message}`)
    process.exit(2)
  }
}

function runCli() {
  if (process.argv.length > 2) {
    console.error('[migrations:check] usage: node scripts/check-breaking-migrations.mjs (no arguments)')
    process.exit(2)
  }
  const changelog = readOrExit(join(packageRoot, 'CHANGELOG.md'), 'CHANGELOG.md')
  const mapText = readOrExit(join(packageRoot, 'scripts', 'breaking-changes.map.json'), 'scripts/breaking-changes.map.json')
  let map
  try {
    map = JSON.parse(mapText)
  } catch (error) {
    console.error(`[migrations:check] scripts/breaking-changes.map.json is not valid JSON: ${error.message}`)
    process.exit(2)
  }
  if (!Array.isArray(map?.entries)) {
    console.error('[migrations:check] scripts/breaking-changes.map.json must contain an entries array')
    process.exit(2)
  }
  let epochArmed = false
  try {
    const baseline = JSON.parse(readFileSync(join(packageRoot, 'contracts', 'compat-baseline.json'), 'utf8'))
    epochArmed = baseline.baselineTag != null
  } catch {
    // No baseline document — treat as unarmed rather than failing this gate.
  }
  const { ok, problems } = checkBreakingMigrations({ changelog, map, migrations: BASE_MIGRATIONS, epochArmed })
  if (!ok) {
    for (const problem of problems) console.error(`[migrations:check] ${problem}`)
    process.exit(1)
  }
  const breakingCount = parseBreakingEntries(changelog).length
  console.log(`[migrations:check] ${breakingCount} breaking changelog entr${breakingCount === 1 ? 'y' : 'ies'} reconciled against ${map.entries.length} map entr${map.entries.length === 1 ? 'y' : 'ies'}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli()
