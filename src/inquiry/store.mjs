import { jsonAt, stat, within, workspaceRoot, replaceJson } from '../capabilities/files.mjs'
import { withOperationLock } from '../capabilities/adoption.mjs'
import { assertInquiry, inquiryDigest, INQUIRY_LIMITS } from './contracts.mjs'
import { EMPTY_INQUIRY_HEAD, inspectInquiry } from './ledger.mjs'

function location(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('invalid campaign identity')
  return `.atelier-local/inquiry/${id}/ledger.json`
}
function read(root, campaign) {
  const file = location(campaign)
  if (!stat(within(root, file))) return { records: [], head: EMPTY_INQUIRY_HEAD }
  const ledger = assertInquiry(jsonAt(root, file), 'ledger')
  const state = inspectInquiry(ledger.records)
  if (state.head !== ledger.head || state.campaign.id !== campaign) throw new Error('inquiry ledger integrity mismatch')
  return state
}
export function readInquiry({ workspaceRoot: input, campaign }) {
  return inspectInquiry(read(workspaceRoot(input), campaign).records)
}
export function appendInquiry({ workspaceRoot: input, record, confirm }) {
  assertInquiry(record)
  const root = workspaceRoot(input, { write: true })
  return withOperationLock(root, () => {
    const before = read(root, record.campaign)
    if (before.head !== confirm) throw new Error('inquiry append requires the current history digest')
    const next = inspectInquiry([...before.records, record])
    // A single atomic replacement retains the entire immutable record history.
    // The shared lock serializes cooperating writers; it is not an OS sandbox.
    const ledger = { schema: 'atelier-inquiry-ledger@v1', records: next.records, head: inquiryDigest(next.records) }
    if (Buffer.byteLength(JSON.stringify(ledger, null, 2)) + 1 > INQUIRY_LIMITS.bytes) throw new Error('serialized inquiry ledger exceeds byte ceiling')
    replaceJson(root, location(record.campaign), ledger)
    return { recorded: record.id, head: next.head, assessment: next.assessments[record.id] ?? null, reconsider: next.reconsider, authority: 'none' }
  })
}
