// Selection, focus, apply policy setup, conflict state and acceptance receipt
// validation for the Obsidian projection. Selection and focus are pure;
// selection state, policy setup and the conflict view read and write the
// workspace's private state through the runtime's own primitives; the receipt
// validator is schema validation only and closes no gate.
export { FOCUS_BOOKMARK_TYPE, FOCUS_QUERY_PRIMITIVES, FOCUS_QUERY_VERSION, MAX_FOCUS_PATHS, UI_OWNED_SETTINGS_FILES, buildFocusQuery, createFocusQueryBuilderForOracleTests, focusBookmarkPayload } from './focus.mjs'
export { EMPTY_SELECTION_REASONS, SCOPE_CONTRACT_SCHEMA, SELECTION_SCHEMA, resolveSelection, scopeDocumentOf } from './selection.mjs'
export { SELECTION_DIRECTORY, SELECTION_STATE_SCHEMA, assertWritableSelectionPath, listSelectionStates, readSelectionState, selectionStateDocument, validateSelectionState, writeSelectionState } from './selection-state.mjs'
export { CONFLICT_DISPOSITION, DEFAULT_MAX_BATCH_SIZE, DEFAULT_RETRY_BUDGET, POLICY_SETUP_ACTIONS, POLICY_SETUP_SCHEMA, buildApplyPolicy, dispatchGate, runPolicySetup } from './policy-setup.mjs'
export { CONFLICT_VIEW_SCHEMA, OBJECT_VIEW_STATES, conflictView, readConflictView } from './conflict-view.mjs'
export { ACCEPTANCE_KINDS, RECEIPT_EXT_KEY, RECEIPT_GATES, RECEIPT_GATE_IDS, RECEIPT_RULES, RECEIPT_VALIDATION_LABEL, createReceiptValidatorForOracleTests, receiptRequirementsFor, validateAcceptanceReceipt } from './receipt.mjs'
export { SELECTION_CONTRIBUTION_ID, createApplyPolicyOperation, createConflictsOperation, createSelectionContribution, createSelectionOperation } from './contribution.mjs'
