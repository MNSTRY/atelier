#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileScanPatterns, STRUCTURAL_FORBIDDEN_CONTENT } from './structural-patterns.mjs'
import { checkForbiddenEgress, discoverForbiddenEgressScanFiles } from '../src/egress/forbidden-egress.mjs'

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
  /^NOTICE$/,
  /^TRADEMARKS\.md$/,
  /^SECURITY\.md$/,
  /^bin\/atelier\.mjs$/,
  /^bin\/mnstry-atelier\.mjs$/,
  /^contracts\/[a-z0-9.-]+\.json$/,
  // Text formats only: every packed file is content-scanned as utf8, so a
  // binary (whose text can hide in compressed chunks) would ship unscanned.
  /^fixtures\/[A-Za-z0-9./_-]+\.(json|md|html|yaml|yml|csv)$/,
  /^skills\/(codex|claude)\/[a-z0-9-]+\/SKILL\.md$/,
  /^src\/[a-z0-9./-]+\.mjs$/,
  /^templates\/[A-Za-z0-9./_-]+(?:\.(json|md)|\.?gitignore)$/,
  /^docs\/[a-z0-9./_-]+\.md$/,
  /^announcements\/(keys\/)?[A-Za-z0-9.-]+\.json$/,
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
if (packageJson.bin?.mnstry) fail('package must not claim the bare mnstry command name')
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

// Release claims are about the exact tarball, not a hand-maintained source
// directory list. This inventory includes test-like directories under shipped
// paths; only an explicit, reviewable fixture marker may suppress a fixture.
const packedEgressFiles = discoverForbiddenEgressScanFiles({ root: packageRoot, files: paths })
for (const finding of checkForbiddenEgress({ root: packageRoot, files: paths })) {
  console.error(`[release:audit] packed egress finding ${finding.file}:${finding.line} ${finding.type}: ${finding.detail}`)
  failures += 1
}

for (const requiredPortableFile of [
  'docs/local-services.md',
  'skills/codex/atelier-local-service/SKILL.md',
  'skills/claude/atelier-local-service/SKILL.md',
  'skills/codex/atelier-public-boundary/SKILL.md',
  'skills/claude/atelier-public-boundary/SKILL.md',
]) {
  if (!paths.includes(requiredPortableFile)) {
    console.error(`[release:audit] tarball must include ${requiredPortableFile}`)
    failures += 1
  }
}

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

// Apache-2.0 section 4(d): every derivative redistribution must reproduce
// the NOTICE file, so the published tarball has to carry it.
if (!paths.includes('NOTICE')) {
  console.error('[release:audit] tarball must include NOTICE')
  failures += 1
}

// The announcements channel is verify-only for consumers: shipping the
// documents without the public key would leave every subcommand dead.
const announcementsKey = 'announcements/keys/mnstry-announcements.public.v1.json'
if (!paths.includes(announcementsKey)) {
  console.error(`[release:audit] tarball must include ${announcementsKey}`)
  failures += 1
}

for (const filePath of paths) {
  if (!allowedFiles.some((pattern) => pattern.test(filePath))) {
    console.error(`[release:audit] unexpected tarball file: ${filePath}`)
    failures += 1
    continue
  }

  // Content scanning is a utf8 regex pass, so a binary file would ship
  // effectively unscanned (text can hide in compressed chunks). Nothing
  // binary is allowed to pack rather than allowing it past the scrub.
  const bytes = readFileSync(join(packageRoot, filePath))
  if (bytes.includes(0)) {
    console.error(`[release:audit] binary file cannot be content-scanned: ${filePath}`)
    failures += 1
    continue
  }

  // A lossy utf8 read turns undecodable bytes into replacement characters, so
  // a NUL-free binary would scan as harmless text while still carrying
  // recoverable content. Decoding strictly refuses it instead.
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    console.error(`[release:audit] file is not valid UTF-8 text and cannot be content-scanned: ${filePath}`)
    failures += 1
    continue
  }
  for (const { pattern, label } of forbiddenContent) {
    if (pattern.test(text)) {
      console.error(`[release:audit] ${filePath} contains ${label}`)
      failures += 1
    }
  }

  // No packed JSON may carry a JWK private scalar: the announcements channel
  // dies the moment a private half is published, and the same mistake in any
  // fixture would ship a signing key.
  if (filePath.endsWith('.json')) {
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      console.error(`[release:audit] packed JSON document does not parse: ${filePath}`)
      failures += 1
      continue
    }
    // Precise rather than broad: a member named d holding a base64url run
    // long enough to be a real scalar (Ed25519 and P-256 are both 43
    // characters). Matching every member named d at any depth would make a
    // future fixture with an unrelated d field fail for no reason.
    const carriesPrivateScalar = (value) => {
      if (Array.isArray(value)) return value.some(carriesPrivateScalar)
      if (!value || typeof value !== 'object') return false
      if (typeof value.d === 'string' && /^[A-Za-z0-9_-]{40,}$/.test(value.d)) return true
      return Object.values(value).some(carriesPrivateScalar)
    }
    if (carriesPrivateScalar(doc)) {
      console.error(`[release:audit] packed JSON document carries a private key member: ${filePath}`)
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

console.log(`[release:audit] ${paths.length} tarball file(s) passed OSS scrub; ${packedEgressFiles.length} executable/markup file(s) passed egress scan`)
