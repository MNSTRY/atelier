import fs from 'node:fs'
const id = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }
const text = { type: 'string', minLength: 1, maxLength: 8192 }
const hash = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }
const git = { type: 'string', pattern: '^[0-9a-f]{40}$' }
const enumeration = values => ({ enum: values.split(' ') })
const array = (items, minItems = 0) => ({ type: 'array', items, minItems, maxItems: 64 })
const ref = name => ({ $ref: `#/$defs/${name}` })
const object = (properties, optional = []) => ({ type: 'object', additionalProperties: false,
  properties: { ...properties, ext: { type: 'object', maxProperties: 0 } }, required: Object.keys(properties).filter(k => !optional.includes(k)) })
const version = { type: 'string', pattern: '^1\\.[0-9]+\\.[0-9]+$' }
const document = properties => object({ ...properties, contractVersion: version }, ['contractVersion'])
const audience = enumeration('public team operator staff private sensitive')
const profile = enumeration('inquiry knowledge build')
const binding = object({ package: text, releaseDigest: hash, generation: hash, binding: text, bindingDigest: hash, host: enumeration('codex-repo-v1 claude-repo-v1'), session: id })
const pointer = object({ id, digest: hash })
const handoff = document({ schema: { const: 'atelier-harness-handoff@v1' },
  source: object({ repository: id, repositoryBinding: enumeration('establishment-record caller-declared'), profile, run: id, historyDigest: hash, subject: pointer }),
  target: object({ repository: id, profile, purpose: text }), audience,
  payload: { type: 'string', minLength: 1, maxLength: 1048576 }, payloadDigest: hash,
  assurance: { const: 'caller-reported' }, authority: { const: 'none' } })
const common = { pointer, binding, handoff }
const record = (name, kind, data) => document({ schema: { const: `atelier-${name}-record@v1` }, id, run: id, at: { type: 'string', format: 'date-time' }, by: text, kind: { const: kind }, data })
const domainData = {
  repository: id, purpose: text, scope: text, owner: text, audience,
  questions: array(object({ id, question: text, acceptance: text }), 1),
  vocabulary: object({ types: array(object({ id, meaning: text }), 1), relations: array(object({ id, meaning: text, graphPredicate: enumeration('related supports supersedes implements depends_on evidences contradicts belongs_to') })) }),
  identityRules: text, sourcePolicy: text, acceptancePolicy: text, binding: ref('binding'),
}
const knowledge = {
  domain: object(domainData, ['binding']),
  'domain-revision': object({ ...domainData, supersedes: ref('pointer'), migration: text }, ['binding']),
  contribution: object({ domain: ref('pointer'), category: enumeration('source observation concept claim model interpretation decision-rationale'), term: id,
    title: text, body: { type: 'string', minLength: 1, maxLength: 262144 }, audience, scope: text,
    origin: { oneOf: [
      object({ method: { const: 'authored' }, reason: text }),
      object({ method: { const: 'captured' }, locator: text, contentDigest: hash, rightsBasis: text }),
      object({ method: { const: 'extracted' }, locator: text, blobDigest: hash, attemptId: id, attemptDigest: hash, outputDigest: hash, completionDigest: hash,
        extractor: object({ id, version: text, configurationDigest: hash }) }),
      object({ method: { const: 'exchange' }, handoff: ref('handoff') }),
    ] },
    basedOn: array(object({ contribution: ref('pointer'), quote: { type: 'string', minLength: 1, maxLength: 8192 } })),
    supersedes: ref('pointer'), revisionReason: text,
  }, ['supersedes', 'revisionReason']),
  evaluation: object({ contribution: ref('pointer'), judgment: enumeration('supported contested uncertain unsupported'), rationale: text, limitations: array(text), scope: text }),
  relation: object({ domain: ref('pointer'), subject: ref('pointer'), predicate: id, object: ref('pointer'), rationale: text }),
  review: object({ target: ref('pointer'), disposition: enumeration('accepted deferred rejected'), basis: text, evaluations: array(ref('pointer')) }),
  withdrawal: object({ target: ref('pointer'), reason: text }),
  activation: object({ reviews: array(ref('pointer'), 1), purpose: text, destination: text, questions: array(id, 1) }),
}
const build = {
  objective: object({ repository: id, owner: text, purpose: text, scope: text, audience, acceptance: array(text, 1),
    gates: array(object({ id, kind: enumeration('source review ci runtime integration delivery'), required: { type: 'boolean' } }), 1),
    dependencies: array(object({ id, need: text, handoff: ref('handoff') })),
    allowedEffects: array(enumeration('read-workspace write-workspace execute-local network publish deploy')),
    maxAttempts: { type: 'integer', minimum: 1, maximum: 64 }, stoppingRule: text, binding: ref('binding'),
  }, ['binding']),
  candidate: object({ objective: ref('pointer'), repository: id, commit: git, tree: git, artifactDigest: hash,
    writer: object({ owner: text, reservation: id, evidenceDigest: hash }), supersedes: ref('pointer'),
  }, ['supersedes']),
  attempt: object({ candidate: ref('pointer'), operation: id, requestDigest: hash, effects: array(enumeration('read-workspace write-workspace execute-local network publish deploy')) }),
  progress: object({ attempt: ref('pointer'), state: enumeration('running uncertain completed failed cancelled'), evidenceDigest: hash, reason: text }),
  gate: object({ candidate: ref('pointer'), gate: id, status: enumeration('passed failed unavailable'), evidence: object({ digest: hash, locator: text, verifier: text }), attempt: ref('pointer') }, ['attempt']),
  decision: object({ candidate: ref('pointer'), disposition: enumeration('accepted changes-requested'), reason: text, gates: array(ref('pointer')) }),
  delivery: object({ decision: ref('pointer'), recipient: text, evidenceDigest: hash, acceptance: text }),
}
for (const [name, shapes] of Object.entries({ knowledge, build, harness: null })) {
  const defs = { ...common }
  if (shapes) {
    for (const [kind, data] of Object.entries(shapes)) defs[kind] = record(name, kind, data)
    defs.record = { oneOf: Object.keys(shapes).map(ref) }
    defs.ledger = document({ schema: { const: 'atelier-harness-ledger@v1' }, profile: { const: name }, records: { type: 'array', items: ref('record'), minItems: 1, maxItems: 256 }, head: hash })
  }
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `https://mnstry.ai/schemas/atelier/atelier-${name}.v1.schema.json`, title: `Atelier ${name} contract`, $comment: 'contract revision 1.0.0 (initial local harness contract)', oneOf: (shapes ? Object.keys(shapes) : ['handoff']).map(ref), $defs: defs }
  fs.writeFileSync(new URL(`../contracts/atelier-${name}.v1.schema.json`, import.meta.url), JSON.stringify(schema, null, 2) + '\n')
}
