# Start with the pinned public package

This quickstart covers the published baseline, 0.2.0-alpha.12. It gives a public invented graph example and existing coauthor capabilities. The full Knowledge Health guided journey is a release-owner join; it is not present in this baseline installation.

Use Node 22.18.0 for the tested rehearsal. Create a new empty directory and install the exact version:

    npm install --save-exact @mnstry/atelier@0.2.0-alpha.12
    ./node_modules/.bin/atelier --version
    ./node_modules/.bin/atelier init --template sample-workspace --target example
    cd example
    ../node_modules/.bin/atelier graph
    ../node_modules/.bin/atelier project

The graph and projection describe the installed invented example. Read its source documents alongside the result. A structural check does not decide whether a real relationship is meaningful or accepted by its owner.

These commands use the installed bin. They do not download a moving latest version or require a publisher checkout. The tested docs inside the installation include README.md, docs/knowledge-graph.md and docs/coauthor-session.md. The exported API families include @mnstry/atelier/graph, @mnstry/atelier/project and @mnstry/atelier/coauthor. Use only the actual version's declared exports.

For the Dev Day release, the facilitator must first receive and rehearse its exact version, normal example entry, guided authoring entry and owning correction route. Replace the pinned version only after that receiving. Do not substitute an unreleased source template or a private editor for an installed capability. Keep the tested package integrity and the separate tarball/registry reports with the handover.
