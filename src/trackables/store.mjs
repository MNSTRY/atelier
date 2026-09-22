import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalize } from '../attestation/jcs.mjs'
import { boundedLearningValue, learningDigest as digest } from '../learning/contracts.mjs'
import { ensureContainedPrivateDirectory, readRegularTextNoFollow } from '../project/private-state.mjs'
import { withPrivateLock, publishPrivateFile, createVerifiedFileSequence, isPendingPrivateWrite } from '../project/durable-state.mjs'
import { initialTrackables, reduceTrackables, trackableView, validateTrackable } from './domain.mjs'
export * from './domain.mjs'

// A private local reference adapter. Product hosts call the domain reducer from
// their existing authenticated writer; they must not mirror member state here.
export function createTrackableStore({ workspaceRoot, scope, actor }) {
  const root = fs.realpathSync(workspaceRoot)
  initialTrackables(scope)
  if (typeof actor !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(actor)) throw new Error('local actor identity required')
  const identity = { schema: 'atelier-trackable-local@v1', scope, rootDigest: digest(root) }
  function placement() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
    try {
      if (execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '.atelier-local'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) throw new Error('tracked')
      execFileSync('git', ['-C', root, 'check-ignore', '--quiet', '.atelier-local/'], { env, stdio: 'ignore' })
    } catch { throw new Error('trackables require ignored, untracked .atelier-local/ in a Git workspace') }
  }
  function directory(...parts) {
    return ensureContainedPrivateDirectory({ workspaceRoot: root, directory: path.join(root, '.atelier-local', 'trackables', digest(scope).slice(7), ...parts) })
  }
  placement()
  const stateDir = directory(), events = directory('events'), identityPath = path.join(stateDir, 'identity.json')
  withPrivateLock(path.join(stateDir, 'operation.lock'), () => {
    if (!fs.existsSync(identityPath)) {
      if (fs.readdirSync(events).some(n => !isPendingPrivateWrite(n))) throw new Error('trackable identity missing from existing history')
      publishPrivateFile(identityPath, canonicalize(identity))
    }
    if (readRegularTextNoFollow(identityPath) !== canonicalize(identity)) throw new Error('trackable scope or workspace identity differs')
  })
  const readSequence = createVerifiedFileSequence({ directory: events, initial: () => ({ state: initialTrackables(scope), events: [], head: null, replayError: null }),
    apply(text, history, index, name) {
      if (name !== `${String(index).padStart(10, '0')}.json`) throw new Error('trackable history is not contiguous')
      const event = JSON.parse(text); boundedLearningValue(event)
      const { digest: pin, ...body } = event
      if (pin !== digest(body) || body.previous !== history.head || body.scope !== scope || body.revision !== index || history.events.some(e => e.command.requestId === body.command.requestId)) throw new Error('trackable history integrity mismatch')
      const legacy = body.schema === 'atelier-trackable-event@v1'
      if (!legacy && body.schema !== 'atelier-trackable-event@v2') throw new Error('unsupported trackable event schema')
      if (validateTrackable(body.command, 'request').length) throw new Error('invalid journal command')
      const invalidResolution = legacy ? Object.hasOwn(body, 'occurrenceResolution')
        : body.command.operation === 'record'
          ? !body.occurrenceResolution || typeof body.occurrenceResolution !== 'object' || Array.isArray(body.occurrenceResolution)
          : body.occurrenceResolution !== null
      if (invalidResolution) throw new Error('trackable event resolution missing or unexpected')
      let state = null, replayError = history.replayError
      if (!replayError) {
        state = reduceTrackables(history.state, body.command, { actor: body.actor, recordedAt: body.recordedAt, occurrenceResolution: legacy ? null : body.occurrenceResolution })
        if (digest(state) !== body.stateDigest) {
          if (!legacy || body.command.operation !== 'record') throw new Error('trackable replay state differs')
          // Old events did not retain their calendar resolution. Keep the chain
          // exportable, but never treat a differing reconstructed state as truth.
          replayError = { code: 'legacy-replay-state-differs', revision: index, message: 'legacy trackable replay state differs; original timezone data may be required' }
          state = null
        }
      }
      return { state, events: [...history.events, event], head: pin, replayError }
    } })
  function read() {
    placement(); directory(); directory('events')
    if (readRegularTextNoFollow(identityPath) !== canonicalize(identity)) throw new Error('trackable identity changed')
    const names = fs.readdirSync(events).filter(n => !isPendingPrivateWrite(n))
    if (names.length > 10000) throw new Error('trackable event limit exceeded')
    let total = 0
    for (const name of names) {
      const stat = fs.lstatSync(path.join(events, name)); total += stat.size
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || total > 32 * 1024 * 1024) throw new Error('trackable journal limit or custody violation')
    }
    return readSequence()
  }
  read()
  function verifiedRead() {
    const h = read()
    if (h.replayError) throw new Error(h.replayError.message)
    return h
  }
  return Object.freeze({
    snapshot() { const h = verifiedRead(); return { ...h.state, head: h.head, authenticated: false } },
    view(query) { return trackableView(verifiedRead().state, query) },
    execute(command) {
      command = boundedLearningValue(command)
      const errors = validateTrackable(command, 'request')
      if (errors.length) throw new Error(errors.join('; '))
      return withPrivateLock(path.join(directory(), 'operation.lock'), () => {
        const h = verifiedRead(), prior = h.events.find(e => e.command.requestId === command.requestId)
        if (prior) {
          if (digest({ command: prior.command, actor: prior.actor }) !== digest({ command, actor })) throw new Error('request identity reused with different input or actor')
          return { duplicate: true, revision: prior.revision, eventDigest: prior.digest, currentRevision: h.state.revision, persisted: true }
        }
        // Leave bounded space for corrections and retirement after ordinary writes stop.
        if (h.state.revision >= (['correct', 'lifecycle'].includes(command.operation) ? 10000 : 9000)) throw new Error('trackable capacity reached; retain/export this history')
        const recordedAt = new Date().toISOString(), state = reduceTrackables(h.state, command, { actor, recordedAt })
        const occurrenceResolution = command.operation === 'record' ? { occurredAt: command.input.evidence.occurredAt, sourceRef: command.input.evidence.source.ref,
          occurrence: state.evidence.at(-1).occurrence, tzdata: process.versions.tz ?? null } : null
        const body = { schema: 'atelier-trackable-event@v2', scope, revision: state.revision, previous: h.head, command, actor, recordedAt, occurrenceResolution, stateDigest: digest(state) }
        const event = { ...body, digest: digest(body) }, bytes = canonicalize(event)
        if (Buffer.byteLength(bytes) > 256 * 1024) throw new Error('trackable event limit exceeded')
        const used = h.events.reduce((sum, e) => sum + Buffer.byteLength(canonicalize(e)), 0)
        const limit = ['correct', 'lifecycle'].includes(command.operation) ? 32 * 1024 * 1024 : 28 * 1024 * 1024
        if (used + Buffer.byteLength(bytes) > limit) throw new Error('trackable journal capacity reached')
        publishPrivateFile(path.join(events, `${String(state.revision).padStart(10, '0')}.json`), bytes)
        const actual = verifiedRead()
        if (actual.head !== event.digest || digest(actual.state) !== body.stateDigest) throw new Error('trackable durable readback differs')
        return { duplicate: false, revision: state.revision, eventDigest: event.digest, stateDigest: body.stateDigest, persisted: true }
      })
    },
    exportHistory() { const h = read(); return { identity, events: h.events, head: h.head, private: true, authenticated: false, stateVerified: h.replayError === null, replayError: h.replayError } },
  })
}
