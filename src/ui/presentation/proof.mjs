import { canonicalize } from '../../attestation/jcs.mjs'

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const positive = value => Number.isFinite(value) && value > 0 && value <= 16384
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const list = (values, predicate) => Array.isArray(values) && values.length > 0 && values.length <= 256 && new Set(values).size === values.length && values.every(predicate)
function plain(value, seen = new Set(), depth = 0) {
  if (depth > 10 || seen.size > 10000) return false
  if (value === null || ['string', 'boolean'].includes(typeof value)) return typeof value !== 'string' || value.length <= 4096
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return false
  seen.add(value)
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(d => Object.hasOwn(d, 'value') && plain(d.value, seen, depth + 1))
}
function environmentValid(env) {
  return closed(env, ['platform', 'release', 'architecture', 'locale', 'timezone', 'scale', 'font', 'motion', 'viewports', 'themes', 'densities']) &&
    [env.platform, env.release, env.architecture, env.locale, env.timezone, env.font].every(text) && positive(env.scale) && ['reduce', 'no-preference'].includes(env.motion) &&
    list(env.viewports, positive) && list(env.themes, x => ['light', 'dark'].includes(x)) && list(env.densities, x => ['comfortable', 'compact'].includes(x))
}
function conditionsValid(c, env) {
  return closed(c, ['width', 'height', 'theme', 'density', 'motion', 'font', 'locale', 'scale']) &&
    positive(c.width) && positive(c.height) && env.viewports.includes(c.width) && env.themes.includes(c.theme) && env.densities.includes(c.density) &&
    c.motion === env.motion && c.font === env.font && c.locale === env.locale && c.scale === env.scale
}

// Comparison is deliberately not baseline acceptance or release authorization.
export function comparePresentationProofs(baseline, candidate) {
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const valid = proof => plain(proof) && closed(proof, ['schema', 'status', 'sourceHead', 'sourceDigest', 'runnerDigest', 'fixtureDigest', 'environment', 'scope', 'nativeDeviceAccepted', 'adopterAccepted', 'visualBaselineAccepted', 'runs']) &&
    proof.schema === 'atelier.presentation-browser-proof/v1' && proof.status === 'passed' &&
    /^[a-f0-9]{40}$/.test(proof.sourceHead ?? '') && digest(proof.sourceDigest) && digest(proof.fixtureDigest) && digest(proof.runnerDigest) &&
    proof.scope === 'synthetic-local-browser' && proof.nativeDeviceAccepted === false && proof.adopterAccepted === false && proof.visualBaselineAccepted === false &&
    environmentValid(proof.environment) && Array.isArray(proof.runs) && proof.runs.length > 0 && proof.runs.length <= 3 &&
    proof.runs.every(run => closed(run, ['browser', 'version', 'status', 'checks', 'screenshots'])) &&
    new Set(proof.runs.map(run => run.browser)).size === proof.runs.length &&
    proof.runs.every(run => ['chromium', 'firefox', 'webkit'].includes(run.browser) && run.status === 'passed' &&
      text(run.version) && list(run.checks, x => text(x) && /^[a-z0-9:-]+$/.test(x)) &&
      Array.isArray(run.screenshots) && run.screenshots.length > 0 && run.screenshots.length <= 256 &&
      run.screenshots.every(frame => closed(frame, ['file', 'sha256', 'conditions'])) &&
      new Set(run.screenshots.map(frame => frame.file)).size === run.screenshots.length &&
      run.screenshots.every(frame => /^[a-z0-9-]+\.png$/.test(frame.file) && digest(frame.sha256) && conditionsValid(frame.conditions, proof.environment)))
  const result = (status, reason, changedFrames = []) => Object.freeze({ status, reason, changedFrames, baselineApprovalVerified: false, executionAuthority: false })
  try { if (!valid(baseline) || !valid(candidate)) return result('incomparable', 'Both complete proof envelopes and their byte digests are required.') }
  catch { return result('incomparable', 'Malformed proof data.') }
  const dimensions = proof => ({ environment: proof.environment, fixtureDigest: proof.fixtureDigest, runnerDigest: proof.runnerDigest,
    runs: proof.runs.map(run => ({ browser: run.browser, version: run.version, checks: [...run.checks].sort(), frames: run.screenshots.map(({ file, conditions }) => ({ file, conditions })).sort((a, b) => a.file.localeCompare(b.file)) })).sort((a, b) => a.browser.localeCompare(b.browser)) })
  if (canonicalize(dimensions(baseline)) !== canonicalize(dimensions(candidate))) return result('incomparable', 'Fixture, environment, engine or coverage changed; recapture and obtain an explicit baseline disposition.')
  const previous = new Map(baseline.runs.flatMap(run => run.screenshots.map(frame => [run.browser + ':' + frame.file, frame.sha256])))
  const changed = candidate.runs.flatMap(run => run.screenshots.filter(frame => previous.get(run.browser + ':' + frame.file) !== frame.sha256).map(frame => run.browser + ':' + frame.file))
  return changed.length ? result('review-required', 'Retain the before/after images and explain each change; never auto-accept a new baseline.', changed)
    : result('unchanged', 'Pixel digests match at equal recorded coverage. Owner acceptance and nonvisual gates remain separate.')
}
