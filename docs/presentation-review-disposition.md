# Presentation correction disposition — 2026-09-15

Status: bounded root correction, not maintainer acceptance, release or adoption.
Reviewed source: `9ea81f087131e909e22fbcff50df1b57050c76af`.

The returned manual defensive review conditionally accepted that source for root
integration and found no new critical/high issue. It ran no tests or live sites;
its visual inspection was partial. The source owner independently verified and
corrected the following findings. Those corrections are a successor, not covered
by an inherited approval of the prior commit.

| Finding | Source disposition | Regression evidence |
| --- | --- | --- |
| S1/S2: native failure contamination and web/native concurrent-delivery drift | Fixed using shared delivery-message logic; current settlement and remaining pending deliveries are distinct from business state | A regression first reproduced failure A contaminating successful B; focused unit tests and both actual web binder and React-backed native fixture exercise settlement |
| S3: schema-dependent attribute safety | Escaped string attributes and generated DOM identifiers in addition to retaining strict validation | Existing text/attribute refusal/escaping tests and browser proof |
| S4: HEAD without dirty-source marker | Proof v3 requires explicit sourceDirty:false for comparison; missing/dirty/old envelopes remain incomparable | Negative comparison cases; dirty development proofs cannot become unchanged baselines |
| S6: implicit form submit without scripts | Static example uses a labelled group and explicit local input validation, not a submitting form | All three engines exercise Enter with scripts both off and on; navigation, retained value and absent form checked |
| N9: repeated pending resize silently dropped | Suppression now gives explicit no-additional-request feedback; host still owns geometry | Shared message test; no optimistic resize or queue added |

## Conditions retained before controlled-host adoption

- N5: browser updates during IME still explicitly refuse. A composition-safe
  update queue needs a separate focused change, including stale-update ordering,
  removal/disable during composition and host eligibility checks. No automatic
  queuing was slipped into this correction.
- N6: email/number selection preservation remains a hypothesis requiring actual
  browser reproduction. Unsupported selection APIs must not be called blindly.
- N7/N8: warning/info differentiation, native tone labels, focus-only skip link,
  chrome alignment and link/action affordances remain an explicit visual slice.
  Preserve before/after frames and obtain a new baseline disposition.
- N10: per-render model serialization cost and printed skip-link chrome remain
  tracked. They are not evidence of a new semantic/runtime owner.
- S5: screen-reader busy announcements remain an assistive-technology hypothesis.
  Do not remove pending semantics on the strength of an unrun AT scenario.
- S7: actual browser-proof CI integration remains unimplemented; use the bounded
  receiving-owner recipe in [consumer boundaries](presentation-consumer-boundaries.md).

No source in existing server, harness, vault, coauthor, runtime, private auth,
business, keyboard, Desktop or downstream site implementations changes here.
Connected component placement and portable auth remain a separate unimplemented
proposal. Shape checks of that proposal do not establish enforcement or admission.

The next source slice is the bounded IME/visual adoption correction above, followed
by exact host proof, maintainer integration and actual CI. Local testing and a
source commit do not publish a package, accept a visual baseline or deploy a site.
