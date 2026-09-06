---
name: atelier-guided-coauthor
description: Guide an author through a selected packet in Codex, retaining private source-bound draft answers and resuming through the local Atelier coauthor CLI.
---

# Guided coauthor

Use the installed `atelier coauthor` command, not a browser conversation service.
The author chooses the packet and may read it normally without this workflow.

Check the repository's instructions and local package first. Run
`./node_modules/.bin/atelier coauthor --help` from the intended repository.
Do not download another package if the command is unavailable. Explain that the
installed version needs the coauthor capability and preserve ordinary packet review.

## Start or resume

- Require an existing Git workspace with ignored, untracked `.atelier-local/`.
  Do not change global skills, sibling repositories, credentials or remote access.
- Read the selected packet. Use consumer-owned field ids and workspace-relative
  source references. Compute SHA-256 over each source file's exact UTF-8 bytes.
  Send a `start` request containing `config: {id, fields}`; each field has
  `id` and `source: {ref, digest}`. Packet structure stays in the consumer.
- Requests are JSON on stdin; responses are JSON. Use an ignored request file
  when needed, not shell interpolation of the author's text. Read the returned
  state and revision. `read` takes `sessionId` and resumes retained history.
- Ask one useful question at a time. Record the author's exact answer with an
  `answer` event; events carry a unique `id`, `expectedRevision` and `type`.
  Do not infer an answer or approval from silence.
- If proposing edited wording, use `propose` and show the change. Wait for the
  author's explicit confirmation before `confirm`. `reject` restores the
  original. Even apparently stylistic rewrites need confirmation.
- Send `save` only for the agreed draft. Say “saved as a private draft” only
  after the command returns a saved receipt. The source packet is never edited.
  `continueAfterSave: true` on an answer retains the author's advance intent;
  otherwise `advance` is explicit.
- `pause` and `resume` preserve the current phase. On restart, a `saving`
  state may use `recover` to reconcile the pending private write. A
  `recovery` state requires explicit `retry`, with one retry available.
  Stop retrying when exhausted and retain all artifacts for inspection.

## Boundaries

Never submit store-owned receipt/failure events or fabricate persistence evidence.
A stale source or revision is a visible conflict, not permission to overwrite it.
Keep the old history and obtain a newly bound session for revised sources.
Saved answers are proposals for later owner review, not publication, canonical
acceptance, guide access, or a completed packet. No saved-answer undo is provided;
do not erase history to simulate it. Summarize unresolved questions for the meeting.
