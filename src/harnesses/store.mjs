import { jsonAt, replaceJson, stat, within, workspaceRoot } from '../capabilities/files.mjs'
import { withOperationLock } from '../capabilities/adoption.mjs'
import { assertHarness, EMPTY_HARNESS_HEAD, HARNESS_LIMITS } from './contracts.mjs'
import { inspectHarness } from './exchange.mjs'
function location(profile, run) {
  if (!['knowledge', 'build'].includes(profile) || !/^[a-z][a-z0-9-]{0,63}$/.test(run ?? '')) throw new Error('invalid stored harness profile or run')
  return `.atelier-local/harnesses/${profile}/${run}/ledger.json`
}
function read(root, profile, run) {
  const file = location(profile, run)
  if (!stat(within(root, file))) return inspectHarness(profile, [])
  const ledger = assertHarness(jsonAt(root, file), profile, 'ledger'), state = inspectHarness(profile, ledger.records)
  if (ledger.head !== state.head || state.establishment.id !== run) throw new Error('harness ledger integrity mismatch')
  return state
}
export function readHarness({ workspaceRoot: root, profile, run }) { return read(workspaceRoot(root), profile, run) }
export function appendHarness({ workspaceRoot: input, profile, record, confirm }) {
  assertHarness(record, profile)
  const root = workspaceRoot(input, { write: true })
  return withOperationLock(root, () => {
    const before = read(root, profile, record.run)
    if ((before.head ?? EMPTY_HARNESS_HEAD) !== confirm) throw new Error('append requires current harness history digest')
    const state = inspectHarness(profile, [...before.records, record])
    const ledger = { schema: 'atelier-harness-ledger@v1', profile, records: state.records, head: state.head }
    if (Buffer.byteLength(JSON.stringify(ledger, null, 2)) + 1 > HARNESS_LIMITS.bytes) throw new Error('serialized harness ledger exceeds bounds')
    replaceJson(root, location(profile, record.run), ledger)
    return { recorded: record.id, head: state.head, reconsider: state.reconsider, authority: 'none' }
  })
}
