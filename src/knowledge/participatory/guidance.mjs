// User-facing cues, not a workflow engine or durable state model.
// The owning host selects a cue only after validating its existing readbacks.
export const guidance = Object.freeze({
  welcome: { title: 'A small workshop, two sources', text: 'Start with the checklist and workshop proposal. The graph connects their declared relationships. You decide what the connection means.', action: 'inspect', label: 'Look at the finding', focus: 'evidence' },
  unsupported: { title: 'This check does not apply here', text: 'You can still read and leave a note. Choose the workshop example to try the supported relationship check.', action: 'return', label: 'Back to writing', focus: 'origin' },
  finding: { title: 'One relationship is missing', text: 'The plan expects the checklist to support the workshop. The checklist currently declares no supporting relationship. This says nothing about whether the workshop is ready.', action: 'contribute', label: 'Add your words', focus: 'existing-contribution-input' },
  contribution: { title: 'How do you understand it?', text: 'Write your own words, then choose Note, Perspective, Disagreement or Pause. You can leave without changing the source. Keep a proposed interpretation separate.', action: 'choose', label: 'Return to your words', focus: 'existing-contribution-input' },
  pendingSave: { title: 'Checking the saved words', text: 'Keep your words in place while the save is checked. A later edit may still need saving.', action: null, label: null, focus: 'preserve' },
  contributionUnconfirmed: { title: 'The choice is not confirmed', text: 'Your words may already be saved. Check the original choice before retrying. A check reads only.', action: 'check-choice', label: 'Check original choice', focus: 'preserve' },
  contributionRetained: { title: 'Your words and choice are saved', text: 'They remain attached to the saved passage and this finding. You can inspect the separate interpretation. The source has not changed.', action: 'review', label: 'Preview the proposed change', focus: 'existing-review' },
  preview: { title: 'Review one change', text: 'The example adds a supporting relationship. It keeps the checklist and workshop identities, and does not approve the workshop. Apply to the working draft only if you choose it.', action: 'return', label: 'Back to writing', focus: 'origin' },
  pendingApplication: { title: 'Checking the draft change', text: 'Keep the same operation until its result is known. The authored source has not changed.', action: 'check-operation', label: 'Check original operation', focus: 'preserve' },
  draftSaved: { title: 'The revised draft is saved', text: 'Reopen it and check the words. The source owner can review the proposed declaration through the normal repository editing route.', action: 'reopen', label: 'Reopen the saved draft', focus: 'existing-history' },
  sourcePending: { title: 'The source change is awaiting its owner', text: 'The saved draft is a proposal. The owner decides whether to apply it, then reads the exact source back before checking again.', action: 'return', label: 'Back to writing', focus: 'origin' },
  reassessed: { title: 'This relationship check no longer reports the gap', text: 'The new source declares the expected relationship. Meaning, workshop readiness and your agreement remain human judgments.', action: 'inspect-result', label: 'Compare the evidence', focus: 'evidence' },
  recoverableRefusal: { title: 'The saved passage has changed', text: 'Keep your words. Read the current source and saved passage, then choose whether to attach a new contribution. Earlier notes remain history.', action: 'read-current', label: 'Read the current passage', focus: 'preserve' },
});
export function guidanceFor(stage) {
  if (!Object.hasOwn(guidance, stage)) throw Error('Known observed journey stage required');
  return { ...guidance[stage], stage, grantsAuthority: false };
}
export function createGuidanceCue({ React, Button } = {}) {
  if (typeof React?.createElement !== 'function' || !Button) throw Error('Existing React and Runtime Button required');
  const h = React.createElement;
  return function GuidanceCue({ stage, id, onAction, busy = false, interpretation = null }) {
    if (!/^[a-zA-Z][\w-]*$/.test(id ?? '')) throw Error('Stable unique cue identity required');
    const cue = guidanceFor(stage);
    return h('section', { 'aria-labelledby': `${id}-title`, 'data-guidance-stage': stage },
      h('h2', { id: `${id}-title` }, cue.title),
      h('p', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, cue.text),
      interpretation !== null && h('details', null, h('summary', null, 'Proposed interpretation'), h('p', { dir: 'auto' }, interpretation)),
      cue.action && h(Button, { type: 'button', uiSize: 'xs', role: 'gray', emphasis: 'ghost',
        disabled: busy || !onAction, 'data-guidance-action': cue.action,
        onPress: () => { if (!busy) onAction?.({ action: cue.action, focus: cue.focus }); } }, cue.label));
  };
}
