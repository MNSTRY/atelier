# Previous release locks

`alpha10-lock.json` is unchanged output from `writeAtelierLock` in public release
`0.2.0-alpha.10`, commit `ff9162df77c0020252fcc73767a47e74b6e22a3e`, using the
invented Example Workshop configuration and boundary policy in the exact-upgrade
tests. The producer source was exported from that commit and resolved against
the same locked dependencies. Its `local_path` package provenance reflects that
export; no private checkout path is stored.

The lock preserves the release's actual bundled readiness-pack identity and
digest. Both upgrade participants commit these bytes before planning, verify
that preparation leaves them alone, then apply only the saved confirmed plan.
The fixture is not generated from the current package during tests: doing so
would miss incompatible edits to the bundled pack under its existing identity.

`alpha12-lock.json` is the same output from public release `0.2.0-alpha.12`,
commit `8ff17ac255b79a874a56afa699173dff2b5aec17`, which is byte-identical to
the published registry package. It is the direct predecessor of the next
release and records the Node.js 22 and 24 runtime range. The prior-release
upgrade tests run against both locks.
