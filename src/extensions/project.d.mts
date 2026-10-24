import type { ExtensionManifest, ExtensionReleaseBundle } from './contracts.mjs'

export type SqlProjectProfile = 'postgres-sql' | 'drizzle-db-first' | 'drizzle-code-first' | 'prisma-7-postgres'
export type ProjectProfile = ExtensionManifest['deployment']['profile']
export type ProjectModel = 'counter' | 'checklist'
export interface ProjectLocation { directory: string; extensionId?: string }
/** Checklist is an explicit PostgreSQL-only provider example. */
export type SqlProjectOptions = ProjectLocation & (
  { profile?: 'postgres-sql'; model?: ProjectModel } |
  { profile: Exclude<SqlProjectProfile, 'postgres-sql'>; model?: 'counter' }
)
export interface ScaffoldResult {
  directory: string; profile: ProjectProfile; releaseDigest: string; qualified: false;
  model?: ProjectModel; hostBinding?: 'unbound';
}
export interface ProjectValidation {
  valid: true; profile: ProjectProfile; extensionId: string; releaseDigest: string;
  qualified: false; packAdoption: 'pending';
}
export function scaffoldPostgres(options: ProjectLocation & { model?: ProjectModel }): Promise<ScaffoldResult>
export function scaffoldSqlProject(options: SqlProjectOptions): Promise<ScaffoldResult>
export function scaffoldConvexProject(options: ProjectLocation & { model?: 'counter' }): Promise<ScaffoldResult>
export function sealProject(directory: string, initialManifest?: ExtensionManifest): Promise<ExtensionManifest>
export function validateProject(directory: string): Promise<ProjectValidation>
export function exportReleaseBundle(directory: string): Promise<ExtensionReleaseBundle>
