#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const expectedPackageName = '@mnstry/atelier'
const expectedTarballName = 'mnstry-atelier-0.1.0-alpha.2.tgz'

const allowedFiles = [
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^bin\/atelier\.mjs$/,
  /^bin\/mnstry-atelier\.mjs$/,
  /^contracts\/[a-z0-9.-]+\.json$/,
  /^fixtures\/(?!atelier-export\/sample-private-offer)(?!atelier-extension-pack\/client-zero\.client-zero)[A-Za-z0-9./_-]+\.(json|md|html)$/,
  /^skills\/(codex|claude)\/[a-z0-9-]+\/SKILL\.md$/,
  /^src\/[a-z0-9./-]+\.mjs$/,
  /^templates\/[A-Za-z0-9./_-]+(?:\.(json|md)|\.gitignore)$/,
  /^docs\/[a-z0-9./_-]+\.md$/,
]

const forbiddenContent = [
  { pattern: /\/Users\//, label: 'absolute user path' },
  { pattern: /\/var\/folders\//, label: 'machine-local temp path' },
  { pattern: /\.codex/, label: 'agent-local state path' },
  { pattern: /\.client-zero-local/, label: 'client-zero local state path' },
  { pattern: /\bClient zero\b|client-zero-|client-zero:/i, label: 'Client zero client-zero content' },
  { pattern: /\bBrandA\b/i, label: 'client-zero brand content' },
  { pattern: /\bPersonC\b|\bPersonD\b|\bProjectY\b/, label: 'project/person-specific content' },
  { pattern: /private[- ]hire/i, label: 'client-zero offer content' },
  { pattern: /BEGIN (RSA|OPENSSH|PRIVATE) KEY/, label: 'private key material' },
  { pattern: /\b(api[_-]?key|secret|password|token)\b\s*[:=]/i, label: 'secret-like assignment' },
]

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

const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
if (packageJson.private !== false) fail('package.json must set private false before publish')
if (packageJson.version !== '0.1.0-alpha.2') fail('package version must be 0.1.0-alpha.2 for this release slice')
if (packageJson.license !== 'Apache-2.0') fail('package license must be Apache-2.0')
if (packageJson.name !== expectedPackageName) fail(`package name must be ${expectedPackageName}`)
if (!packageJson.bin?.atelier) fail('package must expose the atelier CLI')
if (!packageJson.bin?.mnstry) fail('package must expose the mnstry CLI')
if (!packageJson.bin?.['mnstry-atelier']) fail('package must expose the mnstry-atelier legacy CLI')
if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) fail('package must use a files allowlist')

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
