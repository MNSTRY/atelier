// Edits made in a vault: the raw-byte lens that turns an edited note into
// exact source bytes or a typed refusal, and the observation that turns a
// pending edit record into an edit operation document. Nothing here writes to
// a source file or to a vault.
export { ALIGN_LIMITS, alignBodies } from './align.mjs'
export { EDIT_LENS_PRIMITIVES, EDIT_LENS_REFUSALS, applyEditLens, createEditLensForOracleTests, findStructuralLinks, placeUnits, splitGeneratedTail, splitPrefix } from './regions.mjs'
