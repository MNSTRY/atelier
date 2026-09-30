// Generic optional methods. A lens creates questions, never evidence or authority.
export const INQUIRY_LENSES = Object.freeze({
  schema: 'atelier-inquiry-lenses@v1', version: '1.0.0',
  lenses: Object.freeze([
    { id: 'definitions', question: 'Which definitions and framing choices change the question?', method: 'Compare meanings, scope and operational measures.', exclusions: 'Do not assume shared terminology establishes shared meaning.' },
    { id: 'mechanisms', question: 'Which competing mechanisms could explain the observation?', method: 'Generate alternatives and derive distinguishable predictions.', exclusions: 'A coherent explanation is not evidence of its truth.' },
    { id: 'systems', question: 'Which dependencies, feedback and confounders matter?', method: 'Map causal proposals, delays and competing explanations.', exclusions: 'Do not infer causation from graph proximity or association.' },
    { id: 'empirical', question: 'What was actually observed, in whom and under what conditions?', method: 'Inspect original methods, observations, uncertainty and selection.', exclusions: 'Repeated summaries do not establish independent replication.' },
    { id: 'counterevidence', question: 'Which findings would challenge the leading explanation?', method: 'Seek serious alternatives, contradictions and missing observations.', exclusions: 'Do not invent symmetry where evidence differs.' },
    { id: 'counterfactual', question: 'What changes under another action or assumption?', method: 'Compare explicit scenarios and identify sensitive conclusions.', exclusions: 'A simulated scenario is not an observed causal effect.' },
    { id: 'transfer', question: 'What permits this finding to apply in another context?', method: 'Compare mechanisms, populations and boundary conditions; state the transfer gap.', exclusions: 'Similarity alone does not transfer confidence.' },
    { id: 'decision', question: 'Which uncertainty could change which available decision?', method: 'Name options, consequences, reversibility, information cost and stopping criteria.', exclusions: 'A priority score is not formal expected value of information.' },
    { id: 'reflection', question: 'Did the method help, and what else could explain its outcome?', method: 'Inspect version-bound experience and propose reproducible evaluations.', exclusions: 'A complaint or success report alone does not establish causal skill quality.' },
  ].map(Object.freeze)),
})
