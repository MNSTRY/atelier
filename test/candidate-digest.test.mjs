import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execNpmSync } from '../scripts/npm-cli.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('every artifact consumer refuses an unexpected candidate digest', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-candidate-digest-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const pack = JSON.parse(execNpmSync(['pack', '--json', '--pack-destination', tempRoot], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }))[0]
  const tarballPath = path.join(tempRoot, pack.filename)
  const packJsonPath = path.join(tempRoot, 'npm-pack.json')
  fs.writeFileSync(packJsonPath, `${JSON.stringify(pack, null, 2)}\n`)
  const wrongDigest = '0'.repeat(64)
  const commonEnv = {
    ...process.env,
    ATELIER_CANDIDATE_TARBALL: tarballPath,
    ATELIER_EXPECTED_TARBALL_SHA256: wrongDigest,
    ATELIER_DENYLIST_JSON: '{"patterns":[]}',
  }

  for (const [script, extraEnv] of [
    ['scripts/check-release-tarball.mjs', { ATELIER_CANDIDATE_PACK_JSON: packJsonPath }],
    ['scripts/consumer-smoke.mjs', {}],
    ['scripts/distribution-smoke.mjs', {}],
  ]) {
    const result = spawnSync(process.execPath, [path.join(packageRoot, script)], {
      cwd: packageRoot,
      env: { ...commonEnv, ...extraEnv },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, `${script} must refuse a mismatched digest`)
    assert.match(`${result.stdout}\n${result.stderr}`, /candidate tarball SHA-256 mismatch/, `${script} must name the mismatch`)
  }
})
