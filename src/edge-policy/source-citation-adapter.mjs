import { canonicalize } from '../attestation/jcs.mjs'
import { validateRepositoryContribution } from '../graph/repo-contribution.mjs'
import { validSourceRef } from './contract.mjs'

const need = (value) => { if (!value) throw new TypeError('Invalid source citation input') }

/**
 * Convert an exact observed occurrence to the policy's raw-byte citation shape.
 * This pure structural binding does not authenticate source bytes, source-home
 * custody, freshness or a declared triple. The policy host must still implement
 * readSource, verifyOrigin and checkSourceHome against its current snapshot.
 * Original provenance, including UTF16 offsets and any pointer/target range,
 * stays unchanged in the contribution. Only its outer raw-byte range is cited.
 * @param {import('../graph/repo-contribution.types.mjs').RepositoryContribution} contribution
 * @param {import('../graph/repo-contribution.types.mjs').SourceRef} provenance
 */
export function sourceCitationFromProvenance(contribution, provenance) {
  try {
    need(validateRepositoryContribution(contribution).ok)
    const { snapshot, repository } = contribution
    need(provenance?.repoId === repository.repoId && provenance.revision === snapshot.digest)
    const file = snapshot.files.find((pin) => pin.path === provenance.path)
    need(file && provenance.digest === file.rawDigest)
    const { range, rangeDigest } = provenance.locator ?? {}
    need(range && Number.isSafeInteger(range.byteStart) && range.byteStart >= 0 &&
      Number.isSafeInteger(range.byteEnd) && range.byteEnd > range.byteStart && range.byteEnd <= file.byteLength)
    // A matching file pin alone cannot invent a source occurrence. Accept a
    // detached copy too, while retaining every field of the recorded provenance.
    const observed = canonicalize(provenance)
    need([...contribution.ordinaryLinks, ...contribution.declaredRelations]
      .some((occurrence) => canonicalize(occurrence.provenance) === observed))
    const citation = {
      repoId: provenance.repoId, path: provenance.path, revision: provenance.revision,
      fileDigest: provenance.digest,
      locator: { byteStart: range.byteStart, byteEnd: range.byteEnd },
      citedDigest: rangeDigest,
    }
    need(validSourceRef(citation))
    return citation
  } catch {
    throw new TypeError('Invalid source citation input')
  }
}
