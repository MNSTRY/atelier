// `atelier knowledge semantic <operation>`: the public command surface over the
// internal semantic operation runner (src/knowledge/semantic-operation.mjs).
//
// The runner checks only `begin`'s request and some nested values as closed
// shapes; its other methods read their fields by name and ignore extras. This
// adapter closes every request itself, before the runner is constructed, so a
// refused request writes nothing. A valid request is passed on unchanged.
//
// Atelier calls no model here. The host supplies raw output, candidates and
// usage; receiver records are caller assertions, not authentication.
import { createSemanticOperation } from '../knowledge/semantic-operation.mjs'
import { encodeKnowledgeOutput } from '../knowledge/context.mjs'
import { parseArgs } from '../project/config.mjs'
import { safeCommandMessage } from '../cli/command-failure.mjs'

export const SEMANTIC_REQUEST_BYTES = 256 * 1024

// Required fields are never null. Fields the runner reads as objects, arrays or
// text are checked for that type here, so a wrong type is a typed refusal
// rather than a JavaScript error from inside the runner.
const spec = (method, required, optional = [], types = {}) => Object.freeze({ method, required: Object.freeze(required), optional: Object.freeze(optional), types: Object.freeze(types) })
export const SEMANTIC_COMMANDS = Object.freeze({
  begin: spec('begin', ['operationId', 'attemptId', 'at', 'term', 'plan', 'references', 'identityCandidates', 'extractor', 'confirm'], [],
    { plan: 'object', references: 'array', identityCandidates: 'array', extractor: 'object' }),
  status: spec('status', ['operationId']),
  reconcile: spec('reconcile', ['operationId', 'at', 'by', 'reason', 'outcome', 'confirm']),
  complete: spec('complete', ['operationId', 'output', 'expectedOutputDigest', 'candidates', 'usage', 'at', 'confirm'], [],
    { output: 'string', candidates: 'object', usage: 'object' }),
  proposals: spec('proposals', ['operationId', 'query'], ['limit']),
  contribution: spec('prepareContribution', ['operationId', 'id', 'kind', 'candidateId', 'source', 'sourceBinding', 'term', 'at', 'confirm'], ['supersedes', 'revisionReason'],
    { source: 'object', sourceBinding: 'object' }),
  relation: spec('prepareRelation', ['assertion', 'at', 'confirm'], [], { assertion: 'object' }),
  record: spec('record', ['record', 'confirm'], [], { record: 'object' }),
  cascade: spec('cascade', ['withdrawalId', 'at', 'confirm']),
  context: spec('context', ['query']),
  project: spec('project', ['activationId', 'namespace']),
})

const USAGE = `use knowledge semantic ${Object.keys(SEMANTIC_COMMANDS).join('|')} with one JSON object on stdin; see knowledge --help`

class SemanticRequestError extends Error {
  constructor(code, message) { super(message); this.name = 'SemanticRequestError'; this.code = code }
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactFields = (value, required, optional = []) => plainObject(value)
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  && required.every(key => Object.hasOwn(value, key))

async function readRequest() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > SEMANTIC_REQUEST_BYTES) throw new SemanticRequestError('SEMANTIC_OPERATION_LIMIT', 'semantic request exceeds 256 KiB')
    chunks.push(chunk)
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new SemanticRequestError('SEMANTIC_OPERATION_INVALID', 'semantic request must be UTF-8 JSON') }
}

// The closed envelope and the per-command field set, checked before any store is opened.
export function selectSemanticRequest(command, body) {
  const selected = SEMANTIC_COMMANDS[command]
  if (!exactFields(body, ['workspaceId', 'run', 'request']) || typeof body.workspaceId !== 'string' || typeof body.run !== 'string')
    throw new SemanticRequestError('SEMANTIC_OPERATION_INVALID', 'semantic request needs exactly workspaceId, run and request')
  if (!exactFields(body.request, selected.required, selected.optional))
    throw new SemanticRequestError('SEMANTIC_OPERATION_INVALID', `unknown or missing ${command} request field`)
  const typeOk = { object: plainObject, array: Array.isArray, string: value => typeof value === 'string' }
  for (const field of selected.required) {
    const value = body.request[field]
    if (value === null || value === undefined || (selected.types[field] && !typeOk[selected.types[field]](value)))
      throw new SemanticRequestError('SEMANTIC_OPERATION_INVALID', `invalid ${command} request field type: ${field}`)
  }
  return selected
}

const TYPED = /^SEMANTIC_[A-Z_]+$/
// The printed failure for an error, or null when it must go to the command
// executor's redaction. Three cases:
// - a SEMANTIC_* refusal keeps its own code;
// - any error after the runner saved a write or raw output keeps that
//   recorded/captured detail, as SEMANTIC_OPERATION_INTERRUPTED when uncoded;
// - Atelier's own other refusals (safe text, no host detail) become
//   SEMANTIC_OPERATION_REFUSED.
// Only an error with unsafe text and nothing saved is left to the executor.
export function semanticFailure(error) {
  const typed = typeof error?.code === 'string' && TYPED.test(error.code)
  const saved = error?.recorded !== undefined || error?.captured !== undefined
  const message = safeCommandMessage(error)
  if (!typed && !saved && message === null) return null
  const failure = { ok: false, code: typed ? error.code : saved ? 'SEMANTIC_OPERATION_INTERRUPTED' : 'SEMANTIC_OPERATION_REFUSED', error: message ?? '[internal-error]' }
  if (error.recorded !== undefined) failure.recorded = error.recorded
  if (error.captured !== undefined) failure.captured = error.captured
  return failure
}

function reportSemanticFailure(error) {
  const failure = semanticFailure(error)
  if (failure === null) throw error
  console.error(JSON.stringify(failure))
  process.exitCode = 1
}

export async function runKnowledgeSemantic(argv) {
  try {
    const args = parseArgs(argv)
    const command = args._[0]
    if (args._.length !== 1 || !Object.hasOwn(SEMANTIC_COMMANDS, command) || Object.keys(args).some(key => key !== '_'))
      throw new SemanticRequestError('SEMANTIC_OPERATION_INVALID', USAGE)
    const body = await readRequest()
    const selected = selectSemanticRequest(command, body)
    // The workspace is the current directory, as for ingest and learn: the
    // runner reads the ingestion store that `atelier ingest` writes there.
    const runner = createSemanticOperation({ workspaceRoot: process.cwd(), workspaceId: body.workspaceId, run: body.run })
    process.stdout.write(encodeKnowledgeOutput(runner[selected.method](body.request)))
  } catch (error) {
    reportSemanticFailure(error)
  }
}
