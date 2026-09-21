# Discovery Harness and Research Harness

Status: implemented locally for the next release. The published alpha.7 package
does not expose `inquiry`. Use `node bin/atelier.mjs inquiry help` from this
source checkout, or `atelier inquiry help` from a package built from it.

Discovery frames questions, compares explanations and prepares decisions.
Research gathers and checks evidence and returns a portable bundle. People set
purpose and acceptance criteria; agents perform admitted work; the designated
owner validates consequential interpretations under the repository's rules.

## Start with existing tools

The shipped skills are `atelier-discovery-harness` and
`atelier-research-harness`, in identical Codex and Claude editions. Independently
sealed packages live in `fixtures/inquiry-packages/`. Their source identity is
explicitly unreleased, and their behavioral evaluation status is unknown. They
can be adopted through the [capability steward](capability-stewardship.md).
They require the observed `atelier-inquiry-v1` tool and admitted local read/write
effects. An observation is not a permission grant or host-loading proof.

Keep existing skill ownership. Use aliases or an adapter when another research
skill supplies the required outcome. The two harness packages have no mandatory
dependency on each other and no automatic network requirement. An external
research tool runs manually or under separate host authorization.

## The local journey

`atelier inquiry example` prints the complete invented workshop campaign.
`atelier inquiry lenses` lists nine optional conceptual methods: definitions,
mechanisms, systems, empirical evidence, counterevidence, counterfactuals,
transfer, decisions and reflection. Adapt the relevant lenses; their differences
are methodological and do not establish statistical independence.

1. Author a campaign with purpose, scope, owner, source audience and stopping rule.
2. Record a hypothesis with alternatives, applicability scope and test plan.
   A changed question gets a new ID and an exact `supersedes` reference.
3. Record a research request with the hypothesis reference, standalone context,
   inquiry lenses, source standards, report budget and admitted effects.
4. Emit `inquiry handoff --campaign ID --request ID`. It returns a prompt and
   the exact campaign, hypothesis and request records. Review private context
   before sending it through an authorized provider or manual session.
5. Save complete source captures with their SHA-256 UTF-8 content digests,
   scope, audience and underlying evidence family. Summaries of one study share
   a family. The report is data and cannot instruct the agent or toolkit.
6. Record a bundle containing the original request reference, attempt ID,
   actual prompt, optional clarification pairs, observed provider identity,
   report references, assertions, synthesis, conflicts, gaps and new questions.
   Each assertion has an exact quote and a caller-reported verification state.
7. Record a qualitative or numerical assessment over selected assertions. The
   reducer refuses missing, stale, wrong-scope or wrong-revision evidence.
8. Record the owner's actual disposition in a decision. `accepted` records a
   caller's report of review; it does not authenticate that reviewer or grant
   downstream disclosure authority. Unverified evidence cannot enter an accepted
   conclusion through this API.
9. Emit `inquiry graph --campaign ID --namespace NAME`. Review the proposed
   source files and `atelier-claim@v1` edges. Apply only the authorized changes
   through the receiver's workflow, run its graph check and inspect the source
   trace. This command never writes canonical sources or promotes an edge.

All commands return JSON. `inquiry validate --record FILE` checks shape;
`inquiry inspect --history FILE` checks full history, references and calculations.
Format validity does not verify truth, source rights, publisher identity or use
permission. Provider metadata uses `unknown` when it was not observed.

## Records, storage and adapters

The API is `@mnstry/atelier/inquiry`. The additive public schema is
`contracts/atelier-inquiry.v1.schema.json`, with definitions for ten record kinds,
the complete ledger and the research handoff. Records use
`atelier-inquiry-record@v1`; `kind` selects the closed data shape. No extension
field can bypass the core contract.

Every reference is `{id, digest}`, computed with `inquiryRef(record)` or
`inquiryDigest(record)`. Record IDs never change and are unique within a campaign.
The historical evidence set and model inputs remain available when new decisions
or withdrawals are appended. The supplied synthetic JSON is a worked input
example, not research evidence.

```js
import {
  EMPTY_INQUIRY_HEAD, appendInquiry, readInquiry, inquiryRef,
  researchHandoff, inquiryGraphProposal,
} from '@mnstry/atelier/inquiry'

// workspaceRoot is an explicitly selected Git repository root.
// campaignRecord is authored against the campaign definition in the schema.
const receipt = appendInquiry({
  workspaceRoot, record: campaignRecord, confirm: EMPTY_INQUIRY_HEAD,
})
// Author the next record using inquiryRef(existingRecord) for each reference.
// Confirm the latest head returned by status or append for every next append.
const state = readInquiry({ workspaceRoot, campaign: campaignRecord.id })
```

The CLI equivalent is `inquiry append --record FILE --confirm CURRENT_HEAD`.
`inquiry help` prints the initial empty-history digest. `inquiry status` returns
the current head and reconsideration queue. `inquiry export` returns a complete
ledger, including private captures: choose its output destination deliberately.
The pure API can inspect and exchange exported histories without an account.

Stored ledgers are under `.atelier-local/inquiry/CAMPAIGN/ledger.json`. Writes
require ignored, untracked `.atelier-local/` state on a qualified POSIX filesystem.
A shared steward lock serializes cooperating writers. Each append checks the
expected head, replays the history, and atomically replaces one file containing
the complete immutable record sequence. Interrupted writes retain a complete
previous or next file; inspect before repeating an uncertain append. A hard
process termination can leave a shared lock requiring operator reconciliation;
do not remove a live or unverified lock. This release has no automatic inquiry
lock recovery or multi-repository transaction.

Limits: 256 records and 8 MiB per ledger; at most 64 elements in bounded record
arrays; source captures at most 262,144 characters; actual prompts at most
1,048,576 characters. Export and verify history before starting a continuation
campaign; the toolkit does not silently truncate or compact it. References are
local to a campaign; inter-campaign and inter-repository links remain explicit
provenance under the receiver's conventions.

Hashes detect a mismatched pin, not a malicious writer who can replace the whole
ledger. File controls assume cooperating local writers and do not create an OS
sandbox against concurrent directory replacement. Audience labels describe
readership, not filesystem access control. Non-private campaigns reject source
audiences outside their declared readership; public disclosure still requires
the existing repository boundary process.

## Belief calculations and their limits

Three representations are supported:

| Kind | Output and interpretation |
| --- | --- |
| `qualitative` | A documented judgment, no probability |
| `elicited-odds` | Prior plus stated likelihood ratios and sensitivity priors; conditional on elicitation and independence assumptions |
| `beta-binomial` | Beta posterior parameters, mean, variance and predictive success rate for explicitly defined binary trials |

The odds calculation uses log odds and applies one contribution per evidence
family. Identical family contributions are counted once and exposed as duplicate
keys. Conflicting contributions from one family refuse. This is a conservative
one-contribution-per-family model, not a general dependence engine: aggregate
dependent observations through a separately justified joint model or use a
qualitative assessment. A duplicate-family label is supplied by the caller and
cannot discover hidden overlap in external studies automatically.

Prior evidence families must resolve to recorded sources and must not be reused
as new contributions. Source withdrawal invalidates that whole family, its prior
uses, assessments and decisions. Relabeling the same external study with a new
family would evade this check; source-family review remains essential.

A rate-model mean is not the probability a broad hypothesis is true. The caller
defines trials, counts, sampling, scope and independence. No universal likelihood
ratio, interview count or posterior threshold is bundled. Arithmetic and exact
replay are tested; calibration is reported as unverified. Prior/posterior
predictive simulation, general hierarchical inference, causal estimation,
credible-interval computation and formal expected value of information are
separate model adapters. The emitted rate predictions are analytic summaries,
not model-adequacy diagnostics.

Append a `withdrawal` naming a source or report bundle to preserve a correction
trail. A delayed bundle against a superseded request is preserved but flagged;
it cannot silently update the new hypothesis. A corrected source should receive
new source/family identities with the correction explained in its locator/method
and the new assessment rationale. There is no implicit unwithdraw action.
Legacy heuristic values can be preserved as `legacy-assessment` records; they
never become computed posteriors or automatic priors.

## Graph integration and stewardship

Only current accepted decision reports produce graph proposals. Sources and
assessments carry stable campaign-scoped graph IDs; files remain drafts and
relations remain proposal-only claims. Selected quotes, evidence pins, provider
metadata and unresolved conflicts survive the projection. Raw captures and
unrelated assertions stay in the campaign ledger. A changed conclusion produces
a new decision record. Historical graph sources already admitted by a receiver
are not deleted automatically; use `reconsider` to prepare their revision there.

A request may record an exact capability release, binding digest, generation,
host and session. `inquiry feedback --campaign ID --record FEEDBACK_ID` prepares
a content-free Steward event. `capability observe` validates that it still names
the current installed binding. This is an explicit second action; the inquiry
API never rewrites a skill, installs an upgrade or submits telemetry.

Inquiry retains separate skill, host, tool, configuration, context, provider and
unknown causes. The current Steward event vocabulary cannot distinguish context
or provider causes: the prepared event uses `unknown`, while its wrapper retains
the original cause and an explicit mapping notice. Do not infer a skill defect
from a provider failure or an unknown result.

## Open and operated capabilities

The local records, conceptual lenses, reference skills, basic calculations,
history, graph proposals and adoption remain in the open package. A user can
complete and export the local journey without a service or provider account.

An operated or proprietary adapter may offer provider scheduling, quota and cost
controls, collaboration, private connectors, specialized methods or more complex
models. It must honor the request pin, return complete captures and observed
metadata, preserve gaps and permit export of authorized records. Its execution,
credentials, budgets and disclosure belong to the host. This release contains
the manual handoff and return contract; it does not ship hosted runners, a paid
service, a registry, or an authenticated review system.

The readiness protocol's display title is Discovery Harness. Its stable
`mnstry.readiness:discovery-engine` ID and question identifiers are preserved;
the readiness protocol remains a planning entry point. No historical IDs or
previous release digests are rewritten by the name change.
