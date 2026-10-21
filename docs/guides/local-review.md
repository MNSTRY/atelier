# Local source review

The optional review workspace helps a reader inspect claims, ask a question or
propose a correction, and retain that contribution. It records **locally asserted
identity**. A typed name is not an authenticated approver. Acceptance does not
edit source, publish content, grant access or admit a runtime.

Start with `atelier init --template external-project --target NEW_DIRECTORY`.
Use a destination whose ancestors are real directories, not symlinks. The
starter refuses existing destinations and does not initialize Git or install
hooks. Initialize its adapter and synthetic source as separate repositories when
ready. An established repository can replace the synthetic source through
`--repo-path source=PATH`; this changes location, never read authority.

From the adapter, run `atelier graph`, then `atelier project`, followed by:

```sh
atelier review packs
atelier review run sample.readiness:contract-gate --answers answers.example.json
atelier dev --review
```

Open `/review` on the loopback address printed by the foreground sidecar. Enter
repository `source` and path `README.md`, copy an exact passage, type a question
or correction, and choose **Save response**. Save is confirmed only after the
ledger acknowledges the write. On contention, stale content or service failure,
the wording remains in the form and the page does not claim success. Retry an
unchanged contribution after restoring service. A changed draft is a new request.
Unsaved browser drafts are not durable across tab closure.

To resume, save a reading position using the exact passage. Close the page,
reopen it, enter the same asserted name and choose the recorded **Resume** button.
The response history remains visible. A position is restored only against the
same document digest. After a source edit, earlier responses retain their exact
wording, anchor and original digest; explicitly select a passage in the new
revision and contribute a new response. Reading and scrolling never imply agreement.

Enter the returned run ID to review individual subject/predicate/object claims.
Each shows its ID, mapped answer fields, source-reference resolution, source
identity and a bounded excerpt. References in this first cut resolve exact graph
node IDs. Free text, URLs and other reference schemes remain unresolved; they
are never silently treated as source evidence. A linked source establishes
which bytes were read, not whether they logically support the proposed claim.
Read the document and record your judgment. Missing mapped sources or required
answers prevent acceptance. Rejection and revision remain available against
current evidence, so missing evidence can be discussed honestly.

Accept/reject/revise requires a reason, request ID and expected version. Every
contribution is immutable. Subsequent versions link through the same claim/run
identity and target version; proposed successor wording is retained without
rewriting the original claim. A later rejection supersedes an earlier acceptance
for current handoff. An identical retry returns the prior record. Another
reader's intervening contribution refuses a stale version; reopen the run before
making a new decision. Previous history remains visible rather than being
collapsed into a single latest-state approval.

**Inspect owner handoff**, or `atelier review handoff REQUEST_ID`, displays the
proposed relationship, rationale, affected IDs and required evidence digest.
The source owner decides the concrete edit in its own workflow. Source changes
remain unapplied and promotion remains unestablished. No owner-application receipt
or publication authorization is fabricated. Changed source/configuration,
policy, pack or evaluator inputs make current handoff ineligible.

The legacy readiness score and `ready`-shaped packet fields retain their existing
contract meanings: input completion and draft preparation. They are not evidence
confidence, independent rule execution, human acceptance or runtime readiness.
New claims omit the former arbitrary numeric confidence. Bound snapshots store
protocol content, normalized answers, pack identity, declared source byte digests,
policy identity, and the shipped source/schema evaluator inventory. Dependency
bytes and upstream publisher authentication need separate installation proof.
Historic v1 runs without snapshots remain available through the existing readiness
commands, but cannot be accepted as current evidence through this review surface.

The existing sidecar supplies loopback host/origin checks, session nonce checks
and private-file protection. `--review` is opt-in. The new ledgers live separately
from legacy proposals under `.atelier-local/review/`. Each record occupies its own
immutable event aggregate, so existing compaction retains the complete audit
history. Per-target versions are checked while holding the ledger write lock.
Local files and locally asserted identities are not protection from an operator
who controls that same account and its filesystem.

Synthetic installed and browser checks establish software behavior. An unfamiliar
reader's useful question or correction, assistance required, and actual adopter
acceptance still need a human observation; automated tests cannot supply it.
