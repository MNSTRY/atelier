import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ATELIER_MIGRATION_SCHEMA } from '../src/upgrade/upgrade.mjs'
import {
  checkBreakingMigrations,
  parseBreakingEntries,
} from '../scripts/check-breaking-migrations.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const gateScript = path.join(packageRoot, 'scripts', 'check-breaking-migrations.mjs')

function migration(overrides = {}) {
  return {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'fixture-breaking@0.1.0-alpha.0',
    from: '*',
    to: '0.1.0-alpha.2',
    class: 'breaking',
    title: 'Fixture breaking migration',
    description: 'Fixture registry record for the reconciliation gate test.',
    files: [],
    safety: 'breaking',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: true,
    apply: 'none',
    requiredPostChecks: [],
    authority: {
      telemetry: false,
      egress: false,
      sendPath: false,
      runtimeMutation: false,
      runtimeImport: false,
      runtimeApply: false,
      analysisExecution: false,
      hiddenProvider: false,
    },
    ...overrides,
  }
}

function changelog(bullets) {
  return `# Changelog\n\n## Unreleased\n\n${bullets.join('\n')}\n`
}

const cases = [
  {
    name: 'exempt map entry reconciles a breaking bullet',
    changelog: changelog(['- **Breaking:** widget renamed to gadget everywhere.']),
    map: { entries: [{ match: 'widget renamed to gadget', disposition: 'exempt', reason: 'pre-public', date: '2026-08-05' }] },
    migrations: [],
    problems: [],
  },
  {
    name: 'migration map entry reconciles a breaking bullet against an active breaking migration',
    changelog: changelog(['- **Breaking:** lock format v2 requires re-init.']),
    map: { entries: [{ match: 'lock format v2', disposition: 'migration', migration: 'fixture-breaking@0.1.0-alpha.0' }] },
    migrations: [migration()],
    problems: [],
  },
  {
    name: 'match substrings survive changelog line wrapping',
    changelog: changelog(['- **Breaking:** `fileClasses` is now', '  required in the kit manifest.']),
    map: { entries: [{ match: '`fileClasses` is now required', disposition: 'exempt', reason: 'pre-public', date: '2026-08-05' }] },
    migrations: [],
    problems: [],
  },
  {
    name: 'non-breaking bullets are ignored',
    changelog: changelog(['- Adds a harmless feature.', '- Fixes a harmless bug.']),
    map: { entries: [] },
    migrations: [],
    problems: [],
  },
  {
    name: 'a breaking bullet without a map entry fails',
    changelog: changelog(['- **Breaking:** unmapped removal of a flag.']),
    map: { entries: [] },
    migrations: [],
    problems: [/breaking changelog entry has no map entry/],
  },
  {
    name: 'a breaking bullet matching two map entries fails',
    changelog: changelog(['- **Breaking:** ambiguous overlapping change.']),
    map: {
      entries: [
        { match: 'ambiguous overlapping', disposition: 'exempt', reason: 'r', date: 'd' },
        { match: 'overlapping change', disposition: 'exempt', reason: 'r', date: 'd' },
      ],
    },
    migrations: [],
    problems: [/matches 2 map entries/],
  },
  {
    name: 'a stale map entry matching no bullet fails',
    changelog: changelog(['- Adds a harmless feature.']),
    map: { entries: [{ match: 'ghost of a removed bullet', disposition: 'exempt', reason: 'r', date: 'd' }] },
    migrations: [],
    problems: [/stale map entry .* matches no breaking changelog entry/],
  },
  {
    name: 'a map entry matching two bullets fails',
    changelog: changelog(['- **Breaking:** shared phrase first.', '- **Breaking:** shared phrase second.']),
    map: { entries: [{ match: 'shared phrase', disposition: 'exempt', reason: 'r', date: 'd' }] },
    migrations: [],
    problems: [/matches 2 breaking changelog entries/],
  },
  {
    name: 'a migration disposition naming an unknown id fails',
    changelog: changelog(['- **Breaking:** lock format v2 requires re-init.']),
    map: { entries: [{ match: 'lock format v2', disposition: 'migration', migration: 'missing@9.9.9' }] },
    migrations: [migration()],
    problems: [/not in the registry/, /active breaking migration fixture-breaking@0\.1\.0-alpha\.0 is not referenced/],
  },
  {
    name: 'a migration disposition naming a non-breaking migration fails',
    changelog: changelog(['- **Breaking:** lock format v2 requires re-init.']),
    map: { entries: [{ match: 'lock format v2', disposition: 'migration', migration: 'fixture-safe@0.1.0-alpha.0' }] },
    migrations: [
      migration({
        id: 'fixture-safe@0.1.0-alpha.0',
        class: 'config_schema',
        safety: 'safe',
        explicitConfirmationRequired: false,
      }),
    ],
    problems: [/whose class is "config_schema", not "breaking"/],
  },
  {
    name: 'a migration disposition naming an inactive migration fails',
    changelog: changelog(['- **Breaking:** lock format v2 requires re-init.']),
    map: { entries: [{ match: 'lock format v2', disposition: 'migration', migration: 'fixture-breaking@0.1.0-alpha.0' }] },
    migrations: [migration({ active: false })],
    problems: [/which is inactive/],
  },
  {
    name: 'an unreferenced active breaking migration fails',
    changelog: changelog(['- Adds a harmless feature.']),
    map: { entries: [] },
    migrations: [migration()],
    problems: [/active breaking migration fixture-breaking@0\.1\.0-alpha\.0 is not referenced by any map entry/],
  },
  {
    name: 'an inactive breaking migration needs no map entry',
    changelog: changelog(['- Adds a harmless feature.']),
    map: { entries: [] },
    migrations: [migration({ active: false })],
    problems: [],
  },
  {
    name: 'an invalid registry record fails re-validation',
    changelog: changelog(['- Adds a harmless feature.']),
    map: { entries: [] },
    migrations: [migration({ active: false, explicitConfirmationRequired: false })],
    problems: [/registry: fixture-breaking@0\.1\.0-alpha\.0: breaking migrations require explicitConfirmationRequired true/],
  },
  {
    name: 'an exempt entry without a reason fails',
    changelog: changelog(['- **Breaking:** widget renamed to gadget everywhere.']),
    map: { entries: [{ match: 'widget renamed to gadget', disposition: 'exempt', date: '2026-08-05' }] },
    migrations: [],
    problems: [/is exempt but has no reason/],
  },
  {
    name: 'an exempt entry without a date fails',
    changelog: changelog(['- **Breaking:** widget renamed to gadget everywhere.']),
    map: { entries: [{ match: 'widget renamed to gadget', disposition: 'exempt', reason: 'pre-public' }] },
    migrations: [],
    problems: [/is exempt but has no date/],
  },
  {
    name: 'an unrecognized disposition fails',
    changelog: changelog(['- **Breaking:** widget renamed to gadget everywhere.']),
    map: { entries: [{ match: 'widget renamed to gadget', disposition: 'shrug' }] },
    migrations: [],
    problems: [/unrecognized disposition "shrug"/],
  },
  {
    name: 'a map entry with an empty match fails',
    changelog: changelog(['- Adds a harmless feature.']),
    map: { entries: [{ match: '', disposition: 'exempt', reason: 'r', date: 'd' }] },
    migrations: [],
    problems: [/must declare a non-empty match substring/],
  },
]

test('checkBreakingMigrations reconciles fixture changelogs against fixture maps and registries', async (t) => {
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const result = checkBreakingMigrations({
        changelog: testCase.changelog,
        map: testCase.map,
        migrations: testCase.migrations,
      })
      if (testCase.problems.length === 0) {
        assert.deepEqual(result.problems, [], 'expected no problems')
        assert.equal(result.ok, true)
      } else {
        assert.equal(result.ok, false)
        for (const expected of testCase.problems) {
          assert.ok(
            result.problems.some((problem) => expected.test(problem)),
            `expected a problem matching ${expected} in ${JSON.stringify(result.problems, null, 2)}`,
          )
        }
      }
    })
  }
})

test('parseBreakingEntries joins wrapped bullets and skips non-list prose', () => {
  const text = changelog([
    '- **Breaking:** first change that wraps',
    '  onto a second line.',
    '- A harmless bullet.',
  ]) + '\nProse paragraph, not a bullet.\n'
  assert.deepEqual(parseBreakingEntries(text), ['**Breaking:** first change that wraps onto a second line.'])
})

test('the gate script passes against the real repo', () => {
  const result = spawnSync(process.execPath, [gateScript], { cwd: packageRoot, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
})

test('the gate script exits 2 on unexpected arguments', () => {
  const result = spawnSync(process.execPath, [gateScript, '--bogus'], { cwd: packageRoot, encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage/)
})
