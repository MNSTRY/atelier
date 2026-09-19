import { createHash } from 'node:crypto'
import { editIdempotencyKey } from '../../../src/projection/obsidian/edits/index.mjs'

// Invented edit operation documents for the arbitration tests. A label stands
// for bytes: its digest is the digest of the label, and nothing else of it is
// ever recorded.

export const EXT = 'mnstry.atelier.obsidian'
export const digestOf = (label) => `sha256:${createHash('sha256').update(label).digest('hex')}`
export const resultOf = (edited) => `${edited} as source`

export function makeOperation({ workspaceId = 'ws-arbitration', repoId = 'reading-room', nodeId = 'reading-room:guide', scopeId = 'scope-full', generationId = `gen-${scopeId}-0001`, base = 'base-0', edited, result = resultOf(edited), state = 'pending', kind = 'body-replacement', current = base, refusalCode = 'stale-base' }) {
  const baseSourceDigest = digestOf(base)
  const observedDigest = digestOf(edited)
  return {
    schema: 'atelier-obsidian-edit-operation/v1',
    contractVersion: '1.0.0',
    editId: `edit-${createHash('sha256').update([scopeId, generationId, edited].join('\u0000')).digest('hex').slice(0, 32)}`,
    workspaceId,
    repoId,
    nodeId,
    origin: { scopeId, generationId, ext: { [EXT]: { notePath: 'notes/Invented title--000000000000.md', baseNoteDigest: digestOf(`note of ${base}`), publishedNoteDigest: digestOf(`note of ${base}`) } } },
    kind,
    baseSourceDigest,
    observed: { digest: observedDigest, byteLength: edited.length, recoveryRef: `recovery/objects/${observedDigest.slice(7)}.bin` },
    idempotencyKey: editIdempotencyKey({ workspaceId, repoId, nodeId, baseSourceDigest, observedDigest }),
    state,
    observedAt: '2026-01-05T10:05:00.000Z',
    ext: {
      [EXT]: {
        lensVersion: '1.0.0',
        currentSourceDigest: digestOf(current),
        ...(state === 'pending'
          ? { result: { newSourceDigest: digestOf(result), newByteLength: result.length, changedRanges: [], unchanged: false, generated: 'intact' } }
          : { refusal: { code: refusalCode, detail: {} } }),
      },
    },
  }
}

export const RACE_MODES = Object.freeze(['same-edit', 'different-edits', 'different-bases'])
export const raceIdentity = (round) => ({ repoId: 'race-room', nodeId: `race-room:node-${String(round).padStart(4, '0')}` })

export function raceOperation({ round, role, mode }) {
  return makeOperation({
    workspaceId: 'ws-race',
    ...raceIdentity(round),
    scopeId: `scope-${role}`,
    base: mode === 'different-bases' ? `base of ${role}` : 'base shared',
    current: 'base shared',
    edited: mode === 'same-edit' ? `edit of round ${round}` : `edit of ${role} in round ${round}`,
  })
}
