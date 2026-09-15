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
| N5: host refresh during IME throws | Queue latest validated model, expose composition state, flush after final edit; newer synchronous host updates win | Browser cases for unchanged composing DOM, latest/invalid model ordering, no stale widget dispatch, removal/disable/reset/disposal |
| N6: email/number caret continuity | Confirmed email regression; retain compatible focused DOM input without calling unsupported selection APIs | Actual key events insert consecutive characters mid-value during controlled refresh in all three engines |
| N7/N8: neutral-looking warnings and inconsistent chrome | Shared tone labels, dashed warning edge, focus-revealed skip link, aligned header and distinct link/action styling | Web/document/native label assertions; focus/geometry/style/print checks; new before/after frames retained without accepting a baseline |
| N10: printed skip chrome | Skip link excluded in print | Print visibility assertion |

## Conditions retained before controlled-host adoption

- Synthetic composition events prove the binder lifecycle, not a real OS IME or
  assistive-technology session. Receiving hosts still need their actual input,
  device and screen-reader proof, including real navigation/draft lifecycle.
- Visual changes have new before/after frames, not a newly accepted baseline.
- N10 performance: retain the bounded per-render signature used to invalidate
  stale native confirmations. Object-identity memoization would miss in-place
  host mutation. Actual native profiling is still needed before replacing this
  correctness guard; local browser/React fixture proof is not native performance
  acceptance.
- S5: screen-reader busy announcements remain an assistive-technology hypothesis.
  Do not remove pending semantics on the strength of an unrun AT scenario.
- S7: actual browser-proof CI integration remains unimplemented; use the bounded
  receiving-owner recipe in [consumer boundaries](presentation-consumer-boundaries.md).

No source in existing server, harness, vault, coauthor, runtime, private auth,
business, keyboard, Desktop or downstream site implementations changes here.
Connected component placement and portable auth remain a separate unimplemented
proposal. Shape checks of that proposal do not establish enforcement or admission.

The remaining integration gates are exact host proof, maintainer integration,
visual-baseline disposition and actual CI. Local testing and a
source commit do not publish a package, accept a visual baseline or deploy a site.
