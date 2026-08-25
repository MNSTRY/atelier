import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

function refuseExisting(path) {
  if (existsSync(path)) throw new Error(`release candidate output already exists: ${path}`)
}

function atomicCopy(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`
  refuseExisting(destination)
  try {
    copyFileSync(source, temporary, 0)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function persistReleaseCandidate({
  outputDir,
  tarballPath,
  packJsonPath,
  candidateSha,
  packageName,
  version,
  tarballSha256,
  entryCount,
}) {
  const destinationRoot = resolve(outputDir)
  mkdirSync(destinationRoot, { recursive: true })

  const destinationTarball = join(destinationRoot, basename(tarballPath))
  const destinationPackJson = join(destinationRoot, 'npm-pack.json')
  const receiptPath = join(destinationRoot, 'release-candidate.json')
  refuseExisting(destinationPackJson)
  refuseExisting(receiptPath)

  atomicCopy(tarballPath, destinationTarball)
  try {
    atomicCopy(packJsonPath, destinationPackJson)
    const receipt = {
      schema: 'mnstry.atelier-release-candidate@v1',
      candidateSha,
      packageName,
      version,
      tarballPath: destinationTarball,
      tarballFilename: basename(destinationTarball),
      tarballSha256,
      entryCount,
      packJsonPath: destinationPackJson,
    }
    const temporaryReceipt = `${receiptPath}.tmp-${process.pid}`
    try {
      writeFileSync(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
      renameSync(temporaryReceipt, receiptPath)
    } finally {
      rmSync(temporaryReceipt, { force: true })
    }
    return { ...receipt, receiptPath }
  } catch (error) {
    rmSync(destinationTarball, { force: true })
    rmSync(destinationPackJson, { force: true })
    rmSync(receiptPath, { force: true })
    throw error
  }
}

export function readReleaseCandidateReceipt(receiptPath) {
  return JSON.parse(readFileSync(receiptPath, 'utf8'))
}
