# Evidence navigation

The portable evidence contract describes exact source references, attributed
claims, declared host capabilities, and dependency snapshots. It sits under
Knowledge Stewardship and can be composed by inquiry harnesses. The pure
assessments are exported as `@mnstry/atelier/evidence-navigation` and the Node
local reader as `@mnstry/atelier/evidence-navigation/local`. There is no CLI
command.

`validateEvidenceDocument(shape, value)` requires a primitive string shape and
validates bounded JSON against the closed versioned schema. Supported shapes
include `profile`, `hostCapabilities`,
`evidenceRef`, `claim`, and `snapshot`. Unknown fields, unsupported kinds, missing
attribution, invalid dates, and malformed references fail. Reserved `ext` fields
cannot carry behavior. Unknown event time and source attribution remain explicit.
Arrays require the ordinary array prototype. Assessments validate and evaluate
the same copied descriptor values, without using the caller's getters or methods.

`assessEvidenceCompatibility(profile, host)` compares exact declared protocols,
operations, and capability versions. The result says whether those declarations
match. The host must separately qualify its implementation and enforce permission.

`assessEvidenceCurrency(reference, snapshots, { at, maxDepth, maxNodes })` checks
an exact source reference and all supplied dependencies. Missing, ambiguous,
changed, withdrawn, expired, and cyclic evidence cannot yield `current`. Reaching
a verification bound also refuses current use. The caller supplies a valid time;
the pure module never reads a clock, storage, identity, or permission service.
Snapshots are protected host inputs, not permission grants or agent-visible
provenance. This function does not establish coverage, absence, or completeness.

`assessClaimContinuity(previous, next)` checks one logical claim's immutable kind
and requires a new revision for changed content or status. Acceptance cannot
turn an observation into a stated preference. A separately attributed new claim
has a separate identity and lifecycle assigned by its owning host. This bounded
check binds `claimId`, owner record owner/objectId, and kind. It allows subject or
recorder attribution to change with a new revision; it does not classify a new
claim or establish semantic continuity. Matching references do not prove support
or truth.

Every assessment explicitly returns `executionAuthorized: false`,
`authorityTransferred: false`, and `semanticTruthVerified: false`. No assessment
installs instructions, changes consent, writes a record, or qualifies a host.
Source text remains evidence even when it contains imperative language.

The host owns authenticated scope, audience projection, current permission,
source admission and capture, dispatch, effects, and retention. It must recheck
at each read and handoff. Internal paths, selectors, identifiers, digests, and
hidden diagnostic details do not belong in an agent's result. The local
reader uses the existing ingestion and intake owners; these
pure functions create no second source store or acceptance lifecycle.

The generator projects the canonical schema and JSDoc types into ESM modules
and records their hashes and the pinned validator versions. Validation uses the
package's existing Ajv and format dependencies with strict validation and no
coercion or default insertion. A consuming runtime must supply those dependencies
or qualify its own generated validator against the same schema and fixtures. Run
`node scripts/generate-evidence-navigation.mjs --check` to refuse drift. The
generation manifest identifies generated artifacts; a receiving integration
must additionally pin the complete adopted source revision and its distribution.

Invented garden fixtures and focused tests exercise these bounded structural
properties. They do not prove installed consumers, operating-system isolation,
database transactions, source removal, provider retention, or end-to-end consent.

## Local search and exact fetch

`createLocalEvidenceReader`, exported as `@mnstry/atelier/evidence-navigation/local`
(`src/evidence-navigation/local.mjs`), is a Node adapter over one already-created
ingestion plan. There is no CLI command for it. The pure entry point does not
import it.

Trusted host construction supplies `workspaceRoot`, `workspaceId`, exact
`plan: { planId, planDigest }`, and synchronous `admit`. The callback receives the
operation (`search` or `get`) and exact plan binding. Hosts map these callback
strings to the profile operations `searchEvidence` and `getEvidence`. Only precisely
`{ disposition: 'permit', revision, readScope: 'all-plan' }` proceeds. The revision
is a nonempty, bounded identifier from current host authority. It changes whenever
relevant scope, audience, destination, or permission changes, including withdrawal
and regrant. Unknown scope, promises, callback errors, and other dispositions
refuse. Native Promise rejections are contained without awaiting the decision.
The host must admit the whole plan for this reader and intended recipient.
A test callback that always permits establishes no actual consent.

`search({ query, limit })` accepts up to five items and a nonblank query of at
most 512 UTF-16 code units and 32 terms after lowercase, trim, and whitespace
splitting. A secondary 2,048-byte UTF-8 ceiling is retained; the code-unit limit
is already stricter. Invalid queries refuse before admission or
store reservation and do not consume the read budget.
`get({ handle })` accepts only a handle issued by this reader. Optional `readScope`
must be `all-plan`; narrower scopes refuse before store construction. Model
arguments cannot choose paths, plans, backends, or permissions. Construction-only
`openStore` and `now` are trusted host/test seams, defaulting to the existing
store and monotonic clock. Never expose these options as tool arguments.
Admission is checked before construction, before reads, and before release,
against the same revision.

Search treats hits as pointers and re-fetches every item through the owner's
`getEvidence`. Only exact-fetched text is returned. Get rechecks its protected
source/attempt/locator binding and a private commitment to the earlier fetched
text. The owner's integrity label does not prove independent content authenticity:
its journal has no output digest, so a same-size stored rewrite before first
fetch may be undetectable. Backend errors expose no paths or stored diagnostics.
Admitted text itself is not redacted here; the host owns its audience and any
permission to process it downstream.

Results contain text, temporary handles, truncation, and `source-evidence` kind,
without protected IDs, digests, selectors, or hidden-match counts. Coverage is
always `partial`, including zero results. No current absence claim follows.
Instruction-looking text remains evidence; the consuming host must preserve that
distinction in its prompt/context boundary.

Defaults are 32 reserved store calls, 32 handles, 16,384 text bytes per item,
65,536 total released text bytes, and a 60-second session. Trusted limits can
vary within hard ceilings of 128 calls/handles, 65,536 bytes per item, 262,144
total bytes, and ten minutes. Search reserves one query plus its requested maximum
exact fetches. Failed and unused reservations are not refunded. UTF-8 truncation
preserves whole code points. A search releases its result as a whole; if no text
budget remains while fetching its hits, prepared items and handles are dropped
and the whole search refuses. Issued handles retain their session charge even
after an admission revision changes; start a new session for the new admission.
The ingestion owner's plan/processor ceilings bound
traversal; a hit limit does not limit inspected sources. Synchronous store reads
cannot be preempted by the lifetime check. A host requiring a hard execution-time
limit must qualify an isolated worker.

`close()` discards handles and refuses further reads. Expiry, clock reversal,
reentrant calls, foreign handles, changed authority, and changed sources refuse.
The adapter persists, ingests, accepts, activates, and schedules nothing. It
provides cooperative process-level checks, not OS isolation, a permission issuer,
or a database workflow. The host must qualify the real authority and release path.

## Read a complete selected citation

Lexical search is partial discovery. It can find a line that names an
instrument and miss the next line saying that approval awaits inspection. When
a source owner has selected a complete cited unit, a trusted host can read that
unit exactly with the existing APIs. This adds no model-callable API. Exact
reading shows what the selected unit says. It does not show retrieval quality,
answer correctness, usefulness, or semantic acceptance.

### Which route reads what

| Route | Reads | It cannot |
| --- | --- | --- |
| `createLocalEvidenceReader` `search` then `get({ handle })` | Hits that this reader's own search found and re-fetched | Accept a citation, locator, page, path, or protected reference. Only its own search issues handles. |
| `createIngestionStore` (`@mnstry/atelier/ingestion`) `getEvidence` | One exact span for a protected `planId`, `planDigest`, `sourceId`, `sourceDigest`, `attemptId` and `locator` | Grant permission. The host must admit the **whole plan** even though one fetch reads only the named source. A host whose decision covers only some sources must not call it; the store cannot detect this. |

`getEvidence` is the route for an explicitly selected citation. It keeps nothing
between calls: each call checks the current source digest, the completion
receipt stored beside the output, and the journal's recorded size and coverage.
Keep its bindings, the source map, and constructor arguments in trusted host
custody, never under model control. The source must already be in an ingestion
plan with a completed attempt.

### Steps for the host

1. **Map the unit.** The source owner defines the unit in the existing source
   map: its qualifying lines and limits, not just the lines matching a query,
   and whether the text is original or derived. Bind the map to the current
   source digest, the completed extraction attempt, the processor semantics,
   the ordered locators, and the expected hash of each exact text.
2. **Reuse the existing plan and attempt.** Do not create a second extraction
   store or reinterpret locators.
   - Text and Markdown evidence uses physical lines without their line
     terminators (`line`), split on CRLF, LF or a lone CR, after a leading BOM
     (U+FEFF) is removed.
   - JSON primitive leaves use RFC 6901 pointers (`json-pointer`): string text
     is decoded; numbers, `true`, `false` and `null` keep their source
     spelling; empty arrays and objects produce no evidence. A unit that relies
     on a boolean or number qualification includes that leaf.
   - CSV cells use `row:N,column:M` (`csv-cell`).
   - A report page is not a native locator; it needs an owner-verified mapping
     to lines. PDF extraction and page mapping are not supplied.
3. **Qualify authority first.** Before opening the store, qualify the actual
   actor, purpose, consent, whole-plan scope, and current admission revision.
   The host must supply and qualify the adapter that enforces these; Atelier
   supplies none. A test callback that always permits is not authentication or
   consent.
4. **Fetch and check every locator.**
   - Reserve a finite call count, an operation deadline, and a session budget.
     A deadline cannot interrupt a synchronous `getEvidence` call, which can
     run local Git reads and read a large stored attempt; a host that needs a
     hard time limit must qualify an isolated worker.
   - Fetch every required locator through `getEvidence`, checking admission
     before and after each call.
   - Check every returned field: `schema` is
     `mnstry.atelier-ingestion-evidence@v1`; the plan, source, attempt and
     locator equal the request; `freshness` is `current`; `integrity` is
     `verified`; `readScope` is `all-plan`; `semanticAcceptance` is `pending`;
     `synthesized` is `false`.
   - Compare each exact text's hash with the source owner's map. This is the
     check that catches stored content that changed: the store's own
     `integrity: verified` cannot (see the limits below).
   - Keep source text as data, including text that looks like instructions.
5. **Assemble within a byte budget.** Keep every selected fragment, in order.
   Omit paths, digests, IDs and locators unless they are separately admitted for
   that recipient. Measure the whole serialized response against the budget:
   metadata, JSON escaping, separators and any transport envelope. Byte limits
   are not token counts.
6. **Withhold incomplete selections.** If any required locator is missing,
   stale, differently bound, over budget, or refused, withhold the whole
   selection with an explicit incomplete result.
   - Never drop a qualification, clip it, or fall back to an old preview.
   - The local reader's text limits exclude envelope bytes and can return
     `truncated: true`; such an item cannot prove a complete unit.
   - Choose a separately permitted smaller complete unit or a larger bounded
     budget instead, and never call the incomplete selection complete.
7. **Revalidate before release.** Immediately before release, re-fetch every
   selected fragment and repeat all of step 4's checks, including each expected
   text hash, and confirm the admission revision is unchanged. Count those
   calls in the budget. Release only the complete selected unit, with semantic
   acceptance pending.

### Limits that remain

- **Selection is not completeness.** A complete selected unit is not
  completeness for the question or the corpus.
- **No snapshot.** Several filesystem reads are not an atomic source snapshot. A
  host that needs stronger consistency must supply and qualify its own snapshot
  or locking contract.
- **Integrity is local.** The intake completion receipt digests the extraction
  output, but it is stored beside that output in the same local state, and the
  ingestion journal records the output's size and coverage but no output
  digest. A writer able to rewrite the output and its receipt to the same size
  and coverage is not detected by `getEvidence` at any time, because it keeps
  nothing between calls; `integrity: verified` does not independently
  authenticate content. (The local reader is different: it commits to the text
  of its first fetch and detects a later change.) Comparing every fetch,
  including the release revalidation, against the source owner's
  independently bound hashes supports this one selection; it does not
  strengthen the store's general guarantee.
- **Quality is measured separately.** Keep the missed case in the retrieval
  evaluation, and show both the partial discovery and the complete selection.
  Do not count operator-selected citations as held-out search success. Record
  actual reads, response bytes and total effort separately. A person still
  supplies the real question, the permitted sources, and the usefulness
  judgment.
