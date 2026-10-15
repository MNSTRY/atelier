export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface InstallationBinding { installationId: string; generation: string; releaseDigest: string }
export interface Invocation extends InstallationBinding { actionId: string; idempotencyKey: string; input: Json }
export interface OperationReceipt { operationId: string; state: 'pending' | 'admitted' | 'succeeded' | 'unknown' | 'failed'; result?: Json; resultDigest?: string }
export interface ActionManifest { id: string; effect: 'read' | 'write'; scope: 'member' | 'tenant'; inputSchemaRef: string; outputSchemaRef: string; timeoutMs: number }
export interface ExtensionManifest {
  schema: 'mnstry.extension-manifest/v1'; extensionId: string; releaseVersion: string; releaseDigest: string; protocol: 'mnstry.extension/v1';
  compatibility: { sdkMajor: 1; rootContracts: string[]; hosts: ('web' | 'native')[] };
  deployment: { profile: string; bundleDigest: string; schemaDigest: string }; actions: ActionManifest[];
  recovery?: { lookupActionId: string }; permissions: { rootReads: string[]; rootWrites: string[]; egress: string[] };
  surfaces: { id: string; compositionDigest: string; actionIds: string[] }[];
  data: { classes: string[]; retention: 'until-user-delete'; exportVersion: 1; schemaVersion: string; readableSchemaVersions: string[] }
}
export class ExtensionError extends Error { readonly code: string; readonly status: number; constructor(code: string, status?: number) }
export function canonicalJson(value: unknown): string
export function text(value: unknown, limit?: number): string
export function exact(value: unknown, required: string[], optional?: string[]): Record<string, unknown>
export function parseManifest(value: unknown): ExtensionManifest
export function parseInstallationBinding(value: unknown): InstallationBinding
export function parseOperationReceipt(value: unknown): OperationReceipt

export interface ProviderOperationProof extends InstallationBinding { schema: 'mnstry.extension-provider-operation/v1'; operationId: string; actionId: string; payloadDigest: string; resultDigest: string; result: Json }
export function parseProviderOperationProof(value: unknown): ProviderOperationProof
