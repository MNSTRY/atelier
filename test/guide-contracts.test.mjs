import assert from 'node:assert/strict';
import test from 'node:test';
import { guideDocumentDigest as hash, validateGuideDocument, createGuideEngagement, transitionGuideEngagement, assessGuideInvocation } from '../src/guides/contracts.mjs';
const offer = { schema: 'mnstry.atelier-guide-offer@v1', id: 'sample-offer', guideId: 'sample-guide', capabilityIds: ['sample-capability'], deliverableReview: 'required', commercialAuthority: false };
const capability = { schema: 'mnstry.atelier-remote-capability@v1', id: 'sample-capability', serviceRef: 'https://example.invalid/mcp', inputSchemaDigest: hash({}), outputSchemaDigest: hash({}), maxInputBytes: 1024, implementation: 'remote', executionAuthority: false };
function example() {
  const proposed = createGuideEngagement(offer);
  const engagement = transitionGuideEngagement(proposed, { expectedRevision: 0, action: 'accept', offerDigest: hash(offer) });
  const payload = { draft: 'Invented content' };
  const consent = { schema: 'mnstry.atelier-guide-consent@v1', offerDigest: hash(offer), capabilityDigest: hash(capability), payloadDigest: hash(payload), engagementRevision: 1, status: 'approved', validFrom: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z', authority: 'local-assertion-only' };
  return { offer, capability, engagement, payload, consent, now: Date.parse('2026-01-01T12:00:00Z') };
}
test('valid guide bindings remain non-executing local assertions', () => {
  const input = example();
  assert.deepEqual(validateGuideDocument(offer, 'offer'), []);
  assert.deepEqual(assessGuideInvocation(input), { status: 'eligible-for-host-validation', blockers: [], executionAuthority: false });
});
test('changed payload, capability, offer, stale revision and expiry refuse eligibility', () => {
  for (const modify of [
    x => { x.payload = { draft: 'Different content' }; },
    x => { x.capability = { ...x.capability, maxInputBytes: 1 }; },
    x => { x.offer = { ...x.offer, id: 'other-offer' }; },
    x => { x.consent = { ...x.consent, engagementRevision: 0 }; },
    x => { x.now = Date.parse(x.consent.expiresAt); },
    x => { x.now = undefined; },
    x => { x.consent = { ...x.consent, status: 'revoked' }; },
  ]) {
    const input = example(); modify(input);
    assert.equal(assessGuideInvocation(input).status, 'blocked');
  }
});
test('pause and revocation block and revocation cannot be resumed', () => {
  const input = example();
  input.engagement = transitionGuideEngagement(input.engagement, { expectedRevision: 1, action: 'pause', offerDigest: hash(offer) });
  assert.equal(assessGuideInvocation(input).status, 'blocked');
  input.engagement = transitionGuideEngagement(input.engagement, { expectedRevision: 2, action: 'revoke', offerDigest: hash(offer) });
  assert.throws(() => transitionGuideEngagement(input.engagement, { expectedRevision: 3, action: 'resume', offerDigest: hash(offer) }), /refused/);
  assert.throws(() => transitionGuideEngagement(input.engagement, { expectedRevision: 0, action: 'accept', offerDigest: hash(offer) }), /stale/);
});
test('descriptors refuse executable additions and authority claims', () => {
  assert.ok(validateGuideDocument({ ...capability, command: 'execute' }, 'capability').length);
  assert.ok(validateGuideDocument({ ...capability, executionAuthority: true }, 'capability').length);
  assert.ok(validateGuideDocument({ ...offer, commercialAuthority: true }, 'offer').length);
});
