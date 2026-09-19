// Edits made in a vault: the raw-byte lens that turns an edited note into
// exact source bytes or a typed refusal, and the observation that turns a
// pending edit record into an edit operation document, and the durable,
// object-keyed arbitration of those operations across views and processes.
// The lens, the observation and the arbitration write to no source file and to
// no vault. Source apply (apply.mjs) is the one operation that writes a source
// file, under the policy decision of policy.mjs.
export { ALIGN_LIMITS, alignBodies } from './align.mjs'
export {
  DEFAULT_APPLY_QUIET_PERIOD_MS, SOURCE_APPLY_DIRECTORY, SOURCE_APPLY_OPERATION_ID, SOURCE_APPLY_PRIMITIVES, SOURCE_APPLY_PROTOCOL_ID, SOURCE_APPLY_RECORD_SCHEMA, SOURCE_APPLY_REFUSALS,
  SOURCE_APPLY_STEPS, SourceApplyRefusal, createSourceApply, createSourceApplyForOracleTests,
} from './apply.mjs'
export { createApplyCommandOperation, createEngineApplyOperation, createSourceApplyContribution, processApplyContext } from './contribution.mjs'
export { APPLY_MODES, APPLY_POLICY_PRIMITIVES, APPLY_POLICY_REFUSALS, DEFAULT_MANUAL_ACTOR, applyPolicyDigest, canonicalApplyPolicy, createApplyPolicyForOracleTests, decideApply, withApplyPolicyDigest } from './policy.mjs'
export { ARBITRATION_REASONS, ARBITRATION_RULES, EditArbitrationRefusal, OBJECT_EVENT_SCHEMA, OBJECT_EVENT_TYPES, REFUSED_DISPOSITIONS, arbitrateEvents, isObjectEvent } from './arbitrate.mjs'
export { MAX_PLAIN_SEGMENT, decodeIdentitySegment, encodeIdentitySegment } from './object-identity.mjs'
export { EDIT_ACKNOWLEDGEMENT_SCHEMA, OBJECTS_DIRECTORY, OBJECT_INDEX_DIRECTORY, OBJECT_INDEX_SCHEMA, OBJECT_STORE_CRASH_STEPS, OBJECT_STORE_LIMITS, OBJECT_STORE_PRIMITIVES, createObjectStoreForOracleTests, openObjectStore } from './object-store.mjs'
export { EDIT_LENS_VERSION, EDIT_OBSERVATION_STEPS, createEditObserverForOracleTests, editIdempotencyKey, observeEdit } from './observe.mjs'
export { EDIT_LENS_PRIMITIVES, EDIT_LENS_REFUSALS, applyEditLens, assertRewritesAccounted, createEditLensForOracleTests, findStructuralLinks, placeUnits, splitGeneratedTail, splitPrefix } from './regions.mjs'
