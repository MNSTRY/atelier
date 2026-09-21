export function catalogDocument() {
  return {
  "schema": "atelier-architecture-catalog@v1",
  "entries": [
    {
      "id": "inquiry",
      "kind": "responsibility",
      "label": "Inquiry",
      "aliases": [],
      "purpose": "Investigate uncertainty and establish what evidence supports.",
      "implementation": [
        "src/inquiry/index.mjs"
      ]
    },
    {
      "id": "knowledge-stewardship",
      "kind": "responsibility",
      "label": "Knowledge Stewardship",
      "aliases": [],
      "purpose": "Curate, govern, connect and maintain knowledge and its operational applicability.",
      "implementation": [
        "src/knowledge/index.mjs",
        "src/intake/store.mjs",
        "src/ingestion/store.mjs",
        "src/knowledge/ingestion.mjs"
      ]
    },
    {
      "id": "practical-judgment",
      "kind": "responsibility",
      "label": "Practical Judgment",
      "aliases": [
        "Phronesis"
      ],
      "purpose": "Discern fitting action, cultivate practice and learn from consequences.",
      "implementation": [
        "src/learning/store.mjs",
        "src/judgment/index.mjs",
        "src/capabilities/instructions.mjs"
      ]
    },
    {
      "id": "creation-delivery",
      "kind": "responsibility",
      "label": "Creation and Delivery",
      "aliases": [],
      "purpose": "Design, implement, verify and deliver intended changes.",
      "implementation": [
        "src/build/index.mjs"
      ]
    },
    {
      "id": "capability-stewardship",
      "kind": "responsibility",
      "label": "Capability Stewardship",
      "aliases": [],
      "purpose": "Compose, qualify, package, adopt, exercise and evolve reusable abilities.",
      "implementation": [
        "src/capabilities/index.mjs",
        "src/skills/steward.mjs"
      ]
    },
    {
      "id": "reflection",
      "kind": "responsibility",
      "label": "Reflection",
      "aliases": [],
      "purpose": "Form revisable assessments of the person, work, interaction and system.",
      "implementation": []
    },
    {
      "id": "interaction",
      "kind": "responsibility",
      "label": "Interaction",
      "aliases": [],
      "purpose": "Communicate, listen, pace, challenge and repair through the host conversation authority.",
      "implementation": []
    },
    {
      "id": "coordination",
      "kind": "responsibility",
      "label": "Coordination",
      "aliases": [],
      "purpose": "Connect work, ownership, dependencies, delivery, recovery and outcomes.",
      "implementation": [
        "src/collaboration/index.mjs",
        "src/harnesses/exchange.mjs"
      ]
    },
    {
      "id": "discovery",
      "kind": "harness",
      "label": "Discovery Harness",
      "aliases": [
        "Discovery Engine"
      ],
      "purpose": "Composes the named responsibility through the existing workflow.",
      "implementation": [
        "src/inquiry/index.mjs"
      ]
    },
    {
      "id": "research",
      "kind": "harness",
      "label": "Research Harness",
      "aliases": [],
      "purpose": "Composes the named responsibility through the existing workflow.",
      "implementation": [
        "src/inquiry/index.mjs"
      ]
    },
    {
      "id": "knowledge",
      "kind": "harness",
      "label": "Knowledge Harness",
      "aliases": [],
      "purpose": "Composes the named responsibility through the existing workflow.",
      "implementation": [
        "src/knowledge/index.mjs"
      ]
    },
    {
      "id": "build",
      "kind": "harness",
      "label": "Build Harness",
      "aliases": [],
      "purpose": "Composes the named responsibility through the existing workflow.",
      "implementation": [
        "src/build/index.mjs"
      ]
    },
    {
      "id": "capability-harness",
      "kind": "harness",
      "label": "Capability Harness",
      "aliases": [
        "Skills Harness"
      ],
      "purpose": "Composes the named responsibility through the existing workflow.",
      "implementation": [
        "src/capabilities/index.mjs"
      ]
    },
    {
      "id": "learning",
      "kind": "harness",
      "label": "Learning lifecycle",
      "aliases": [],
      "purpose": "Composes the named responsibility through the existing workflow.",
      "implementation": [
        "src/learning/store.mjs"
      ]
    },
    {
      "id": "ingestion",
      "kind": "harness",
      "label": "Ingestion workflow",
      "aliases": [],
      "purpose": "Composes the named responsibility through the existing workflow.",
      "implementation": [
        "src/ingestion/store.mjs"
      ]
    },
    {
      "id": "skill-steward",
      "kind": "role",
      "label": "Skill Steward",
      "aliases": [],
      "purpose": "Participation within a responsibility; does not create a separate authority.",
      "implementation": [
        "src/skills/steward.mjs"
      ]
    },
    {
      "id": "witness",
      "kind": "role",
      "label": "Witness",
      "aliases": [],
      "purpose": "Participation within a responsibility; does not create a separate authority.",
      "implementation": []
    },
    {
      "id": "companion",
      "kind": "role",
      "label": "Companion",
      "aliases": [],
      "purpose": "Participation within a responsibility; does not create a separate authority.",
      "implementation": []
    },
    {
      "id": "orthogonal-inquiry",
      "kind": "method",
      "label": "Orthogonal inquiry",
      "aliases": [],
      "purpose": "An optional method, selected for its fit to the purpose.",
      "implementation": []
    },
    {
      "id": "bayesian-assessment",
      "kind": "method",
      "label": "Bayesian assessment",
      "aliases": [],
      "purpose": "An optional method, selected for its fit to the purpose.",
      "implementation": []
    },
    {
      "id": "coaching",
      "kind": "method",
      "label": "Coaching",
      "aliases": [],
      "purpose": "An optional method, selected for its fit to the purpose.",
      "implementation": []
    },
    {
      "id": "trackable",
      "kind": "record",
      "label": "Trackable",
      "aliases": [],
      "purpose": "Domain composition of definition, instance, occurrences, evidence and qualified views.",
      "implementation": []
    },
    {
      "id": "adr",
      "kind": "record",
      "label": "Architecture decision record",
      "aliases": [],
      "purpose": "Repository-owned decision identity and history; implementation and evidence currency are distinct.",
      "implementation": []
    },
    {
      "id": "govern-adoption",
      "kind": "capability",
      "label": "Govern capability adoption",
      "aliases": [],
      "purpose": "Independently adopt an exact reusable capability in a repository.",
      "implementation": [
        "src/capabilities/index.mjs"
      ]
    },
    {
      "id": "steward-skill",
      "kind": "resource",
      "label": "Steward operating skill",
      "aliases": [],
      "purpose": "A portable operating resource for the stewardship outcome.",
      "implementation": [
        "skills/codex/atelier-skill-steward/SKILL.md"
      ]
    },
    {
      "id": "codex-repository",
      "kind": "host",
      "label": "Codex repository profile",
      "aliases": [],
      "purpose": "An explicit skill placement profile; actual host loading requires separate evidence.",
      "implementation": [
        "src/capabilities/package.mjs"
      ]
    }
  ],
  "relations": [
    {
      "from": "discovery",
      "type": "composes",
      "to": "inquiry"
    },
    {
      "from": "research",
      "type": "composes",
      "to": "inquiry"
    },
    {
      "from": "knowledge",
      "type": "composes",
      "to": "knowledge-stewardship"
    },
    {
      "from": "build",
      "type": "composes",
      "to": "creation-delivery"
    },
    {
      "from": "capability-harness",
      "type": "composes",
      "to": "capability-stewardship"
    },
    {
      "from": "learning",
      "type": "composes",
      "to": "practical-judgment"
    },
    {
      "from": "ingestion",
      "type": "composes",
      "to": "knowledge-stewardship"
    },
    {
      "from": "skill-steward",
      "type": "participates",
      "to": "capability-stewardship"
    },
    {
      "from": "witness",
      "type": "participates",
      "to": "reflection"
    },
    {
      "from": "companion",
      "type": "participates",
      "to": "interaction"
    },
    {
      "from": "research",
      "type": "applies",
      "to": "orthogonal-inquiry"
    },
    {
      "from": "discovery",
      "type": "applies",
      "to": "bayesian-assessment"
    },
    {
      "from": "govern-adoption",
      "type": "supports",
      "to": "capability-stewardship"
    },
    {
      "from": "steward-skill",
      "type": "realizes",
      "to": "govern-adoption"
    },
    {
      "from": "codex-repository",
      "type": "executes",
      "to": "steward-skill"
    }
  ]
}
}
