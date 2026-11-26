#!/usr/bin/env node

// Checks that install and current-package version pins in user-facing entry
// documents stay aligned with package.json#version. Historical prose (such as
// "since 0.2.0-alpha.13" or "v0.2.0-alpha.0" epoch notes) is not matched; only
// explicit package-install pins (`@mnstry/atelier@<ver>` and git `#v<ver>`).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PIN_PATTERNS = [
  { label: 'npm pin', regex: /@mnstry\/atelier@(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g },
  { label: 'git tag pin', regex: /github\.com\/MNSTRY\/atelier\.git#v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g },
]

export const VERSION_PIN_FILES = [
  'README.md',
  'docs/start/install.md',
]

export function findVersionPinDrift({ expectedVersion, files }) {
  const findings = []
  for (const { path: relPath, content } of files) {
    let matchedAny = false
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const { label, regex } of PIN_PATTERNS) {
        regex.lastIndex = 0
        let match
        while ((match = regex.exec(line)) !== null) {
          matchedAny = true
          const found = match[1]
          if (found !== expectedVersion) {
            findings.push(`${relPath}:${index + 1} ${label} points at ${found}, expected ${expectedVersion}`)
          }
        }
      }
    }
    if (!matchedAny) {
      findings.push(`${relPath} contains no @mnstry/atelier version pin`)
    }
  }
  return findings
}

export function checkVersionPinsInRoot(root, expectedVersion, { requireAllFiles = false } = {}) {
  const findings = []
  const files = []
  for (const relPath of VERSION_PIN_FILES) {
    const fullPath = join(root, relPath)
    if (!existsSync(fullPath)) {
      if (requireAllFiles) findings.push(`${relPath} is missing`)
      continue
    }
    files.push({
      path: relPath,
      content: readFileSync(fullPath, 'utf8'),
    })
  }
  return [...findings, ...findVersionPinDrift({ expectedVersion, files })]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const findings = checkVersionPinsInRoot(packageRoot, packageJson.version, { requireAllFiles: true })
  if (findings.length > 0) {
    for (const finding of findings) console.error(`[version-pins] ${finding}`)
    process.exit(1)
  }
  console.log(`[version-pins] all install pins in ${VERSION_PIN_FILES.join(', ')} match ${packageJson.version}`)
}
