// A known-case comparison utility, not an extractor, identity resolver, graph
// admission engine, or authority check. Extraction adapters supply observations.
import { isDeepStrictEqual } from 'node:util';

export function evaluateProfileCases(bundle, observations) {
  if (bundle?.schema !== 'atelier-ontology-profile-cases/local-v1' || bundle.cohort !== 'known-regression' ||
      !Array.isArray(bundle.cases) || bundle.cases.length > 50 || !Array.isArray(observations) || observations.length > 50)
    throw new Error('Unsupported or oversized known-case input.');
  const ids = bundle.cases.map(c => c.id);
  if (new Set(ids).size !== ids.length || new Set(observations.map(o => o.id)).size !== observations.length)
    throw new Error('Case and observation IDs must be unique.');
  if (observations.some(o => !ids.includes(o.id))) throw new Error('Observation belongs to an unknown case.');
  const results = bundle.cases.map(c => {
    const actual = observations.find(o => o.id === c.id);
    if (!actual) return { id: c.id, status: 'unknown', mismatches: [], reason: 'No observation supplied.', dimensions: c.dimensions };
    if (actual.profileId !== bundle.profileId || actual.profileVersion !== bundle.profileVersion)
      return { id: c.id, status: 'fail', mismatches: ['profileId/profileVersion'], reason: 'Profile binding differs.', dimensions: c.dimensions };
    const mismatches = Object.keys(c.expected).filter(k => !isDeepStrictEqual(c.expected[k], actual.value?.[k]));
    const extra = Object.keys(actual.value ?? {}).filter(k => !Object.hasOwn(c.expected, k));
    return { id: c.id, status: mismatches.length || extra.length ? 'fail' : 'pass', mismatches: [...mismatches, ...extra.map(k => `undeclared:${k}`)],
      reason: 'Exact fixture meaning fields; alternative equivalent representations require an owner-reviewed adapter.', dimensions: c.dimensions };
  });
  return { schema: 'atelier-ontology-profile-case-results/local-v1', profileId: bundle.profileId, profileVersion: bundle.profileVersion,
    cohort: bundle.cohort, results,
    counts: Object.fromEntries(['pass', 'fail', 'unknown'].map(s => [s, results.filter(r => r.status === s).length])),
    semanticExtractionQualified: false, realUserAcceptance: false, completeTaskCost: null, hostPermissionsVerified: false,
    scope: 'Known-case fidelity only. A passing fixture comparison grants no semantic admission, canonical identity merge, review acceptance, or execution authority.' };
}
