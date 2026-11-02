/** Derived source DTOs. Digests establish integrity, never source ownership. */

/** @typedef {`sha256:${string}`} Digest */
/** @typedef {{repoId:string, localId:string}} NodeRef */
/** @typedef {{start:number, end:number, byteStart:number, byteEnd:number}} SourceRange */
/** @typedef {{repoId:string, path:string, revision:Digest, digest:Digest, locator?:{pointer?:string, range?:SourceRange, targetRange?:SourceRange, rangeDigest?:Digest}}} SourceRef */
/** @typedef {{base:string, include:string|null, exclude:string|null}} CensusScope */
/** @typedef {{path:string, rawDigest:Digest, byteLength:number}} SourceFilePin */
/** @typedef {{repoId:string, head:string, tree:string, dirty:boolean, scope:CensusScope, files:SourceFilePin[], digest:Digest}} RepositorySnapshot */
/** @typedef {{ref:NodeRef, source:SourceRef, title:string, summary:string, path:string, extension:'md', type:'markdown', kgType:string, domain:string, lifecycle:string, status:string, audience:string, classification:'classified', tags:string[]}} ContributionNode */
/** @typedef {{source:NodeRef, target:NodeRef|null, origin:'ordinary-link', syntax:'markdown'|'wikilink', embed:boolean, href:string, fragment:string, provenance:SourceRef, resolution:'resolved-local'|'unresolved'}} OrdinaryLinkOccurrence */
/** @typedef {{source:NodeRef, target:string, predicate:string, origin:'declared', provenance:SourceRef}} DeclaredRelation */
/**
 * A source projection, not a permission decision or accepted semantic assertion.
 * revision is snapshot.digest, including the selected dirty working-tree bytes.
 * rangeDigest pins exactly the raw byte slice described by locator.range.
 * @typedef {object} RepositoryContribution
 * @property {'atelier.repo-contribution@v1'} schema
 * @property {'markdown-explicit-id/v1'} sourceProfile
 * @property {{repoId:string, identity:{provider:'github', id:string, source:'recorded-identity'}, aliases:string[]}} repository
 * @property {RepositorySnapshot} snapshot
 * @property {{config:SourceRef|null, plan:SourceRef|null}} inputs
 * @property {ContributionNode[]} nodes
 * @property {OrdinaryLinkOccurrence[]} ordinaryLinks
 * @property {DeclaredRelation[]} declaredRelations
 * @property {Digest} digest
 */
/** @typedef {{scope?:Partial<CensusScope>, inputPaths?:{config?:string, plan?:string}}} SourceBuilderOptions */
/** @typedef {Omit<OrdinaryLinkOccurrence, 'resolution'> & {resolution:'resolved-local'|'resolved-cross-repository'|'unresolved'}} ResolvedOrdinaryLinkOccurrence */
/** @typedef {{nodes:ContributionNode[], ordinaryLinks:ResolvedOrdinaryLinkOccurrence[], declaredRelations:DeclaredRelation[]}} ContributionTopology */

export {}
