// Additive presentation/composition over the host's existing received APIs.
// This module opens no store, changes no editor, dispatches nothing and writes no source.
export function createGuidedContribution({ adapter, caller, same } = {}) {
  for (const name of ['isJoin', 'prepareContribution', 'prepareSelection'])
    if (typeof adapter?.[name] !== 'function') throw Error('Received contribution adapter required');
  for (const name of ['noteEligible', 'noteCanWrite', 'dispositionFromChoice'])
    if (typeof caller?.[name] !== 'function') throw Error('Received native contribution caller required');
  if (typeof same !== 'function') throw Error('Existing equality required');
  function prepareChoice({ joined, editorState, contributionId, choiceId, originalWords, interpretation = null,
    outcome, participantChoice = false } = {}) {
    if (!adapter.isJoin(joined)) throw Error('Current source-bound finding required');
    if (participantChoice !== true) throw Error('Choose how to keep these words first.');
    if (!contributionId?.startsWith('kh-note-')) throw Error('Use the existing host contribution identity.');
    const plan = adapter.prepareContribution(joined, { id: contributionId, originalWords, interpretation, outcome });
    const eligibility = caller.noteCanWrite('note', plan.record);
    if (!eligibility.allowed) throw Error(eligibility.reason);
    if (!caller.noteEligible(editorState, plan.record)) throw Error('Save and verify the current passage first.');
    const record = caller.dispositionFromChoice({ id: choiceId, contribution: plan.record,
      findingReference: plan.context.findingReference, outcome, participantChoice, interpretation });
    // Delegate all disposition rules/readback to the actual native caller.
    return { plan, record, state: 'chosen-not-retained', assistantRequest: false, sourceApplication: false };
  }
  function exampleRevision({ joined, contribution, proposalId, changeId, decisionId } = {}) {
    if (!adapter.isJoin(joined) || joined.document.binding.sourceId !== 'devday:checklist' ||
      joined.document.binding.fieldId !== 'kg.relations.supports' || joined.savedPassage.anchor.quote !== '[]' ||
      !same(joined.finding.direction && {
        from: joined.finding.direction.fromConceptRef, predicate: joined.finding.direction.predicate,
        to: joined.finding.direction.toConceptRef
      }, { from: 'checklist', predicate: 'supports', to: 'workshop' }))
      throw Error('This proposed change belongs only to the current invented workshop declaration.');
    const anchor = joined.savedPassage.anchor;
    const proposal = { binding: contribution.binding, id: proposalId, revision: 1,
      sourceBase: contribution.sourceBase, draftRevision: contribution.draftRevision,
      contributionId: contribution.id, contributionRevision: contribution.revision,
      changes: [{ id: changeId, startByte: anchor.startByte, endByte: anchor.endByte,
        original: anchor.quote, replacement: '["devday:workshop"]', dependsOn: [] }] };
    // This is participant-visible example wording, not an assistant response.
    const selection = adapter.prepareSelection(joined, { contribution,
      proposal: { ...proposal, changeStates: { [changeId]: 'pending' } }, changeIds: [changeId], decisionId });
    return { proposal, selection, provenance: 'invented-example-proposal', state: 'preview-only',
      assistantRequest: false, draftApplication: false, sourceApplication: false };
  }
  return Object.freeze({ prepareChoice, exampleRevision });
}
