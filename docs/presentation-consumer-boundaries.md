# Presentation and public-page consumers

Status: compatibility reference, not consumer migration or acceptance.

The portable presentation API serves both workspaces and simpler consumers.
Public pages may consume resolved tokens without rendering a workspace or
shipping a framework hydration runtime. The Astro example demonstrates that
build-time boundary with invented content and native HTML controls.

| Concern | Owning layer | Integration rule |
| --- | --- | --- |
| Neutral color, type, spacing and accessibility floors | Atelier token API | Map roles explicitly; retain consumer aliases until migration is proved |
| Workspace requests, pending and presentation confirmation | Atelier presentation API | Requests carry no operation authority; host decides outcomes |
| Public-page navigation, scroll and overlay lifecycle | Existing consumer framework | Never attach a second global focus/keyboard/scroll controller |
| Reading geometry, editorial sections and brand fonts | Consumer | No tenant palette, content, private methodology or layout is promoted by copying |
| Production forms, identity, persistence and publication | Host/business authority | A reference form is not a transport or successful submission |
| Responsive and visual proof | Shared proof mechanism plus consumer fixtures | Accepted baselines and real-host accessibility remain separate |

## Compatibility constraints

Current root colors accept validated six-digit hexadecimal values. A consumer
using another color representation needs an explicitly verified mapping; its
stylesheets cannot be passed through as token overrides. Typography family is
currently limited to generic serif, sans-serif and monospace. Custom brand-font
delivery is not silently supported by that restriction. Do not widen the API
or lower a floor to make an adapter appear compatible.

The example uses native document scrolling and a non-overlay disclosure menu.
This is a fixture choice, not a ruling that overrides a consumer framework's
bounded scroll owner or overlay lifecycle. It has no reveal effects or custom
font loads; no-JavaScript readability and absence of motion are the baseline.

## Migration gates

1. Pin the clean supplier and consumer commits plus their adopted-practice
   manifests; a package version alone is insufficient.
2. Record shared roles, intentional exceptions, and which controller owns each
   interaction. Preserve existing behavior and compatibility aliases.
3. Test a representative consumer under its existing framework. Verify actual
   rendered contrast, keyboard, form failure, reflow, reduced motion and page
   weight, not just token arithmetic.
4. Review before/after frames and accept the exact baseline explicitly. Retain
   rollback to the previous dependency and adapter as one reversible unit.
5. Obtain the separate source, CI, maintainer and deployment authorities. The
   reference consumer neither allocates a product path nor activates a site.

## CI integration handoff

The existing workflow does not yet execute either browser proof. A maintainer
must allocate a bounded browser-proof job using the repository's approved
runner and required-check policy; this document does not create or dispatch it.
Use one job, read-only repository permissions, a finite timeout, no application
credentials and no deployment steps. Retain receipts and screenshots even on
failure. A successful CI exit does not establish visual-baseline acceptance.

The execution sequence, from the checked-out candidate root, is:

```sh
# Node 22.18.0: existing root proof runtime.
npm ci --ignore-scripts
npx --no-install playwright install --with-deps chromium firefox webkit
node scripts/prove-presentation-browser.mjs
# Node 22.22.2: isolated Astro build; keep the root runtime contract unchanged.
npm ci --ignore-scripts --prefix examples/astro-presentation
ASTRO_TELEMETRY_DISABLED=1 npm run build --prefix examples/astro-presentation
# Return to Node 22.18.0 for the same proof runtime used locally.
node scripts/prove-astro-presentation.mjs
```

Archive `.artifacts/presentation-browser/` and `.artifacts/astro-presentation/`.
Browser binary versions are determined by the root lockfile. Linux and macOS
frames are separate environments, not interchangeable visual baselines. On
macOS WebKit the synthetic keyboard script uses Option-Tab for link navigation
when system full keyboard access is disabled. This is a host exception, not a
new global keyboard handler.
