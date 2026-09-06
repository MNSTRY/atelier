# External-project adapter starter

This invented example uses MNSTRY Atelier. The adapter owns configuration and
a sample extension pack; the separate source repository owns canonical text.
Runs, answers and review history remain ignored local state. Public audience
labels do not grant publication, consent or runtime access.

Create this scaffold with `atelier init --template external-project --target DIR`.
The target must not exist. No Git repository, hook or remote is created.
Initialize the adapter and its source directory as separate repositories when
ready; the adapter ignores `source/`. To connect an existing repository instead,
pass `--repo-path source=PATH` consistently, or use an ignored local overlay.
Keep domain vocabulary and methods in your own adapter and source repositories.
Replace the synthetic actor in the boundary policy with your actual policy.

Using the installed package's CLI, from the adapter directory:

```sh
atelier lock provenance
atelier config check --explain
atelier extension-pack validate
atelier graph
atelier project
atelier readiness
atelier review packs
atelier review run sample.readiness:contract-gate --answers answers.example.json
atelier dev --review
```

Open `/review` on the displayed local address. Use repository `source` and
`README.md` to leave a question. Use the returned run ID to review its claims.
The evaluator measures answer completeness only. Read and judge the evidence;
acceptance creates a handoff, never a canonical edit. Use `atelier review history`
and `atelier review handoff REQUEST_ID` to inspect records locally.

Real answers and responses belong in ignored local state, not the tracked
example answer file. Reopening recovers saved contributions; missing or failed
saves remain visible. Stop/start the foreground sidecar with the same project
and reopen the same document. This does not establish cross-computer access.

For CI, compose the root's existing consumer, portability, boundary and
private-disclosure checks. No new CI run or provider is triggered by this template.
Before changing the pack, run `atelier upgrade --dry-run`, retain historical
pack content, update its lifecycle declaration and lock through your reviewed
migration process, and run the checks again. Never reinterpret old run evidence.
