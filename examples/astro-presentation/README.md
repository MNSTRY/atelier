# Astro presentation consumer

A synthetic, source-checkout compatibility fixture, not a production website
template or a replacement marketing framework. It consumes Atelier's public
presentation token API at build time. Astro 7.3.2 is pinned only in this
private example; no Astro or React runtime is added to the Atelier package.
The example is excluded from the published package allowlist.

From this directory, using the pinned Node 22.22.2:

```sh
npm ci
ASTRO_TELEMETRY_DISABLED=1 npm run build
```

The root package dependency is a local source link, not an npm publication
claim. Use the root release-candidate command separately for installed-tarball
proof. Root proof command after building this example:

```sh
node scripts/prove-astro-presentation.mjs
```

The example's transitive font tooling requires Node >=22.19.0. This isolated
build uses the pinned patch version instead of ignoring engine requirements.
Root tests still use Node 22.18.0. The example does not establish compatibility
with older Astro installations or authorize upgrading a consumer site.

Light and dark pages use the same resolved tokens. The reading layout is
consumer-owned, independently invented, and does not force public pages into
a workspace/pane model. No site source, palette, content or runtime is copied.

The menu is a non-overlay native disclosure: no scroll lock or global focus
bridge is installed. Escape closes it within its own keyboard scope. The form
has no named fields, endpoint or submission button, and performs local validity
checks only. Without JavaScript it stays explicitly unavailable; the page and
navigation remain readable and operable. There are no remote fonts, media,
analytics, authentication, persistence, or real submissions.

Existing consumer frameworks remain the owners of scroll/overlay lifecycles,
font delivery, editorial layouts, SEO, real forms and business services. Their
versioned adoption contracts and exact source pins must be reconciled before
an actual migration. This example does not certify any of them.
