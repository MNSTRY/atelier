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
import { reportCommandFailure, safeCommandMessage } from '../cli/command-failure.mjs'

export const SEMANTIC_REQUEST_BYTES = 256 * 1024

const spec = (method, required, optional = []) => Object.freeze({ method, required: Object.freeze(required), optional: Object.freeze(optional) })
export const SEMANTIC_COMMANDS = Object.freeze({
  begin: spec('begin', ['operationId', 'attemptId', 'at', 'term', 'plan', 'references', 'identityCandidates', 'extractor', 'confirm']),
  status: spec('status', ['operationId']),
  reconcile: spec('reconcile', ['operationId', 'at', 'by', 'reason', 'outcome', 'confirm']),
  complete: spec('complete', ['operationId', 'output', 'expectedOutputDigest', 'candidates', 'usage', 'at', 'confirm']),
  proposals: spec('proposals', ['operationId', 'query'], ['limit']),
  contribution: spec('prepareContribution', ['operationId', 'id', 'kind', 'candidateId', 'source', 'sourceBinding', 'term', 'at', 'confirm'], ['supersedes', 'revisionReason']),
  relation: spec('prepareRelation', ['assertion', 'at', 'confirm']),
  record: spec('record', ['record', 'confirm']),
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
  return selected
}

const TYPED = /^SEMANTIC_[A-Z_]+$/
// Typed semantic refusals keep their code and the runner's saved diagnostics;
// anything else goes to the shared failure reporting, which redacts host detail.
function reportSemanticFailure(error) {
  if (typeof error?.code !== 'string' || !TYPED.test(error.code)) return reportCommandFailure(error)
  const failure = { ok: false, code: error.code, error: safeCommandMessage(error) ?? '[internal-error]' }
  if (error.recorded !== undefined) failure.recorded = error.recorded
  if (error.captured !== undefined) failure.captured = error.captured
  console.error(JSON.stringify(failure))
  process.exitCode = 1
}

export async function runKnowledgeSemantic(argv) {
  try {
    const args = parseArgs(argv)
    const command = args._[0]
    if (args._.length !== 1 || !Object.hasOwn(SEMANTIC_COMMANDS, command) || Object.keys(args).some(key => key !== '_')) throw new Error(USAGE)
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
