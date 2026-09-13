- It does not write to a MNSTRY runtime database.
- It does not import, provision, publish, or send project content to a MNSTRY
  managed runtime.
- Conformance remains offline. Local CLI network access is limited to the documented
  `gh` actor-resolution fallback and explicitly enrolled Atelier Sync Git
  operations: bounded fetch for observation/reconciliation, and non-force push
  only when the exact reviewed commit plan requested and confirmed it, no
  earlier local commit remains unpublished, and HEAD still names the verified
  commit object; Sync does not use network actor fallback, follow tags, or
  recursively publish submodule refs.
- Optional vault adapters use explicitly injected host SDKs and transports. The
  host owns their network access, authentication and infrastructure; importing
  the kit does not create a service or make a network request.
- It does not execute model-assisted analysis or any model provider.
- It does not include client project content.

These limits are the design. An authoring tool for private material earns
trust by what it refuses to be able to do.
