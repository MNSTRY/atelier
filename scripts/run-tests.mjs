#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Select only regular test files. Helpers and linked directories are not tests.
export function discoverTests(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...discoverTests(absolute))
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(absolute)
  }
  return files.sort()
}

const entrypoint = fs.realpathSync(fileURLToPath(import.meta.url))
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === entrypoint
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const packageRoot = path.dirname(path.dirname(entrypoint))
  try {
    const files = discoverTests(path.join(packageRoot, 'test'))
    if (files.length === 0) throw new Error('No .test.mjs files found under test/')
    const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
      cwd: packageRoot,
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error) throw new Error(`Test process failed: ${result.error.code}`)
    process.exitCode = result.status ?? 1
  } catch (error) {
    console.error(`[test] ${error.message}`)
    process.exitCode = 1
  }
}
