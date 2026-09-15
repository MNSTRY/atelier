# Connected composition workshop

A synthetic reference consumer for the experimental root composition, access
and preview modules. It does not connect to an identity provider or private
service. See [the boundary and implementation brief](../../docs/connected-composition.md).

## Run the reproducible proof

From the repository root, install its development dependencies using the
repository's normal workflow. Install this example's locked Astro runtime with
Node 22.22.2 (Astro requires a later patch than the root's Node 22.18.0 floor):

```sh
cd examples/connected-composition
fnm exec --using=22.22.2 npm ci
cd ../..
fnm exec --using=22.18.0 npx playwright install chromium firefox webkit
fnm exec --using=22.18.0 node --test test/connected-composition*.test.mjs
fnm exec --using=22.18.0 node scripts/prove-connected-composition.mjs
```

`ATELIER_ASTRO_RUNTIME` may instead point to an existing installed example
`node_modules` with Astro 7.3.2. `PLAYWRIGHT_BROWSERS_PATH` can select an existing
browser cache. No package download occurs in the proof script. The example lock
reuses the existing Astro reference consumer's versions and integrity pins;
offline npm lock validation verifies the trimmed dependency graph.

The proof starts no server. Playwright fulfills every request for two distinct
HTTPS loopback origins, refuses other traffic, builds a disposable source copy,
and controls the fake host from Node. It rebuilds after a source edit and proves
that both the static Astro heading and dynamic preview consume the new digest.
Screenshots, exact input/build hashes and the result receipt go under
`.artifacts/connected-composition/`. Temporary generated workspaces are retained
there for inspection. No canonical page is edited by the proof.

The fake bridge is installed only by the proof harness and only accepts its
top-level shell frame. The cross-origin preview cannot call it or inspect shell
DOM. Building this example alone yields a useful static page with disabled
fixture controls, not an authenticated service or a hosted interactive demo.
Do not deploy the proof bridge or treat fake adapter controls as real login.

## What is demonstrated

- A descriptor-selected scalar props/action contract, exact source-byte binding
  and an immutable definition/renderer registry snapshot.
- An opaque session-map adapter and an assertion-plus-membership adapter sharing
  one enforcement path; missing identity, wrong tenant and agent action refusals.
- Session/delegation/mode/resource/source/policy-bound decisions, fresh checks
  before the fake service and output, generic public failures and filtered data.
- A reversible in-memory pin action with expected-version concurrency and
  request-payload-bound idempotency. Nothing is published or permanently stored.
- Exact origin/window/nonce channel mounting, request sequencing, stale/replayed
  response refusal, navigation disposal and clearing on identity changes.
- Three desktop engines, narrow reflow, doubled text, native focus and no-script
  static content. These are not actual phone, native or assistive-technology tests.

Private integration, real token/session transport, provider assurance, persisted
effect reconciliation, audit durability and owner acceptance remain future gates.
The trusted host must notify/dispose the shell on real session or policy changes;
the helper is not a background identity watcher. Abort is cooperative: private
services must independently reauthorize and own their transaction outcome. An
uncertain response never promises rollback and must not trigger automatic retry.
