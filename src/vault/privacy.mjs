/** Trusted host evidence only: never accept evidence from a publisher. */
const unknown = reason => ({ status: 'unknown', reason })
export function vaultObjects(vault, manifest) {
  return [...new Map(manifest.map(file => [`${vault}/${file.sha256}`, { key: `${vault}/${file.sha256}`, sha256: file.sha256, size: file.size }])).values()]
}
export function validDeployment(deployment) {
  if (!deployment || typeof deployment.id !== 'string' || !deployment.id || !Array.isArray(deployment.origins) || !deployment.origins.length || deployment.origins.length > 16) return false
  return new Set(deployment.origins).size === deployment.origins.length && deployment.origins.every(origin => {
    try { const u = new URL(origin); return u.protocol === 'https:' && u.origin === origin && !u.username && !u.password } catch { return false }
  })
}
export function assessVaultPrivacy(evidence, context) {
  const { vault, publication, phase, owner, deployment, manifest = [], objects = [], request, now = Date.now() } = context
  // Exposure is a sticky alarm, not authorization. Even stale/mismatched trusted
  // evidence must not turn a known exposure into an ordinary availability error.
  if (evidence?.targets?.some?.(t => t?.anonymous === 'content' || t?.otherUser === 'content')) return { status: 'exposed', reason: 'Unauthorized content observed. This handler refuses delivery; external routes may remain exposed.' }
  if (!evidence || evidence.vault !== vault || evidence.publication !== publication) return unknown('Protection evidence does not match this publication.')
  if (evidence.phase !== phase || !['before-upload', 'before-activation', 'read'].includes(phase) || !owner?.issuer || !owner?.subject || evidence.owner?.issuer !== owner.issuer || evidence.owner?.subject !== owner.subject) return unknown('Protection evidence does not match the owner and operation.')
  if (!validDeployment(deployment) || evidence.deployment?.id !== deployment.id || JSON.stringify(evidence.deployment?.origins) !== JSON.stringify(deployment.origins)) return unknown('Protection evidence does not match this deployment.')
  if (request && (!deployment.origins.includes(request.origin) || (phase === 'read' && request.path !== `/${vault}` && request.path !== `/${vault}/` && !manifest.some(f => request.path === `/${vault}/${f.path}`)))) return unknown('Request is outside the verified inventory.')
  if (!Number.isFinite(evidence.checkedAt) || !Number.isFinite(evidence.validUntil) || evidence.checkedAt > now || evidence.validUntil <= now || evidence.validUntil <= evidence.checkedAt || evidence.validUntil - evidence.checkedAt > 300000) return unknown('Protection evidence is missing or expired.')
  if (typeof evidence.policyRevision !== 'string' || !evidence.policyRevision) return unknown('Provider policy identity is missing.')
  const config = evidence.configuration
  if (config?.ownerOnly !== true || config?.privateStorage !== true || config?.completeInventory !== true) return unknown('Provider protection or route inventory is unverified.')
  if (!Array.isArray(evidence.targets) || !evidence.targets.length || evidence.targets.length > 2000) return unknown('Access checks are missing or oversized.')
  const urls = new Set(), routes = new Set(), keys = new Set()
  for (const target of evidence.targets) {
    let url
    try { url = new URL(target.url) } catch { return unknown('Access check URL is invalid.') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || urls.has(url.href)) return unknown('Access check inventory is invalid.')
    urls.add(url.href)
    if (target.anonymous !== 'denied' || target.otherUser !== 'denied') return unknown('Required access checks did not complete successfully.')
    if (target.kind === 'storage') {
      if (!objects.some(o => o.key === target.key && o.sha256 === target.sha256 && o.size === target.size)) return unknown('Storage check does not match a staged object.')
      keys.add(target.key)
    } else if (target.kind === 'route') {
      if (!deployment.origins.includes(url.origin)) return unknown('Access check uses an unconfigured origin.')
      const file = manifest.find(f => url.pathname === `/${vault}/${f.path}`)
      const home = url.pathname === `/${vault}` || url.pathname === `/${vault}/`
      if (!home && (!file || file.sha256 !== target.sha256)) return unknown('Access check does not match a manifest path and digest.')
      routes.add(url.href)
    } else return unknown('Access check target is invalid.')
  }
  for (const origin of deployment.origins) {
    for (const path of [`/${vault}`, `/${vault}/`, ...manifest.map(f => `/${vault}/${f.path}`)]) if (!routes.has(origin + path)) return unknown('A configured route is missing from access checks.')
  }
  for (const object of objects) if (!keys.has(object.key)) return unknown('A staged storage object is missing from access checks.')
  return { status: 'verified', reason: 'Configured routes refused unauthorized access at the recorded check time. Owner rendering is qualified separately.', checkedAt: evidence.checkedAt, validUntil: evidence.validUntil, policyRevision: evidence.policyRevision }
}
export async function verifyVaultPrivacy(privacy, context) {
  const method = context.phase === 'read' ? 'current' : 'verify'
  if (typeof privacy?.[method] !== 'function') return unknown('No provider privacy evidence is configured.')
  try { return assessVaultPrivacy(await privacy[method](context), context) }
  catch { return unknown('Provider privacy verification is unavailable.') }
}

/** Host-owned durable evidence store. Refresh is explicit; reads never probe. */
export function createVaultPrivacyState({ probe, load, save }) {
  if (typeof probe?.verify !== 'function' || typeof load !== 'function' || typeof save !== 'function') throw new TypeError('Probe and durable evidence store required')
  const key = context => JSON.stringify([context.deployment?.id, context.vault])
  async function collect(context) {
    const previous = await load(key(context))
    if (assessVaultPrivacy(previous, context).status === 'exposed') return previous
    const evidence = await probe.verify(context)
    // Persist alarms before reporting them; failure still refuses access. A host
    // must latch alarms durably until explicit operator reconciliation.
    if (context.phase !== 'read' && assessVaultPrivacy(evidence, context).status !== 'exposed') return evidence
    try { await save(key(context), evidence) } catch (error) {
      if (assessVaultPrivacy(evidence, context).status !== 'exposed') throw error
    }
    return evidence
  }
  return {
    verify: collect,
    current: context => load(key(context)),
    async refresh(context) { return collect({ ...context, phase: 'read' }) },
  }
}
