#!/usr/bin/env node
// atelier extension-pack validate|list
//
// Self-contained subcommand parser (no shared CLI plumbing) so the module can
// be invoked directly: node src/commands/extension-pack.mjs <subcommand> ...
//
// Exit codes: 0 every enabled pack loads clean (warnings do not fail),
// 1 an enabled pack failed to load, 2 usage or project resolution error.
// No network access anywhere in this command. Log-safety contract: output
// names pack ids, declared paths, and loader messages; it never echoes pack
// or protocol file contents.

import path from 'node:path'
import { ATELIER_EXT_NAMESPACE, loadExtensionPacks } from '../extension-packs/loader.mjs'
import { asObject, commandProject } from '../project/config.mjs'

const REPORT_SCHEMA = 'mnstry.atelier-extension-pack-report@v1'
const LIST_SCHEMA = 'mnstry.atelier-extension-pack-list@v1'

const USAGE = `Usage: atelier extension-pack <subcommand>

Subcommands:
  validate [--json] [--project ./atelier.project.json]
      Load every declared extension pack in report mode and print one line
      per pack (ok, error, or skipped) with errors and warnings indented.
      --json emits { schema: "${REPORT_SCHEMA}", packs, ok }.

  list [--json] [--project ./atelier.project.json]
      Show declared packs with id, version, enabled, config-relative path, digest,
      protocol count, and lock status (locked, unlocked, or mismatch).
      This is the default subcommand.

Packs are declared in the tracked project config under
ext["${ATELIER_EXT_NAMESPACE}"].extensionPacks. Pack protocols are resolvable
by full namespaced id only; the machine-local overlay can disable a declared
pack but can never enable an undeclared one.

Exit codes: 0 every enabled pack loads clean (warnings do not fail),
1 an enabled pack failed to load, 2 usage or project resolution error.`

function fail(message) {
  console.error(message)
  process.exit(2)
}

// --project / --project-config (both --flag VALUE and --flag=VALUE forms) are
// recognized here for the unknown-option check only; commandProject reads the
// same process.argv itself, so the values need no forwarding.
const OPTION_SPEC = { json: 'flag', project: 'value', 'project-config': 'value' }

function parseOptions(argv) {
  const options = { json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (!arg.startsWith('--')) {
      fail(`unexpected argument: ${arg}\n\n${USAGE}`)
    }
    const name = arg.slice(2).split('=')[0]
    if (!(name in OPTION_SPEC)) fail(`unknown option --${name}\n\n${USAGE}`)
    if (OPTION_SPEC[name] === 'flag') {
      options[name] = true
    } else if (!arg.includes('=')) {
      i += 1
      if (argv[i] === undefined) fail(`--${name} requires a value`)
    }
  }
  return options
}

function resolveProject() {
  try {
    return commandProject()
  } catch (error) {
    fail(error.message)
  }
  return null
}

function declaredEntries(project) {
  const container = asObject(asObject(asObject(project?.config).ext)[ATELIER_EXT_NAMESPACE])
  return Array.isArray(container.extensionPacks) ? container.extensionPacks : []
}

const LOCK_MISMATCH_PATTERN = /^lock (version|digest) mismatch/
const portablePath = (file) => file.split(path.sep).join('/')

// One row per declared entry, in declaration order, joining the loader report
// back onto the declaration. Loader messages without a usable packId (project-
// level problems and malformed entries) surface separately as project rows.
function buildRows(project, result) {
  const entries = declaredEntries(project)
  const attributed = new Set()
  const rows = entries.map((entry, index) => {
    const id = typeof entry?.id === 'string' && entry.id ? entry.id : null
    const label = id ?? `extensionPacks[${index}]`
    const record = id ? result.packs.find((pack) => pack.id === id) ?? null : null
    const skippedEntry = id ? result.skipped.find((item) => item.packId === id) ?? null : null
    const errors = id ? result.errors.filter((item) => item.packId === id).map((item) => item.message) : []
    const warnings = id ? result.warnings.filter((item) => item.packId === id).map((item) => item.message) : []
    if (id) attributed.add(id)
    const status = record ? 'ok' : skippedEntry ? 'skipped' : 'error'
    const declaredPath = typeof entry?.path === 'string' && entry.path ? entry.path : null
    // Log-safety: paths in output stay relative to the project config dir
    // (same rationale as distribution.mjs) so neither text nor --json output
    // ever leaks machine-local absolute paths.
    const resolvedPath = record?.path ?? (declaredPath ? path.resolve(project.configDir, declaredPath) : null)
    const displayPath = resolvedPath ? portablePath(path.relative(project.configDir, resolvedPath) || '.') : null
    return {
      id: label,
      status,
      // Effective enablement: the declared flag minus any disable (config or
      // machine-local overlay); skippedReason names which disable applied.
      enabled: entry?.enabled === true && !skippedEntry,
      skippedReason: skippedEntry?.reason ?? null,
      version: record?.version ?? (typeof entry?.version === 'string' ? entry.version : null),
      path: displayPath,
      digest: record?.digest ?? null,
      protocolCount: record ? record.protocols.length : null,
      lock: record ? record.lock : errors.some((message) => LOCK_MISMATCH_PATTERN.test(message)) ? 'mismatch' : null,
      errors,
      warnings,
    }
  })
  const projectErrors = result.errors.filter((item) => !item.packId || !attributed.has(item.packId)).map((item) => item.message)
  const projectWarnings = result.warnings.filter((item) => !item.packId || !attributed.has(item.packId)).map((item) => item.message)
  return { rows, projectErrors, projectWarnings }
}

function loadReport() {
  const project = resolveProject()
  const result = loadExtensionPacks(project, { report: true })
  return { project, result, ...buildRows(project, result) }
}

function printIndented(row) {
  for (const message of row.errors) console.log(`  error: ${message}`)
  for (const message of row.warnings) console.log(`  warning: ${message}`)
}

function runValidate(argv) {
  const options = parseOptions(argv)
  const { result, rows, projectErrors, projectWarnings } = loadReport()
  const ok = result.errors.length === 0
  if (options.json) {
    const packs = rows.map(({ id, status, enabled, skippedReason, version, path: packPath, digest, protocolCount, lock, errors, warnings }) => ({
      id, status, enabled, skippedReason, version, path: packPath, digest, protocolCount, lock, errors, warnings,
    }))
    console.log(JSON.stringify({ schema: REPORT_SCHEMA, ok, packs, errors: projectErrors, warnings: projectWarnings }, null, 2))
  } else {
    if (!rows.length && !projectErrors.length) console.log('no extension packs declared')
    for (const row of rows) {
      const detail = row.status === 'ok'
        ? ` (${row.version}, ${row.protocolCount} ${row.protocolCount === 1 ? 'protocol' : 'protocols'}, ${row.lock})`
        : row.status === 'skipped' ? ` (${row.skippedReason})` : ''
      console.log(`${row.id} ${row.status}${detail}`)
      printIndented(row)
    }
    if (projectErrors.length || projectWarnings.length) {
      console.log('project')
      for (const message of projectErrors) console.log(`  error: ${message}`)
      for (const message of projectWarnings) console.log(`  warning: ${message}`)
    }
  }
  process.exit(ok ? 0 : 1)
}

function runList(argv) {
  const options = parseOptions(argv)
  const { result, rows, projectErrors, projectWarnings } = loadReport()
  const ok = result.errors.length === 0
  if (options.json) {
    const packs = rows.map(({ id, status, enabled, skippedReason, version, path: packPath, digest, protocolCount, lock }) => ({
      id, status, enabled, skippedReason, version, path: packPath, digest, protocolCount, lock,
    }))
    console.log(JSON.stringify({ schema: LIST_SCHEMA, ok, packs, errors: projectErrors, warnings: projectWarnings }, null, 2))
  } else {
    if (!rows.length) console.log('no extension packs declared')
    for (const row of rows) {
      console.log(row.id)
      console.log(`  status: ${row.status}${row.skippedReason ? ` (${row.skippedReason})` : ''}`)
      console.log(`  version: ${row.version ?? 'unknown'}`)
      console.log(`  enabled: ${row.enabled ? 'yes' : 'no'}`)
      if (row.path) console.log(`  path: ${row.path}`)
      if (row.digest) console.log(`  digest: ${row.digest}`)
      if (row.protocolCount !== null) console.log(`  protocols: ${row.protocolCount}`)
      if (row.lock) console.log(`  lock: ${row.lock}`)
    }
    if (projectErrors.length || projectWarnings.length) {
      console.log('project')
      for (const message of projectErrors) console.log(`  error: ${message}`)
      for (const message of projectWarnings) console.log(`  warning: ${message}`)
    }
  }
  process.exit(ok ? 0 : 1)
}

const argv = process.argv.slice(2)
const first = argv[0]
if (first === '--help' || first === '-h' || first === 'help') {
  console.log(USAGE)
  process.exit(0)
}
if (first === 'validate') runValidate(argv.slice(1))
else if (first === 'list') runList(argv.slice(1))
else if (first === undefined || first.startsWith('--')) runList(argv)
else fail(`unknown extension-pack subcommand: ${first}\n\n${USAGE}`)
