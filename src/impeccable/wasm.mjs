import { digest } from '../capabilities/files.mjs'
import { compileImpeccablePolicy, interpretImpeccableDetection } from './index.mjs'
import { impeccableFindingExitCode } from './engine-contract.mjs'

const MAX_BYTES = 2 * 1024 * 1024
const FILE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/

// The host admits, instantiates and isolates the exact pinned synchronous module.
// This adapter neither loads that module nor authenticates its supplied build digest.
export function detectImpeccableWasmSource(input, module) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).some(key => !['source', 'policy', 'engine', 'engineDigest', 'file', 'content'].includes(key))) {
    throw new Error('invalid WASM source request')
  }
  const { source, policy, engine, engineDigest, file, content } = input
  if (!['source', 'static-html'].includes(engine)) throw new Error('unsupported WASM source engine')
  if (typeof file !== 'string' || !FILE.test(file) || file.split('/').some(part => ['', '.', '..'].includes(part))) {
    throw new Error('bounded relative display file required')
  }
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_BYTES) {
    throw new Error('invalid or oversized WASM source content')
  }
  // Reuse the existing checks and snapshot source/policy before any export call.
  const checked = interpretImpeccableDetection({ source, policy, engine, engineDigest, exitCode: 1, stdout: '', stderr: '' })
  const policySnapshot = compileImpeccablePolicy({ requiredRules: policy.requiredRules, advisoryRules: policy.advisoryRules })
  if (policySnapshot.digest !== checked.policyDigest) throw new Error('policy changed during snapshot')
  const base = { source: checked.source, policy: policySnapshot, engine, engineDigest }
  const name = engine === 'source' ? 'detect_text_json' : 'detect_html_source_json'
  const detect = module?.[name]
  if (typeof detect !== 'function') throw new Error('required WASM detector export is unavailable')
  const target = { file, digest: digest(content), bytes: Buffer.byteLength(content) }
  const finish = (stdout, stderr, exitCode, exitCodeSource) => ({
    target,
    result: interpretImpeccableDetection({ ...base, stdout, stderr, exitCode }),
    exitCodeSource,
    limitations: [
      'The exit code is derived from a synchronous WASM export, not captured from a process.',
      'The host owns module provenance, execution isolation and time/memory budgets.',
      'The display file and target digest do not authenticate the supplied canonical source reference.',
      'Source checks do not establish rendered coverage; static HTML sees inline CSS only in this profile.',
    ],
  })
  let stdout
  try {
    stdout = detect(content, file, JSON.stringify({ inlineIgnores: false }))
  } catch (error) {
    const stderr = typeof error === 'string' ? error : error instanceof Error ? error.message : 'WASM export failed'
    return finish('', stderr, 1, 'export-threw')
  }
  if (typeof stdout !== 'string') throw new Error('WASM detector must return a primitive JSON string')
  if (stdout.includes('\0') || Buffer.byteLength(stdout) > MAX_BYTES) {
    return finish(stdout, '', 1, 'invalid-export-output')
  }
  let findings
  try { findings = JSON.parse(stdout) } catch { return finish(stdout, '', 1, 'invalid-export-output') }
  if (!Array.isArray(findings)) return finish(stdout, '', 1, 'invalid-export-output')
  return finish(stdout, '', impeccableFindingExitCode(findings), 'derived-from-findings')
}
