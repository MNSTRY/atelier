#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const roots = ['bin', 'src']

function collectModules(directory, files = []) {
  if (!fs.existsSync(directory)) return files
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) collectModules(absolute, files)
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(absolute)
  }
  return files
}

const files = roots
  .flatMap((root) => collectModules(path.join(packageRoot, root)))
  .sort((left, right) => left.localeCompare(right))

let failures = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status === 0) continue
  failures += 1
  const relative = path.relative(packageRoot, file)
  console.error(`[syntax:check] ${relative} failed`)
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  if (detail) console.error(detail)
  if (result.error) console.error(result.error.message)
}

if (failures > 0) {
  console.error(`[syntax:check] ${failures} module${failures === 1 ? '' : 's'} failed`)
  process.exit(1)
}

console.log(`[syntax:check] ${files.length} modules passed`)
