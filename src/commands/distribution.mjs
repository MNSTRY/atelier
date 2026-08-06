#!/usr/bin/env node
// atelier distribution check — verifies that a distribution package carries
// the required MNSTRY attribution markers. The normative attribution policy
// lives in TRADEMARKS.md under "Required attribution"; this command checks
// only the mechanical markers and points there rather than restating policy.
//
// Exit codes: 0 = checks passed, 1 = blocking attribution check failed,
// 2 = usage error (unknown subcommand or unusable target).
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from '../project/config.mjs'

const ATTRIBUTION_BYTES = 'powered by MNSTRY Atelier'
const ATTRIBUTION_EXT_KEY = 'mnstry.atelier/attribution'
const PACK_MANIFEST_NAME = 'atelier.pack.json'
const PREFIX = '[atelier-distribution:check]'
const POLICY_POINTER = 'see TRADEMARKS.md ("Required attribution") and docs/attestation.md'

const log = (message) => console.log(`${PREFIX} ${message}`)
const logError = (message) => console.error(`${PREFIX} ${message}`)

// Paths in output stay relative to the checked distribution so logs never
// leak machine-local absolute paths.
const displayPath = (target, file) => path.relative(target, file) || path.basename(file)

function checkReadmeAttribution(target) {
  const readmePath = path.join(target, 'README.md')
  let bytes
  try {
    bytes = fs.readFileSync(readmePath)
  } catch {
    return { ok: false, reason: 'README.md is missing from the distribution root' }
  }
  if (!bytes.includes(ATTRIBUTION_BYTES)) {
    return { ok: false, reason: `README.md does not contain the exact byte string "${ATTRIBUTION_BYTES}"` }
  }
  return { ok: true }
}

function manifestIn(dir) {
  const file = path.join(dir, PACK_MANIFEST_NAME)
  return fs.existsSync(file) ? file : null
}

function findPackManifests(target, packOverride) {
  if (typeof packOverride === 'string' && packOverride.trim()) {
    const resolved = path.resolve(packOverride)
    let stat = null
    try {
      stat = fs.statSync(resolved)
    } catch {
      return { manifests: [], note: `--pack path does not exist: ${packOverride}` }
    }
    if (stat.isDirectory()) {
      const manifest = manifestIn(resolved)
      if (manifest) return { manifests: [manifest], note: null }
      return { manifests: [], note: `--pack directory has no ${PACK_MANIFEST_NAME}: ${packOverride}` }
    }
    return { manifests: [resolved], note: null }
  }

  const packsRoot = path.join(target, 'packs')
  let entries = []
  try {
    entries = fs.readdirSync(packsRoot, { withFileTypes: true })
  } catch {
    return { manifests: [], note: `no packs/ directory found; nothing to check for the pack-manifest attribution key` }
  }
  const manifests = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => manifestIn(path.join(packsRoot, entry.name)))
    .filter(Boolean)
  if (!manifests.length) {
    return { manifests: [], note: `no ${PACK_MANIFEST_NAME} found under packs/` }
  }
  return { manifests, note: null }
}

// Advisory only: reported, never blocking, regardless of what it finds.
function reportPackAttribution(target, packOverride) {
  const { manifests, note } = findPackManifests(target, packOverride)
  if (note) log(`advisory: ${note}`)
  for (const manifest of manifests) {
    const shown = displayPath(target, manifest)
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    } catch {
      log(`advisory: ${shown} is not readable JSON; attribution key not verified`)
      continue
    }
    if (doc?.ext?.[ATTRIBUTION_EXT_KEY] === ATTRIBUTION_BYTES) {
      log(`advisory: ${shown} declares ext["${ATTRIBUTION_EXT_KEY}"] — satisfied`)
    } else {
      log(`advisory: ${shown} does not declare ext["${ATTRIBUTION_EXT_KEY}"] — ${POLICY_POINTER}`)
    }
  }
}

function runCheck(args) {
  const target = path.resolve(typeof args.target === 'string' ? args.target : '.')
  let stat = null
  try {
    stat = fs.statSync(target)
  } catch {
    stat = null
  }
  if (!stat?.isDirectory()) {
    logError(`target is not a directory: ${typeof args.target === 'string' ? args.target : target}`)
    process.exit(2)
  }

  const readme = checkReadmeAttribution(target)
  reportPackAttribution(target, args.pack)

  if (!readme.ok) {
    logError(`${readme.reason}; distributions must carry the MNSTRY attribution — ${POLICY_POINTER}`)
    process.exit(1)
  }
  log('required README.md attribution present')
  log('distribution check passed')
  process.exit(0)
}

const args = parseArgs(process.argv.slice(2))
const subcommand = args._[0] || 'check'
if (subcommand === 'check') {
  runCheck(args)
} else {
  logError(`Unknown distribution command: ${subcommand}`)
  logError('Usage: distribution check [--target DIR] [--pack DIR]')
  process.exit(2)
}
