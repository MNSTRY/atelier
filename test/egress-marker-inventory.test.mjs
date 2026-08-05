import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LOCAL_COMPUTED_ALLOW_MARKER } from '../src/egress/forbidden-egress.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const PINNED_MARKER_INVENTORY = {
  'src/egress/forbidden-egress.mjs': 1,
  'src/server/server.mjs': 2,
  'src/harness/context-client.mjs': 2,
}

function trackedFiles(...paths) {
  const result = spawnSync('git', ['-C', ROOT, 'ls-files', ...paths], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`)
  return result.stdout.split('\n').filter(Boolean)
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

test('local-computed egress allow marker appears only at pinned sites', () => {
  const inventory = {}
  for (const file of trackedFiles('src', 'bin', 'scripts')) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const count = countOccurrences(text, LOCAL_COMPUTED_ALLOW_MARKER)
    if (count > 0) inventory[file] = count
  }
  assert.deepEqual(
    inventory,
    PINNED_MARKER_INVENTORY,
    [
      `${LOCAL_COMPUTED_ALLOW_MARKER} disables unresolved-target egress detection for a 5-line window,`,
      'so every use in shipped code is a hole in the egress gate.',
      'Widening this inventory is a reviewed decision: justify the new call site,',
      'then update PINNED_MARKER_INVENTORY in this test in the same change.',
    ].join(' '),
  )
})
