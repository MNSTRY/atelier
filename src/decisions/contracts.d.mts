export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }
export interface DecisionExtension { ext?: JsonObject }
export interface DecisionScope extends DecisionExtension {
  workspaceId: string
  /** Host-reported provenance; this reference does not grant authorization. */
  authorizationRef: string
}
export interface DecisionEvidence extends DecisionExtension {
  id: string
  sourceRef: string
}
export interface DecisionQuestionBase extends DecisionExtension {
  instructions: string
  evidenceIds: string[]
}
export interface ChoiceQuestion extends DecisionQuestionBase {
  type: 'choice'
  criteria: Record<string, string>
}
export interface ScoreQuestion extends DecisionQuestionBase {
  type: 'score'
  criteria: string[]
}
export interface BooleanQuestion extends DecisionQuestionBase {
  type: 'boolean'
  criteria: DecisionExtension & { true: string; false: string }
}
export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | BooleanQuestion
export interface DecisionRequest extends DecisionExtension {
  schema: 'atelier-decision-request@v1'
  contractVersion?: `1.${number}.${number}`
  id: string
  task: string
  rubricVersion: string
  scope: DecisionScope
  state: string
  evidence: DecisionEvidence[]
  questions: Record<string, DecisionQuestion>
}
export interface ChoiceAnswer extends DecisionExtension {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  /** A provider statistic, not a measured probability of semantic correctness. */
  confidence: number
}
export interface ScoreAnswer extends DecisionExtension {
  type: 'score'
  /** The zero-index weighted expectation of the ordered criteria. */
  score: number
  probabilities: number[]
  confidence: number
}
export interface BooleanAnswer extends DecisionExtension {
  type: 'boolean'
  probability: number
}
export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | BooleanAnswer
export interface DecisionUsage extends DecisionExtension {
  inputTokens: number
  outputTokens: number
}
export interface DecisionResultBase extends DecisionExtension {
  schema: 'atelier-decision-result@v1'
  contractVersion?: `1.${number}.${number}`
  requestId: string
  requestDigest: string
  task: string
  rubricVersion: string
  scope: DecisionScope
  provider: DecisionExtension & { id: string; model: string }
  authority: 'proposal-only'
  mode: 'shadow' | 'advisory'
  usage: DecisionUsage | null
  elapsedMs: number
}
export interface AssessedDecisionResult extends DecisionResultBase {
  status: 'assessed'
  answers: Record<string, DecisionAnswer>
  reason?: never
}
export type DecisionAbstentionReason = 'insufficient-evidence' | 'ambiguous' | 'no-match' | 'budget-exhausted' | 'provider-unavailable' | 'timeout' | 'invalid-response' | 'unauthorized'
export interface AbstainedDecisionResult extends DecisionResultBase {
  status: 'abstained'
  answers: Record<string, never>
  reason: DecisionAbstentionReason
}
export type DecisionResult = AssessedDecisionResult | AbstainedDecisionResult
export interface DecisionValidation { ok: boolean; errors: string[] }
export function validateDecisionRequest(input: unknown): DecisionValidation
export function validateDecisionResult(request: unknown, result: unknown): DecisionValidation
/** Checks questions and answers without state, hashing, or evidence membership. */
export function validateDecisionAnswers(questions: unknown, answers: unknown): DecisionValidation
/** Throws a generic TypeError for invalid input. The digest is lowercase SHA-256. */
export function decisionRequestDigest(request: unknown): string
