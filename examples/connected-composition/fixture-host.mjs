// Invented in-memory adapter/service example. Not a production identity provider.
import { createRegistrySnapshot, digestBytes } from '../../src/composition/registry.mjs';
import { parsePlacement, canonical, closed } from '../../src/composition/wire.mjs';
import { createPreviewEnforcer, PreviewRefusal } from '../../src/access/preview-enforcer.mjs';

export const definitionBytes = JSON.stringify({ schema: 'atelier-component-definition/proposal-v1', componentId: 'sample.collection', version: '1.0.0',
  rendererRef: 'sample.collection.renderer', propsSchemaRef: 'sample.collection.props', dataContractRefs: ['sample.collection.read'],
  projections: ['web'], previewModes: ['synthetic', 'connected-read-only', 'sandbox-interactive'] });
export function placementBytes(heading = 'Workshop notes') {
  return JSON.stringify({ schema: 'atelier-component-placement/proposal-v1', placementId: 'sample.collection.1', componentId: 'sample.collection',
    componentVersion: '1.0.0', slotRef: 'page.main', props: { heading, limit: 5 },
    dataBindings: [{ contractRef: 'sample.collection.read', resourceRef: 'sample.collection.notes' }] }, null, 2) + '\n';
}
const human = Object.freeze({ issuer: 'fixture.issuer', subject: 'sample.reader', kind: 'human' });
const agent = Object.freeze({ issuer: 'fixture.issuer', subject: 'sample.agent', kind: 'agent' });
function base(generation, now) {
  return { principal: human, representedPrincipal: human, sessionRef: 'fixture.session', generation, tenantRef: 'sample.tenant', workspaceRef: 'sample.workspace',
    plane: 'preview', audienceRef: 'sample.preview', expiresAt: now + 60000, policyRevision: 'policy.1', delegation: null };
}
// Adapter A: opaque handle lookup in a session store.
export function sessionMapAdapter({ generation, now, identity }) {
  const sessions = new Map([['opaque-fixture-handle', base(generation, now)]]);
  return { authenticate: async channel => {
    const value = sessions.get(channel.handle);
    if (!value || identity === 'signed-out') throw new PreviewRefusal('unauthenticated');
    return value;
  } };
}
// Adapter B: a preverified fixture claim plus separate membership resolution.
// The WeakMap identity is host-only; the browser cannot mint this assertion.
export function assertionMembershipAdapter({ generation, now, identity }) {
  const assertion = {}, verified = new WeakMap([[assertion, { subject: human.subject, audience: 'sample.preview' }]]);
  const memberships = new Map([[human.subject, { tenant: 'sample.tenant', workspace: 'sample.workspace' }]]);
  return { channel: { assertion }, authenticate: async channel => {
    const claim = verified.get(channel.assertion), membership = memberships.get(claim?.subject);
    if (!claim || identity === 'signed-out') throw new PreviewRefusal('unauthenticated');
    if (!membership || claim.audience !== 'sample.preview') throw new PreviewRefusal('forbidden');
    return { ...base(generation, now), tenantRef: membership.tenant, workspaceRef: membership.workspace };
  } };
}

export function createFixtureHost({ sourceBytes = placementBytes(), rendererBytes = 'invented fixture renderer', clock = Date.now, hooks = {} } = {}) {
  let source = sourceBytes, generation = 1, identity = 'human', adapterName = 'session-map', version = 0, pinned = false;
  const events = [], effectReceipts = new Map(); let effects = 0;
  const registry = createRegistrySnapshot({ definitionBytes, rendererBytes, revision: 'registry.1',
    validateProps: props => { closed(props, ['heading', 'limit']); return typeof props.heading === 'string' && props.heading.length <= 120 && Number.isSafeInteger(props.limit) && props.limit >= 1 && props.limit <= 5; },
    validateIntent: (ref, payload) => { closed(payload, ['pinned', 'expectedVersion']); return ref === 'sample.pin' && typeof payload.pinned === 'boolean' && Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion >= 0; },
  });
  const channels = new WeakMap();
  function newChannel() {
    const adapter = adapterName === 'session-map' ? sessionMapAdapter({ generation, now: clock(), identity }) : assertionMembershipAdapter({ generation, now: clock(), identity });
    const channel = Object.freeze({ generation });
    channels.set(channel, { adapter, inner: adapter.channel || { handle: 'opaque-fixture-handle' }, generation, identity }); return channel;
  }
  const active = binding => binding.generation === generation && identity !== 'signed-out' && binding.target.sourceDigest === digestBytes(source) &&
    binding.policyRevision === 'policy.1' && binding.target.registryRevision === registry.revision && binding.expiresAt > clock();
  const allowed = binding => active(binding) && binding.tenantRef === 'sample.tenant' && binding.workspaceRef === 'sample.workspace' &&
    binding.audienceRef === 'sample.preview' && binding.plane === 'preview' && binding.target.resourceRef === 'sample.collection.notes' &&
    ['sample.read', 'sample.pin'].includes(binding.target.operationRef) &&
    (binding.target.operationRef !== 'sample.pin' || (binding.mode === 'sandbox-interactive' && binding.principal.kind === 'human'));
  const ports = {
    async authenticate(channel) {
      const item = channels.get(channel);
      if (!item || item.generation !== generation) throw new PreviewRefusal('stale');
      const s = await item.adapter.authenticate(item.inner);
      if (identity === 'agent') {
        s.principal = agent;
        s.delegation = { ref: 'delegation.1', revision: '1', active: true, expiresAt: s.expiresAt, actor: agent, representedPrincipal: human,
          sessionRef: s.sessionRef, generation, tenantRef: s.tenantRef, workspaceRef: s.workspaceRef, audienceRef: s.audienceRef, plane: s.plane,
          modes: ['synthetic', 'connected-read-only'], operationRefs: ['sample.read'], resourceRefs: ['sample.collection.notes'], redelegationAllowed: false };
      }
      if (identity === 'other-tenant') s.tenantRef = 'sample.other';
      return s;
    },
    async resolveTarget(session, request) {
      if (request.sourceDigest !== digestBytes(source)) throw new PreviewRefusal('stale');
      return registry.resolve({ sourceBytes: source, sourceRef: 'sample.source', request, serviceRef: 'sample.service', operationRef: request.intentRef || 'sample.read' });
    },
    async authorize(binding) { return { binding, outcome: allowed(binding) ? 'allow' : 'deny', publicReason: 'fixture.policy' }; },
    async revalidate(binding) { await hooks.revalidate?.(binding); return active(binding); },
    async perform(session, request, decision) {
      await hooks.beforeService?.();
      // Independently reauthorize, including delegation and exact request.
      if (!allowed(decision.binding) || decision.binding.requestDigest !== digestBytes(canonical(request)) || (request.intentRef && session.delegation)) throw new PreviewRefusal('forbidden');
      if (request.intentRef) {
        const key = canonical([session.sessionRef, session.principal, request.requestId]);
        const signature = digestBytes(canonical(request));
        const prior = effectReceipts.get(key);
        if (prior && prior.signature !== signature) throw new PreviewRefusal('forbidden');
        if (prior) return structuredClone(prior.result);
        if (request.payload.expectedVersion !== version) throw new PreviewRefusal('stale');
        // No await between version comparison and this invented effect/receipt.
        pinned = request.payload.pinned; version++; effects++;
        const result = rawResult(); effectReceipts.set(key, { signature, result });
        await hooks.afterEffect?.(); return structuredClone(result);
      }
      return rawResult();
    },
    async projectResult(binding, result) {
      await hooks.project?.();
      return { heading: result.heading, items: result.items.slice(0, 5).map(item => ({ title: item.title })), pinned: result.pinned, version: result.version };
    },
    async audit(event) { await hooks.audit?.(event); events.push(event); },
  };
  function rawResult() { return { heading: parsePlacement(source).props.heading, items: [{ title: 'Paper shapes' }, { title: 'Color studies' }], pinned, version,
    internalSecret: 'fixture-private-canary', membership: 'host-only-fixture-membership' }; }
  const enforcer = createPreviewEnforcer(ports, { now: clock });
  return { ports, enforcer, registry, events, newChannel,
    handle(channel, bytes, signal) { return enforcer.handle(channel, bytes, signal); },
    setSource(bytes) { parsePlacement(bytes); source = bytes; generation++; },
    setIdentity(value, adapter = adapterName) {
      if (!['human', 'agent', 'signed-out', 'other-tenant'].includes(value) || !['session-map', 'assertion-membership'].includes(adapter)) throw new TypeError('Unknown fixture adapter');
      identity = value; adapterName = adapter; generation++;
    },
    snapshot() { return { sourceDigest: digestBytes(source), placementId: 'sample.collection.1', generation, effects, version, pinned }; },
  };
}
