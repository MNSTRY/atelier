import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { persistReleaseCandidate, readReleaseCandidateReceipt } from '../scripts/release-candidate-output.mjs'

test('a verified candidate can be retained with exact bytes and a machine-readable receipt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-retained-candidate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const output = path.join(root, 'output')
  fs.mkdirSync(source)
  const tarballPath = path.join(source, 'mnstry-atelier-0.2.0-alpha.5.tgz')
  const packJsonPath = path.join(source, 'npm-pack.json')
  const bytes = Buffer.from('synthetic exact candidate bytes')
  fs.writeFileSync(tarballPath, bytes)
  fs.writeFileSync(packJsonPath, '{"entryCount":1}\n')
  const digest = createHash('sha256').update(bytes).digest('hex')

  const retained = persistReleaseCandidate({
    outputDir: output,
    tarballPath,
    packJsonPath,
    candidateSha: 'a'.repeat(40),
    packageName: '@mnstry/atelier',
    version: '0.2.0-alpha.5',
    tarballSha256: digest,
    entryCount: 1,
  })

  assert.deepEqual(fs.readFileSync(retained.tarballPath), bytes)
  assert.equal(readReleaseCandidateReceipt(retained.receiptPath).tarballSha256, digest)
  assert.equal(readReleaseCandidateReceipt(retained.receiptPath).tarballPath, retained.tarballPath)
})

test('retaining a candidate refuses to overwrite prior release evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-retained-candidate-collision-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tarballPath = path.join(root, 'candidate.tgz')
  const packJsonPath = path.join(root, 'npm-pack-source.json')
  const output = path.join(root, 'output')
  fs.writeFileSync(tarballPath, 'candidate')
  fs.writeFileSync(packJsonPath, '{}\n')
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'release-candidate.json'), '{}\n')

  assert.throws(() => persistReleaseCandidate({
    outputDir: output,
    tarballPath,
    packJsonPath,
    candidateSha: 'b'.repeat(40),
    packageName: '@mnstry/atelier',
    version: '0.2.0-alpha.5',
    tarballSha256: 'c'.repeat(64),
    entryCount: 1,
  }), /output already exists/)
})
