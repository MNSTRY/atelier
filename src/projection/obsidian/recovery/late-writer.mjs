import fs from 'node:fs'
import path from 'node:path'
import { listJournals } from './journal.mjs'
import { readFileBytes, sha256Digest } from './store.mjs'

// A program that opened a note before it was exchanged still holds the
// displaced file, and may write into it at any later time. Those bytes land in
// the recovery area, not in the vault, so nothing shows them to the person
// unless the displaced files are looked at again. This compares every
// displaced file with the digest recorded when it was moved. A difference is
// kept as an immutable object and reported as `late-writer-captured`.
//
// The check is meaningful only after a quiet period, and one pass does not end
// the obligation: a holder can write later still. Callers repeat it.
export function recheckDisplacedFiles({ store, journalIds, clock = () => new Date() } = {}) {
  const ids = journalIds ?? listJournals(store).map((journal) => journal.document().journalId)
  const findings = []
  for (const journalId of ids) {
    const receipts = store.listReceipts(journalId)
    const known = new Set(receipts.filter((receipt) => receipt.role === 'late-writer').map((receipt) => `${receipt.unit}\u0000${receipt.observedDigest}`))
    for (const receipt of receipts.filter((item) => item.role === 'displaced')) {
      // A recovery name that is a hard link to the live note (an interrupted
      // put-back) is the note itself: edits to it are not a late writer's.
      const live = receipt.notePath ? fs.lstatSync(path.join(store.vaultRoot, receipt.notePath), { throwIfNoEntry: false }) : null
      const held = fs.lstatSync(store.resolve(receipt.displacedRef), { throwIfNoEntry: false })
      if (live && held && live.ino === held.ino && live.dev === held.dev) continue
      let bytes
      try { bytes = readFileBytes(store.resolve(receipt.displacedRef)) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        findings.push({ code: 'displaced-file-missing', journalId, unit: receipt.unit, notePath: receipt.notePath, displacedRef: receipt.displacedRef })
        continue
      }
      const observedDigest = sha256Digest(bytes)
      if (observedDigest === receipt.digestAtMove) continue
      const object = store.retainObject(bytes)
      const finding = { code: 'late-writer-captured', journalId, unit: receipt.unit, notePath: receipt.notePath, displacedRef: receipt.displacedRef, digestAtMove: receipt.digestAtMove, observedDigest, objectRef: object.ref }
      if (!known.has(`${receipt.unit}\u0000${observedDigest}`)) {
        const value = clock()
        store.writeReceipt(journalId, receipt.unit, { role: 'late-writer', notePath: receipt.notePath, displacedRef: receipt.displacedRef, digestAtMove: receipt.digestAtMove, observedDigest, objectRef: object.ref,
          at: (value instanceof Date ? value : new Date(value)).toISOString() })
      }
      findings.push(finding)
    }
  }
  return findings
}
