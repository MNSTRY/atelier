import { refuse } from './errors.mjs'

// Whether the installed Obsidian may be published through and opened.
//
// Nothing here looks at this machine. What is installed is learned through an
// injected `appProbe`:
//
//   appProbe.inspect()                 -> { installed, cli, running, version, noVaultOpen? }
//   appProbe.vaultState({ vaultRoot }) -> { answered, indexReady }
//
// `installed` and `cli` are booleans, `running` is true, false or null (not
// known) and `version` is the app's own version text or null. `noVaultOpen`
// is true when the command-line tool answered that no vault is open. The
// production probe is a separate module that only the real command-line
// entries load; every test passes its own.

// The publication protocol sets the view's undocumented `lastSavedData` field.
// 1.13.7 is the only app version that protocol was proven on, so it is the
// floor. Raising the ceiling needs the protocol cases re-run on that release.
export const MINIMUM_APP_VERSION = '1.13.7'

export const APP_OUTCOMES = Object.freeze(['qualified', 'app-missing', 'app-cli-unavailable', 'app-version-unsupported'])

const VERSION = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?(?=$|[\s(])/

// { major, minor, patch, prerelease: string[] } or null. Only a version at the
// very start of the text counts; anything else is not a version.
export function parseAppVersion(text) {
  if (typeof text !== 'string' || text.length > 200) return null
  const match = VERSION.exec(text.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

function comparePrerelease(left, right) {
  // No prerelease ranks above any prerelease of the same version.
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    const [a, b] = [left[index], right[index]]
    const [aNumeric, bNumeric] = [/^\d+$/.test(a), /^\d+$/.test(b)]
    if (aNumeric && bNumeric) { if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1 } else if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    else if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

// Pure. -1, 0 or 1; null when either side is not a version.
export function compareAppVersions(left, right) {
  const [a, b] = [parseAppVersion(left), parseAppVersion(right)]
  if (a === null || b === null) return null
  for (const part of ['major', 'minor', 'patch']) if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

// Pure. A version that cannot be read does not meet the floor.
export function meetsMinimumAppVersion(version, floor = MINIMUM_APP_VERSION) {
  const order = compareAppVersions(version, floor)
  return order !== null && order >= 0
}

// While the app runs with no vault open, its command-line tool answers every
// command, `version` too, with this line (observed on 1.13.7, on either output
// stream and with either exit status). It is not a version.
const NO_VAULT_OPEN = /^vault not found\.?$/i

// Pure. What one `version` call of the command-line tool answered:
// { version, noVaultOpen }. `exited` is false for a call that failed or exited
// non-zero; its output is then read for the no-vault answer, never for a version.
export function readVersionAnswer({ stdout = '', stderr = '', exited = true } = {}) {
  const lines = [stdout, stderr].flatMap((text) => (typeof text === 'string' ? text.split('\n') : [])).map((line) => line.trim())
  if (lines.some((line) => NO_VAULT_OPEN.test(line))) return { version: null, noVaultOpen: true }
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  return { version: exited && text !== '' ? text : null, noVaultOpen: false }
}

// Pure. `requireVersion: false` lets an installed app that is positively not
// running pass without a version: nothing is published through an app that
// does not run, and the version is asked for again once it does. An app whose
// command-line tool says no vault is open runs, whatever the process table
// said, and answers nothing else: `no-vault-open`, which does not qualify.
export function qualifyApp(observation, { requireVersion = true, floor = MINIMUM_APP_VERSION } = {}) {
  const seen = observation !== null && typeof observation === 'object' ? observation : {}
  const base = { floor, version: typeof seen.version === 'string' ? seen.version.slice(0, 80) : null, running: seen.running === true ? true : seen.running === false ? false : null }
  if (seen.installed !== true) return { ...base, outcome: 'app-missing', reason: 'no-app-found' }
  if (seen.cli !== true) return { ...base, outcome: 'app-cli-unavailable', reason: 'cli-capability-absent' }
  if (seen.noVaultOpen === true) return { ...base, outcome: 'app-version-unsupported', reason: 'no-vault-open' }
  if (base.version === null) {
    if (!requireVersion && base.running === false) return { ...base, outcome: 'qualified', reason: 'app-not-running-version-not-needed', versionChecked: false }
    return { ...base, outcome: 'app-version-unsupported', reason: 'version-unknown' }
  }
  if (parseAppVersion(base.version) === null) return { ...base, outcome: 'app-version-unsupported', reason: 'version-unreadable' }
  if (!meetsMinimumAppVersion(base.version, floor)) return { ...base, outcome: 'app-version-unsupported', reason: 'below-minimum-version' }
  return { ...base, outcome: 'qualified', reason: 'meets-minimum-version', versionChecked: true }
}

export async function inspectApp(appProbe) {
  if (typeof appProbe?.inspect !== 'function') throw new TypeError('an appProbe with inspect() is required')
  try { return await appProbe.inspect() } catch { return { installed: false, cli: false, running: null, version: null } }
}

// The adapter factory of a service that reaches a real app. The editor adapter
// is constructed only after the app qualified; otherwise the factory refuses,
// typed, and the engine records that reason and publishes nothing. The answer
// is remembered briefly so a tick over many views asks once.
export function createQualifiedAdapterFactory({ appProbe, createAdapter, floor = MINIMUM_APP_VERSION, maxAgeMs = 10_000, now = () => Date.now() } = {}) {
  if (typeof appProbe?.inspectSync !== 'function') throw new TypeError('the qualified adapter factory needs an appProbe with inspectSync()')
  if (typeof createAdapter !== 'function') throw new TypeError('the qualified adapter factory needs createAdapter')
  let last = null
  const qualification = () => {
    if (last === null || now() - last.at > maxAgeMs) {
      let observation
      try { observation = appProbe.inspectSync() } catch { observation = null }
      last = { at: now(), result: qualifyApp(observation, { requireVersion: false, floor }) }
    }
    return last.result
  }
  const factory = (input) => {
    const result = qualification()
    // No app at all is not an unqualified app: the publisher's own path needs none, and its adapter finds no process.
    if (result.outcome !== 'qualified' && result.outcome !== 'app-missing') refuse(result.outcome, 'the installed Obsidian does not qualify; nothing is published through it', { reason: result.reason, floor: result.floor, version: result.version })
    return createAdapter(input)
  }
  factory.qualification = qualification
  // What was last learned, without asking again: for a status answer.
  factory.lastQualification = () => last?.result ?? null
  return factory
}
