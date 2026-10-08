// The pure consumer-closure classifiers live in the packed source, so that the
// read-only `upgrade closure` planner can use them. This path is kept for
// consumer-smoke.mjs and the tests that import it.
export * from '../src/upgrade/closure-diagnostics.mjs'
