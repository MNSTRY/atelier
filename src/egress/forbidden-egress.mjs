#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '../..')

export const TEST_FIXTURE_ALLOW_MARKER = '@atelier-egress-allow-test-fixture'
export const LOCAL_COMPUTED_ALLOW_MARKER = '@atelier-egress-local-computed'

export const DEFAULT_EGRESS_SCAN_PATHS = [
  'src',
  'scripts',
  'bin',
  'lib',
  'server',
  'ui',
  'harness',
  'support',
  'egress',
  'analysis',
  'collaboration',
]

const SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.sh'])
const SKIP_DIRS = new Set(['node_modules', '.git'])
const INTERNAL_SCANNER_FILES = new Set(['forbidden-egress.mjs'])

function isTestFile(file) {
  return /(?:^|[/.])test(?:s)?[/.]/.test(file) || /\.(?:test|spec)\.[cm]?[jt]s$/.test(file)
}

function isMarkedTestFixture(file, text) {
  return isTestFile(file) && text.includes(TEST_FIXTURE_ALLOW_MARKER)
}

function shouldScanFile(file, { includeTests = false } = {}) {
  if (!SCRIPT_EXTS.has(path.extname(file))) return false
  if (INTERNAL_SCANNER_FILES.has(path.basename(file))) return false
  if (!includeTests && isTestFile(file)) return false
  return true
}

function walk(dir, options = {}) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name), options))
    } else {
      const file = path.join(dir, entry.name)
      if (shouldScanFile(file, options)) out.push(file)
    }
  }
  return out
}

function uniqueFiles(files) {
  return [...new Set(files.map((file) => path.resolve(file)))]
}

export function discoverForbiddenEgressScanFiles({
  root = packageRoot,
  scanPaths = DEFAULT_EGRESS_SCAN_PATHS,
  includeTests = false,
} = {}) {
  const files = []
  for (const rel of scanPaths) {
    const abs = path.resolve(root, rel)
    if (!fs.existsSync(abs)) continue
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) files.push(...walk(abs, { includeTests }))
    else if (shouldScanFile(abs, { includeTests })) files.push(abs)
  }
  return uniqueFiles(files)
}

function hostnameFromNetworkUrl(value) {
  try {
    return new URL(value).hostname
  } catch {
    const match = String(value || '').match(/^(?:https?|wss?):\/\/(\[[^\]]+\]|[^/:${}\s]+)/i)
    if (match) return match[1].replace(/^\[|\]$/g, '')
    return ''
  }
}

function isLocalHostname(hostname) {
  const clean = String(hostname || '').toLowerCase()
  return clean === 'localhost' || clean === '::1' || /^127(?:\.\d{1,3}){3}$/.test(clean)
}

function isNetworkUrl(value) {
  return /^(?:https?|wss?):\/\//i.test(String(value || ''))
}

function isLocalUrl(value) {
  if (!isNetworkUrl(value)) return false
  return isLocalHostname(hostnameFromNetworkUrl(value))
}

function stringLiterals(text) {
  const literals = []
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g
  let match
  while ((match = re.exec(text))) {
    literals.push(match[2])
  }
  return literals
}

function firstNonLocalNetworkLiteral(text) {
  return stringLiterals(text).find((literal) => isNetworkUrl(literal) && !isLocalUrl(literal))
}

function firstLocalNetworkLiteral(text) {
  return stringLiterals(text).find((literal) => isLocalUrl(literal))
}

function firstRelativePathLiteral(text) {
  return stringLiterals(text).find((literal) => /^\/(?!\/)/.test(literal))
}

function firstNonLocalHostLiteral(text) {
  return stringLiterals(text).find((literal) => {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(literal)) return false
    return !isLocalHostname(literal)
  })
}

function firstLocalHostLiteral(text) {
  return stringLiterals(text).find((literal) => isLocalHostname(literal))
}

function callBlock(lines, index) {
  return lines.slice(index, Math.min(lines.length, index + 5)).join('\n')
}

function isFixtureAllowed(lines, index, file) {
  return isTestFile(file) && callBlock(lines, Math.max(0, index - 2)).includes(TEST_FIXTURE_ALLOW_MARKER)
}

function isLocalComputedAllowed(lines, index) {
  return callBlock(lines, Math.max(0, index - 2)).includes(LOCAL_COMPUTED_ALLOW_MARKER)
}

function trimmedCodeLine(line) {
  return line.replace(/\/\/.*$/, '').trim()
}

function addFinding(findings, file, line, type, detail) {
  findings.push({ file, line, type, detail })
}

function jsFindingsForBlock(block, { findings, file, line, allowLocalComputed = false }) {
  const nonLocalNetwork = firstNonLocalNetworkLiteral(block)
  const localNetwork = firstLocalNetworkLiteral(block)
  const relativePath = firstRelativePathLiteral(block)
  const nonLocalHost = firstNonLocalHostLiteral(block)
  const localHost = firstLocalHostLiteral(block)

  if (/\bfetch\s*\(/.test(block)) {
    if (nonLocalNetwork) addFinding(findings, file, line, 'non-localhost-fetch', nonLocalNetwork)
    else if (!localNetwork && !relativePath && !allowLocalComputed) addFinding(findings, file, line, 'fetch-unresolved', 'computed fetch target')
  }
  if (/\bnew\s+WebSocket\s*\(/.test(block)) {
    if (nonLocalNetwork) addFinding(findings, file, line, 'websocket-egress', nonLocalNetwork)
    else if (!localNetwork && !relativePath && !allowLocalComputed) addFinding(findings, file, line, 'websocket-unresolved', 'computed websocket target')
  }
  if (/\bhttps?\.request\s*\(/.test(block)) {
    if (nonLocalNetwork || nonLocalHost) addFinding(findings, file, line, 'non-localhost-http-request', nonLocalNetwork || nonLocalHost)
    else if (!localNetwork && !localHost && !allowLocalComputed) addFinding(findings, file, line, 'http-request-unresolved', 'computed HTTP request target')
  }
  if (/\bnet\.connect\s*\(/.test(block) || /\bnet\.createConnection\s*\(/.test(block)) {
    if (nonLocalHost || nonLocalNetwork) addFinding(findings, file, line, 'net-connect-egress', nonLocalHost || nonLocalNetwork)
    else if (!localHost && !localNetwork && !allowLocalComputed) addFinding(findings, file, line, 'net-connect-unresolved', 'computed socket target')
  }
  if (/\bdns\.(?:resolve|lookup|promises\.resolve|promises\.lookup)\s*\(/.test(block)) {
    if (nonLocalHost) addFinding(findings, file, line, 'dns-egress', nonLocalHost)
    else if (!localHost && !allowLocalComputed) addFinding(findings, file, line, 'dns-unresolved', 'computed DNS target')
  }
}

function shellWords(line) {
  return line.match(/(?:[^\s'"`]+|'[^']*'|"[^"]*")+/g) || []
}

function unquote(value) {
  return String(value || '').replace(/^['"]|['"]$/g, '')
}

function firstNonLocalNetworkWord(line) {
  return shellWords(line).map(unquote).find((word) => isNetworkUrl(word) && !isLocalUrl(word))
}

function firstLocalNetworkWord(line) {
  return shellWords(line).map(unquote).find((word) => isLocalUrl(word))
}

function firstShellHostArg(line, commandRe) {
  if (!commandRe.test(line)) return ''
  const words = shellWords(line).map(unquote)
  for (const word of words.slice(1)) {
    const candidate = word.includes(':') ? word.split(':')[0] : word
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate) && !isLocalHostname(candidate)) return candidate
  }
  return ''
}

function shellFindingsForLine(line, { findings, file, lineNumber }) {
  const clean = String(line || '').trim()
  if (!clean || clean.startsWith('#')) return
  if (/\b(?:curl|wget)\b/.test(clean)) {
    const nonLocal = firstNonLocalNetworkWord(clean)
    const local = firstLocalNetworkWord(clean)
    if (nonLocal) addFinding(findings, file, lineNumber, 'shell-http-egress', nonLocal)
    else if (!local && /\bhttps?:\/\//.test(clean)) addFinding(findings, file, lineNumber, 'shell-http-unresolved', 'computed shell HTTP target')
  }
  const socketHost = firstShellHostArg(clean, /\b(?:nc|ncat|telnet)\b/)
  if (socketHost) addFinding(findings, file, lineNumber, 'shell-socket-egress', socketHost)
  const opensslHost = firstShellHostArg(clean, /\bopenssl\s+s_client\b/)
  if (opensslHost) addFinding(findings, file, lineNumber, 'shell-socket-egress', opensslHost)
}

export function forbiddenEgressFindingsForText(text, { file = 'input' } = {}) {
  if (isMarkedTestFixture(file, text)) return []
  const findings = []
  const lines = String(text || '').split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    if (isFixtureAllowed(lines, index, file)) continue
    const lineCode = trimmedCodeLine(lines[index])
    const hasJsPrimitive = /\b(?:fetch|https?\.request|new\s+WebSocket|net\.connect|net\.createConnection|dns\.(?:resolve|lookup|promises\.resolve|promises\.lookup))\s*\(/.test(lineCode)
    const block = callBlock(lines, index)
    if (hasJsPrimitive) {
      jsFindingsForBlock(block, {
        findings,
        file,
        line: index + 1,
        allowLocalComputed: isLocalComputedAllowed(lines, index),
      })
    }
    shellFindingsForLine(lines[index], { findings, file, lineNumber: index + 1 })
  }

  const seen = new Set()
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.line}:${finding.type}:${finding.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function checkForbiddenEgress({
  root = packageRoot,
  scanPaths = DEFAULT_EGRESS_SCAN_PATHS,
  includeTests = false,
} = {}) {
  const findings = []
  for (const file of discoverForbiddenEgressScanFiles({ root, scanPaths, includeTests })) {
    const rel = path.relative(root, file)
    findings.push(...forbiddenEgressFindingsForText(fs.readFileSync(file, 'utf8'), { file: rel }))
  }
  return findings
}

function main() {
  const findings = checkForbiddenEgress()
  if (findings.length) {
    for (const finding of findings) {
      console.error(`[atelier-egress] ${finding.file}:${finding.line} ${finding.type}: ${finding.detail}`)
    }
    process.exitCode = 1
    return
  }
  console.log('[atelier-egress] no forbidden network egress found')
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main()
}
