#!/usr/bin/env node
// atelier distribution check — verifies that a distribution package carries
// the required MNSTRY attribution markers. The normative attribution policy
// lives in TRADEMARKS.md under "Required attribution"; this command checks
// only the mechanical markers and points there rather than restating policy.
//
// Exit codes: 0 = checks passed, 1 = blocking attribution check failed,
// 2 = usage error (unknown subcommand or unusable target).
import { spawnSync } from 'node:child_process'
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

// Blocking CLI probe. runCli accepts injected stdout/stderr writers, so a
// wrapper can swallow the attribution that help/version output carries. The
// probe therefore spawns the distribution's own declared bin with --version
// through real pipes (not the wrapper's writers) and requires the exact
// attribution byte string in the child's stdout.
//
// The probe is opt-out-proof for anything that looks like a distribution:
// a target that depends on @mnstry/atelier, ships packs/, or carries an
// atelier.project.json MUST declare a probe-able bin — a missing or empty
// bin, or a package.json that does not parse, is a blocking failure there.
// Only a target with none of those markers gets the advisory skip (packages
// without a CLI exist). A declared bin that cannot be resolved, or whose
// --version stdout lacks the attribution bytes, is always blocking.
function looksLikeDistribution(target, pkg) {
  if (pkg && (pkg.dependencies?.['@mnstry/atelier'] || pkg.peerDependencies?.['@mnstry/atelier'] || pkg.devDependencies?.['@mnstry/atelier'])) return true
  if (fs.existsSync(path.join(target, 'packs'))) return true
  if (fs.existsSync(path.join(target, 'atelier.project.json'))) return true
  return false
}

function declaredBinEntries(target) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { pkg: null, entries: null }
    // A manifest that exists but does not parse must never be
    // indistinguishable from an absent one.
    return { pkg: null, entries: null, malformed: true }
  }
  const bin = pkg?.bin
  if (typeof bin === 'string' && bin.trim()) {
    return { pkg, entries: [{ name: typeof pkg.name === 'string' ? pkg.name : 'bin', file: bin.trim() }] }
  }
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const entries = Object.entries(bin)
      .filter(([, file]) => typeof file === 'string' && file.trim())
      .map(([name, file]) => ({ name, file: file.trim() }))
    if (entries.length) return { pkg, entries }
  }
  return { pkg, entries: null }
}

function checkBinAttribution(target) {
  const { pkg, entries, malformed } = declaredBinEntries(target)
  if (malformed) {
    return { ok: false, reason: 'package.json exists but does not parse; the CLI attribution probe cannot be skipped by shipping a malformed manifest' }
  }
  if (entries === null) {
    if (looksLikeDistribution(target, pkg)) {
      return { ok: false, reason: 'target looks like a distribution (declares @mnstry/atelier, ships packs/, or carries atelier.project.json) but declares no probe-able bin; a distribution CLI must exist and carry the attribution' }
    }
    return { ok: true, note: 'no package.json bin declared and no distribution markers; CLI attribution probe skipped' }
  }
  for (const { name, file } of entries) {
    const resolved = path.resolve(target, file)
    if (!fs.existsSync(resolved)) {
      return { ok: false, reason: `declared bin "${name}" cannot be resolved: ${displayPath(target, resolved)}` }
    }
    const result = spawnSync(process.execPath, [resolved, '--version'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 30_000,
    })
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    if (result.error || !stdout.includes(ATTRIBUTION_BYTES)) {
      return {
        ok: false,
        reason: `declared bin "${name}" --version stdout does not contain the exact byte string "${ATTRIBUTION_BYTES}"`,
      }
    }
  }
  return { ok: true, note: null }
}

function usageExit(message) {
  logError(message)
  logError('Usage: distribution check [--target DIR] [--pack DIR]')
  process.exit(2)
}

function runCheck(args) {
  if (args.target === true) usageExit('--target requires a value')
  if (args.pack === true) usageExit('--pack requires a value')
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
  const binProbe = checkBinAttribution(target)
  reportPackAttribution(target, args.pack)
  if (binProbe.note) log(`advisory: ${binProbe.note}`)

  if (!readme.ok) {
    logError(`${readme.reason}; distributions must carry the MNSTRY attribution — ${POLICY_POINTER}`)
    process.exit(1)
  }
  if (!binProbe.ok) {
    logError(`${binProbe.reason}; distributions must carry the MNSTRY attribution — ${POLICY_POINTER}`)
    process.exit(1)
  }
  log('required README.md attribution present')
  if (!binProbe.note) log('declared bin --version output carries the required attribution')
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
