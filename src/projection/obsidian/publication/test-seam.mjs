// Crash injection for tests. The seam is a symbol-keyed option holding a
// function, so it cannot arrive through JSON, a bridge payload, a CLI argument
// or a configuration file, and the code sent to a real app never carries it.
//
//   publishView({ ..., [CRASH_INJECTION_TEST_SEAM]: { at: 'after-exchange', halt: () => process.kill(process.pid, 'SIGKILL') } })
//
// Points inside the critical section: after-exchange, after-recovery-move,
// after-editor-update, after-removal-move. Points in the publisher:
// after-staging, after-capture, after-publish, before-manifest-commit,
// after-manifest-pointer. Inside the retirement of a staged file, between its
// move to the unit's recovery directory and the judgement: after-retire-move.
export const CRASH_INJECTION_TEST_SEAM = Symbol('atelier.obsidian.crash-injection-test-seam')
