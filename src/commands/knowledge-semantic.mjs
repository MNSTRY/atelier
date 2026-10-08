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

// Every request field has a declared kind, checked before the runner exists, so
// a wrong kind is a typed refusal with nothing written. Formats (timestamps,
// digests, identifiers) are the runner's to judge. Required fields are never
// null; optional ones may be null only where the kind says so.
const S = 'string', O = 'object', A = 'array'
const spec = (method, types, optional = []) => Object.freeze({ method, types: Object.freeze(types),
  required: Object.freeze(Object.keys(types).filter(field => !optional.includes(field))), optional: Object.freeze(optional) })
export const SEMANTIC_COMMANDS = Object.freeze({
  begin: spec('begin', { operationId: S, attemptId: S, at: S, term: S, plan: O, references: A, identityCandidates: A, extractor: O, confirm: S }),
  status: spec('status', { operationId: S }),
  reconcile: spec('reconcile', { operationId: S, at: S, by: S, reason: S, outcome: S, confirm: S }),
  complete: spec('complete', { operationId: S, output: S, expectedOutputDigest: S, candidates: O, usage: O, at: S, confirm: S }),
  proposals: spec('proposals', { operationId: S, query: S, limit: 'integer' }, ['limit']),
  contribution: spec('prepareContribution', { operationId: S, id: S, kind: 'interpretation-kind', candidateId: S, source: O, sourceBinding: O, term: S, at: S, confirm: S,
    supersedes: 'object-or-null', revisionReason: 'string-or-null' }, ['supersedes', 'revisionReason']),
  relation: spec('prepareRelation', { assertion: O, at: S, confirm: S }),
  record: spec('record', { record: O, confirm: S }),
  cascade: spec('cascade', { withdrawalId: S, at: S, confirm: S }),
  context: spec('context', { query: S }),
  project: spec('project', { activationId: S, namespace: S }),
})

const USAGE = `use knowledge semantic ${Object.keys(SEMANTIC_COMMANDS).join('|')} with one JSON object on stdin; see knowledge --help`

class SemanticRequestError extends Error {
  constructor(code, message) { super(message); this.name = 'SemanticRequestError'; this.code = code }
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const KINDS = Object.freeze({
  string: value => typeof value === 'string',
  object: plainObject,
  array: Array.isArray,
  integer: Number.isSafeInteger,
  'object-or-null': value => value === null || plainObject(value),
  'string-or-null': value => value === null || typeof value === 'string',
  // The runner maps exactly these three kinds; any other, even an inherited
  // property name, is refused here.
  'interpretation-kind': value => value === 'entity' || value === 'assertion' || value === 'unknown',
})
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
  for (const [field, value] of Object.entries(body.request))
    if (!KINDS[selected.types[field]](value)) throw new SemanticRequestError('SEMANTIC_OPERATION_INVALID', `invalid ${command} request field type: ${field}`)
  return selected
}

const TYPED = /^SEMANTIC_[A-Z_]+$/
// The printed failure for an error, or null when it must go to the command
// executor's redaction. Three cases:
// - a SEMANTIC_* refusal keeps its own code;
// - any error carrying the runner's recorded/captured detail keeps it, as
//   SEMANTIC_OPERATION_INTERRUPTED when uncoded;
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
