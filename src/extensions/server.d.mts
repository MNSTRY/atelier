import type { KeyObject } from 'node:crypto'
import type { ExtensionManifest, Json } from './contracts.mjs'
export interface VerifiedScope {
  readonly installationId: string; readonly tenantRef: string; readonly subjectRef: string; readonly generation: string;
  readonly releaseDigest: string; readonly actionId: string; readonly operationId: string; readonly payloadDigest: string; readonly rootWrites: readonly string[];
}
export interface VerifierOptions {
  issuer: string; audience: string; installationId: string; releaseDigest: string; keys: ReadonlyMap<string, KeyObject>;
  now?: () => number; consume(claims: Readonly<Record<string, unknown>>, delegation: string): Promise<boolean>;
}
export interface ActionDefinition<I = Json, O = Json> {
  input(value: unknown): I; output(value: unknown): O; run(context: { scope: VerifiedScope; signal: AbortSignal }, input: I): unknown | Promise<unknown>;
}
export function digest(value: unknown): string
export function releaseDigest(value: unknown): string
export function assertVerifiedScope(scope: VerifiedScope): void
export function createRootAdmissionConsumer(options: { origin: string; allowLocalTesting?: boolean; fetch?: typeof fetch }): VerifierOptions['consume']
export function defineAction<I, O>(definition: ActionDefinition<I, O>): Readonly<ActionDefinition<I, O>>
export function defineExtension(options: { manifest: ExtensionManifest; verifier: VerifierOptions; actions: Record<string, ActionDefinition<any, any>> }): unknown
export function createExtensionHandler(extension: ReturnType<typeof defineExtension>): (request: Request) => Promise<Response>
