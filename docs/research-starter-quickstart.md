# Start a research workspace

This packet works with any topic and research tool. Read
[the six-stage research starter](research-starter.md) for the prompts. The package
provides local evidence custody, governance, skills and contracts; your selected
research tool and reviewers supply research and judgment.

## Use the included candidate

This packet may contain an unreleased candidate. Install its included tarball,
not a registry version assumed to contain the same features. Check the packet's
SHA-256 manifest. The runtime requires Node.js 22.18 or later within major 22,
Git, and npm. Installing dependencies needs a registry or a previously warmed
cache; using the local core does not require a hosted account.

In a new disposable directory:

```sh
git init
npm init -y
npm install /path/to/the/included/mnstry-atelier-0.2.0-alpha.7.tgz
```

Add `.atelier-local/` and `node_modules/` to `.gitignore` before local persistent
operations. Keep source material and private exports under the intended
repository's access policy. Then inspect the installed interfaces:

```sh
npx --no-install atelier architecture catalog
npx --no-install atelier inquiry lenses
npx --no-install atelier inquiry example
npx --no-install atelier harness example
```

The invented examples are templates, not real research findings. Replace their
question, sources, judgments and scope deliberately. Retain original captures,
source citations, uncertainty and disagreements through each step.

## Choose the relevant operating skill

The installed package includes paired `skills/codex/` and `skills/claude/`
resources. Start with the Research and Discovery Harness documentation; use
Capability Stewardship and Skill Steward to inspect existing skills, qualify
compatibility and plan a destination-specific adoption. An installed skill is
not automatically active in an agent. Keep local instructions and custom skills;
review a concrete adoption plan before applying its exact digest.

Use [ingestion](ingestion.md) for bounded local captures and
[Knowledge and Build](learning-harnesses.md) for the current governed
workflow. Practical lessons use [Practical Judgment](practical-judgment.md).
[Trackables](trackables.md), [Interaction and Reflection](interaction-and-reflection.md)
and [Coordination](coordination.md) describe supported reference profiles and
what an actual host must implement.

## What successful completion looks like

You can answer the original question using reviewed context, trace each material
claim to its source, explain uncertainty, and correct one source without silently
retaining stale downstream guidance. Graph proposals become admitted sources
only through the receiving repository's explicit process. Package installation,
validation and extraction are useful steps; none establishes research truth or
someone else's acceptance.

Use the packet locally before adding optional hosted research or operated
connectors. No topic, provider, proprietary service or continuous monitoring is
required. Real host adoption and research usefulness need their own evidence.
