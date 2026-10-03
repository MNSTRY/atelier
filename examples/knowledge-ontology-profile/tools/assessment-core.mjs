// Evidence-backed local diagnostics over existing Atelier output, without
// source edits, policy installation, provider calls, or semantic acceptance.
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
const array = value => Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const retrievalPassed = (c, run) => run.expectedEvidencePresent && !run.missing.length && !run.stale.length && !run.missingRelations.length &&
  (c.expect === 'abstain' ? run.sourceIds.length === 0 : run.sourceIds.length > 0);

export function summarizeSession(read) {
  if (read?.ok !== true || !read.record || !read.state || !array(read.state.saved) || !array(read.state.fields) ||
      typeof read.current !== 'boolean' || !identifier(read.state.id) || !count(read.state.revision)) throw new Error('Invalid session readback.');
  const { record, state } = read;
  const receiptMatches = state.saved.every(s => s && s.receipt?.sessionId === state.id && identifier(s.fieldId) &&
    s.receipt?.fieldId === s.fieldId && typeof s.text === 'string' && s.receipt?.valueDigest === digest(s.text));
  return { id: state.id, flow: record.flow, question: record.question?.question ?? '', author: record.author,
    revision: state.revision, phase: state.phase, current: read.current,
    savedFields: state.saved.length, totalFields: state.fields.length,
    receipts: state.saved.map(s => ({ sessionId: identifier(s?.receipt?.sessionId) ? s.receipt.sessionId : null,
      fieldId: identifier(s?.receipt?.fieldId) ? s.receipt.fieldId : null,
      valueDigest: sha(s?.receipt?.valueDigest) ? s.receipt.valueDigest : null,
      readbackValueSha256: typeof s?.text === 'string' ? digest(s.text) : null })),
    receiptMatches, receiptCheckScope: 'Value digest and session/field association in a fresh CLI read; not authenticated acceptance.',
    pending: state.pending !== null, savedMeaning: read.savedMeaning, sourceEditsApplied: read.sourceEditsApplied };
}

export function assessCapture(capture, metrics = null) {
  if (capture?.schema !== 'atelier-enablement-capture/local-v1') throw new Error('Unsupported capture schema.');
  const d = capture.dashboard, inspection = d?.inspection;
  if (d?.schema !== 'atelier-knowledge-dashboard/experimental-v1' || !sha(d.snapshot) ||
      !inspection || typeof inspection.ok !== 'boolean' ||
      !array(inspection.errors) || !array(inspection.warnings) || !array(inspection.concepts) ||
      !array(inspection.relations) || !array(d.questions) || !array(d.flows) ||
      !sha(capture.finalSnapshot) || typeof capture.consistent !== 'boolean' || capture.consistent !== (capture.finalSnapshot === d.snapshot) ||
      !Number.isFinite(Date.parse(capture.observedAt)) || !array(capture.sessions?.items) || !count(capture.sessions.listed))
    throw new Error('Invalid or unsupported dashboard capture; do not infer success from absent fields.');
  const findings = [];
  const add = (code, status, category, title, observed, stage, action, evidenceRefs, severity = 'info') => findings.push({
    code: `LOCAL.${code}`, status, severity: status === 'fail' ? 'error' : severity,
    category, title, observed, evidenceRefs, nextAction: { stage, label: action },
    canonicalEffect: 'none',
  });
  const ref = fragment => `capture.json#/dashboard${fragment}`;
  add('SNAPSHOT', capture.consistent ? 'pass' : 'fail', 'recovery', 'Assessment inputs agree on a source snapshot',
    capture.consistent ? d.snapshot : `Initial snapshot ${d.snapshot}; final snapshot ${capture.finalSnapshot}.`,
    capture.consistent ? 'apply' : 'deepen', capture.consistent ? 'Use the observed snapshot; rerun when sources change.' : 'Rerun the assessment on current sources; preserve this historical report.', [ref('/snapshot')]);
  const brief = [d.purpose, d.steward, d.reviewer].every(v => typeof v === 'string' && v.trim());
  add('PURPOSE', brief && d.questions.length > 0 ? 'pass' : 'fail', 'setup', 'Purpose, asserted roles, and planned questions are present',
    `${d.questions.length} planned questions. Role names are local assertions.`, 'onboard',
    'Choose a consequential question, its source owner, and its reviewer.', [ref('/purpose'), ref('/questions')]);
  add('STRUCTURE', inspection.ok ? 'pass' : 'fail', 'model', 'Model structure is valid',
    inspection.errors.length ? inspection.errors.join('; ') : inspection.status, 'model',
    inspection.ok ? 'Inspect how the recorded model supports the useful question.' : 'Resolve model errors against the exact plan revision, then rerun.', [ref('/inspection')]);
  if (inspection.warnings.length) add('MODEL_WARNINGS', 'warning', 'model', 'Model needs attention', inspection.warnings.join('; '),
    'deepen', 'Inspect these model gaps with their source evidence.', [ref('/inspection/warnings')], 'warning');
  const emptyConcepts = inspection.concepts.filter(c => c.records === 0).map(c => c.id);
  const emptyRelations = inspection.relations.filter(r => r.matchingEdges === 0).map(r => r.id);
  add('COVERAGE', emptyConcepts.length || emptyRelations.length ? 'warning' : 'pass', 'model', 'Declared concepts and relations have source coverage',
    emptyConcepts.length || emptyRelations.length ? `Concepts without records: ${emptyConcepts.join(', ') || 'none'}; relations without matching edges: ${emptyRelations.join(', ') || 'none'}.`
      : `${inspection.concepts.length} concepts and ${inspection.relations.length} relations have matching source records or declared edges.`,
    'deepen', 'Review whether a gap needs more evidence or a smaller model.', [ref('/inspection/concepts'), ref('/inspection/relations')], 'warning');
  if (inspection.unclassifiedRecords > 0) add('UNCLASSIFIED', 'warning', 'evidence', 'Some records are unclassified',
    `${inspection.unclassifiedRecords} unclassified records.`, 'deepen', 'Classify permitted records or record their exclusion.', [ref('/inspection/unclassifiedRecords')], 'warning');

  const cases = d.evaluation?.cases ?? [];
  if (d.evaluation && !array(d.evaluation.cases)) throw new Error('Invalid evaluation cases.');
  if (d.questions.some(q => !identifier(q?.id) || !['evidence', 'abstain'].includes(q.expect)) ||
      cases.some(c => !identifier(c?.id))) throw new Error('Invalid planned or evaluated question identity.');
  const plannedIds = d.questions.map(q => q.id), evaluatedIds = cases.map(c => c.id);
  const duplicates = ids => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const missingIds = [...new Set(plannedIds.filter(id => !evaluatedIds.includes(id)))];
  const unplannedIds = [...new Set(evaluatedIds.filter(id => !plannedIds.includes(id)))];
  const duplicatePlannedIds = duplicates(plannedIds), duplicateCaseIds = duplicates(evaluatedIds);
  const expectationMismatches = cases.filter(c => d.questions.some(q => q.id === c.id && q.expect !== c.expect)).map(c => c.id);
  const evaluation = { plannedQuestions: d.questions.length, observedCases: cases.length,
    missingIds, unplannedIds, duplicatePlannedIds, duplicateCaseIds, expectationMismatches,
    complete: ![missingIds, unplannedIds, duplicatePlannedIds, duplicateCaseIds, expectationMismatches].some(ids => ids.length) };
  if ([missingIds, unplannedIds, duplicatePlannedIds, duplicateCaseIds].some(ids => ids.length))
    add('EVALUATION_COVERAGE', 'unknown', 'evidence', 'Evaluation does not cover the unique planned questions',
      `Planned ${plannedIds.length}; evaluated ${cases.length}; missing ${missingIds.join(', ') || 'none'}; unplanned ${unplannedIds.join(', ') || 'none'}; duplicates ${[...duplicatePlannedIds, ...duplicateCaseIds].join(', ') || 'none'}.`,
      'deepen', 'Reconcile the planned question identities and evaluate every planned question once.', [ref('/questions'), ref('/evaluation')]);
  if (expectationMismatches.length) add('EVALUATION_EXPECTATION', 'fail', 'evidence', 'Evaluated expectations differ from the plan',
    expectationMismatches.join(', '), 'deepen', 'Evaluate the recorded expectation; do not replace an evidence requirement with abstention.', [ref('/questions'), ref('/evaluation')]);
  const retrieval = cases.map((c, index) => ({ c, index })).filter(({ c }) =>
    plannedIds.includes(c.id) && !duplicatePlannedIds.includes(c.id) && !duplicateCaseIds.includes(c.id) && !expectationMismatches.includes(c.id)).map(({ c, index }) => {
    for (const mode of ['lexical', 'graph']) {
      const run = c.runs?.[mode];
      if (!run || !['sourceIds', 'missing', 'stale', 'missingRelations'].every(k => array(run[k])) ||
          typeof run.expectedEvidencePresent !== 'boolean' || !count(run.payloadBytes) || !count(run.omitted))
        throw new Error(`Invalid retrieval run ${c.id}/${mode}.`);
    }
    const graph = c.runs.graph;
    const checksPass = retrievalPassed(c, graph);
    add(`EVIDENCE.${c.id}`, checksPass ? 'pass' : 'fail', 'evidence', c.question,
      `Graph: ${graph.sourceIds.length} selected sources; missing ${graph.missing.length}; stale ${graph.stale.length}; missing directed relations ${graph.missingRelations.length}.`,
      checksPass ? 'apply' : 'deepen', checksPass ? c.expect === 'abstain' ? 'Record the evidence limit and the source needed to answer.' : 'Inspect the selected passages and coauthor a supported result.'
        : graph.stale.length ? 'Inspect changed source bytes before revising the expected evidence pins.' : 'Inspect decisive passages and relation direction; repair the source or model gap.',
      [ref(`/evaluation/cases/${index}`)]);
    if (graph.omitted > 0) add(`OMISSIONS.${c.id}`, 'warning', 'evidence', 'Retrieval omitted candidate sources',
      `${graph.omitted} omitted for ${c.id}.`, 'apply', 'Inspect omission reasons; narrow the question or deliberately change the context budget.',
      [ref(`/evaluation/cases/${index}/runs/graph/omitted`)], 'warning');
    return { id: c.id, question: c.question, expect: c.expect, checksPass, lexical: c.runs.lexical, graph };
  });
  if (!cases.length) add('NO_EVALUATION', 'unknown', 'evidence', 'Evidence retrieval has not been checked',
    'No evaluation cases are available.', 'onboard', 'Add a useful question with source-bound expected evidence, then evaluate.', [ref('/evaluation')]);
  if (cases.some(c => !retrievalPassed(c, c.runs.lexical)))
    add('BASELINE_GAP', 'warning', 'evidence', 'The metadata search baseline misses planned evidence',
      'Fewer context bytes do not establish a cheaper supported answer. This lexical baseline searches metadata, not complete source text.',
      'learn', 'Compare complete tasks against actual direct source search on unseen questions.', [ref('/evaluation/cases')], 'warning');

  const sessions = capture.sessions;
  if (!sessions.complete || sessions.items.length !== sessions.listed || new Set(sessions.items.map(s => s.id)).size !== sessions.items.length)
    add('SESSION_COVERAGE', 'unknown', 'recovery', 'Session inspection is incomplete',
    `${sessions.items.length} readbacks from ${sessions.listed} listed sessions. ${sessions.error ?? ''}`.trim(),
    'apply', 'Read omitted sessions explicitly; do not treat this report as a complete recovery check.', ['capture.json#/sessions']);
  if (!sessions.items.length) add('NO_SESSIONS', 'unknown', 'recovery', 'No shared authoring readback was observed',
    'No draft continuity result is available.', 'onboard', 'Save a private draft and resume it from another client.', ['capture.json#/sessions']);
  for (const [index, s] of sessions.items.entries()) {
    const sessionEvidence = [`capture.json#/sessions/items/${index}`, `session:${s.id}@${s.revision}`];
    const draftStatus = !s.receiptMatches || s.savedMeaning !== 'private-draft-only' || s.sourceEditsApplied !== false ? 'fail'
      : s.savedFields === 0 ? 'unknown' : 'pass';
    add(`DRAFT.${s.id}`, draftStatus,
      'coauthoring', `Private draft readback: ${s.id}`, `${s.savedFields}/${s.totalFields} fields saved; phase ${s.phase}; revision ${s.revision}.`,
      s.flow, 'Resume this shared session. A saved draft still needs source-owner review and application.', sessionEvidence);
    if (!s.current) add(`STALE_SESSION.${s.id}`, 'fail', 'recovery', 'Saved draft refers to changed sources',
      s.id, 'deepen', 'Keep the old draft, inspect the changed evidence, and prepare a current proposal.', sessionEvidence);
    if (s.pending || ['saving', 'recovery'].includes(s.phase)) add(`RECOVERY.${s.id}`, 'warning', 'recovery', 'An authoring request needs reconciliation',
      `Phase ${s.phase}; pending ${s.pending}.`, s.flow, 'Read the request receipt before a deliberate retry; preserve the original request identity.',
      sessionEvidence, 'warning');
  }
  const measuredQuality = metrics?.measurements.some(m => m.supportedPrecision !== null && m.taskSuccessRatio !== null) ?? false;
  add('SEMANTIC_QUALITY', measuredQuality ? 'warning' : 'unknown', 'quality', 'Meaning and useful answers need independent review',
    measuredQuality ? 'Reported semantic samples exist; this local tool has not authenticated their reviews.' : 'Retrieval checks do not measure wrong merges, lost qualifications, answer correctness, or real-user success.',
    'learn', 'Review unseen tasks against source passages and record semantic errors, correction effort, and actual outcomes.', [ref('/evaluation'), 'assessment.json#/metrics'], measuredQuality ? 'warning' : 'info');
  const costs = metrics?.measurements ?? [];
  const completeCost = costs.length > 0 && costs.every(m => m.totalTaskCost !== null);
  add('TASK_COST', completeCost ? 'warning' : 'unknown', 'cost', 'Complete task cost needs measurement',
    completeCost ? 'Complete task costs were reported; any comparison remains scoped to its recorded trials.' : 'Provider, compute, and human costs have not all been measured. Estimated tokens are not billed usage.',
    'learn', 'Record cold and warm runs separately, including retries, review, correction, retrieval, and reuse.', ['assessment.json#/metrics'], completeCost ? 'warning' : 'info');
  add('HOST_PERMISSIONS', 'unknown', 'governance', 'Host permissions have not been verified by this assessment',
    'This CLI uses the local filesystem principal. Recorded governance and role names do not enforce source use, canonical writes, provider disclosure, or effects.',
    'onboard', 'Ask the selected host and owning service to verify current workspace and operation permission.', [ref('/governance')]);

  const counts = Object.fromEntries(['pass', 'fail', 'warning', 'unknown'].map(s => [s, findings.filter(f => f.status === s).length]));
  return { schema: 'atelier-enablement-assessment/local-v1', observedAt: capture.observedAt,
    runtimeCandidate: capture.runtimeCandidate, workspaceSnapshot: d.snapshot, consistent: capture.consistent,
    summary: { ...counts, status: counts.fail ? 'needs-correction' : 'checks-observed-with-open-questions',
      meaning: 'No overall semantic, economic, governance, or acceptance pass is issued.' },
    workspace: { name: d.name, purpose: d.purpose, flows: d.flows.map(f => ({ id: f.id, title: f.title, description: f.description })), next: d.next },
    model: { concepts: inspection.concepts, relations: inspection.relations, unclassifiedRecords: inspection.unclassifiedRecords },
    retrieval, evaluation, sessions: capture.sessions, metrics,
    declaredDirectAssessmentProviderCalls: 0,
    reportedDashboardProviderCalls: count(d.providerCalls) ? d.providerCalls : null,
    providerCallScope: 'The example declares no direct provider invocation; dashboard counts are reported by the selected CLI, not authenticated total task usage.', findings,
    scope: 'Consumer-local assessment of source coverage, planned evidence retrieval, and private draft readback. No automatic fixes, semantic admission, policy installation, disclosure, or action execution.' };
}

const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const fmt = value => value === null || value === undefined ? 'Unmeasured' : String(value);
export function renderAssessment(report, { studioUrl = null, command = 'node examples/knowledge-ontology-profile/tools/assess.mjs --atelier-entry /absolute/installed/atelier/bin/atelier.mjs --binding /absolute/private/receiving-binding.json --workspace /absolute/permitted/workspace' } = {}) {
  const url = studioUrl === null ? null : new URL(studioUrl);
  if (url && (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/knowledge' || url.username || url.password || url.search || url.hash))
    throw new Error('studioUrl must identify the loopback /knowledge workspace.');
  const priority = { fail: 0, warning: 1, unknown: 2, pass: 3 };
  const findings = [...report.findings].sort((a, b) => priority[a.status] - priority[b.status]).map(f => `<article class="finding ${esc(f.status)}"><div class="line"><span class="badge">${esc(f.status)}</span><span class="code">${esc(f.code)}</span></div><h3>${esc(f.title)}</h3><p>${esc(f.observed)}</p><p class="next"><strong>${esc(f.nextAction.stage)}:</strong> ${esc(f.nextAction.label)}</p><details><summary>Evidence references</summary><ul>${f.evidenceRefs.map(r => `<li><code>${esc(r)}</code></li>`).join('')}</ul></details></article>`).join('');
  const retrievalLabel = (c, passed) => passed ? c.expect === 'abstain' ? 'No evidence selected, as expected' : 'Expected evidence found' : 'Needs correction';
  const rows = report.retrieval.map(c => `<tr><td><strong>${esc(c.id)}</strong><br>${esc(c.question)}</td><td>${retrievalLabel(c, retrievalPassed(c, c.lexical))}<br>${c.lexical.payloadBytes} bytes</td><td>${retrievalLabel(c, c.checksPass)}<br>${c.graph.payloadBytes} bytes</td><td>${esc(c.expect)}<br>${c.graph.omitted} omitted</td></tr>`).join('');
  const sessions = report.sessions.items.map(s => `<tr><td><code>${esc(s.id)}</code><br>${esc(s.author)}</td><td>${esc(s.phase)}<br>${s.savedFields}/${s.totalFields} fields saved</td><td>${s.current ? 'Current evidence' : 'Changed evidence'}<br>${s.receiptMatches ? 'Draft value matches receipt' : 'Receipt mismatch'}</td></tr>`).join('');
  const measurements = report.metrics?.measurements ?? [];
  const metricRows = measurements.map(m => `<tr><td>${esc(m.id)}<br>${esc(m.method)}</td><td>${esc(fmt(m.supportedPrecision))}<br>${m.qualityCounts.reviewedAssertions ?? 'Unknown'} reviewed</td><td>${esc(fmt(m.totalTaskCost))} ${esc(m.currency ?? '')}</td><td>${esc(fmt(m.correctionMinutes))}</td><td>${esc(m.quality.status)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Atelier · Knowledge assessment</title><style>
  :root{color-scheme:light;--ink:#18352e;--muted:#596b65;--line:#d8e1dc;--green:#dcece2;--amber:#fbebcc;--red:#f9ddd6;--paper:#f6f5ef}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:48px 30px 80px}a{color:#255b46;text-underline-offset:3px}header{border-top:5px solid var(--ink);padding:24px 0 26px}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}h1{font:normal 44px/1.15 Georgia,serif;margin:10px 0 16px}h2{font:normal 28px/1.2 Georgia,serif;margin-top:40px}h3{font-size:18px;line-height:1.35;margin:14px 0 8px}p{margin:8px 0 14px}.muted{color:var(--muted)}.intro{max-width:790px}.cta{display:inline-block;background:var(--ink);color:white;border-radius:4px;padding:10px 18px;text-decoration:none;margin:12px 0}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{border:1px solid var(--line);padding:18px;background:white}.value{display:block;font-size:30px;font-weight:600}.label{font-size:14px;color:var(--muted)}.notice{background:var(--amber);padding:14px 18px;margin:20px 0}.flows{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.flow{border-bottom:2px solid #648473;padding:14px 0}.flow p{font-size:14px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}th,td{text-align:left;padding:14px;vertical-align:top;border-bottom:1px solid var(--line)}th{background:#e8ede8}.findings{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.finding{padding:20px;background:white;border:1px solid var(--line);border-left:4px solid #cad9d2}.finding.fail{border-left-color:#ab4b37}.finding.warning{border-left-color:#b78322}.finding.unknown{border-left-color:#7d8ca2}.badge{display:inline-block;border-radius:3px;padding:2px 8px;font-size:12px;background:var(--green)}.fail .badge{background:var(--red)}.warning .badge{background:var(--amber)}.unknown .badge{background:#e5e9ef}.line{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.code{font:11px/1.4 ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}.next{font-size:14px}details{font-size:12px;color:var(--muted)}summary{cursor:pointer}code{overflow-wrap:anywhere;font-size:12px}pre{padding:18px;border:1px solid var(--line);background:white;white-space:pre-wrap;word-break:break-word}.footer{font-size:13px;color:var(--muted);margin-top:36px;border-top:1px solid var(--line);padding-top:20px}@media(max-width:780px){main{padding:25px 18px}h1{font-size:35px}.cards,.findings{grid-template-columns:repeat(2,1fr)}.flows{grid-template-columns:1fr}.flow{padding:8px 0}}@media(max-width:480px){.cards,.findings{grid-template-columns:1fr}}
  </style></head><body><main><header><div class="eyebrow">Atelier · Local assessment · ${esc(report.observedAt)}</div><h1>Build knowledge you can use.</h1><p class="intro">${esc(report.workspace.purpose)}</p><p class="muted">Assessment of <strong>${esc(report.workspace.name)}</strong>. Use the shared workspace to coauthor; use this report to see what needs evidence, review, or measurement.</p>${url ? `<a class="cta" href="${esc(url.href)}">Open shared knowledge workspace</a>` : '<p>Use the selected Atelier knowledge workspace to coauthor and review these findings.</p>'}</header>
  <div class="cards"><div class="card"><span class="value">${report.retrieval.filter(c => c.checksPass).length}/${report.evaluation.plannedQuestions}</span><span class="label">Planned graph retrieval checks</span></div><div class="card"><span class="value">${report.summary.fail}</span><span class="label">Findings needing correction</span></div><div class="card"><span class="value">${report.summary.unknown}</span><span class="label">Checks still unknown</span></div><div class="card"><span class="value">${report.sessions.items.reduce((n, s) => n + s.savedFields, 0)}</span><span class="label">Private draft fields read back</span></div></div>
  <p class="notice"><strong>${report.consistent ? 'This is a read-only snapshot.' : 'Inputs changed during assessment; rerun before relying on this snapshot.'}</strong> Retrieval and draft checks do not establish semantic correctness, economic benefit, permission enforcement, or owner acceptance. Rerun after sources, model, or session state change.</p>
  <h2>The same five workspaces</h2><div class="flows">${report.workspace.flows.map(f => `<div class="flow"><strong>${esc(f.title)}</strong><p>${esc(f.description)}</p></div>`).join('')}</div>
  <h2>Evidence before efficiency</h2><p class="muted">The current metadata baseline is narrower than direct source search. Context byte counts are measured; token estimates are not billing.</p><div class="table"><table><thead><tr><th>Useful question</th><th>Metadata search</th><th>Declared graph</th><th>Expected behavior</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No retrieval observations available.</td></tr>'}</tbody></table></div>
  <h2>Coauthoring continuity</h2><p class="muted">Saved means a private draft. The source owner still reviews and applies canonical changes.</p><div class="table"><table><thead><tr><th>Shared session and asserted author</th><th>Saved progress</th><th>Readback observation</th></tr></thead><tbody>${sessions || '<tr><td colspan="3">No draft readback observed.</td></tr>'}</tbody></table></div>
  <h2>Quality and complete task cost</h2><p class="muted">${measurements.length ? 'These values come from reported measurement records. Review their evidence and sample sizes before using them.' : 'No semantic quality, correction effort, or complete task cost has been measured. Unknown values stay unknown.'}</p>${measurements.length ? `<div class="table"><table><thead><tr><th>Recorded run</th><th>Supported assertion precision</th><th>Complete task cost</th><th>Correction minutes</th><th>Prespecified quality floor</th></tr></thead><tbody>${metricRows}</tbody></table></div>` : ''}
  <h2>Findings and next steps</h2><div class="findings">${findings}</div><h2>Run the assessment again</h2><p>From the Atelier repository root:</p><pre>${esc(command)}</pre><p class="muted">Run with <code>--workspace /absolute/path</code> on your own permitted Atelier workspace. Reports stay local; exporting them requires its own recipient decision.</p>
  <div class="footer">Snapshot <code>${esc(report.workspaceSnapshot)}</code><br>Runtime <code>${esc(report.runtimeCandidate)}</code><br>${esc(report.scope)}</div></main></body></html>`;
}
