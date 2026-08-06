#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileScanPatterns, STRUCTURAL_FORBIDDEN_CONTENT } from './structural-patterns.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const expectedPackageName = '@mnstry/atelier'
const expectedVersion = packageJson.version
const expectedTarballName = `${packageJson.name.replace(/^@/, '').replace('/', '-')}-${expectedVersion}.tgz`

const allowedFiles = [
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^TRADEMARKS\.md$/,
  /^bin\/atelier\.mjs$/,
  /^bin\/mnstry-atelier\.mjs$/,
  /^contracts\/[a-z0-9.-]+\.json$/,
  /^fixtures\/[A-Za-z0-9./_-]+\.(json|md|html)$/,
  /^skills\/(codex|claude)\/[a-z0-9-]+\/SKILL\.md$/,
  /^src\/[a-z0-9./-]+\.mjs$/,
  /^templates\/[A-Za-z0-9./_-]+(?:\.(json|md)|\.?gitignore)$/,
  /^docs\/[a-z0-9./_-]+\.md$/,
]

const structuralForbiddenContent = STRUCTURAL_FORBIDDEN_CONTENT

// Client-zero and person-specific name patterns live in a gitignored local
// denylist so the committed audit does not disclose what it scrubs for.
// Load precedence: ATELIER_DENYLIST_JSON env -> release-denylist.local.json -> fail closed.
const localDenylistPath = join(packageRoot, 'release-denylist.local.json')
let denylistDoc = null
if (process.env.ATELIER_DENYLIST_JSON) {
  denylistDoc = JSON.parse(process.env.ATELIER_DENYLIST_JSON)
} else if (existsSync(localDenylistPath)) {
  denylistDoc = JSON.parse(readFileSync(localDenylistPath, 'utf8'))
}
let localDenylist = []
if (denylistDoc) {
  localDenylist = compileScanPatterns(denylistDoc.patterns)
} else if (process.env.ATELIER_ALLOW_MISSING_DENYLIST === '1') {
  console.warn('[release:audit] WARNING: denylist unavailable and ATELIER_ALLOW_MISSING_DENYLIST=1 acknowledged — private-name scrub skipped; structural checks still apply')
} else {
  console.error('[release:audit] denylist unavailable: provide ATELIER_DENYLIST_JSON, restore release-denylist.local.json, or set ATELIER_ALLOW_MISSING_DENYLIST=1 to acknowledge a structural-only run')
  process.exit(2)
}

const forbiddenContent = [...structuralForbiddenContent, ...localDenylist]

function fail(message) {
  console.error(`[release:audit] ${message}`)
  process.exitCode = 1
}

function packDryRun() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = JSON.parse(stdout)
  return result[0]
}

if (packageJson.private !== false) fail('package.json must set private false before publish')
if (packageJson.license !== 'Apache-2.0') fail('package license must be Apache-2.0')
if (packageJson.name !== expectedPackageName) fail(`package name must be ${expectedPackageName}`)
if (!packageJson.bin?.atelier) fail('package must expose the atelier CLI')
if (!packageJson.bin?.mnstry) fail('package must expose the mnstry CLI')
if (!packageJson.bin?.['mnstry-atelier']) fail('package must expose the mnstry-atelier legacy CLI')
if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) fail('package must use a files allowlist')

const changelog = readFileSync(join(packageRoot, 'CHANGELOG.md'), 'utf8')
if (!changelog.includes(`## ${expectedVersion}`)) fail(`CHANGELOG.md must contain a "## ${expectedVersion}" heading`)
const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8')
if (!readme.includes(expectedVersion)) fail(`README.md must mention version ${expectedVersion}`)

const pack = packDryRun()
if (pack.name !== expectedPackageName) fail(`npm pack name must be ${expectedPackageName}`)
if (pack.filename !== expectedTarballName) fail(`npm pack filename must be ${expectedTarballName}`)
const paths = pack.files.map((entry) => entry.path).sort()
let failures = 0

if (!paths.includes('bin/atelier.mjs')) {
  console.error('[release:audit] tarball must include bin/atelier.mjs')
  failures += 1
}

if (!paths.includes('bin/mnstry-atelier.mjs')) {
  console.error('[release:audit] tarball must include bin/mnstry-atelier.mjs')
  failures += 1
}

// The normative attribution and trademark policy every distribution points at.
// Shipping the package without it would leave TRADEMARKS.md references in the
// CLI, docs, and distribution check dangling for an installed consumer.
if (!paths.includes('TRADEMARKS.md')) {
  console.error('[release:audit] tarball must include TRADEMARKS.md')
  failures += 1
}

for (const filePath of paths) {
  if (!allowedFiles.some((pattern) => pattern.test(filePath))) {
    console.error(`[release:audit] unexpected tarball file: ${filePath}`)
    failures += 1
    continue
  }

  const text = readFileSync(join(packageRoot, filePath), 'utf8')
  for (const { pattern, label } of forbiddenContent) {
    if (pattern.test(text)) {
      console.error(`[release:audit] ${filePath} contains ${label}`)
      failures += 1
    }
  }
}

if (paths.some((filePath) => filePath.includes('node_modules/'))) {
  console.error('[release:audit] tarball must not include node_modules')
  failures += 1
}

if (failures > 0 || process.exitCode) {
  process.exit(1)
}

console.log(`[release:audit] ${paths.length} tarball file(s) passed OSS scrub`)
