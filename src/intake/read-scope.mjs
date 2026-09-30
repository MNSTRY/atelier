// Internal coordinator capability, intentionally absent from the package's
// public exports. Only synchronous, library-owned read loops enter a scope;
// caller callbacks and mutations must not inherit placement admission.
const scopes = new WeakMap();

export function registerIntakeReadScope(store, run) { scopes.set(store, run); }

export function withIntakeReadScope(store, read) {
  const run = scopes.get(store);
  if (!run) throw new Error('intake read scope is unavailable');
  return run(read);
}
