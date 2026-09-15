import { parseRequest, parseBoundedJSON, need, isRef, isDigest, canonical, deepFreeze, MODES } from '../composition/wire.mjs';
import { digestBytes } from '../composition/registry.mjs';

const messages = Object.freeze({ loading: 'Checking access.', ready: 'Preview ready.', unauthenticated: 'Sign in to preview.',
  forbidden: 'Preview is not permitted.', expired: 'Session expired.', unavailable: 'Preview unavailable.', stale: 'Preview changed. Refresh to continue.' });
export class PreviewRefusal extends Error {
  constructor(state) { super('Preview refused'); need(Object.hasOwn(messages, state) && !['ready', 'loading'].includes(state)); this.state = state; }
}
function principal(p) { need(p && isRef(p.issuer) && isRef(p.subject) && ['human', 'agent', 'service', 'local-owner'].includes(p.kind)); }
function sessionCheck(s, now) {
  need(s && Number.isSafeInteger(s.generation) && s.generation >= 0 && Number.isFinite(s.expiresAt));
  for (const k of ['sessionRef', 'workspaceRef', 'audienceRef', 'policyRevision']) need(isRef(s[k]));
  need(s.tenantRef === null || isRef(s.tenantRef));
  // This prototype deliberately cannot admit production or implicit public access.
  need(s.plane === 'preview');
  if (!s.principal) throw new PreviewRefusal('unauthenticated');
  principal(s.principal); principal(s.representedPrincipal);
  if (s.expiresAt <= now) throw new PreviewRefusal('expired');
}
function checkDelegation(s, request, target, now) {
  const d = s.delegation;
  if (!d) {
    need(s.principal.kind !== 'agent' && canonical(s.principal) === canonical(s.representedPrincipal)); return;
  }
  need(s.principal.kind === 'agent' && d.active === true && d.redelegationAllowed === false && isRef(d.ref) && isRef(d.revision));
  need(Number.isFinite(d.expiresAt) && d.expiresAt > now && d.expiresAt <= s.expiresAt);
  need(canonical(d.actor) === canonical(s.principal) && canonical(d.representedPrincipal) === canonical(s.representedPrincipal));
  for (const key of ['sessionRef', 'generation', 'tenantRef', 'workspaceRef', 'audienceRef', 'plane']) need(d[key] === s[key]);
  for (const key of ['modes', 'operationRefs', 'resourceRefs']) need(Array.isArray(d[key]) && d[key].length <= 64 && new Set(d[key]).size === d[key].length);
  need(d.modes.every(m => MODES.includes(m)) && d.operationRefs.every(isRef) && d.resourceRefs.every(isRef));
  if (!d.modes.includes(request.mode) || !d.operationRefs.includes(target.operationRef) || !d.resourceRefs.includes(target.resourceRef)) throw new PreviewRefusal('forbidden');
}
export function createPreviewEnforcer(ports, { now = Date.now } = {}) {
  for (const key of ['authenticate', 'resolveTarget', 'authorize', 'revalidate', 'perform', 'projectResult', 'audit']) need(typeof ports?.[key] === 'function');
  return Object.freeze({ async handle(channel, bytes, signal) {
    let request, binding, phase = 'parse', performed = false;
    const generation = Number.isSafeInteger(channel?.generation) && channel.generation >= 0 ? channel.generation : 0;
    const state = (name, projectedData) => deepFreeze({ state: {
      schema: 'atelier-preview-state/proposal-v1', requestId: request?.requestId || 'invalid', placementId: request?.placementId || 'invalid',
      sourceDigest: request?.sourceDigest || '0'.repeat(64), mode: request?.mode || 'synthetic', state: name,
      sessionGeneration: generation, publicMessage: messages[name],
    }, ...(name === 'ready' ? { projectedData } : {}) });
    const live = () => { if (signal?.aborted) throw new PreviewRefusal('stale'); if (binding && binding.expiresAt <= now()) throw new PreviewRefusal('expired'); };
    const fresh = async () => { live(); if (await ports.revalidate(binding, signal) !== true) throw new PreviewRefusal('stale'); live(); };
    const audit = (stage, outcome) => ports.audit(deepFreeze({ binding, phase: stage, outcome }));
    try {
      request = deepFreeze(parseRequest(bytes)); live(); phase = 'authenticate';
      const s = deepFreeze(structuredClone(await ports.authenticate(channel, signal)));
      sessionCheck(s, now()); live(); phase = 'resolve';
      const t = deepFreeze(structuredClone(await ports.resolveTarget(s, request, signal)));
      for (const key of ['resourceRef', 'operationRef', 'serviceRef', 'sourceRef', 'placementRef', 'registryRevision']) need(isRef(t?.[key]));
      for (const key of ['sourceDigest', 'descriptorDigest', 'rendererDigest']) need(isDigest(t[key]));
      need(t.sourceDigest === request.sourceDigest && t.placementRef === request.placementId);
      checkDelegation(s, request, t, now());
      binding = deepFreeze({ sessionRef: s.sessionRef, generation: s.generation, principal: s.principal, representedPrincipal: s.representedPrincipal,
        delegationRef: s.delegation?.ref || null, delegationRevision: s.delegation?.revision || null,
        tenantRef: s.tenantRef, workspaceRef: s.workspaceRef, plane: s.plane, mode: request.mode, audienceRef: s.audienceRef,
        target: t, requestRef: request.requestId, requestDigest: digestBytes(canonical(request)), policyRevision: s.policyRevision,
        expiresAt: Math.min(s.expiresAt, s.delegation?.expiresAt ?? Infinity) });
      phase = 'authorize'; live(); await audit('requested', 'pending');
      const decision = deepFreeze(structuredClone(await ports.authorize(binding, signal))); live();
      need(canonical(decision?.binding) === canonical(binding));
      if (decision.outcome !== 'allow') throw new PreviewRefusal(decision.outcome === 'deny' ? 'forbidden' : decision.outcome === 'reauth-required' ? 'expired' : 'unavailable');
      await audit('authorized', 'allowed'); await fresh(); phase = 'perform'; performed = true;
      const raw = await ports.perform(s, request, decision, signal);
      await fresh(); phase = 'project';
      const projected = await ports.projectResult(binding, raw, signal);
      // Trusted projector owns the field allowlist. Root still enforces JSON,
      // byte/depth bounds and cannot accidentally serialize result metadata.
      const data = parseBoundedJSON(JSON.stringify(projected));
      // Preparation is not a browser delivery acknowledgement. Keep the last
      // asynchronous audit inside the revalidation boundary before returning.
      await fresh(); await audit('settled', 'prepared'); await fresh();
      return state('ready', data);
    } catch (error) {
      const name = error instanceof PreviewRefusal ? error.state : 'unavailable';
      if (binding) {
        try { await audit('settled', performed ? 'uncertain' : name === 'stale' ? 'stale' : phase === 'authorize' ? 'denied' : 'failed'); }
        catch { /* No output or automatic effect retry if audit storage fails. */ }
      }
      return state(name);
    }
  } });
}
