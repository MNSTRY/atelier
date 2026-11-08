# Resource origin

The upstream design references derive from compiled Agents-profile Markdown at
Impeccable commit `924bbd194d02e5e15a227e75b5901fb0d7a4ecad`, skill4.8.1, engine0.1.19. The distribution
uses neutral terminology and omits host hook setup. Every changed resource has
both input/output digests and an adaptation notice in the origin inventory.
Relative playbook links remain inside this skill.
The active governance wrapper and command map are new candidate instructions,
not upstream code or an upstream-approved integration.

The bundled [Apache license](licenses/apache-2.0.md),
[upstream notices](licenses/upstream-notice.md) and
[platform MIT license](licenses/platform-design-skills-mit.md) remain within
each projected skill, as well as the publisher package. Exact resource
origins are in package-level source-inventory.json. Font files, external catalog
assets, images, executable launchers, browser scripts, provider-agent configs,
hooks and engine binaries are excluded. Their redistribution or use would need
separate qualified host bindings and rights evidence.

The descriptor's source revision names the upstream resource provenance. This
descriptor does not assert publisher authentication, external review, host
observation or product acceptance. Those need separate version/binding/session
evidence. A sealed digest establishes byte integrity only.
