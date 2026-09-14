import { canonicalize } from '../../attestation/jcs.mjs'

// Comparison is deliberately not baseline acceptance or release authorization.
export function comparePresentationProofs(baseline, candidate) {
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const valid = proof => proof?.schema === 'atelier.presentation-browser-proof/v1' && proof.status === 'passed' &&
    /^[a-f0-9]{40}$/.test(proof.sourceHead ?? '') && digest(proof.sourceDigest) && digest(proof.fixtureDigest) &&
    proof.environment && Array.isArray(proof.runs) && proof.runs.length > 0 &&
    new Set(proof.runs.map(run => run.browser)).size === proof.runs.length &&
    proof.runs.every(run => ['chromium', 'firefox', 'webkit'].includes(run.browser) && run.status === 'passed' &&
      typeof run.version === 'string' && run.version.length > 0 && Array.isArray(run.checks) && run.checks.length > 0 &&
      Array.isArray(run.screenshots) && run.screenshots.length > 0 &&
      new Set(run.screenshots.map(frame => frame.file)).size === run.screenshots.length &&
      run.screenshots.every(frame => /^[a-z0-9-]+\.png$/.test(frame.file) && digest(frame.sha256)))
  const result = (status, reason, changedFrames = []) => Object.freeze({ status, reason, changedFrames, baselineApprovalVerified: false, executionAuthority: false })
  if (!valid(baseline) || !valid(candidate)) return result('incomparable', 'Both complete proof envelopes and their byte digests are required.')
  const dimensions = proof => ({ environment: proof.environment, fixtureDigest: proof.fixtureDigest,
    runs: proof.runs.map(run => ({ browser: run.browser, version: run.version, checks: run.checks, frames: run.screenshots.map(frame => frame.file).sort() })).sort((a, b) => a.browser.localeCompare(b.browser)) })
  if (canonicalize(dimensions(baseline)) !== canonicalize(dimensions(candidate))) return result('incomparable', 'Fixture, environment, engine or coverage changed; recapture and obtain an explicit baseline disposition.')
  const previous = new Map(baseline.runs.flatMap(run => run.screenshots.map(frame => [run.browser + ':' + frame.file, frame.sha256])))
  const changed = candidate.runs.flatMap(run => run.screenshots.filter(frame => previous.get(run.browser + ':' + frame.file) !== frame.sha256).map(frame => run.browser + ':' + frame.file))
  return changed.length ? result('review-required', 'Retain the before/after images and explain each change; never auto-accept a new baseline.', changed)
    : result('unchanged', 'Pixel digests match at equal recorded coverage. Owner acceptance and nonvisual gates remain separate.')
}
