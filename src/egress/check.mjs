import fs from 'node:fs'
import path from 'node:path'
import { packageRootFrom } from '../project/package-root.mjs'

const ROOT = packageRootFrom(import.meta.url)
const SCAN_DIRS = ['bin', 'src']
const FORBIDDEN = [
  { pattern: /fetch\(\s*['"]https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/, label: 'non-localhost fetch' },
  { pattern: /https?\.request\s*\(/, label: 'http request primitive' },
  { pattern: /new\s+WebSocket\s*\(/, label: 'websocket egress primitive' },
  { pattern: /net\.connect\s*\(/, label: 'net connect primitive' },
  { pattern: /dns\./, label: 'dns primitive' },
  { pattern: /\bcurl\s+https?:\/\//, label: 'shell network call' },
]

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(abs, files)
    else if (/\.(mjs|js|sh)$/.test(ent.name)) files.push(abs)
  }
  return files
}

export function checkForbiddenEgress(root = ROOT) {
  const failures = []
  for (const rel of SCAN_DIRS) {
    for (const file of walk(path.join(root, rel))) {
      const text = fs.readFileSync(file, 'utf8')
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(text)) failures.push(`${path.relative(root, file)}:${rule.label}`)
      }
    }
  }
  return failures
}

export function runEgressCommand() {
  const failures = checkForbiddenEgress()
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log('[egress:check] no forbidden non-localhost egress found in package runtime paths')
}
