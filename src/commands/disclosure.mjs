import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compileDisclosurePatterns,
  isPathIgnored,
  isPathTracked,
  scanDisclosureContent,
} from '../disclosure/content-scan.mjs'

export function runDisclosureCommand(argv = process.argv.slice(2), { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  let root = process.cwd()
  let staged = false
  let structuralOnly = false
  let untrusted = false
  let failOnBinary = false
  let denylistPath = null

  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]
      if (arg === 'check') continue
      if (arg === '--root') {
        root = requiredValue(argv, ++index, '--root')
      } else if (arg === '--denylist') {
        denylistPath = requiredValue(argv, ++index, '--denylist')
      } else if (arg === '--staged') {
        staged = true
      } else if (arg === '--structural-only') {
        structuralOnly = true
      } else if (arg === '--untrusted') {
        untrusted = true
      } else if (arg === '--fail-on-binary') {
        failOnBinary = true
      } else {
        return usageError(stderr, `unknown argument: ${arg}`)
      }
    }
  } catch (error) {
    return usageError(stderr, error.message)
  }

  const resolvedRoot = path.resolve(root)
  let denylistPatterns = []
  if (!structuralOnly) {
    const denylist = loadDenylist({ root: resolvedRoot, denylistPath, env, stderr })
    if (!denylist.ok) return 2
    try {
      denylistPatterns = compileDisclosurePatterns(denylist.document.patterns)
    } catch (error) {
      stderr(`[disclosure:check] ${error.message}`)
      return 2
    }
  }

  let report
  try {
    report = scanDisclosureContent({
      root: resolvedRoot,
      staged,
      denylistPatterns,
      failOnBinary,
    })
  } catch (error) {
    stderr(`[disclosure:check] ${error.message}`)
    return 2
  }

  if (!report.ok) {
    if (untrusted) {
      stderr('[disclosure:check] findings present (details suppressed: untrusted tree)')
    } else {
      for (const finding of report.findings) {
        const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`
        stderr(`[disclosure:check] ${finding.label}: ${location}`)
      }
      stderr(`[disclosure:check] ${report.findings.length} finding(s)`)
    }
    return 1
  }

  const binaryNote = report.skippedBinary.length > 0
    ? `; ${report.skippedBinary.length} binary file(s) skipped${failOnBinary ? '' : ' (use --fail-on-binary for public text-only surfaces)'}`
    : ''
  stdout(`[disclosure:check] clean: ${report.scannedFiles} ${staged ? 'staged' : 'tracked'} text file(s)${binaryNote}`)
  return 0
}

function loadDenylist({ root, denylistPath, env, stderr }) {
  if (env.ATELIER_DENYLIST_JSON) {
    try {
      return { ok: true, document: JSON.parse(env.ATELIER_DENYLIST_JSON) }
    } catch {
      stderr('[disclosure:check] ATELIER_DENYLIST_JSON is not valid JSON')
      return { ok: false }
    }
  }

  const candidate = path.resolve(root, denylistPath ?? '.atelier-local/disclosure-denylist.json')
  if (!fs.existsSync(candidate)) {
    stderr('[disclosure:check] private denylist unavailable; provide ATELIER_DENYLIST_JSON, --denylist FILE, or pass --structural-only explicitly')
    return { ok: false }
  }
  if (isPathTracked(root, candidate)) {
    stderr('[disclosure:check] refusing a Git-tracked private denylist')
    return { ok: false }
  }
  if (path.resolve(candidate).startsWith(`${path.resolve(root)}${path.sep}`) && !isPathIgnored(root, candidate)) {
    stderr('[disclosure:check] a repository-local private denylist must be covered by .gitignore')
    return { ok: false }
  }

  try {
    return { ok: true, document: JSON.parse(fs.readFileSync(candidate, 'utf8')) }
  } catch {
    stderr('[disclosure:check] private denylist is not valid JSON')
    return { ok: false }
  }
}

function requiredValue(argv, index, flag) {
  if (!argv[index]) throw new Error(`${flag} requires a value`)
  return argv[index]
}

function usageError(stderr, message) {
  stderr(`[disclosure:check] ${message}`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runDisclosureCommand()
}
