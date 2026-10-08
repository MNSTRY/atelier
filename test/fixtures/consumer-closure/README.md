# Consumer closure planner fixtures

Invented lockfiles for `test/consumer-closure-plan.test.mjs`. Every package,
scope and host name is made up; the hosts use the reserved `.test` domain, and
each `integrity` value is the SHA-512 of the text `name@version`, not of a real
tarball. Nothing here was recorded from an installation.

`clean-lock.json` is the base: a consumer that installs `@example/publisher`,
which depends on `pinned-dep` and `plain-dep`. Each other lockfile differs from
it in the one way its name says. `publisher-package.json` is the selected
package's installed manifest, with one exact override that is installed, one
that is not, and one each of a range, a version-selector key and a nested
override. `consumer-package.json` is the candidate's own manifest.
