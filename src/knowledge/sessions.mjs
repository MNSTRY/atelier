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
  function currency(record, cache = new Map()) {
    try {
      const ref = record.config.fields[0].source.ref
      if (!cache.has(ref)) {
        try {
          cache.set(ref, loadKnowledgeWorkspace(initial, ref).snapshot)
        } catch {
          cache.set(ref, null)
        }
      }
      const snapshot = cache.get(ref)
      return snapshot === null
        ? 'unavailable'
        : snapshot === record.snapshot
        ? 'current'
        : 'changed'
    } catch {
      return 'unavailable'
    }
  }
  function result(record, state) {
    if (
      state.id !== record.id ||
      canonicalize(state.fields) !== canonicalize(record.config.fields)
    )
      throw new Error('knowledge session configuration mismatch')
    const sourceState = currency(record)
    return {
      ok: true,
      record,
      state,
      current: sourceState === 'current',
      currency: sourceState,
      savedMeaning: 'private-draft-only',
      sourceEditsApplied: false,
    }
  }
  return {
    start(input) {
      shape(input, ['requestId', 'flow', 'questionId', 'snapshot', 'author'])
      input = {
        ...input,
        requestId:
          typeof input.requestId === 'string'
            ? input.requestId.toLowerCase()
            : input.requestId,
      }
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
        const file = path.join(directory(), `${id}.json`)
        // A descriptor is a recoverable start intent. Keep its original prompts,
        // evidence, timestamp, and identity on an exact retry after interruption.
        if (fs.existsSync(file)) {
          const record = descriptor(id)
          if (
            record.snapshot !== input.snapshot ||
            record.flow !== input.flow ||
            record.question.id !== input.questionId ||
            record.author !== input.author.trim() ||
            record.config.fields.some(
              (field) =>
                field.source.ref !== ref ||
                field.source.digest !== workspace.sourceDigest
            )
          )
            throw new Error(
              'invalid knowledge request: session id already bound'
            )
          return result(record, adapter.start(record.config))
        }
        const config = {
          id,
          fields: flow.prompts.map(([field]) => ({
            id: field,
            source: { ref, digest: workspace.sourceDigest },
          })),
        }
        const record = {
          schema: 'atelier-knowledge-session/experimental-v1',
          id,
          createdAt: new Date().toISOString(),
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
      const limit = 200
      if (!fs.existsSync(location))
        return { sessions: [], total: 0, limit, truncated: false }
      const names = fs
        .readdirSync(directory())
        .filter((n) => identifier.test(n.slice(0, -5)) && n.endsWith('.json'))
        .map((name) => {
          try {
            return {
              name,
              time: fs.lstatSync(path.join(location, name)).mtimeMs,
            }
          } catch {
            return { name, time: 0 }
          }
        })
        .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name))
      const adapter = store()
      const cache = new Map()
      const sessions = names.slice(0, limit).map(({ name }) => {
        const id = name.slice(0, -5)
        let record
        try {
          record = descriptor(id)
          const state = adapter.read(id)
          if (canonicalize(state.fields) !== canonicalize(record.config.fields))
            throw new Error('knowledge session configuration mismatch')
          const sourceState = currency(record, cache)
          return {
            id,
            available: true,
            createdAt: record.createdAt || null,
            flow: record.flow,
            title: record.title,
            question: record.question.question,
            author: record.author,
            phase: state.phase,
            saved: state.saved.length,
            fields: state.fields.length,
            current: sourceState === 'current',
            currency: sourceState,
          }
        } catch (error) {
          const incomplete =
            record && error.message === 'coauthor session not found'
          return {
            id,
            available: false,
            recoverable: Boolean(
              incomplete && currency(record, cache) === 'current'
            ),
            reason: incomplete
              ? 'Start incomplete. Resume it while its bound sources still match.'
              : 'Session unavailable. Preserve its local files for inspection.',
          }
        }
      })
      return {
        sessions,
        total: names.length,
        limit,
        truncated: names.length > limit,
        order: 'newest-local-descriptor-first',
      }
    },
    event(input) {
      shape(input, ['sessionId', 'event'])
      const record = descriptor(input.sessionId)
      if (currency(record) !== 'current')
        throw new Error(
          'workspace changed; retained history is readable; start a newly bound session'
        )
      const state = store().dispatch(record.id, input.event)
      return result(record, state)
    },
    recover(input) {
      shape(input, ['sessionId'])
      const record = descriptor(input.sessionId)
      if (currency(record) !== 'current')
        throw new Error(
          'workspace changed; retained history is readable; start a newly bound session'
        )
      const adapter = store()
      let state
      try {
        state = adapter.read(record.id)
      } catch (error) {
        if (error.message !== 'coauthor session not found') throw error
        state = adapter.start(record.config)
      }
      return result(
        record,
        state.phase === 'saving' ? adapter.recover(record.id) : state
      )
    },
  }
}
