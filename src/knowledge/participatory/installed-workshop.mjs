import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCoauthorStore } from '@mnstry/atelier/coauthor/store';
import { contentDigest } from '@mnstry/atelier/coauthor';
import { buildCanonicalGraph } from '@mnstry/atelier/graph';
import { resolveProjectConfig } from '@mnstry/atelier/project';
import { initializeKnowledgeHealthWorkshop, assessKnowledgeHealthWorkshop } from '../../knowledge-health/workshop.mjs';

// Public invented example over installed Foundation APIs. The source owner's
// example edit is confined to a newly created disposable workspace. This is
// not a Workbench host, editor, store, graph rule or publication controller.
const words = '  Fixture participant: the checklist can support our discussion.\nIt cannot make our decision. 🪴  ';
const interpretation = 'Fixture interpretation: record the checklist as supporting evidence; readiness remains undecided.';
const outcomes = ['note', 'disagreement', 'perspective-only', 'pause', 'revision'];
export function initializeWorkshop(destination) {
  return initializeKnowledgeHealthWorkshop(destination);
}

function project(root) {
  return resolveProjectConfig({ cwd: root, argv: ['--project', path.join(root, 'atelier.project.json')],
    env: {}, writeLocalState: false });
}
// Run the received generic assessment against the SAME participatory fixture.
// Structural current evidence and frozen expected-evidence evaluation stay separate.
export async function assessInstalledWorkshop(root) {
  return { status: 'observed', result: assessKnowledgeHealthWorkshop({ workspaceRoot: root }) };
}

export async function rehearseInstalledWorkshop(destination, { outcome = 'revision' } = {}) {
  assert.ok(outcomes.includes(outcome), 'Choose an explicit supported example outcome.');
  const root = initializeWorkshop(destination), sourceFile = path.join(root, 'records/checklist.md');
  const source = fs.readFileSync(sourceFile, 'utf8'), baselinePlan = fs.readFileSync(path.join(root, 'knowledge-plan.json'));
  const before = buildCanonicalGraph(project(root));
  assert.equal(before.ok, true); assert.equal(before.nodes.length, 2); assert.equal(before.edges.length, 0);
  const beforeAssessment = await assessInstalledWorkshop(root);
  const store = createCoauthorStore({ workspaceRoot: root }), id = 'invented-workshop-' + outcome;
  // Consumer-owned fields keep original words, interpretation and choice apart.
  // These are ordinary coauthor draft fields. They are not native typed finding
  // disposition envelopes; that package join remains separately required.
  const fields = ['original-words', 'proposed-interpretation', 'example-choice'].map(fieldId => ({ id: fieldId,
    source: { ref: 'records/checklist.md', digest: contentDigest(source) } }));
  let state = store.start({ id, fields }), eventOrdinal = 0;
  const send = (type, input = {}) => {
    const event = { id: `example-event-${++eventOrdinal}`, type, expectedRevision: state.revision, ...input };
    state = store.dispatch(id, event); return { state, event };
  };
  send('answer', { text: words });
  const paused = send('pause').state;
  assert.equal(paused.phase, 'paused'); assert.deepEqual(store.recover(id), paused);
  send('resume');
  const firstSave = send('save');
  assert.equal(state.phase, 'saved'); assert.equal(state.saved[0].text, words);
  assert.deepEqual(store.dispatch(id, firstSave.event), state); // No duplicate effect.
  send('advance'); send('answer', { text: 'Fixture interpretation awaiting review.' });
  send('propose', { text: interpretation });
  assert.equal(state.phase, 'confirmation');
  assert.throws(() => store.dispatch(id, { id: 'unconfirmed-save', type: 'save', expectedRevision: state.revision }), /refused/);
  send('confirm'); send('save'); send('advance');
  send('answer', { text: outcome }); send('save');
  const reopened = createCoauthorStore({ workspaceRoot: root }).read(id);
  assert.deepEqual(reopened, state);
  assert.deepEqual(reopened.saved.map(x => x.text), [words, interpretation, outcome]);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
  const preview = source.replace('    supports: []\n', '    supports: ["devday:workshop"]\n');
  assert.notEqual(preview, source);
  let after = before, afterAssessment = beforeAssessment, ownerCorrection = false;
  if (outcome === 'revision') {
    // Ordinary source-owner editing route in this fresh disposable example.
    // No generic source writer is exported; no other workspace is accepted.
    assert.equal(fs.realpathSync(path.dirname(sourceFile)), path.join(fs.realpathSync(root), 'records'));
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
    fs.writeFileSync(sourceFile, preview);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), preview);
    ownerCorrection = true;
    after = buildCanonicalGraph(project(root));
    assert.equal(after.ok, true);
    assert.ok(after.edges.some(e => e.source === 'devday:checklist' && e.type === 'supports' && e.target === 'devday:workshop'));
    assert.deepEqual(store.read(id), reopened); // Old words remain historical.
    assert.throws(() => store.dispatch(id, { id: 'write-after-source-drift', type: 'advance', expectedRevision: reopened.revision }), /source changed/);
    afterAssessment = await assessInstalledWorkshop(root);
  }
  assert.deepEqual(fs.readFileSync(path.join(root, 'knowledge-plan.json')), baselinePlan);
  const packageInfo = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.resolve('@mnstry/atelier/coauthor/store')))));
  return {
    packageVersion: packageInfo.version, outcome, publicInventedOnly: true, participantChoice: 'fixture',
    beforeGraph: { ok: before.ok, nodes: before.nodes.length, edges: before.edges.length }, beforeAssessment,
    originalWords: words, interpretation, storedChoice: outcome,
    savedValues: reopened.saved.map(x => ({ fieldId: x.fieldId, text: x.text, receipt: x.receipt })),
    preview: { original: '[]', replacement: '["devday:workshop"]', sourceChangedAtPreview: false },
    ownerCorrection, sourceReadbackSha256: contentDigest(fs.readFileSync(sourceFile, 'utf8')),
    reopenedSame: true, pauseRecoveryPreserved: true, unconfirmedInterpretationSaveRefused: true,
    duplicateSaveNoAdditionalEffect: true, sourceDriftWriteRefused: ownerCorrection,
    afterGraph: { ok: after.ok, nodes: after.nodes.length, edges: after.edges.length }, afterAssessment,
    baselinePlanPreserved: true,
    gaps: ['Public native typed finding contribution/caller/disposition closure and host',
      'Native guided authoring entry and measured keyboard/focus/undo/recovery', 'Real-source and participant acceptance'],
    fullKnowledgeHealthJourneyQualified: false, humanAcceptance: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2], outcome = process.argv[3] ?? 'revision';
  if (!destination) throw Error('Usage: node installed-workshop.mjs NEW_DISPOSABLE_DIRECTORY [note|disagreement|perspective-only|pause|revision]');
  console.log(JSON.stringify(await rehearseInstalledWorkshop(destination, { outcome }), null, 2));
}
