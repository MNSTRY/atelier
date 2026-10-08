# The invented workshop example

[The checklist](records/checklist.md) and [the workshop proposal](records/workshop.md) retain separate identities. Their words are the authored sources. The graph projects declared relationships from the `kg` metadata; it is not another place to edit those words.

[knowledge-plan.json](knowledge-plan.json) asks what supports consideration of the workshop. It names the `checklist → supports → workshop` relationship and pins both original sources. [atelier.project.json](atelier.project.json) binds only this example's `records/` directory, using [its public access declaration](repo-access.v1.json). Nothing points to a private repository or previous editor.

The starting checklist declares an empty supporting array. The single proposed revision is:

```diff
-    supports: []
+    supports: ["devday:workshop"]
```

This is an example proposal for the participant to inspect, not an assistant result. It neither changes the proposal's status nor approves the workshop. The checklist's prose and the two source identities stay the same.

Create a disposable copy using the installed host's supported example-copy operation. If the host has not supplied that operation, copy this folder through your ordinary file manager into a new directory, then initialize that directory as a Git repository with `git init`. Keep `.atelier-local/` and `output/` ignored before opening a native draft store. Never open the package's installed files as a writable workspace.

Read the [exercise](../../../docs/knowledge-health/exercise.md) before changing anything. Once the source owner applies a chosen revision, reread the exact source and refresh the plan's corresponding expected-evidence hash through the installed owning tool. Run the same question evaluation and relationship check again. Do not report a verified evidence match from an old hash or silently replace the participant's historical finding reference.

The two commands `git init` and `node --version` are ordinary prerequisite checks. The actual assessment, guided-host, source-application and reassessment entry commands are release-owner joins; none is guessed here.
