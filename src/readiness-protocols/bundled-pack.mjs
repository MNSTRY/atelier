export const MNSTRY_READINESS_PACK_SCHEMA = 'mnstry-readiness-pack@v1'
export const READINESS_PROTOCOL_SCHEMA = 'atelier-readiness-protocol@v1'
export const READINESS_RUN_SCHEMA = 'atelier-readiness-run@v1'

export const READINESS_PROTOCOL_SLUGS = [
  'identity-map',
  'transformation-map',
  'offer-map',
  'space-design',
  'trackables',
  'consent-boundaries',
  'content-inventory',
  'discovery-engine',
  'journey-map',
  'operations-readiness',
  'runtime-readiness',
  'tenant-packet',
]

export const READINESS_PROTOCOL_IDS = READINESS_PROTOCOL_SLUGS.map((slug) => `mnstry.readiness:${slug}`)

const baseSafetyPosture = {
  runtimeMutation: false,
  externalEgress: false,
  defaultVisibility: 'private',
  authority: 'proposal-only',
  reviewMode: 'static-inspection',
  failClosedOnMissingEvidence: true,
}

function safetyPosture(overrides = {}) {
  return {
    ...baseSafetyPosture,
    ...overrides,
    refuses: [
      'runtime writes',
      'identity inference without source evidence',
      'visibility expansion without explicit review',
      ...(overrides.refuses ?? []),
    ],
  }
}

function namespacedProtocolId(slug) {
  return slug.includes(':') ? slug : `mnstry.readiness:${slug}`
}

function outputSlug(slug, id) {
  return id
    .replace(`${slug}.`, '')
    .replace(/[^a-z0-9:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function namespacedTerm(protocolId, value) {
  if (String(value).includes(':')) return value
  return `${protocolId}.${String(value).split('.').pop()}`
}

function sourceTerm(protocolId, mapping) {
  if (mapping.sourceTerm) return mapping.sourceTerm
  const clean = String(mapping.sourceField || 'source')
    .replace(/\[\]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return `${protocolId}.${clean || 'source'}`
}

function protocol({
  id,
  stage = 'formation',
  title,
  purpose,
  questions,
  inputFields,
  outputHints,
  readinessRules,
  claimMappings,
  exportMappings,
  safety,
}) {
  const slug = id.includes(':') ? id.split(':').at(-1) : id
  const protocolId = namespacedProtocolId(id)
  const normalizedQuestions = questions.map((question) => ({
    required: true,
    ...question,
  }))
  const normalizedReadinessRules = readinessRules.map((rule) => ({
    ...rule,
    id: namespacedTerm(protocolId, rule.id),
  }))
  const normalizedClaimMappings = claimMappings.map((mapping) => ({
    ...mapping,
    id: namespacedTerm(protocolId, mapping.id),
  }))
  const normalizedExportMappings = exportMappings.map((mapping) => ({
    ...mapping,
    id: namespacedTerm(protocolId, mapping.id),
    sourceTerm: sourceTerm(protocolId, mapping),
  }))
  const safetySummary = safetyPosture(safety)

  return {
    schema: READINESS_PROTOCOL_SCHEMA,
    id: protocolId,
    slug,
    version: 'v1',
    stage,
    title,
    purpose,
    questions: normalizedQuestions,
    inputFields,
    outputHints,
    outputs: {
      runSchema: READINESS_RUN_SCHEMA,
      artifacts: outputHints.map((hint) => ({
        id: `${protocolId}.${outputSlug(slug, hint.id)}`,
        kind: 'draft',
        schema: hint.schema || 'atelier-readiness-run@v1',
        description: hint.text,
      })),
    },
    readinessRules: normalizedReadinessRules,
    claimMappings: normalizedClaimMappings,
    graphLenses: [{
      id: `${protocolId}.lens`,
      title: `${title} Lens`,
      query: {
        protocolId,
        claimProvider: 'atelier-readiness',
      },
    }],
    exportMappings: normalizedExportMappings,
    safety: {
      runtimeMutation: false,
      runtimeImport: false,
      canonicalWrites: false,
      claimOnly: true,
      telemetry: false,
      egress: false,
      sendPath: false,
      browserApply: false,
      dryRunOnly: true,
    },
    safetyPosture: safetySummary,
    ui: {
      section: 'readiness-journey',
      title,
      description: purpose,
      agentPrompt: `Run atelier readiness run ${protocolId} --project ./atelier.project.json.`,
    },
  }
}

export const bundledReadinessProtocols = [
  protocol({
    id: 'identity-map',
    title: 'Identity Map',
    purpose: 'Resolve the participant, facilitator, operator, organization, and system roles that a readiness packet must describe.',
    questions: [
      {
        id: 'identity-map.roles',
        prompt: 'Which roles must be represented before this packet can be reviewed?',
        inputFields: ['actors[].role', 'actors[].displayName', 'actors[].sourceRef'],
      },
      {
        id: 'identity-map.ownership',
        prompt: 'Which runtime owner would be responsible for each identity or role if promoted later?',
        inputFields: ['actors[].runtimeOwner', 'actors[].ownerRationale'],
      },
      {
        id: 'identity-map.ambiguity',
        prompt: 'Which aliases, duplicate records, or unknown owners need human review?',
        inputFields: ['identityQuestions[].subject', 'identityQuestions[].reason'],
      },
    ],
    inputFields: [
      { id: 'actors[].localId', type: 'string', required: true, description: 'Packet-local stable id for the role or actor.' },
      { id: 'actors[].role', type: 'enum', required: true, values: ['participant', 'facilitator', 'operator', 'organization', 'system'], description: 'Neutral role category.' },
      { id: 'actors[].runtimeOwner', type: 'enum', required: true, values: ['identity', 'providers', 'audit'], description: 'Runtime owner proposed for later review.' },
      { id: 'identityQuestions[]', type: 'array', required: false, description: 'Open identity questions that block confident promotion.' },
    ],
    outputHints: [
      { id: 'identity-map.table', text: 'Render a role table with local ids, source evidence, owner, and review state.' },
      { id: 'identity-map.unresolved', text: 'Group unresolved aliases and duplicate candidates separately from confirmed identities.' },
    ],
    readinessRules: [
      { id: 'identity-map.required-role-evidence', severity: 'blocker', condition: 'Every actor has a sourceRef and runtimeOwner.', remediation: 'Add source evidence or flag the actor unresolved.', failClosed: true },
      { id: 'identity-map.no-contact-authority', severity: 'warning', condition: 'Contact details are not treated as authority for identity merge decisions.', remediation: 'Use reviewed source refs instead of direct-contact fields.', failClosed: true },
    ],
    claimMappings: [
      { id: 'identity-map.actor-belongs-to-role', claimPredicate: 'belongs_to', sourceFields: ['actors[].localId', 'actors[].role'], target: 'atelier-claim@v1', evidence: 'actors[].sourceRef' },
      { id: 'identity-map.alias-supports-actor', claimPredicate: 'supports', sourceFields: ['identityQuestions[].subject'], target: 'atelier-claim@v1', evidence: 'identityQuestions[].reason' },
    ],
    exportMappings: [
      { id: 'identity-map.actor-artifact', sourceField: 'actors[]', target: 'core.artifact', runtimeOwner: 'identity', targetCollection: 'staffPrep' },
      { id: 'identity-map.review-trackable', sourceField: 'identityQuestions[]', target: 'core.trackable', runtimeOwner: 'audit', targetCollection: 'trackables' },
    ],
    safety: {
      reviewFocus: 'Verify that identity records remain role-based and evidence-backed until a runtime owner reviews them.',
    },
  }),
  protocol({
    id: 'transformation-map',
    title: 'Transformation Map',
    purpose: 'Describe the before, after, mechanisms, evidence, and limits of the change a project claims to support.',
    questions: [
      {
        id: 'transformation-map.before-after',
        prompt: 'What observable state is expected before and after the experience?',
        inputFields: ['states.before', 'states.after', 'states.evidenceRef'],
      },
      {
        id: 'transformation-map.mechanisms',
        prompt: 'Which mechanisms are claimed to support the transformation?',
        inputFields: ['mechanisms[].name', 'mechanisms[].sourceRef', 'mechanisms[].confidence'],
      },
      {
        id: 'transformation-map.limits',
        prompt: 'What outcomes are explicitly out of scope?',
        inputFields: ['limits[].statement', 'limits[].reason'],
      },
    ],
    inputFields: [
      { id: 'states.before', type: 'text', required: true, description: 'Plain-language starting condition.' },
      { id: 'states.after', type: 'text', required: true, description: 'Plain-language intended condition.' },
      { id: 'mechanisms[].confidence', type: 'number', required: true, description: '0 to 1 proposal confidence for each mechanism.' },
      { id: 'limits[]', type: 'array', required: true, description: 'Out-of-scope promises or unsupported claims.' },
    ],
    outputHints: [
      { id: 'transformation-map.delta', text: 'Render a before-to-after delta with mechanisms and source evidence beside each claim.' },
      { id: 'transformation-map.limits', text: 'Show limits as first-class packet content, not footnotes.' },
    ],
    readinessRules: [
      { id: 'transformation-map.evidence-per-mechanism', severity: 'blocker', condition: 'Every mechanism has source evidence and confidence.', remediation: 'Attach evidence or remove the mechanism.', failClosed: true },
      { id: 'transformation-map.limits-present', severity: 'warning', condition: 'At least one explicit limit or non-goal is recorded.', remediation: 'Add limits before external review.', failClosed: false },
    ],
    claimMappings: [
      { id: 'transformation-map.mechanism-supports-outcome', claimPredicate: 'supports', sourceFields: ['mechanisms[].name', 'states.after'], target: 'atelier-claim@v1', evidence: 'mechanisms[].sourceRef' },
      { id: 'transformation-map.limit-contradicts-overclaim', claimPredicate: 'contradicts', sourceFields: ['limits[].statement'], target: 'atelier-claim@v1', evidence: 'limits[].reason' },
    ],
    exportMappings: [
      { id: 'transformation-map.material', sourceField: 'states', target: 'content.material', runtimeOwner: 'projection', targetCollection: 'surfaces' },
      { id: 'transformation-map.outcome-trackable', sourceField: 'mechanisms[]', target: 'core.trackable', runtimeOwner: 'events', targetCollection: 'trackables' },
    ],
    safety: {
      refuses: ['unsupported therapeutic or financial outcome claims'],
      reviewFocus: 'Verify that outcome claims are framed as source-backed proposals with visible limits.',
    },
  }),
  protocol({
    id: 'offer-map',
    title: 'Offer Map',
    purpose: 'Convert service, product, session, or program ideas into reviewable offer components without creating an active sale path.',
    questions: [
      {
        id: 'offer-map.promise',
        prompt: 'What is being offered, to whom, and under what constraints?',
        inputFields: ['offer.name', 'offer.audience', 'offer.constraints[]'],
      },
      {
        id: 'offer-map.commitment',
        prompt: 'What commitment path would a participant enter if this offer later became active?',
        inputFields: ['commitmentPath.steps[]', 'commitmentPath.exitOptions[]'],
      },
      {
        id: 'offer-map.status',
        prompt: 'Which parts are approved, draft, blocked, or need review?',
        inputFields: ['offer.components[].approvalStatus', 'offer.blockers[]'],
      },
    ],
    inputFields: [
      { id: 'offer.name', type: 'string', required: true, description: 'Neutral offer name.' },
      { id: 'offer.audience', type: 'enum', required: true, values: ['public', 'team', 'operator', 'staff', 'private', 'sensitive'], description: 'Local source audience.' },
      { id: 'commitmentPath.steps[]', type: 'array', required: true, description: 'Reviewable sequence before any booking or purchase path exists.' },
      { id: 'offer.components[].approvalStatus', type: 'enum', required: true, values: ['approved', 'draft', 'blocked', 'needs-review'], description: 'Approval state for each offer component.' },
    ],
    outputHints: [
      { id: 'offer-map.summary', text: 'Render the offer as promise, eligibility, commitment path, constraints, and approval status.' },
      { id: 'offer-map.blockers', text: 'Keep draft or blocked components visible in a remediation section.' },
    ],
    readinessRules: [
      { id: 'offer-map.no-active-commerce', severity: 'blocker', condition: 'The pack does not include active payment, booking, or send paths.', remediation: 'Remove active runtime actions and keep only dry-run mappings.', failClosed: true },
      { id: 'offer-map.approval-known', severity: 'blocker', condition: 'Every offer component has an approvalStatus.', remediation: 'Set each component approved, draft, blocked, or needs-review.', failClosed: true },
    ],
    claimMappings: [
      { id: 'offer-map-offer-implements-promise', claimPredicate: 'implements', sourceFields: ['offer.name', 'offer.promise'], target: 'atelier-claim@v1', evidence: 'offer.sourceRef' },
      { id: 'offer-map-step-depends-on-previous', claimPredicate: 'depends_on', sourceFields: ['commitmentPath.steps[]'], target: 'atelier-claim@v1', evidence: 'commitmentPath.sourceRef' },
    ],
    exportMappings: [
      { id: 'offer-map.offer', sourceField: 'offer', target: 'content.material', runtimeOwner: 'catalog', targetCollection: 'offers' },
      { id: 'offer-map.commitment-path', sourceField: 'commitmentPath', target: 'scheduling.commitment', runtimeOwner: 'commitments', targetCollection: 'commitmentPaths' },
    ],
    safety: {
      refuses: ['active booking flow', 'active payment flow'],
      reviewFocus: 'Verify that the offer is reviewable content and dry-run mapping only.',
    },
  }),
  protocol({
    id: 'space-design',
    title: 'Space Design',
    purpose: 'Describe physical, virtual, or hybrid spaces as reviewable requirements before any provisioning is requested.',
    questions: [
      {
        id: 'space-design.purpose',
        prompt: 'What purpose does the space serve and which offer or journey stage depends on it?',
        inputFields: ['space.purpose', 'space.relatedProtocolIds[]', 'space.sourceRef'],
      },
      {
        id: 'space-design.constraints',
        prompt: 'What capacity, access, accessibility, privacy, or equipment constraints apply?',
        inputFields: ['space.constraints[]', 'space.accessModel', 'space.accessibilityNotes'],
      },
      {
        id: 'space-design.provisioning',
        prompt: 'What must be provisioned, reviewed, or refused before use?',
        inputFields: ['provisioning.needs[]', 'provisioning.blockers[]'],
      },
    ],
    inputFields: [
      { id: 'space.name', type: 'string', required: true, description: 'Neutral space label.' },
      { id: 'space.accessModel', type: 'enum', required: true, values: ['open', 'invited', 'staffed', 'private-review'], description: 'How access would be controlled after review.' },
      { id: 'space.constraints[]', type: 'array', required: true, description: 'Capacity, accessibility, privacy, or equipment constraints.' },
      { id: 'provisioning.needs[]', type: 'array', required: false, description: 'Provisioning needs that remain inactive in the bundled pack.' },
    ],
    outputHints: [
      { id: 'space-design.matrix', text: 'Render space purpose, access model, constraints, dependencies, and provisioning status together.' },
      { id: 'space-design.refusal', text: 'Call out any constraints that would prevent safe provisioning.' },
    ],
    readinessRules: [
      { id: 'space-design.constraints-recorded', severity: 'blocker', condition: 'Space constraints are present before export mapping.', remediation: 'Add constraints or flag the space blocked.', failClosed: true },
      { id: 'space-design.no-auto-provision', severity: 'blocker', condition: 'Provisioning is represented only as proposed requirements.', remediation: 'Remove any provision/apply instruction from the packet.', failClosed: true },
    ],
    claimMappings: [
      { id: 'space-design-space-supports-offer', claimPredicate: 'supports', sourceFields: ['space.name', 'space.relatedProtocolIds[]'], target: 'atelier-claim@v1', evidence: 'space.sourceRef' },
      { id: 'space-design-provision-depends-on-constraint', claimPredicate: 'depends_on', sourceFields: ['provisioning.needs[]', 'space.constraints[]'], target: 'atelier-claim@v1', evidence: 'provisioning.sourceRef' },
    ],
    exportMappings: [
      { id: 'space-design.space', sourceField: 'space', target: 'space.space', runtimeOwner: 'projection', targetCollection: 'spaces' },
      { id: 'space-design.provision', sourceField: 'provisioning', target: 'space.provision', runtimeOwner: 'providers', targetCollection: 'providerEgress' },
    ],
    safety: {
      refuses: ['automatic provisioning', 'capacity expansion without review'],
      reviewFocus: 'Verify that space requirements fail closed when access, privacy, or capacity constraints are incomplete.',
    },
  }),
  protocol({
    id: 'trackables',
    title: 'Trackables',
    purpose: 'Define observable states, milestones, events, and review signals without starting collection or telemetry.',
    questions: [
      {
        id: 'trackables.signal',
        prompt: 'Which signals matter for readiness, quality, safety, or progress?',
        inputFields: ['trackables[].name', 'trackables[].purpose', 'trackables[].sourceRef'],
      },
      {
        id: 'trackables.visibility',
        prompt: 'Who should be allowed to see each signal after runtime review?',
        inputFields: ['trackables[].localAudience', 'trackables[].proposedVisibility'],
      },
      {
        id: 'trackables.cadence',
        prompt: 'When would the signal be checked, and what decision would it support?',
        inputFields: ['trackables[].cadence', 'trackables[].decisionUse'],
      },
    ],
    inputFields: [
      { id: 'trackables[].name', type: 'string', required: true, description: 'Neutral signal or milestone name.' },
      { id: 'trackables[].proposedVisibility', type: 'enum', required: true, values: ['private', 'shared', 'platform', 'public'], description: 'Runtime visibility proposed for review.' },
      { id: 'trackables[].cadence', type: 'string', required: true, description: 'Review cadence, not an active scheduler.' },
      { id: 'trackables[].decisionUse', type: 'text', required: true, description: 'Decision this signal would inform.' },
    ],
    outputHints: [
      { id: 'trackables.catalog', text: 'Render each signal with visibility, cadence, owner, and decision use.' },
      { id: 'trackables.missing-owner', text: 'Separate signals missing an owner into a blocker list.' },
    ],
    readinessRules: [
      { id: 'trackables.owner-and-visibility', severity: 'blocker', condition: 'Every trackable has a runtimeOwner and proposedVisibility.', remediation: 'Assign owner and visibility or remove the signal.', failClosed: true },
      { id: 'trackables.no-telemetry', severity: 'blocker', condition: 'Trackables do not enable telemetry or background collection.', remediation: 'Keep signals as definitions only.', failClosed: true },
    ],
    claimMappings: [
      { id: 'trackables-signal-evidences-outcome', claimPredicate: 'evidences', sourceFields: ['trackables[].name', 'trackables[].decisionUse'], target: 'atelier-claim@v1', evidence: 'trackables[].sourceRef' },
      { id: 'trackables-signal-supports-journey', claimPredicate: 'supports', sourceFields: ['trackables[].relatedStage'], target: 'atelier-claim@v1', evidence: 'trackables[].sourceRef' },
    ],
    exportMappings: [
      { id: 'trackables.trackable', sourceField: 'trackables[]', target: 'core.trackable', runtimeOwner: 'events', targetCollection: 'trackables' },
      { id: 'trackables.audit-artifact', sourceField: 'trackables[].decisionUse', target: 'core.artifact', runtimeOwner: 'audit', targetCollection: 'staffPrep' },
    ],
    safety: {
      refuses: ['background collection', 'implicit participant monitoring'],
      reviewFocus: 'Verify that trackables are definitions and review signals, not collection jobs.',
    },
  }),
  protocol({
    id: 'consent-boundaries',
    title: 'Consent Boundaries',
    purpose: 'Record consent requirements, refusal paths, revocation expectations, and visibility limits for review.',
    questions: [
      {
        id: 'consent-boundaries.scope',
        prompt: 'What action, content, space, signal, or commitment requires consent?',
        inputFields: ['boundaries[].subject', 'boundaries[].scope', 'boundaries[].sourceRef'],
      },
      {
        id: 'consent-boundaries.refusal',
        prompt: 'How can consent be declined, withheld, or revoked without penalty?',
        inputFields: ['boundaries[].refusalPath', 'boundaries[].revocationPath'],
      },
      {
        id: 'consent-boundaries.visibility',
        prompt: 'What is the most restrictive visibility that can still support the intended workflow?',
        inputFields: ['boundaries[].defaultVisibility', 'boundaries[].exceptions[]'],
      },
    ],
    inputFields: [
      { id: 'boundaries[].subject', type: 'string', required: true, description: 'Thing governed by this consent boundary.' },
      { id: 'boundaries[].scope', type: 'text', required: true, description: 'Specific permission or limit under review.' },
      { id: 'boundaries[].refusalPath', type: 'text', required: true, description: 'How refusal is represented.' },
      { id: 'boundaries[].defaultVisibility', type: 'enum', required: true, values: ['private', 'shared'], description: 'Default to private unless review justifies shared.' },
    ],
    outputHints: [
      { id: 'consent-boundaries.register', text: 'Render a consent register with subject, scope, refusal path, revocation path, and visibility.' },
      { id: 'consent-boundaries.exceptions', text: 'Show exceptions as review items with evidence and owner.' },
    ],
    readinessRules: [
      { id: 'consent-boundaries.refusal-required', severity: 'blocker', condition: 'Every consent boundary has refusal and revocation paths.', remediation: 'Add refusal and revocation paths before readiness.', failClosed: true },
      { id: 'consent-boundaries.no-visibility-expansion', severity: 'blocker', condition: 'Visibility is private or explicitly justified as shared.', remediation: 'Downgrade visibility or add review evidence.', failClosed: true },
    ],
    claimMappings: [
      { id: 'consent-boundaries-boundary-governs-subject', claimPredicate: 'belongs_to', sourceFields: ['boundaries[].subject', 'boundaries[].scope'], target: 'atelier-claim@v1', evidence: 'boundaries[].sourceRef' },
      { id: 'consent-boundaries-refusal-supports-boundary', claimPredicate: 'supports', sourceFields: ['boundaries[].refusalPath'], target: 'atelier-claim@v1', evidence: 'boundaries[].sourceRef' },
    ],
    exportMappings: [
      { id: 'consent-boundaries.artifact', sourceField: 'boundaries[]', target: 'core.artifact', runtimeOwner: 'consent', targetCollection: 'consentBoundaries' },
      { id: 'consent-boundaries.audit-trackable', sourceField: 'boundaries[].exceptions[]', target: 'core.trackable', runtimeOwner: 'audit', targetCollection: 'trackables' },
    ],
    safety: {
      refuses: ['assumed consent', 'silent visibility expansion'],
      reviewFocus: 'Verify that consent controls refuse or fail closed when scope, refusal, or revocation is missing.',
    },
  }),
  protocol({
    id: 'content-inventory',
    title: 'Content Inventory',
    purpose: 'Inventory source material, packet artifacts, public surfaces, and review status without mixing private source authority into public output.',
    questions: [
      {
        id: 'content-inventory.artifacts',
        prompt: 'Which materials belong in the packet and what role does each material play?',
        inputFields: ['materials[].name', 'materials[].contentRole', 'materials[].sourceRef'],
      },
      {
        id: 'content-inventory.audience',
        prompt: 'What local audience and proposed runtime visibility apply to each material?',
        inputFields: ['materials[].localAudience', 'materials[].proposedVisibility'],
      },
      {
        id: 'content-inventory.status',
        prompt: 'Which materials are ready, draft, blocked, duplicated, or superseded?',
        inputFields: ['materials[].approvalStatus', 'materials[].supersedes'],
      },
    ],
    inputFields: [
      { id: 'materials[].name', type: 'string', required: true, description: 'Neutral material name.' },
      { id: 'materials[].contentRole', type: 'enum', required: true, values: ['source', 'summary', 'surface', 'staff-prep', 'evidence'], description: 'How this material is used in the packet.' },
      { id: 'materials[].localAudience', type: 'enum', required: true, values: ['public', 'team', 'operator', 'staff', 'private', 'sensitive'], description: 'Source readership boundary.' },
      { id: 'materials[].approvalStatus', type: 'enum', required: true, values: ['approved', 'draft', 'blocked', 'needs-review'], description: 'Review state.' },
    ],
    outputHints: [
      { id: 'content-inventory.register', text: 'Render a material register with source role, audience, visibility, approval, and dependencies.' },
      { id: 'content-inventory.taint', text: 'Surface private or sensitive materials as taint blockers for public projection.' },
    ],
    readinessRules: [
      { id: 'content-inventory.audience-known', severity: 'blocker', condition: 'Every material has localAudience and approvalStatus.', remediation: 'Classify audience and status before export mapping.', failClosed: true },
      { id: 'content-inventory.public-only-policy', severity: 'blocker', condition: 'Public export mappings only use public-approved source material.', remediation: 'Remove private source refs or reduce visibility.', failClosed: true },
    ],
    claimMappings: [
      { id: 'content-inventory-material-supports-surface', claimPredicate: 'supports', sourceFields: ['materials[].sourceRef', 'materials[].contentRole'], target: 'atelier-claim@v1', evidence: 'materials[].sourceRef' },
      { id: 'content-inventory-material-supersedes', claimPredicate: 'supersedes', sourceFields: ['materials[].supersedes'], target: 'atelier-claim@v1', evidence: 'materials[].sourceRef' },
    ],
    exportMappings: [
      { id: 'content-inventory.material', sourceField: 'materials[]', target: 'content.material', runtimeOwner: 'projection', targetCollection: 'surfaces' },
      { id: 'content-inventory.staff-prep', sourceField: 'materials[contentRole=staff-prep]', target: 'core.artifact', runtimeOwner: 'providers', targetCollection: 'staffPrep' },
    ],
    safety: {
      refuses: ['public projection from private source material', 'unreviewed content promotion'],
      reviewFocus: 'Verify that source audience and runtime visibility remain separate fields.',
    },
  }),
  protocol({
    id: 'discovery-engine',
    title: 'Discovery Engine',
    purpose: 'Define discovery prompts, intake signals, scoring notes, and next-step suggestions as local review artifacts.',
    questions: [
      {
        id: 'discovery-engine.questions',
        prompt: 'Which discovery questions gather the minimum context needed for a useful next step?',
        inputFields: ['discoveryQuestions[].prompt', 'discoveryQuestions[].purpose'],
      },
      {
        id: 'discovery-engine.signals',
        prompt: 'Which answers or observations would change the recommendation?',
        inputFields: ['signals[].name', 'signals[].interpretation', 'signals[].sourceRef'],
      },
      {
        id: 'discovery-engine.next-step',
        prompt: 'What next step can be suggested, and what evidence supports it?',
        inputFields: ['nextSteps[].label', 'nextSteps[].evidenceRef', 'nextSteps[].confidence'],
      },
    ],
    inputFields: [
      { id: 'discoveryQuestions[].prompt', type: 'text', required: true, description: 'Neutral discovery question.' },
      { id: 'signals[].interpretation', type: 'text', required: true, description: 'How a signal changes the local recommendation.' },
      { id: 'nextSteps[].confidence', type: 'number', required: true, description: '0 to 1 proposal confidence.' },
      { id: 'nextSteps[].requiresReview', type: 'boolean', required: true, description: 'Whether a human review is required before showing the suggestion.' },
    ],
    outputHints: [
      { id: 'discovery-engine.flow', text: 'Render discovery questions, expected signals, recommendation logic, and review gates.' },
      { id: 'discovery-engine.low-confidence', text: 'Separate low-confidence next steps from ready suggestions.' },
    ],
    readinessRules: [
      { id: 'discovery-engine.no-model-provider', severity: 'blocker', condition: 'Discovery definitions do not require a model provider or external egress.', remediation: 'Represent discovery as local prompts and static rules only.', failClosed: true },
      { id: 'discovery-engine.review-required', severity: 'warning', condition: 'Any next step with confidence below threshold requires review.', remediation: 'Set requiresReview true or remove the next step.', failClosed: true },
    ],
    claimMappings: [
      { id: 'discovery-engine-signal-evidences-next-step', claimPredicate: 'evidences', sourceFields: ['signals[].name', 'nextSteps[].label'], target: 'atelier-claim@v1', evidence: 'nextSteps[].evidenceRef' },
      { id: 'discovery-engine-question-supports-signal', claimPredicate: 'supports', sourceFields: ['discoveryQuestions[].prompt', 'signals[].name'], target: 'atelier-claim@v1', evidence: 'signals[].sourceRef' },
    ],
    exportMappings: [
      { id: 'discovery-engine.surface', sourceField: 'discoveryQuestions[]', target: 'content.material', runtimeOwner: 'projection', targetCollection: 'sdui' },
      { id: 'discovery-engine.signal-trackable', sourceField: 'signals[]', target: 'core.trackable', runtimeOwner: 'events', targetCollection: 'trackables' },
    ],
    safety: {
      refuses: ['external analysis execution', 'automatic recommendation promotion'],
      reviewFocus: 'Verify that discovery suggestions are local proposals with confidence and review gates.',
    },
  }),
  protocol({
    id: 'journey-map',
    title: 'Journey Map',
    purpose: 'Represent stages, transitions, commitments, handoffs, and exit paths across an experience.',
    questions: [
      {
        id: 'journey-map.stages',
        prompt: 'What stages does a participant or operator move through?',
        inputFields: ['stages[].name', 'stages[].entryCriteria', 'stages[].exitCriteria'],
      },
      {
        id: 'journey-map.handoffs',
        prompt: 'Where do responsibilities, visibility, or ownership change?',
        inputFields: ['handoffs[].fromOwner', 'handoffs[].toOwner', 'handoffs[].consentBoundaryRef'],
      },
      {
        id: 'journey-map.exits',
        prompt: 'How can a participant pause, decline, complete, or leave the journey?',
        inputFields: ['exits[].stageRef', 'exits[].path', 'exits[].supportNeed'],
      },
    ],
    inputFields: [
      { id: 'stages[].name', type: 'string', required: true, description: 'Neutral journey stage name.' },
      { id: 'stages[].entryCriteria', type: 'text', required: true, description: 'Reviewed entry condition.' },
      { id: 'handoffs[].toOwner', type: 'enum', required: true, values: ['identity', 'catalog', 'commitments', 'providers', 'messaging', 'audit'], description: 'Owner proposed for review.' },
      { id: 'exits[].path', type: 'text', required: true, description: 'Pause, decline, complete, or leave path.' },
    ],
    outputHints: [
      { id: 'journey-map.timeline', text: 'Render a stage timeline with entry, exit, owner, consent, and trackable references.' },
      { id: 'journey-map.handoffs', text: 'Highlight handoffs as readiness checks, not as automatic routing.' },
    ],
    readinessRules: [
      { id: 'journey-map.entry-exit-present', severity: 'blocker', condition: 'Every stage has entry and exit criteria.', remediation: 'Add criteria or flag the stage blocked.', failClosed: true },
      { id: 'journey-map.exit-path-present', severity: 'blocker', condition: 'At least one non-punitive exit path is present.', remediation: 'Add pause, decline, complete, or leave path.', failClosed: true },
    ],
    claimMappings: [
      { id: 'journey-map-stage-depends-on-previous', claimPredicate: 'depends_on', sourceFields: ['stages[]'], target: 'atelier-claim@v1', evidence: 'stages[].sourceRef' },
      { id: 'journey-map-exit-supports-consent', claimPredicate: 'supports', sourceFields: ['exits[].path', 'handoffs[].consentBoundaryRef'], target: 'atelier-claim@v1', evidence: 'exits[].sourceRef' },
    ],
    exportMappings: [
      { id: 'journey-map.commitment-path', sourceField: 'stages[]', target: 'scheduling.commitment', runtimeOwner: 'commitments', targetCollection: 'commitmentPaths' },
      { id: 'journey-map.surface', sourceField: 'stages[].participantCopy', target: 'content.material', runtimeOwner: 'projection', targetCollection: 'surfaces' },
    ],
    safety: {
      refuses: ['automatic routing', 'exit path omission'],
      reviewFocus: 'Verify that stage transitions and handoffs fail closed when consent, owner, or exit criteria are incomplete.',
    },
  }),
  protocol({
    id: 'operations-readiness',
    title: 'Operations Readiness',
    purpose: 'Check staff prep, ownership, support boundaries, escalation paths, and manual runbooks before launch review.',
    questions: [
      {
        id: 'operations-readiness.owners',
        prompt: 'Who owns each operational responsibility?',
        inputFields: ['responsibilities[].name', 'responsibilities[].ownerRole', 'responsibilities[].backupRole'],
      },
      {
        id: 'operations-readiness.runbooks',
        prompt: 'Which runbooks or checklists are required before use?',
        inputFields: ['runbooks[].name', 'runbooks[].sourceRef', 'runbooks[].approvalStatus'],
      },
      {
        id: 'operations-readiness.escalation',
        prompt: 'What support or escalation path exists when something is blocked?',
        inputFields: ['escalations[].condition', 'escalations[].response', 'escalations[].ownerRole'],
      },
    ],
    inputFields: [
      { id: 'responsibilities[].ownerRole', type: 'string', required: true, description: 'Role responsible for the operational area.' },
      { id: 'responsibilities[].backupRole', type: 'string', required: true, description: 'Backup role for continuity.' },
      { id: 'runbooks[].approvalStatus', type: 'enum', required: true, values: ['approved', 'draft', 'blocked', 'needs-review'], description: 'Runbook review state.' },
      { id: 'escalations[].condition', type: 'text', required: true, description: 'Condition that triggers manual review or support.' },
    ],
    outputHints: [
      { id: 'operations-readiness.matrix', text: 'Render owners, backups, runbooks, escalation, and unresolved blockers in one matrix.' },
      { id: 'operations-readiness.launch-gates', text: 'Call out launch gates separately from nice-to-have cleanup.' },
    ],
    readinessRules: [
      { id: 'operations-readiness.owner-backup', severity: 'blocker', condition: 'Every responsibility has ownerRole and backupRole.', remediation: 'Assign owner and backup before launch review.', failClosed: true },
      { id: 'operations-readiness.runbooks-approved', severity: 'warning', condition: 'Required runbooks are approved or explicitly set needs-review.', remediation: 'Update approvalStatus and blockers.', failClosed: true },
    ],
    claimMappings: [
      { id: 'operations-readiness-runbook-supports-responsibility', claimPredicate: 'supports', sourceFields: ['runbooks[].name', 'responsibilities[].name'], target: 'atelier-claim@v1', evidence: 'runbooks[].sourceRef' },
      { id: 'operations-readiness-escalation-depends-on-owner', claimPredicate: 'depends_on', sourceFields: ['escalations[].condition', 'escalations[].ownerRole'], target: 'atelier-claim@v1', evidence: 'escalations[].sourceRef' },
    ],
    exportMappings: [
      { id: 'operations-readiness.staff-prep', sourceField: 'runbooks[]', target: 'core.artifact', runtimeOwner: 'providers', targetCollection: 'staffPrep' },
      { id: 'operations-readiness.escalation-trackable', sourceField: 'escalations[]', target: 'core.trackable', runtimeOwner: 'audit', targetCollection: 'trackables' },
    ],
    safety: {
      refuses: ['unowned operational responsibility', 'silent launch with blocked runbooks'],
      reviewFocus: 'Verify that support and escalation controls block launch when ownership or runbooks are incomplete.',
    },
  }),
  protocol({
    id: 'runtime-readiness',
    title: 'Runtime Readiness',
    purpose: 'Validate dry-run import posture, runtime owner boundaries, export mapping completeness, and fail-closed controls.',
    questions: [
      {
        id: 'runtime-readiness.owners',
        prompt: 'Which runtime owners are touched by the proposed packet?',
        inputFields: ['runtimeOwners[].name', 'runtimeOwners[].reason', 'runtimeOwners[].sourceRef'],
      },
      {
        id: 'runtime-readiness.import-plan',
        prompt: 'What would the dry-run import plan contain and what must remain blocked?',
        inputFields: ['importPlan.mode', 'importPlan.operations[]', 'importPlan.blockers[]'],
      },
      {
        id: 'runtime-readiness.controls',
        prompt: 'Which controls must refuse, block, or fail closed before promotion?',
        inputFields: ['controls[].name', 'controls[].expectedRefusal', 'controls[].evidenceRef'],
      },
    ],
    inputFields: [
      { id: 'runtimeOwners[].name', type: 'enum', required: true, values: ['identity', 'catalog', 'commitments', 'events', 'projection', 'consent', 'messaging', 'providers', 'audit'], description: 'Runtime owner proposed by the packet.' },
      { id: 'importPlan.mode', type: 'enum', required: true, values: ['dry-run'], description: 'Bundled pack only supports dry-run import planning.' },
      { id: 'importPlan.operations[]', type: 'array', required: true, description: 'Reviewable operations, not executable writes.' },
      { id: 'controls[].expectedRefusal', type: 'text', required: true, description: 'Boundary validation expectation for fail-closed behavior.' },
    ],
    outputHints: [
      { id: 'runtime-readiness.control-table', text: 'Render controls with expected refusal, observed evidence, owner, and remediation order.' },
      { id: 'runtime-readiness.blockers', text: 'Show blockers as the authoritative reason the packet is not importable.' },
    ],
    readinessRules: [
      { id: 'runtime-readiness.dry-run-only', severity: 'blocker', condition: 'importPlan.mode is dry-run and every operation is reviewable only.', remediation: 'Remove apply intent or runtime mutation fields.', failClosed: true },
      { id: 'runtime-readiness.controls-have-evidence', severity: 'blocker', condition: 'Every control has expectedRefusal and evidenceRef.', remediation: 'Add static inspection evidence or existing defensive test evidence.', failClosed: true },
    ],
    claimMappings: [
      { id: 'runtime-readiness-control-evidences-boundary', claimPredicate: 'evidences', sourceFields: ['controls[].name', 'controls[].expectedRefusal'], target: 'atelier-claim@v1', evidence: 'controls[].evidenceRef' },
      { id: 'runtime-readiness-operation-depends-on-owner', claimPredicate: 'depends_on', sourceFields: ['importPlan.operations[]', 'runtimeOwners[].name'], target: 'atelier-claim@v1', evidence: 'runtimeOwners[].sourceRef' },
    ],
    exportMappings: [
      { id: 'runtime-readiness.report', sourceField: 'controls[]', target: 'core.artifact', runtimeOwner: 'audit', targetCollection: 'staffPrep' },
      { id: 'runtime-readiness.import-trackable', sourceField: 'importPlan.blockers[]', target: 'core.trackable', runtimeOwner: 'audit', targetCollection: 'trackables' },
    ],
    safety: {
      refuses: ['apply mode', 'runtime mutation', 'unverified control pass'],
      reviewFocus: 'Prefer static inspection and existing defensive tests; verify that each control refuses, blocks, or fails closed.',
    },
  }),
  protocol({
    id: 'tenant-packet',
    title: 'Tenant Packet',
    purpose: 'Assemble tenant-level launch evidence, ownership, configuration, boundary decisions, and acceptance state.',
    questions: [
      {
        id: 'tenant-packet.scope',
        prompt: 'What tenant, workspace, or project scope does this packet cover?',
        inputFields: ['tenant.scopeName', 'tenant.scopeType', 'tenant.sourceRef'],
      },
      {
        id: 'tenant-packet.acceptance',
        prompt: 'Who accepts readiness and what evidence supports acceptance?',
        inputFields: ['acceptance.ownerRole', 'acceptance.evidenceRefs[]', 'acceptance.conditions[]'],
      },
      {
        id: 'tenant-packet.package',
        prompt: 'Which protocol outputs are included, blocked, or deferred?',
        inputFields: ['protocolStates[].protocolId', 'protocolStates[].state', 'protocolStates[].blockers[]'],
      },
    ],
    inputFields: [
      { id: 'tenant.scopeName', type: 'string', required: true, description: 'Neutral tenant or workspace scope label.' },
      { id: 'tenant.scopeType', type: 'enum', required: true, values: ['project', 'workspace', 'organization', 'sandbox'], description: 'Scope category.' },
      { id: 'acceptance.ownerRole', type: 'string', required: true, description: 'Role accountable for acceptance.' },
      { id: 'protocolStates[].state', type: 'enum', required: true, values: ['included', 'blocked', 'deferred', 'not-applicable'], description: 'Protocol inclusion state.' },
    ],
    outputHints: [
      { id: 'tenant-packet.cover', text: 'Render scope, acceptance owner, included protocols, blockers, and deferred work as a single cover sheet.' },
      { id: 'tenant-packet.delta', text: 'Show done, blocked, and deferred protocol states separately.' },
    ],
    readinessRules: [
      { id: 'tenant-packet.all-protocols-accounted', severity: 'blocker', condition: 'All bundled protocol ids have a protocolStates entry.', remediation: 'Add included, blocked, deferred, or not-applicable state for every protocol.', failClosed: true },
      { id: 'tenant-packet.acceptance-evidence', severity: 'blocker', condition: 'Acceptance has ownerRole, evidenceRefs, and conditions.', remediation: 'Add acceptance evidence or flag packet blocked.', failClosed: true },
    ],
    claimMappings: [
      { id: 'tenant-packet-protocol-belongs-to-scope', claimPredicate: 'belongs_to', sourceFields: ['protocolStates[].protocolId', 'tenant.scopeName'], target: 'atelier-claim@v1', evidence: 'tenant.sourceRef' },
      { id: 'tenant-packet-acceptance-evidences-readiness', claimPredicate: 'evidences', sourceFields: ['acceptance.ownerRole', 'acceptance.conditions[]'], target: 'atelier-claim@v1', evidence: 'acceptance.evidenceRefs[]' },
    ],
    exportMappings: [
      { id: 'tenant-packet.cover-artifact', sourceField: 'tenant', target: 'core.artifact', runtimeOwner: 'audit', targetCollection: 'staffPrep' },
      { id: 'tenant-packet.provision-review', sourceField: 'protocolStates[]', target: 'space.provision', runtimeOwner: 'providers', targetCollection: 'providerEgress' },
    ],
    safety: {
      refuses: ['unaccounted protocol state', 'acceptance without evidence'],
      reviewFocus: 'Verify that the tenant packet reports done, blocked, and deferred states without overstating readiness.',
    },
  }),
]

export const bundledMnstryReadinessPackV1 = {
  schema: MNSTRY_READINESS_PACK_SCHEMA,
  id: 'mnstry-readiness-pack',
  version: 'v1',
  title: 'MNSTRY Readiness Pack V1',
  description: 'Neutral bundled readiness protocol definitions for package-safe Atelier preparation.',
  packageSafe: true,
  protocolSlugs: READINESS_PROTOCOL_SLUGS,
  protocolIds: READINESS_PROTOCOL_IDS,
  safetyPosture: {
    ...baseSafetyPosture,
    packageSpecificContent: false,
    projectSpecificContent: false,
    reviewerGuidance: 'Prefer static inspection, existing defensive tests, concrete evidence, observed behavior, impact, confidence, and remediation order.',
  },
  protocols: bundledReadinessProtocols,
}

export function getBundledReadinessProtocol(id) {
  return bundledReadinessProtocols.find((protocolDefinition) => (
    protocolDefinition.id === id ||
    protocolDefinition.slug === id ||
    protocolDefinition.id === namespacedProtocolId(id)
  )) ?? null
}

export const bundledReadinessPack = bundledMnstryReadinessPackV1

export function protocolById(id) {
  return getBundledReadinessProtocol(id)
}
