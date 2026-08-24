#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tempRoot = mkdtempSync(join(tmpdir(), 'atelier-release-candidate-'))

function output(command, args) {
  return execFileSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function run(command, args, env) {
  execFileSync(command, args, {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
  })
}

try {
  const dirty = output('git', ['status', '--porcelain', '--untracked-files=all'])
  if (dirty) throw new Error('release candidate requires a clean Git working tree')
  const candidateSha = output('git', ['rev-parse', 'HEAD'])
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const versionTag = `v${packageJson.version}`
  let existingVersionCommit = null
  try {
    existingVersionCommit = output('git', ['rev-parse', `${versionTag}^{commit}`])
  } catch {
    // A missing version tag is the expected state for a new candidate.
  }
  if (existingVersionCommit && existingVersionCommit !== candidateSha) {
    throw new Error(`version ${packageJson.version} is already bound to ${versionTag} at ${existingVersionCommit}; current candidate ${candidateSha} must use a new version`)
  }
  const packResult = JSON.parse(output('npm', ['pack', '--json', '--pack-destination', tempRoot]))
  const pack = packResult[0]
  const tarballPath = join(tempRoot, pack.filename)
  const packJsonPath = join(tempRoot, 'npm-pack.json')
  writeFileSync(packJsonPath, `${JSON.stringify(pack, null, 2)}\n`)
  const tarballSha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex')
  const candidateEnv = {
    ...process.env,
    ATELIER_CANDIDATE_TARBALL: tarballPath,
    ATELIER_CANDIDATE_PACK_JSON: packJsonPath,
    ATELIER_EXPECTED_TARBALL_SHA256: tarballSha256,
  }

  run('npm', ['run', 'release:audit'], candidateEnv)
  run('npm', ['run', 'consumer:smoke'], candidateEnv)
  run('npm', ['run', 'distribution:smoke'], candidateEnv)

  console.log(`[release:candidate] commit ${candidateSha}; SHA-256 ${tarballSha256}; ${pack.entryCount} packed file(s); one artifact passed audit, consumer, and distribution gates`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
