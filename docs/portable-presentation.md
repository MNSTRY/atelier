# Portable presentation v1

Status: opt-in implementation candidate, not a published or adopted interface.
Contract discussion: [issue 39](https://github.com/MNSTRY/atelier/issues/39).

## Placement and authority

Atelier owns the domain-neutral presentation model, bounded validators, neutral
tokens, reference views and proof mechanisms in this module. A host supplies
meaning, capabilities, action references, data, business validation, persistence,
operation outcomes and receipts. A renderer cannot promote a request into an
operation, permission, accepted decision or publication.

This implementation was independently derived from generic presentation
requirements and public accessibility standards. The paper-shape fixture is
invented. No client implementation, brand palette, information architecture or
methodology was imported. The existing CLI, sidecar HTML helpers and unpublished
control-grammar work are not replaced or silently adopted. This is a new optional
subpath, not a second semantic interpretation or route-adoption authority.

Source reservation: `src/ui/presentation/**`, the two presentation schemas,
`fixtures/ui/presentation/**`, the presentation tests and proof/generation scripts,
and this document. The package-export additions and contract-corpus entries are
the only shared-file hunks. No runtime, server, command catalog, existing UI
helper, release guard, route, template or consumer source is changed.

## API and host connection

```js
import { assertPresentation, renderPresentation } from '@mnstry/atelier/presentation'
import { bindPresentation } from '@mnstry/atelier/presentation/browser'

assertPresentation(model)
container.innerHTML = renderPresentation(model)
const binding = bindPresentation(container.querySelector('[data-ap-root]'), model, {
  onRequest: request => host.receivePresentationRequest(request),
})
// Before replacing or unmounting this presentation:
binding.dispose()
```

`host` is a consumer-owned port, not a shipped implementation. Do not pass
arbitrary HTML; only the validated renderer output is intended for insertion.
Give simultaneously mounted models distinct IDs. Styles and DOM IDs are scoped
by that identity. Callers embedding more than one workspace must supply an
appropriate page-level landmark hierarchy; the document renderer emits a main
landmark for one workspace.

Required model identity is `schema: "atelier.presentation/v1"` and
`version: "1.0.0"`. Optional `contractVersion` follows the repository's schema
epoch convention; it is metadata, not an alternative version-negotiation path.
Optional `ext` containers are retained, bounded plain JSON and never interpreted,
rendered or used to authorize an action. Unknown ordinary fields and unsupported
versions refuse. Canonical serialization does not mean signing or acceptance.

All callback requests carry `schema: "atelier.presentation-request/v1"`,
`version: "1.0.0"`, `presentationId`, `status: "proposed"`, and
`executionAuthority: false`. Kinds and payloads:

| Kind | Payload | Host obligation |
| --- | --- | --- |
| action | `id`, opaque `actionRef`, optional `presentationConfirmed: true` | Resolve current permission, operation and final outcome independently |
| selection | `id`, `itemId` | Return authoritative selection; do not infer persistence |
| resize | pane `id`, bounded percentage `value` | Apply current host geometry rules and return the next model |
| edit | field/editor `id`, string `value` | Maintain local draft promptly; validate and persist through existing authority |
| move | sequence `id`, `itemId`, zero-based `position` | Recheck eligibility and current ordering; apply only through the host |
| navigation | native `id`, `paneId`, or `itemId` and local `href` | Resolve host navigation and focus; never create a global shortcut bridge |

Callback resolution confirms delivery only. Rejection reports delivery failure,
not business refusal or rollback. Repeated pending actions are suppressed; edits
coalesce to the latest value while delivery is pending. Unmount removes scoped
listeners and pending visual flags but cannot cancel a callback already delivered
to a host. Host operations therefore need their own concurrency, idempotency,
authorization and outcome-recovery controls. Do not retain an old binding when
replacing a model. The native component should be keyed to its model identity.

The module installs no transport, storage, process, global keyboard handler,
telemetry, hosted account, command registration or navigation service. Web links
are local paths or fragments. Media resolves only local paths; hosts must prevent
those routes from redirecting outside their intended boundary. The model is not
a network-security boundary for a consumer's asset server.

## Tokens, composition and component families

One checked token source covers typography, light/dark color, spacing, layout,
density, elevation, borders, motion and state. Overrides are restricted to known
keys and safe values. Text/background pairs have a 4.5:1 floor, control boundaries
and focus have 3:1, and reference controls have 44-unit minimum targets in both
densities. Compact density changes spacing, not target or type floors. A host's
font metrics, zoom, transparency and surrounding surface still need verification.

One primary pane is required. Context/utility panes remain linear and reachable
at narrow widths; resizing is hidden when panes stack. Panes accept block IDs,
not executable routes, business schemas or workspace-allocation commands.

Implemented reference families: text, collection, ordered sequence, graph node
list with relationship table, media, action, status, refusal, decision, receipt,
offer, field, editor, preview, diff, review and publication. The latter names are
display slots: their text, tone and actions come from the host. No business
lifecycle is defined. Graph lists and relationship tables are the accessible
baseline; a force layout, query engine, graph editing and virtualization are not
implemented by this reference. Rich text/media editors likewise belong in
separately proved adapters, not in an unbounded interpretation of a text field.

Only host-selected blocks should enter a workspace. The all-family fixture is a
coverage gallery, not a recommended product screen. Use the workspace's primary
task and context needs to limit simultaneous controls; preserve visible reasons,
action consequences and recovery state when applying progressive disclosure.

## Interaction and accessibility contract

Hover, focus, pressed, selected, disabled, pending, invalid and dragging are
independent axes; selection must not erase focus. Web focus is visible, pressed
feedback differs from hover, and reduced-motion preference removes transitions.
Forced-color mode retains focus and selection boundaries. Ordinary keys and Tab
remain native; only a focused range's Arrow/Home/End keys and the confirmation
dialog's Tab endpoints are locally handled. Host-resolved shortcut display and
ARIA hints register no commands and promise no shortcut implementation.

Confirmation shows host-supplied consequences, initially focuses Cancel, contains
Tab, accepts Escape and restores the opener (or surviving pane). Confirmation is
never an authorization or successful irreversible operation. A missing native
confirmation port refuses to send. A host still owns reauthentication, irreversible
action eligibility, last-moment checks, receipt interpretation and recovery.

Sequences optionally expose drag requests and equivalent earlier/later buttons.
Drop handling accepts only an active drag begun in the same bound sequence; it
never imports external drop data. Touch and keyboard users need not drag. Bounds
and order remain host-controlled after either interaction. Browser/native
platforms may supply additional drag affordances only after equivalent proof.

The reference follows the intent of W3C guidance on
[modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/),
[range/separator interaction](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/),
[non-drag alternatives](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
and [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
The range is a labelled native range, not an assertion of splitter-pattern
conformance. Automated checks do not establish WCAG certification or assistive
technology acceptance.

## Host projections and explicit exceptions

| Host | Implemented projection | Remaining receiving-host proof |
| --- | --- | --- |
| Web | Semantic HTML, scoped CSS and local binder | Real route, keyboard catalogue, assistive technology and host updates |
| Desktop webview | Same optional web module | Webview version, OS shortcuts/focus, process and broker isolation; no Desktop runtime included |
| Native | Injected React/native-compatible primitives, tokens, requests, linear graph/diff, pane layout | Actual framework build, font scaling, screen reader, keyboard/focus, dialogs, touch and device proof |
| Documents | `renderReadOnlyDocument`, linear content and print styles | Exact PDF/export pipeline, tagging, pagination, font embedding and document semantics |

`createNativePresentation` accepts the consumer's existing `React`, `View`,
`Text`, `Pressable`, `TextInput`, `ScrollView`, and `Image`; compatible wrappers
can use existing Tamagui primitives. Atelier takes no framework dependency.
`Pressable` must support React Native's state-function style. The host supplies
measured `containerWidth`, `resolveAsset` and a `confirm` port implementing cancel
initial focus and focus restoration. Native uses step/move buttons instead of a
browser range/drag API. Focus treatment and OS keyboard behavior remain native
host obligations; injected-tree tests cannot prove them. Do not claim compatibility
with a specific framework version until its mounted adapter has been tested.

Document output has no edit, resize, confirmation or move controls. It preserves
host status text but cannot create a receipt. Print neutralizes dark colors and
hides navigation and action groups. This is HTML suitable for an existing export
pipeline, not a new semantic document or PDF authority.

## Proof and visual-regression governance

Run from a source checkout using Node 22.18.0:

```sh
node scripts/generate-presentation-schema.mjs --check
node --test test/ui-presentation.test.mjs test/contract-hygiene.test.mjs
node scripts/prove-presentation-browser.mjs
npm run contract:compat
npm run public-api:compat
npm run syntax:check
npm test
```

The browser runner uses an already installed `playwright` package. An absolute
module path may be supplied through `ATELIER_PLAYWRIGHT_MODULE`; it is a local
tooling choice, not a package dependency. No browser download or server startup
is performed. All requests are intercepted to invented fixtures, with other
origins refused. Default engines: Chromium, Firefox, WebKit. Optional
`ATELIER_PROOF_BROWSERS` narrows coverage and must remain visible in the receipt.

Outputs live in ignored `.artifacts/presentation-browser` (override with
`ATELIER_PROOF_OUTPUT`). A receipt records exact source-module and fixture hashes,
Git HEAD, browser versions, checks and screenshot hashes. During development HEAD
alone does not identify the working source; freeze a commit and rerun before
using it for acceptance. Successful rendering explicitly does not accept a
visual baseline, native device, or downstream adopter.

Baseline governance is deliberate: never auto-update expected images after a
failure. Store a baseline's exact source/fixture/environment identity and its
reviewing owner's disposition outside generated output. Compare at equal engine
version, viewport, scale, locale, theme, density, motion and font environment.
Changed pixels require explanation and a retained before/after pair. Keep
geometry, accessible names, focus, behavior and content assertions alongside
images; screenshot equality alone is insufficient. A host with no accepted
baseline remains unaccepted, not silently green. Actual device and assistive
technology runs are separate required evidence for those adoption claims.

`comparePresentationProofs(baseline, candidate)` returns `incomparable` for missing
or changed coverage, `review-required` for changed screenshot digests, or
`unchanged`. It always reports `baselineApprovalVerified: false` and
`executionAuthority: false`. The calling proof owner must verify the referenced
image bytes and baseline provenance; matching self-reported digests are not
proof of image custody or an accepted design.

Reference chrome is currently English. `lang` and `direction` preserve host
content language and logical layout, not complete translated control copy.
Localization, rich editor composition, large-graph exploration, native hover and
keyboard-focus treatment, and a mounted framework-specific adapter remain
explicit extensions requiring focused proof before those capabilities are claimed.

## Versioning, migration and adoption

The implementation uses presentation v1.0.0 but does not publish a new package
version. Existing published subpaths retain the repository's compatibility gate;
new presentation contracts have no historical baseline yet. Changes to token
meaning, state behavior, focus, required labels, request payloads or host defaults
must be treated as compatibility changes even when TypeScript would accept them.

An adoption handoff must pin package/source/tree, model and token version,
consumer source/tree, exact write set, host/framework versions, supported family
set, shortcut/focus owner, business request resolver, proof matrix and rollback.
Adapter conversion is explicit: validate both input and output, retain the old
source and rendered evidence, and migrate one synthetic consumer before any
real content. There is no automatic data migration, global token switch, route
replacement or private adapter import in this module.

Completion ladder:

1. Root source, schema parity, neutral reference rendering and defensive tests.
2. Exact committed source, full existing suite, private disclosure scan and
   tarball inspection; maintainer integration review and actual CI separately.
3. A bounded consumer adapter with explicit business/keyboard/focus handoffs.
4. Mounted host/browser/device/document proofs and accepted visual baselines.
5. Separately authorized package publication, route adoption and activation.

Only the root implementation is allocated here. Other owners' source stays
read-only. A local proof, commit, package audit or issue does not advance the
later milestones by implication.
