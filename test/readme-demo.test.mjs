import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliBin = path.join(packageRoot, 'bin', 'mnstry-atelier.mjs')
const sampleFixture = path.join(packageRoot, 'fixtures', 'atelier-export', 'sample-studio-offer.v1.json')

test('README dry-run demo accepts valid sample and refuses public export referencing private source', () => {
  const validStdout = execFileSync(process.execPath, [cliBin, 'dry-run', sampleFixture], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  const validReport = JSON.parse(validStdout)
  assert.equal(validReport.accepted, true)
  assert.equal(validReport.importable, false)
  assert.deepEqual(validReport.errors, [])

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-readme-demo-'))
  try {
    const invalidPath = path.join(tmpDir, 'invalid-export.json')
    const doc = JSON.parse(fs.readFileSync(sampleFixture, 'utf8'))
    doc.provenance.sourceNodes[0].audience = 'private'
    fs.writeFileSync(invalidPath, JSON.stringify(doc, null, 2))

    let failed = false
    let refusalStdout = ''
    try {
      execFileSync(process.execPath, [cliBin, 'dry-run', invalidPath], {
        cwd: packageRoot,
        encoding: 'utf8',
      })
    } catch (error) {
      failed = true
      refusalStdout = error.stdout ?? ''
    }
    assert.equal(failed, true, 'mutated public export with private source must exit non-zero')
    const refusalReport = JSON.parse(refusalStdout)
    assert.equal(refusalReport.accepted, false)
    assert.match(
      refusalReport.errors.join('\n'),
      /is public but source node .* audience private is not public-projectable/,
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
