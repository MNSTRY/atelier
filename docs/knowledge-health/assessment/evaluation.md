# Recorded calibration and broader evaluation

This public invented recorded trial uses the existing ingestion evaluator. It
runs no processor, provider or held-out bank:

```sh
node --input-type=module -e "import {evaluateKnowledgeHealthCalibration as evaluate} from '@mnstry/atelier/knowledge-health'; console.log(JSON.stringify(evaluate(), null, 2))"
```

The [suite](../../../fixtures/knowledge-health/calibration-suite.json) expects one
evidence item; the [trial](../../../fixtures/knowledge-health/calibration-trial.json)
returns it twice. Native scoring reports one matched and one unexpected item.
Cost remains null, human verdict unassessed, semantic qualification not-assessed.
Calibration-only cases cannot pass held-out qualification.

For a recorded evaluation, use the existing `./ingestion/evaluation` exports. Pin
suite/processor/configuration/sources; retain exact evidence locators/text,
outcome, attempts, measured latency/cost and any human-assessment provenance.
Unknown measurements stay unknown. This evaluates extraction evidence, not
semantic support or authenticated human judgment.

`knowledge evaluate` separately compares graph versus lexical retrieval using
the typed plan's frozen expectations. Measure actual answer support, qualifiers,
contradiction/identity and correction effort through an authorized semantic/human
trial. Supplied agent suggestions can retain exact citations/provenance but
cannot accept canonical truth. See [capabilities](capabilities.md) for the broader
repository/host/maintenance work.
