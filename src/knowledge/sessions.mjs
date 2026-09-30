import fs from 'node:fs'
import path from 'node:path'
import { canonicalize } from '../attestation/jcs.mjs'
import { createCoauthorStore } from '../coauthor/store.mjs'
import {
  ensureContainedPrivateDirectory,
  openRegularFileNoFollow,
} from '../project/private-state.mjs'
import {
  publishPrivateFile,
  withPrivateLock,
} from '../project/durable-state.mjs'
import { digest } from './plan.mjs'
import {
  KNOWLEDGE_FLOWS,
  knowledgeQuestionContext,
  loadKnowledgeWorkspace,
} from './workspace.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const identifier =
  /^kg-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const shape = (value, keys) => {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new Error('invalid knowledge request fields')
}
function readDescriptor(file) {
  const fd = openRegularFileNoFollow(file)
  try {
    if (fs.fstatSync(fd).size > 1024 * 1024)
      throw new Error('knowledge session exceeds byte limit')
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd))
    )
    shape(value, ['record', 'sha256'])
    if (
      digest(canonicalize(value.record)) !== value.sha256 ||
      value.record.schema !== 'atelier-knowledge-session/experimental-v1'
    )
      throw new Error('invalid knowledge session record')
    return value.record
  } finally {
    fs.closeSync(fd)
  }
}

// The descriptor preserves the prompts and the evidence shown at session start.
// Accepted intents and draft receipts live only in the existing coauthor ledger.
// None of these records are canonical plan edits or authenticated decisions.
export function createKnowledgeSessions(
  initial,
  planName = 'knowledge-plan.json'
) {
  const root = fs.realpathSync(initial.configDir)
  const location = path.join(root, '.atelier-local', 'knowledge', 'sessions')
  const store = () => createCoauthorStore({ workspaceRoot: root })
  const directory = () =>
    ensureContainedPrivateDirectory({
      workspaceRoot: root,
      directory: location,
      label: 'knowledge sessions',
    })
  function descriptor(id) {
    if (!identifier.test(id)) throw new Error('invalid knowledge session id')
    const record = readDescriptor(path.join(directory(), `${id}.json`))
    if (record.id !== id) throw new Error('knowledge session identity mismatch')
    return record
  }
  function current(record) {
    try {
      return (
        loadKnowledgeWorkspace(initial, planName).snapshot === record.snapshot
      )
    } catch {
      return false
    }
  }
  function result(record, state) {
    if (
      state.id !== record.id ||
      canonicalize(state.fields) !== canonicalize(record.config.fields)
    )
      throw new Error('knowledge session configuration mismatch')
    return {
      ok: true,
      record,
      state,
      current: current(record),
      savedMeaning: 'private-draft-only',
      sourceEditsApplied: false,
    }
  }
  return {
    start(input) {
      shape(input, ['requestId', 'flow', 'questionId', 'snapshot', 'author'])
      if (
        !uuid.test(input.requestId) ||
        typeof input.author !== 'string' ||
        !input.author.trim() ||
        input.author.length > 160
      )
        throw new Error('request UUID and locally asserted author required')
      const adapter = store() // Verify private Git placement before any descriptor write.
      return withPrivateLock(path.join(directory(), 'start.lock'), () => {
        const workspace = loadKnowledgeWorkspace(initial, planName)
        if (input.snapshot !== workspace.snapshot)
          throw new Error(
            'workspace changed; refresh before starting a new session'
          )
        const flow = KNOWLEDGE_FLOWS.find((f) => f.id === input.flow)
        const question = workspace.plan.questions.find(
          (q) => q.id === input.questionId
        )
        if (!flow || !question)
          throw new Error('unknown knowledge flow or question')
        const ref = path
          .relative(root, workspace.file)
          .split(path.sep)
          .join('/')
        if (
          !ref ||
          ref.split('/').some((p) => !p || p.startsWith('.')) ||
          path.isAbsolute(ref)
        )
          throw new Error(
            'coauthor plan must be a visible workspace-relative file'
          )
        let sourcePath = root
        for (const segment of ref.split('/')) {
          sourcePath = path.join(sourcePath, segment)
          if (fs.lstatSync(sourcePath).isSymbolicLink())
            throw new Error('coauthor plan must not be redirected')
        }
        const id = `kg-${input.requestId}`
        const config = {
          id,
          fields: flow.prompts.map(([field]) => ({
            id: field,
            source: { ref, digest: workspace.sha256 },
          })),
        }
        const record = {
          schema: 'atelier-knowledge-session/experimental-v1',
          id,
          snapshot: workspace.snapshot,
          flow: flow.id,
          title: flow.title,
          prompts: flow.prompts,
          question,
          author: input.author.trim(),
          identity: 'locally-asserted',
          context: workspace.graph.ok
            ? knowledgeQuestionContext(workspace, question.id)
            : null,
          config,
        }
        const file = path.join(directory(), `${id}.json`)
        const bytes = canonicalize({
          record,
          sha256: digest(canonicalize(record)),
        })
        if (Buffer.byteLength(bytes) > 1024 * 1024)
          throw new Error('knowledge session exceeds byte limit')
        // Non-overwriting publication makes a retry of the same request exact.
        publishPrivateFile(file, bytes)
        return result(record, adapter.start(config))
      })
    },
    read(id) {
      const record = descriptor(id)
      return result(record, store().read(id))
    },
    list() {
      if (!fs.existsSync(location)) return []
      const names = fs
        .readdirSync(directory())
        .filter((n) => identifier.test(n.slice(0, -5)) && n.endsWith('.json'))
        .sort()
      if (names.length > 200)
        throw new Error(
          'knowledge session list exceeds 200; use an exact session id'
        )
      const adapter = store()
      let snapshot = null
      try {
        snapshot = loadKnowledgeWorkspace(initial, planName).snapshot
      } catch {
        /* History still has value after a source failure. */
      }
      return names.map((name) => {
        const record = descriptor(name.slice(0, -5))
        const state = adapter.read(record.id)
        return {
          id: record.id,
          flow: record.flow,
          title: record.title,
          question: record.question.question,
          author: record.author,
          phase: state.phase,
          saved: state.saved.length,
          fields: state.fields.length,
          current: snapshot === record.snapshot,
        }
      })
    },
    event(input) {
      shape(input, ['sessionId', 'event'])
      const record = descriptor(input.sessionId)
      if (!current(record))
        throw new Error(
          'workspace changed; retained history is readable; start a newly bound session'
        )
      const state = store().dispatch(record.id, input.event)
      return result(record, state)
    },
    recover(input) {
      shape(input, ['sessionId'])
      const record = descriptor(input.sessionId)
      if (!current(record))
        throw new Error(
          'workspace changed; retained history is readable; start a newly bound session'
        )
      return result(record, store().recover(record.id))
    },
  }
}
