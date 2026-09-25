#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , requestedScript, ...args] = process.argv

// Only Atelier's own typed codes (lowercase words joined by hyphens) are
// printed verbatim. Node's system and internal errors (ENOENT, EACCES, ERR_*)
// carry a string code too, but their messages name absolute paths and no next
// step, so they are redacted to the code and system call alone.
const TYPED_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const NODE_CODE = /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/
const SYSCALL = /^[a-z_]+$/

function untypedDetail(error) {
  if (typeof error?.code !== 'string' || !NODE_CODE.test(error.code)) return ''
  const syscall = typeof error.syscall === 'string' && SYSCALL.test(error.syscall) ? ` from ${error.syscall}` : ''
  return ` (${error.code}${syscall})`
}

function renderError(error) {
  const debug = process.env.ATELIER_DEBUG === '1'
  if (debug) {
    console.error(error?.stack || String(error))
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1
  }
  if (typeof error?.code === 'string' && TYPED_CODE.test(error.code)) {
    console.error(`[${error.code}] ${error.message}`)
    if (error.hint) console.error(`Next: ${error.hint}`)
    return Number.isInteger(error.exitCode) ? error.exitCode : 2
  }
  console.error(`[internal-error] command failed without a safe diagnostic${untypedDetail(error)}`)
  console.error('Next: rerun with ATELIER_DEBUG=1 to inspect the stack locally.')
  return 1
}

if (!requestedScript) {
  console.error('[command-missing] no command module was selected')
  process.exit(2)
}

const scriptPath = path.resolve(requestedScript)
process.argv = [process.execPath, scriptPath, ...args]

try {
  await import(pathToFileURL(scriptPath).href)
} catch (error) {
  process.exitCode = renderError(error)
}
