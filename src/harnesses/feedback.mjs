import { assertDocument } from '../capabilities/package.mjs'
import { harnessRef } from './contracts.mjs'
import { inspectHarness } from './exchange.mjs'
export function prepareHarnessFeedback({ profile, records, subjectId, id, outcome, cause, evidenceDigest, at, by }) {
  const state = inspectHarness(profile, records), subject = records.find(r => r.id === subjectId)
  if (!subject) throw new Error('feedback subject missing')
  const atSubject = inspectHarness(profile, records.slice(0, records.indexOf(subject) + 1))
  const binding = (atSubject.domain ?? atSubject.establishment ?? atSubject.campaign)?.data.binding
  if (!binding) throw new Error('harness establishment has no skill binding')
  if (!['skill', 'host', 'tool', 'configuration', 'context', 'provider', 'unknown'].includes(cause)) throw new Error('unknown feedback cause')
  const event = { schema: 'mnstry.atelier-capability-event@v1', id, kind: 'feedback', ...binding, observer: by, outcome,
    cause: ['context', 'provider'].includes(cause) ? 'unknown' : cause, evidenceDigest, at }
  assertDocument(event, 'event')
  return { event, subject: harnessRef(subject), historyDigest: state.head, reportedCause: cause,
    causeMapping: event.cause === cause ? 'exact' : 'unsupported-steward-cause-preserved-in-wrapper', recorded: false, authority: 'none' }
}
