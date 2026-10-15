import type { ExtensionManifest, InstallationBinding, Invocation, Json, OperationReceipt } from './contracts.mjs'
export interface HostTransport {
  getInstallation(id: string): Promise<InstallationBinding>;
  invoke(request: Invocation): Promise<OperationReceipt>;
  lookupOperation(id: string, key: string, action: string): Promise<OperationReceipt | null>;
  recoverOperation(binding: InstallationBinding, key: string, action: string): Promise<OperationReceipt>;
  recordResult(operationId: string): Promise<void>;
}
export interface AdminHostTransport {
  configure(manifest: ExtensionManifest, connectionRef: string, environment: 'development' | 'staging' | 'production'): Promise<InstallationBinding>;
  transition(binding: InstallationBinding, transition: 'verify' | 'enable' | 'disable' | 'remove'): Promise<InstallationBinding>;
  upgrade(binding: InstallationBinding, manifest: ExtensionManifest): Promise<InstallationBinding>;
}
export function createHttpHostTransport(hostFetch: typeof fetch): HostTransport & AdminHostTransport
export function createExtensionClient(transport: HostTransport): {
  getInstallation(id: string): Promise<InstallationBinding>;
  invoke(binding: InstallationBinding, actionId: string, input: Json, idempotencyKey: string): Promise<OperationReceipt>;
  lookupOperation(id: string, key: string, action: string): Promise<OperationReceipt | null>;
  recoverOperation(binding: InstallationBinding, key: string, action: string): Promise<OperationReceipt>;
  recordResult(operationId: string): Promise<void>;
}
export function createExtensionAdminClient(transport: AdminHostTransport): Omit<AdminHostTransport, 'configure'> & { configure(manifest: ExtensionManifest, connectionRef: string, environment?: 'development' | 'staging' | 'production'): Promise<InstallationBinding> }
