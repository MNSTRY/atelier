#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const baselinePath = join(packageRoot, 'contracts', 'public-api-baseline.json')

export function publicApiCompatibilityFindings({ baseline, packageJson, moduleExports }) {
  const findings = []
  for (const subpath of baseline.requiredSubpaths) {
    if (!Object.hasOwn(packageJson.exports ?? {}, subpath)) {
      findings.push(`published package subpath removed: ${subpath}`)
    }
  }
  for (const [subpath, requiredNames] of Object.entries(baseline.requiredModuleExports)) {
    const actual = new Set(moduleExports[subpath] ?? [])
    for (const name of requiredNames) {
      if (!actual.has(name)) findings.push(`published named export removed: ${subpath} -> ${name}`)
    }
  }
  return findings
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function main() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const moduleExports = {}
  for (const subpath of Object.keys(baseline.requiredModuleExports)) {
    const target = packageJson.exports?.[subpath]
    if (typeof target !== 'string' || !target.endsWith('.mjs')) continue
    const module = await import(pathToFileURL(join(packageRoot, target)).href)
    moduleExports[subpath] = Object.keys(module)
  }

  const findings = publicApiCompatibilityFindings({ baseline, packageJson, moduleExports })
  for (const finding of findings) console.error(`[public-api:compat] ${finding}`)

  const head = gitOutput(['rev-parse', 'HEAD'])
  let baselineCommit = null
  try {
    baselineCommit = gitOutput(['rev-parse', `${baseline.baselineTag}^{commit}`])
  } catch {
    console.error(`[public-api:compat] baseline tag is unavailable: ${baseline.baselineTag}`)
    process.exit(2)
  }
  if (!baseline.baselineCommit || baseline.baselineCommit !== baselineCommit) {
    console.error(`[public-api:compat] baseline provenance mismatch: ${baseline.baselineTag} resolves to ${baselineCommit}, recorded ${baseline.baselineCommit ?? 'none'}`)
    findings.push('public API baseline provenance drift')
  }
  if (packageJson.version === baseline.baselineVersion && head !== baselineCommit) {
    console.error(`[public-api:compat] version ${packageJson.version} is already bound to ${baseline.baselineTag} at ${baselineCommit}; current HEAD ${head} must use a new version`)
    findings.push('published version identity reused')
  }

  if (findings.length > 0) process.exit(1)
  console.log(`[public-api:compat] ${baseline.requiredSubpaths.length} published subpath(s) and ${Object.values(baseline.requiredModuleExports).reduce((sum, names) => sum + names.length, 0)} named export(s) remain compatible with registry-verified ${baseline.baselineTag} (${baseline.baselineCommit})`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  await main()
}
