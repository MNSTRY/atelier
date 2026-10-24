import type { Sql } from 'postgres'
export interface AdoptionColumn { name: string; type: string; nullable: boolean }
export interface AdoptionTable {
  schema: string; table: string;
  owner: { role: string; reference: string };
  scope: { installationId: string; tenantRef: string; subjectRef: string };
  columns: AdoptionColumn[];
}
export interface AdoptionRequest {
  profile: 'postgres-sql' | 'drizzle-db-first' | 'drizzle-code-first' | 'prisma-7-postgres';
  database: string; schemaVersion: string; source: { reference: string; digest: string };
  schemas: string[]; tables: AdoptionTable[];
}
export interface AdoptionCatalogTable {
  schema: string; table: string; relationOid: string; ownerRole: string; kind: 'r' | 'p';
  rlsEnabled: boolean; rlsForced: boolean; policyCount: number; primaryKey: string[]; columns: AdoptionColumn[];
}
export interface AdoptionPlan {
  profile: AdoptionRequest['profile']; database: string; serverVersion: string; schemaVersion: string;
  source: AdoptionRequest['source']; requestDigest: string; catalogDigest: string;
  readOnly: true; runtimeBound: false; qualified: false; accepted: false;
  status: 'mapping-changes-required' | 'owner-review-required';
  ownershipMap: Array<Pick<AdoptionTable, 'schema' | 'table' | 'owner' | 'scope'> & {
    relationOid: string; ownership: 'role-matched-owner-reference-unverified';
  }>;
  catalog: AdoptionCatalogTable[];
  differences: Array<{ table: string; column?: string; kind: string; expected?: AdoptionColumn; observed?: AdoptionColumn }>;
  limits: string[];
}
export function parseAdoptionRequest(value: unknown): AdoptionRequest;
/** The existing native postgres-js Sql type is reused, without a bundled driver. */
export function planPostgresAdoption(database: Sql, request: AdoptionRequest): Promise<AdoptionPlan>;
