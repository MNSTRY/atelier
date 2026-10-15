import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { ExtensionManifest, Json, OperationReceipt, ProviderOperationProof } from './contracts.mjs'
import type { VerifiedScope } from './server.mjs'
export interface ConvexVerifierOptions {
  issuer: string; audience: string; installationId: string; releaseDigest: string;
  keys: ReadonlyMap<string, JsonWebKey>; now?: () => number;
  consume?(claims: Readonly<Record<string, unknown>>, delegation: string): Promise<boolean>;
}
export interface ConvexActionDefinition<I = Json, O = Json, D extends GenericDataModel = GenericDataModel> {
  input(value: unknown): I; output(value: unknown): O;
  run(context: { context: GenericMutationCtx<D>; scope: VerifiedScope }, input: I): unknown | Promise<unknown>;
}
export interface ConvexExtension { readonly manifest: ExtensionManifest }
export function convexDigest(value: unknown): Promise<string>
export function assertConvexScope(scope: VerifiedScope): void
export function defineConvexExtension<D extends GenericDataModel = GenericDataModel>(options: {
  manifest: ExtensionManifest; verifier: ConvexVerifierOptions; actions: Record<string, ConvexActionDefinition<any, any, D>>;
}): ConvexExtension
export function createRootAdmissionConsumer(options: { origin: string; allowLocalTesting?: boolean; fetch?: typeof fetch }): NonNullable<ConvexVerifierOptions['consume']>
export function createConvexHttpHandler(extension: ConvexExtension, invoke: (args: { delegation: string; payload: Json }) => Promise<OperationReceipt>): (request: Request) => Promise<Response>
export function runConvexInvocation<D extends GenericDataModel>(extension: ConvexExtension, context: GenericMutationCtx<D>, args: { delegation: string; payload: Json }): Promise<OperationReceipt>
export function onceConvexOperation<D extends GenericDataModel>(context: GenericMutationCtx<D>, scope: VerifiedScope, input: Json, run: (context: GenericMutationCtx<D>) => Promise<Json>): Promise<Json>
export function lookupConvexOperation<D extends GenericDataModel>(context: GenericMutationCtx<D>, scope: VerifiedScope, operationId: string): Promise<ProviderOperationProof | null>
export function convexHealth<D extends GenericDataModel>(context: GenericQueryCtx<D>, manifest: ExtensionManifest): Promise<{ schema: 'mnstry.extension-health/v1'; ready: true; profile: 'convex-native'; releaseDigest: string; schemaDigest: string }>
