import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalize } from '../attestation/jcs.mjs';
import { validateJsonSchema } from '../export/atelier-export-contract.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-guide.v1.schema.json', import.meta.url), 'utf8'));
export function guideDocumentDigest(value) { return createHash('sha256').update(canonicalize(value)).digest('hex'); }
export function validateGuideDocument(value, kind) {
  if (!['offer', 'capability', 'consent', 'engagement'].includes(kind)) return ['unknown guide document kind'];
  const errors = validateJsonSchema({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${kind}` }, value);
  if (kind === 'capability' && !errors.length) {
    const url = new URL(value.serviceRef);
    if (url.username || url.password || url.search || url.hash) errors.push('service reference must not contain credentials, query or fragment');
  }
  return errors;
}
function requireValid(value, kind) {
  if (validateGuideDocument(value, kind).length) throw new Error(`invalid guide ${kind}`);
}
export function createGuideEngagement(offer) {
  requireValid(offer, 'offer');
  return { schema: 'mnstry.atelier-guide-engagement@v1', offerDigest: guideDocumentDigest(offer),
    revision: 0, status: 'proposed', authority: 'local-assertion-only' };
}
export function transitionGuideEngagement(state, { expectedRevision, action, offerDigest }) {
  requireValid(state, 'engagement');
  if (expectedRevision !== state.revision || offerDigest !== state.offerDigest) throw new Error('stale or mismatched guide engagement');
  const routes = { proposed: { accept: 'accepted', revoke: 'revoked' }, accepted: { pause: 'paused', revoke: 'revoked' }, paused: { resume: 'accepted', revoke: 'revoked' }, revoked: {} };
  const status = Object.hasOwn(routes[state.status], action) ? routes[state.status][action] : null;
  if (!status) throw new Error('guide transition refused');
  return { ...state, revision: state.revision + 1, status };
}

// No connection, credentials, invocation, payment, or permission grant occurs.
// A host must independently authenticate participants and revalidate revocation,
// consent, policy, schema and exact bytes immediately before any disclosure.
export function assessGuideInvocation({ offer, capability, engagement, consent, payload, now }) {
  const blockers = [];
  for (const [kind, value] of Object.entries({ offer, capability, engagement, consent })) {
    if (validateGuideDocument(value, kind).length) blockers.push(`invalid ${kind}`);
  }
  if (blockers.length) return { status: 'blocked', blockers, executionAuthority: false };
  let bytes;
  try { bytes = canonicalize(payload); } catch { blockers.push('payload is not canonical JSON'); }
  if (!Number.isFinite(now)) blockers.push('explicit current time required');
  if (engagement.status !== 'accepted') blockers.push('engagement is not accepted');
  if (engagement.offerDigest !== guideDocumentDigest(offer) || consent.offerDigest !== engagement.offerDigest) blockers.push('offer binding mismatch');
  if (consent.engagementRevision !== engagement.revision) blockers.push('consent revision is stale');
  if (!offer.capabilityIds.includes(capability.id) || consent.capabilityDigest !== guideDocumentDigest(capability)) blockers.push('capability binding mismatch');
  if (consent.status !== 'approved') blockers.push('disclosure consent is not approved');
  if (now < Date.parse(consent.validFrom) || now >= Date.parse(consent.expiresAt) || Date.parse(consent.validFrom) >= Date.parse(consent.expiresAt)) blockers.push('consent is not currently valid');
  if (bytes !== undefined && (Buffer.byteLength(bytes) > capability.maxInputBytes || guideDocumentDigest(payload) !== consent.payloadDigest)) blockers.push('payload binding or byte limit mismatch');
  return { status: blockers.length ? 'blocked' : 'eligible-for-host-validation', blockers, executionAuthority: false };
}
