# Start Atelier independently

Atelier runs locally with readable files and Git as the source of record. The
CLI, library and contracts work without a MNSTRY account, hosted service or
desktop utility. Installing the package uses the npm registry; the authoring
commands below run locally.

## Find the source and choose a release

The maintained public source is [MNSTRY/atelier](https://github.com/MNSTRY/atelier),
on `main`. In the 20 October 2026 source/release snapshot, its package manifest
describes the `0.2.0-alpha.15` candidate. A version in source is not a publication receipt.
The example below pins the published `0.2.0-alpha.14` alpha release. Registry
`latest` and `alpha` are separate channels; check them before choosing an upgrade:

```bash
npm view @mnstry/atelier dist-tags --json
```

Use Node.js `>=22.18.0 <23` or `>=24.13.1 <25`, as declared by the current
source package. See [installation](install.md) and [upgrades](../guides/upgrade.md) for
release identity, workspace locks and migration checks.

## Create a disposable example

Run these commands in a new directory:

```bash
npm init -y
npm install --save-dev @mnstry/atelier@0.2.0-alpha.14
npx mnstry-atelier init --template sample-workspace --target ./sample
npx mnstry-atelier graph --project ./sample/atelier.project.json
npx mnstry-atelier build --project ./sample/atelier.project.json
```

Inspect the readable sources in `sample/` and the generated graph and projection
under `sample/atelier-output/`. Generated output is rebuildable; it does not
replace source files. To view it in an optional foreground browser service:

```bash
npx mnstry-atelier dev --project ./sample/atelier.project.json --port=0
```

Open the printed `127.0.0.1` URL and stop the service with Ctrl-C. Build first:
`dev` serves an existing projection. These commands need no MNSTRY environment
variables or canonical-repository credentials.

Keep the `@mnstry/` package scope. After installation, `npx mnstry-atelier`
selects the shipped binary; the unscoped npm package `atelier` is unrelated.

## Adopt a small scope in an existing repository

From the intended repository, install the same pinned package, then select the
actual documents you want the graph to read:

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.14
npx mnstry-atelier adopt --profile single-repo --target . --include 'docs/**' --yes
```

`adopt` prepares the project configuration and ignored local bindings. Review
its diff and the selected sources before building the graph. Existing documents
need the appropriate metadata or sidecars; use the [knowledge setup workflow](knowledge-setup.md)
to author that model. `init` is for a new starter and refuses existing Atelier
configuration. Neither path requires enabling [Sync](../guides/atelier-sync.md).

## Public tooling and consuming hosts

The complete export list is in `package.json`. Choose the surface that matches
the work:

| Surface | Existing examples | Boundary |
| --- | --- | --- |
| Local authoring and contracts | Root API, `./project`, `./graph`, `./projection`, versioned `./contracts/` subpaths | Files, Git and adopted contracts retain authority. |
| Optional local interfaces | `./cli`, `./server`, `./ui`, `./presentation`, `./presentation/browser`, `./presentation/native` | A host selects and qualifies its presentation and lifecycle. |
| Optional supervision and integrations | `./runtime`, `./runtime/git`, `./extension-packs`, `./extensions`, `./extensions/client`, `./vault` | Git synchronization and host-bound providers require explicit configuration; the host supplies provider SDKs and credentials. |
| Local proposals and learning | `./collaboration`, `./learning` | Proposal acceptance is copy-only; learning activation supplies scoped context. Neither grants source-write authority. |

Generic headless startup, editor and native-presentation bindings remain public
tooling. MNSTRY's desktop utility is a separate proprietary consumer. A host's
authentication, integrated capture, provider access and managed data stay with
that host. See the [responsibility architecture](../reference/architecture.md),
[learning boundary](../guides/learning.md) and [local-service contract](../reference/local-services.md).

Repository read access exposes its files. Audience metadata governs projections;
it does not hide private files from someone who can read the repository. Share
only an explicitly prepared bounded view, and retain owner-controlled source
application. Public tooling does not supply a managed MNSTRY runtime or confer
runtime admission.
