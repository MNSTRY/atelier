# Responsibilities, workflows and runtime bindings

Atelier is a repository substrate for people, agents and tools. Its portable
contracts, governance, graph and local runtime support eight responsibilities.

| Responsibility | Work it owns | Existing entry points |
| --- | --- | --- |
| Inquiry | Investigate uncertainty and assess evidence | Discovery and Research Harnesses; `inquiry` |
| Knowledge Stewardship | Curate, govern, connect and operationalize knowledge | `harness knowledge`, `ingest`, intake, graph and context |
| Practical Judgment | Discern fitting action, cultivate practice and learn from consequences | `learn`, practical cases, decision adapters, `practice` |
| Creation and Delivery | Design, implement, verify and deliver changes | `harness build` |
| Capability Stewardship | Qualify, package, adopt, exercise and evolve reusable abilities | `capability`, Skill Steward and `skills` |
| Reflection | Form revisable assessments of the person, work, interaction and system | Witness role; qualified assessments and reflective acts |
| Interaction | Listen, communicate, pace, challenge and repair | Companion policy and controller over one host authority |
| Coordination | Connect work, owners, dependencies, delivery, recovery and outcomes | Collaboration, Build and typed Coordination projections |

These names describe responsibilities. A **harness** composes responsibilities
into work. A **role** describes participation. A **capability** specifies a
supported outcome; a **resource** realizes it. A **method** is an optional way of
working. A **record** retains domain meaning. A **host** executes through its
actual bindings. A role does not acquire a new store or permission merely by
being named. Coaching is one reflective method. Phronesis remains the foundation
of Practical Judgment, including purposes, particulars, taste and exceptions.

Skill Steward is a specialized role within Capability Stewardship. Its existing
catalog and bindings remain authoritative for managed skills. Knowledge
Stewardship owns knowledge inclusion and applicability. Neither owns another
repository's adoption decision. Fabric can implement Coordination; the local
contracts do not require a Fabric service or account.

Creation and Delivery also owns the kit's user-facing failure contract: one
diagnostic shape, a registry of stable codes, and one exit-code convention for
every command. Other responsibilities raise typed diagnostics through that
contract rather than defining their own formats. The contract is proposed in
issue #90 and is not yet implemented. Until it lands, existing typed codes and
refusal classes remain authoritative.

`atelier architecture catalog` returns the validated catalog. `architecture
entry "Skill Steward"` resolves a name. Historical names remain aliases: Discovery
Engine resolves to Discovery Harness; Skills Harness resolves to Capability
Harness. Existing persisted CLI/schema/API identifiers are retained.

## Authoring must name its consumers

The additive `atelier-behavior-binding@v1` contract links exact authored
definition references to field pointers and named, versioned consumers. Each
field is classified as deterministic **enforcement**, interpreted **guidance**,
**presentation**, or descriptive **rationale**. Required unsupported behavior
prevents resolution; optional gaps remain visible in diagnostics.

Pass `{binding, consumers}` to `atelier architecture resolve` or
`resolveBehaviorBinding` from `@mnstry/atelier/architecture`. Consumer declarations
bind identity, profile, revision and supported classifications. This is contract
resolution, not evidence that the declaration is truthful or that a host has
loaded the definition. The output explicitly leaves adoption unestablished.

Qualification must connect authored bytes, resolved binding, exact adopted and
consumed revision, executed operation, durable readback and rendered state.
Preview and production use the same relevant rules with explicitly different
adapters. A changed authored file must not silently change existing adoptions.
Host authentication, release resolution, operation authorization and storage stay
with their owners. An unsupported host supplies diagnostics, not an invented
fallback interpretation.

## Contract ownership and current coverage

| Meaning | Authoritative mechanism | Consumer proof required |
| --- | --- | --- |
| Research evidence and assessment | Inquiry ledger and assessment profiles | Exact handoff, source-family handling and withdrawal |
| Source custody | Intake store; bounded ingestion processor receipts | Source bytes, output integrity, freshness and locators |
| Knowledge applicability | Knowledge review and activation records | Current dependencies, local-source checks and retrieval |
| Accepted learning | Learning decisions and per-harness activation | Scope/exception preservation and withdrawal |
| Managed capabilities | Exact release, adoption state and binding inventory | Installation, host loading and exercise remain separate |
| Scoped agent instructions | Instruction adoption adapter | Exact plan, destination readback and consumer context receipt |
| Build and coordination | Candidate, attempt, gate and handoff records | Native gate evidence and receiving acceptance |
| Personal Trackables | The selected host's domain writer | Definition adoption, occurrences, evidence and qualified views |
| Conversation and reflection | Selected host conversation/effect authority | Delivery, interruption, correction and scope controls |

The portable Trackables reducer/local store, Reflection qualification, Interaction
controller and Coordination views supply reference implementations. Production
host adoption is not established by this catalog. A catalog entry is not an executable runtime or an additional
semantic registry. Host adapters must map these contracts to existing domain
operations rather than create competing writers.

See [Practical Judgment](practical-judgment.md), [research starter](research-starter.md)
and [integration decisions](integration-contract-decisions.md).

See [Trackables](trackables.md), [Interaction and Reflection](interaction-and-reflection.md)
and [Coordination](coordination.md) for supported profiles, native bindings and limits.
