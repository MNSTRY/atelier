/** Pure evaluator: evidence must come from a trusted host probe, never a publisher. */
export function assessVaultPrivacy(evidence, { vault, publication, now = Date.now() }) {
  const unknown = reason => ({ status: 'unknown', reason })
  if (!evidence || evidence.vault !== vault || evidence.publication !== publication) return unknown('Protection evidence does not match this publication.')
  if (!Number.isFinite(evidence.checkedAt) || !Number.isFinite(evidence.validUntil) || evidence.checkedAt > now || evidence.validUntil <= now || evidence.validUntil - evidence.checkedAt > 300000) return unknown('Protection evidence is missing or expired.')
  if (typeof evidence.policyRevision !== 'string' || !evidence.policyRevision) return unknown('Provider policy identity is missing.')
  if (!Array.isArray(evidence.targets) || !evidence.targets.length) return unknown('Access checks are missing.')
  // Report observed exposure even when some other checks are incomplete.
  if (evidence.targets.some(target => target?.anonymous === 'content' || target?.otherUser === 'content')) return { status: 'exposed', reason: 'Protected content was returned to an unauthorized reader.' }
  const config = evidence.configuration
  if (config?.ownerOnly !== true || config?.privateStorage !== true || config?.completeInventory !== true) return unknown('Provider protection or route inventory is unverified.')
  const kinds = new Set()
  const urls = new Set()
  for (const target of evidence.targets) {
    if (!target || !['artifact', 'asset', 'alias', 'origin', 'storage'].includes(target.kind)) return unknown('Access check target is invalid.')
    let url
    try { url = new URL(target.url) } catch { return unknown('Access check URL is invalid.') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || urls.has(url.href)) return unknown('Access check inventory is invalid.')
    urls.add(url.href); kinds.add(target.kind)
    const expectedOwner = target.kind === 'storage' ? 'denied' : 'content'
    if (target.owner !== expectedOwner || target.anonymous !== 'denied' || target.otherUser !== 'denied') return unknown('Required access checks did not complete successfully.')
  }
  for (const kind of ['artifact', 'asset', 'alias', 'origin', 'storage']) if (!kinds.has(kind)) return unknown('Required access surface is missing.')
  return { status: 'verified', reason: 'Owner access and unauthorized refusal verified.', checkedAt: evidence.checkedAt, validUntil: evidence.validUntil, policyRevision: evidence.policyRevision }
}

export async function verifyVaultPrivacy(privacy, context) {
  if (!privacy || typeof privacy.verify !== 'function') return { status: 'unknown', reason: 'No provider privacy verifier is configured.' }
  try { return assessVaultPrivacy(await privacy.verify(context), context) }
  catch { return { status: 'unknown', reason: 'Provider privacy verification is unavailable.' } }
}
