# Project location and repository overrides

Project-aware commands share these options through the project resolver:

```sh
atelier extension-pack validate --project adapter/atelier.project.json --repo-path content=../source
atelier graph --project-config=adapter/atelier.project.json --repo-path=content=../source
atelier config check --project adapter/atelier.project.json --explain
```

Both `--flag=value` and `--flag value` work. Repeat `--repo-path NAME=PATH`
for multiple logical repositories. Names must already be declared in the
project; an undeclared name adds no repository or read authority. The last
override for a name wins. The first `--project` or `--project-config` selection
wins, preserving existing alias behavior. Missing or malformed values now fail
with `project-option-invalid` instead of silently falling back to another path.
Paths may contain spaces or equals signs; quote them as your shell requires.

Resolution precedence is CLI override, ignored local overlay, tracked relative
path, then sibling discovery. CLI paths resolve from the working directory;
tracked and overlay paths resolve from the project config directory. Sibling
discovery checks the declared remote when one is supplied. An override does not
change the repo's declared identity or read boundary; downstream graph and
boundary checks still apply. `kind: external` means unmanaged with no read
boundary, not an adapter for reading arbitrary external content.

`config check --explain` shows logical names, resolution sources and declared
read boundaries without machine paths or remote URLs. `resolved` means a path
was selected, not that the repo exists or passed identity and content checks.
Resolution may create ignored `.atelier-local/` directories; this diagnostic is
not a promise of a write-free invocation. The ordinary config report retains
its existing shape and local config path.

## Command inventory

| Family | Project handling | Other effects |
| --- | --- | --- |
| config, graph, project/build | Shared resolver | Validation or generated artifacts |
| readiness, generated aliases | Shared resolver; protocol listing can be standalone | Runs, packets, generated artifacts |
| extension-pack list/validate | Shared resolver and strict command options | Loads declared packs locally |
| setup, doctor | Shared resolver | Ignored state repair when requested |
| boundary, promote | Shared resolver | Boundary checks, explicit hooks or ledger operations |
| upgrade, lock | Shared resolver | Explicit lock/upgrade operations |
| dev/server, support | Forward project arguments to the shared resolver | Local listener or local support preview |
| context/resolve/capabilities/proposal | Shared resolver | Local context envelope or capabilities report |
| init/adopt | Target/template inputs; generated config then resolved | Creates starter/config files |
| contract, export/dry-run, analysis, egress, distribution, disclosure, attestation, feedback, announcements, sync | File/repo-specific inputs | Follow their own command contracts |

The shared options do not turn standalone commands into project consumers.
Command-specific parsers retain their existing behavior; in particular the
extension-pack allowlist still refuses unknown options. Public and legacy CLI
names, `runCli` distribution wrappers, and direct project-aware modules all
reach the same resolver.
