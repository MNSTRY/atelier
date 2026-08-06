#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProjectConfig } from '../project/config.mjs'

export const SUPPORT_BUNDLE_PREVIEW_SCHEMA = 'mnstry.atelier-support-bundle-preview@v1'

export const DEFAULT_SUPPORT_FIELDS = [
  'nodeVersion',
  'platform',
  'packageVersion',
  'command',
  'localErrorSummary',
]

export const BANNED_KEY_PATTERNS = [
  /prompt/i,
  /secret/i,
  /token/i,
  /password/i,
  /private/i,
  /email/i,
  /remote/i,
  /url/i,
]

export const BANNED_VALUE_PATTERNS = [
  { type: 'absolute-path', re: /(?:^|[\s"'])\/(?:Users|home)\/[^/\s"']+\/[^\s"']+/ },
  { type: 'repo-file-path', re: /(?:^|[\s"'])(?:[a-z0-9._-]+)\/(?:APP|app|src|docs|private|secrets?)\/[^\s"']+/i },
  { type: 'kg-node-id', re: /(?:^|[\s"'])[a-z][a-z0-9._-]*:[a-z0-9._:-]*[a-z][a-z0-9._:-]*/i },
  { type: 'git-remote', re: /\b(?:git@|https:\/\/github\.com\/)[^\s"']+/i },
  // Bounded on purpose. The unbounded local-part and domain runs backtracked
  // catastrophically on large non-email input: a few hundred KB of
  // address-shaped characters with no "@" took about a minute to reject, which
  // would turn any capped file attachment into a stall. RFC 5321 caps the
  // local part at 64 octets and the domain at 255, so every real address
  // still matches.
  { type: 'email', re: /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,}\b/i },
  { type: 'hostname-or-url', re: /\b(?:https?:\/\/|wss?:\/\/)(?!localhost\b|127\.0\.0\.1\b|\[?::1\]?)[^\s"']+/i },
  { type: 'secret', re: /\b(?:sk|pk|ghp|gho|pat|xoxb|AKIA)[-_A-Za-z0-9]{12,}\b/ },
  // Every PEM private-key header, not only the bare PKCS#8 one. The previous
  // form allowed exactly one word between BEGIN and KEY, so an ssh-keygen
  // default key (OPENSSH PRIVATE KEY) and the RSA/EC/DSA/ENCRYPTED and PGP
  // "PRIVATE KEY BLOCK" headers all passed the scan untouched. Kept identical
  // to the structural pattern in scripts/structural-patterns.mjs.
  // The literal must not match itself: this file ships in the tarball and
  // release:audit scans it with that structural pattern.
  // Keys in this kit are JWK, not PEM: the PEM patterns above never saw the
  // one key format atelier itself writes. Both patterns match key material
  // rather than prose about it — a document may discuss privateKeyJwk, and
  // 40 is the floor for a real scalar (Ed25519 and P-256 are both 43
  // base64url characters), so shorter identifiers under a member named d
  // do not fire, and a redacted example in documentation stays attachable. Escaped JSON evades text patterns, which is why a context
  // file that parses as JSON is walked structurally as well.
  { type: 'jwk-private-key', re: /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/ },
  { type: 'jwk-private-key-document', re: /"privateKeyJwk"\s*:\s*\{[^{}]*"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/ },
  { type: 'private-key', re: /BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?|BEGIN (?:RSA|OPENSSH) KEY/ },
]

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function hashPayload(payload) {
  const clone = { ...payload }
  delete clone.hash
  return crypto.createHash('sha256').update(JSON.stringify(stable(clone))).digest('hex')
}

function count(value) {
  return Array.isArray(value) ? value.length : 0
}

function visit(value, fn, pathParts = []) {
  fn(value, pathParts)
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, fn, [...pathParts, String(index)]))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      visit(item, fn, [...pathParts, key])
    }
  }
}

export function validateSupportBundlePayload(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['support bundle payload must be an object']
  }
  if (value.schema !== SUPPORT_BUNDLE_PREVIEW_SCHEMA) {
    errors.push(`schema must be ${SUPPORT_BUNDLE_PREVIEW_SCHEMA}`)
  }
  if (value.sendPath !== false) errors.push('sendPath must be false')
  if (value.background !== false && value.background != null) errors.push('background must be false when present')
  if (value.telemetry && value.telemetry !== 'none') errors.push('telemetry must be none')

  visit(value, (item, parts) => {
    const key = parts.at(-1) || ''
    if (key && BANNED_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      errors.push(`banned key ${parts.join('.')}`)
    }
    if (typeof item === 'string') {
      for (const { type, re } of BANNED_VALUE_PATTERNS) {
        if (re.test(item)) errors.push(`banned value ${type} at ${parts.join('.') || '<root>'}`)
      }
    }
  })
  return errors
}

export function buildSupportBundlePreview({
  state = 'support_bundle',
  fields = DEFAULT_SUPPORT_FIELDS,
  artifacts = null,
  generatedAt = new Date(0).toISOString(),
} = {}) {
  const payload = {
    schema: SUPPORT_BUNDLE_PREVIEW_SCHEMA,
    state,
    telemetry: 'none',
    sendPath: false,
    background: false,
    generatedAt,
    fields: [...fields],
    artifacts: state === 'none' ? [] : (artifacts || [
      {
        kind: 'local-diagnostic',
        label: 'operator-reviewed-summary',
        count: count(fields),
      },
    ]),
  }
  return {
    ...payload,
    hash: hashPayload(payload),
  }
}

export function supportBundlePreview(project = null) {
  const projectShape = project ? ['schema', 'source', 'repos.length'] : DEFAULT_SUPPORT_FIELDS
  return buildSupportBundlePreview({
    state: 'support_bundle',
    fields: projectShape,
    artifacts: [
      {
        kind: 'local-diagnostic',
        label: project ? 'project-config-shape' : 'operator-reviewed-summary',
        count: count(projectShape),
      },
    ],
  })
}

export function readSupportBundleJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeOrPrintSupportBundle(payload, out = null) {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (!out) {
    process.stdout.write(text)
    return
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text, { mode: 0o600 })
}

export function parseSupportBundleArgs(argv = process.argv.slice(2)) {
  const args = { state: 'support_bundle', out: null, projectArgs: [] }
  for (const arg of argv) {
    if (arg === '--none') args.state = 'none'
    else if (arg.startsWith('--state=')) args.state = arg.slice('--state='.length)
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length)
    else if (arg === '--help' || arg === '-h') args.help = true
    else args.projectArgs.push(arg)
  }
  return args
}

function usage() {
  return [
    'Usage: node src/support/support-bundle.mjs [--none|--state=support_bundle] [--out=FILE] [--project-config=FILE]',
    '',
    'Builds a local preview only. It never sends or uploads support data.',
  ].join('\n')
}

export function runSupportCommand(argv = process.argv.slice(2)) {
  const args = parseSupportBundleArgs(argv)
  if (args.help) {
    console.log(usage())
    return 0
  }
  const project = resolveProjectConfig({ argv: args.projectArgs })
  const payload = args.state === 'none'
    ? buildSupportBundlePreview({ state: 'none' })
    : supportBundlePreview(project)
  const errors = validateSupportBundlePayload(payload)
  if (errors.length) {
    for (const error of errors) console.error(`[atelier-support-bundle] ${error}`)
    return 1
  }
  writeOrPrintSupportBundle(payload, args.out)
  return 0
}

function main() {
  try {
    process.exitCode = runSupportCommand()
  } catch (error) {
    console.error(`[atelier-support-bundle] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main()
}
