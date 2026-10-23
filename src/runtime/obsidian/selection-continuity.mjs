import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withPrivateLock } from '../../project/durable-state.mjs'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, openRegularFileNoFollow } from '../../project/private-state.mjs'
import { canonicalJson, closedObject } from './documents.mjs'
import { ObsidianMaintenanceRefusal, refuse } from './errors.mjs'

// Machine-private continuity evidence, separate from the person's append-only selection history. The maximum never
// decreases, and previously observed record identities remain known after the person confirms a shorter history.
export const SELECTION_CONTINUITY_SCHEMA = 'atelier-obsidian-selection-continuity/v1'
export const MAX_SELECTION_IDENTITIES = 8192
export const MAX_SELECTION_CONTINUITY_BYTES = 1024 * 1024
const DIGEST = /^[0-9a-f]{64}$/
const CONFIRMATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SOURCE = Object.freeze({ source: 'personal-workspace' })
const invalid = () => refuse('invalid-selection-continuity', 'the private selection continuity state cannot be verified; nothing is loaded', SOURCE)
const count = (value) => Number.isSafeInteger(value) && value >= 0

function validate(document, workspaceId, homeDigest) {
  closedObject(document, { required: ['schema', 'workspaceId', 'homeDigest', 'highestSequence', 'accepted', 'seen', 'confirmations'] }, 'invalid-selection-continuity', 'the selection continuity state')
  closedObject(document.accepted, { required: ['sequence', 'head'] }, 'invalid-selection-continuity', 'the accepted selection')
  if (document.schema !== SELECTION_CONTINUITY_SCHEMA || document.workspaceId !== workspaceId || document.homeDigest !== homeDigest
    || !count(document.highestSequence) || !count(document.accepted.sequence) || document.accepted.sequence > document.highestSequence
    || !Array.isArray(document.seen) || document.seen.length > MAX_SELECTION_IDENTITIES || document.seen.some((digest) => typeof digest !== 'string' || !DIGEST.test(digest))
    || !Array.isArray(document.confirmations) || document.confirmations.length > MAX_SELECTION_IDENTITIES || document.confirmations.some((id) => typeof id !== 'string' || !CONFIRMATION_ID.test(id))
    || new Set(document.confirmations).size !== document.confirmations.length
    || new Set(document.seen).size !== document.seen.length || document.highestSequence > document.seen.length
    || (document.accepted.sequence === 0 ? document.accepted.head !== 'genesis' : !document.seen.includes(document.accepted.head))) invalid()
  return document
}

export function createSelectionContinuity({ workspaceRoot, workspaceId, personalHome }) {
  const homeDigest = createHash('sha256').update(personalHome).digest('hex')
  const directory = () => ensureContainedPrivateDirectory({ workspaceRoot, directory: path.join(workspaceRoot, 'state', 'maintenance'), label: 'selection continuity state' })
  const file = path.join(workspaceRoot, 'state', 'maintenance', 'selection-continuity.json')
  let observedState = false
  let pending = null // an observed head whose durable write has not yet been proved
  function read() {
    directory()
    let fd
    try {
      fd = openRegularFileNoFollow(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
      if (fs.fstatSync(fd).size > MAX_SELECTION_CONTINUITY_BYTES) invalid()
      const bytes = fs.readFileSync(fd)
      if (bytes.length > MAX_SELECTION_CONTINUITY_BYTES) invalid()
      const document = validate(JSON.parse(bytes), workspaceId, homeDigest)
      observedState = true
      return document
    } catch (error) {
      if (error.code === 'ENOENT' && !observedState) return null
      invalid()
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  function next(before, head) {
    const seen = new Set(before?.seen ?? [])
    const confirmations = new Set(before?.confirmations ?? [])
    const same = before?.accepted.sequence === head.sequence && before?.accepted.head === head.head
    const shorter = before !== null && (head.sequence < before.highestSequence || head.sequence <= before.accepted.sequence)
    const fresh = head.confirmationId !== null && !confirmations.has(head.confirmationId) && !seen.has(head.head)
    if (!same && shorter && !fresh) refuse('selection-history-shortened', 'the selection history no longer follows the private continuity state; restore the removed records or confirm the selection again', SOURCE)
    for (const digest of head.recordDigests) seen.add(digest)
    for (const id of head.confirmationIds) confirmations.add(id)
    if (seen.size > MAX_SELECTION_IDENTITIES || confirmations.size > MAX_SELECTION_IDENTITIES) refuse('selection-continuity-capacity', 'the private selection continuity state has reached its identity limit; nothing is loaded', SOURCE)
    return validate({ schema: SELECTION_CONTINUITY_SCHEMA, workspaceId, homeDigest,
      highestSequence: Math.max(before?.highestSequence ?? 0, head.sequence), accepted: { sequence: head.sequence, head: head.head }, seen: [...seen].sort(), confirmations: [...confirmations].sort() }, workspaceId, homeDigest)
  }
  function withPending(current) {
    if (pending === null) return current
    if (current === null) return pending
    const seen = [...new Set([...current.seen, ...pending.seen])].sort()
    const confirmations = [...new Set([...current.confirmations, ...pending.confirmations])].sort()
    if (seen.length > MAX_SELECTION_IDENTITIES || confirmations.length > MAX_SELECTION_IDENTITIES) refuse('selection-continuity-capacity', 'the private selection continuity state has reached its identity limit; nothing is loaded', SOURCE)
    return { ...pending, highestSequence: Math.max(current.highestSequence, pending.highestSequence), seen, confirmations,
      accepted: current.highestSequence > pending.highestSequence ? current.accepted : pending.accepted }
  }
  function note(head) {
    try {
      const disk = read()
      const before = withPending(disk)
      const planned = next(before, head)
      if (disk !== null && canonicalJson(disk) === canonicalJson(planned)) { pending = null; return head }
      pending = planned
      withPrivateLock(path.join(directory(), 'selection-continuity.lock'), () => {
        const current = read()
        const document = next(withPending(current), head)
        pending = document
        const text = canonicalJson(document)
        if (Buffer.byteLength(text) > MAX_SELECTION_CONTINUITY_BYTES) invalid()
        if (current === null || canonicalJson(current) !== text) atomicReplacePrivateText(file, text)
        // An uncertain write is never authority to return a project.
        if (canonicalJson(read()) !== text) invalid()
      })
      pending = null
      return head
    } catch (error) {
      if (error instanceof ObsidianMaintenanceRefusal) throw error
      refuse('selection-continuity-unavailable', 'the private selection continuity state could not be kept; nothing is loaded', SOURCE)
    }
  }
  return Object.freeze({ note })
}
