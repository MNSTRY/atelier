// Keep a selected local workspace independent of an enclosing Git hook.
// Other inherited process settings are preserved and are never logged here.
export const localCliEnvironment = (environment = process.env) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
