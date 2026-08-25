#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , requestedScript, ...args] = process.argv

function renderError(error) {
  const debug = process.env.ATELIER_DEBUG === '1'
  if (debug) {
    console.error(error?.stack || String(error))
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1
  }
  if (typeof error?.code === 'string' && error.code) {
    console.error(`[${error.code}] ${error.message}`)
    if (error.hint) console.error(`Next: ${error.hint}`)
    return Number.isInteger(error.exitCode) ? error.exitCode : 2
  }
  console.error('[internal-error] command failed without a safe diagnostic')
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
