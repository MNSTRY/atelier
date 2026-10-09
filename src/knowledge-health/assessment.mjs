import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Consumer projection only. The injected Atelier checker owns every graph rule.
// No I/O, accepted knowledge, authoring write, model, or health score lives here.
export const PROJECTION_VERSION = 'kh-required-direction-projection/r1'
export const assessmentDigest = bytes => createHash('sha256').update(bytes).digest('hex')
const clone = value => structuredClone(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
const digestObject = value => assessmentDigest(JSON.stringify(canonical(value)))
const requireInput = (condition, message) => { if (!condition) throw new TypeError(message) }
const safePath = value => text(value) && !value.startsWith('/') && !value.includes('\\')
  && value.split('/').every(part => part && part !== '.' && part !== '..')
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
function readSetPins(readSet) {
  requireInput(plain(readSet) && plain(readSet.scope) && sha(readSet.scope.projectSha256)
    && sha(readSet.scope.repoAccessSha256) && Array.isArray(readSet.entries), 'Exact project/access/read-set pins required')
  const keys = new Set()
  const entries = readSet.entries.map(entry => {
    requireInput(plain(entry) && text(entry.repo) && safePath(entry.path) && sha(entry.sha256)
      && text(entry.revision), 'Exact source read-set entry required')
    const key = JSON.stringify([entry.repo, entry.path])
    requireInput(!keys.has(key), 'Duplicate read-set source'); keys.add(key)
    return { repo: entry.repo, path: entry.path, sha256: entry.sha256, revision: entry.revision }
  }).sort((a, b) => {
    const left = JSON.stringify([a.repo, a.path]), right = JSON.stringify([b.repo, b.path])
    return left < right ? -1 : left > right ? 1 : 0
  })
  return { scope: clone(readSet.scope), entries }
}

/** Inject the current owner-qualified implementations and their source identity. */
export function createAssessmentProjector({ inspectKnowledgePlan, splitFrontmatter, parseYamlSubset, check }) {
  requireInput([inspectKnowledgePlan, splitFrontmatter, parseYamlSubset].every(f => typeof f === 'function')
    && plain(check) && text(check.id) && sha(check.sourceSha256)
    && ['version', 'sourceTree', 'sourceBlob', 'schemaBlob', 'graphBlob'].every(k => /^[a-f0-9]{40}$/.test(check[k] ?? '')),
  'Qualified checker/parser commit/tree/blob identity required')
  const checker = clone(check)
  const metadata = bytes => {
    const split = splitFrontmatter(decode(bytes))
    requireInput(split !== null, 'A typed Markdown frontmatter declaration is required')
    return parseYamlSubset(split.yaml)
  }

  return function assessRequiredDirection({ planBytes, planSha256, graph, context = null,
    evaluation = null, readSet, relationId, questionId, binding = null, currentSourceBytes = null }) {
    requireInput(planBytes instanceof Uint8Array && sha(planSha256)
      && assessmentDigest(planBytes) === planSha256, 'Current raw plan bytes/hash required')
    const plan = JSON.parse(decode(planBytes))
    requireInput(plain(graph) && typeof graph.ok === 'boolean' && Array.isArray(graph.nodes)
      && Array.isArray(graph.edges) && Array.isArray(graph.errors), 'Canonical graph output required')
    const pins = readSetPins(readSet)
    // Original checker output is never rewritten or reconstructed from warnings.
    const report = inspectKnowledgePlan(plan, graph)
    const original = clone({ report, diagnostics: graph.diagnostics ?? [], graphErrors: graph.errors, context, evaluation })
    requireInput(plain(report) && typeof report.ok === 'boolean' && Array.isArray(report.warnings)
      && Array.isArray(report.errors), 'Unsupported checker output')
    const evidence = { check: clone(checker), planSha256, readSet: pins, readSetSha256: digestObject(pins),
      graphSha256: digestObject(graph), reportSha256: digestObject(report) }
    const result = { projectionVersion: PROJECTION_VERSION, status: 'uncertain',
      structure: report.status ?? 'invalid', coverage: 'unknown', currency: 'unverified',
      semanticQualification: 'not-assessed', semanticSupport: 'unknown', grantsAuthority: false,
      evidence, original, findings: [], refusal: null }
    const refuse = (code, reason) => {
      result.status = 'uncertain'; result.refusal = { code, reason }; return result
    }
    if (!graph.ok || !report.ok) { result.status = 'invalid'; return result }
    requireInput(Array.isArray(report.relations), 'Unsupported relation-check output')
    const relation = plan.relations.find(r => r.id === relationId)
    const question = plan.questions.find(q => q.id === questionId)
    requireInput(relation && question && question.relations.includes(relationId), 'A task-required declared relation must be selected')
    const checked = report.relations.find(r => r.id === relationId)
    requireInput(checked && Number.isSafeInteger(checked.matchingEdges), 'Selected relation has no checker result')
    const warning = `relation ${relationId} has no declared edge in the required direction`
    requireInput(report.warnings.includes(warning) === (checked.matchingEdges === 0), 'Checker relation/warning mismatch')
    evidence.relationId = relationId; evidence.questionId = questionId

    if (context !== null) {
      requireInput(context.schema === 'atelier-knowledge-context@v1' && plain(context.coverage)
        && Array.isArray(context.omissions) && Array.isArray(context.sources), 'Existing context output required')
      if (context.planSha256 !== planSha256) return refuse('context-plan-stale', 'Context belongs to a different plan')
      if (context.question !== question.question) return refuse('context-question-mismatch', 'Context belongs to a different task question')
      for (const source of context.sources) {
        const pin = pins.entries.find(e => e.repo === source.repo && e.path === source.path)
        if (!pin || pin.sha256 !== source.sha256) return refuse('context-read-set-mismatch', 'Selected context source does not match the read-set')
      }
      result.coverage = context.coverage.omitted > 0 || context.coverage.omissionsUnlisted > 0 ? 'partial' : 'complete'
      if (context.omissions.some(o => o.reason === 'changed-since-census')) {
        result.currency = 'changed'
        return refuse('source-changed-since-census', 'Current context omitted changed source bytes')
      }
      evidence.contextCensusSha256 = context.censusSha256
      evidence.contextSha256 = digestObject(context)
    }
    if (evaluation !== null) {
      requireInput(evaluation.schema === 'atelier-knowledge-evaluation@v1' && Array.isArray(evaluation.cases), 'Existing evaluation output required')
      if (evaluation.planSha256 !== planSha256) return refuse('evaluation-plan-stale', 'Evaluation belongs to a different plan')
      const evaluated = evaluation.cases.find(c => c.id === questionId)?.runs?.graph
      requireInput(evaluated && Array.isArray(evaluated.stale), 'Selected question has no graph evaluation result')
      if (evaluated.stale.length) {
        result.currency = 'changed'
        return refuse('expected-evidence-stale', 'Evaluation retains stale expected source pins')
      }
      evidence.evaluationSha256 = digestObject(evaluation)
    }

    // Bind even a cleared finding so a stale or missing target never masquerades
    // as verified source correction. Refusals expose no actionable edit target.
    if (!binding || !(currentSourceBytes instanceof Uint8Array)) return refuse('binding-missing', 'Exact source/field binding and current bytes are required')
    const source = binding.source, field = binding.field, authoring = binding.authoring
    if (!plain(source) || !plain(field) || !plain(authoring)) return refuse('binding-missing', 'Source, declaration and existing authoring identity are required')
    const pin = pins.entries.find(e => e.repo === source.repo && e.path === source.path)
    if (!pin || !sha(source.sha256) || !text(source.revision) || source.sha256 !== pin.sha256
      || source.revision !== pin.revision || assessmentDigest(currentSourceBytes) !== source.sha256) {
      result.currency = 'changed'; return refuse('binding-stale', 'Source bytes/revision differ from the bound read-set')
    }
    const node = graph.nodes.find(n => n.id === source.id && n.repo === source.repo && n.path === source.path)
    const from = plan.concepts.find(c => c.id === relation.from)
    if (!node || !node.tags.includes(from.tag)) return refuse('binding-source-mismatch', 'Target is not a source in the selected relation role')
    if (field.format !== 'markdown-inline-array' || field.id !== `kg.relations.${relation.predicate}`
      || field.pointer !== `/kg/relations/${relation.predicate}` || !Number.isSafeInteger(field.start)
      || !Number.isSafeInteger(field.end) || field.start < 0 || field.end <= field.start
      || field.end > currentSourceBytes.length || !text(field.quote) || !/^\[[^\r\n]*\]$/.test(field.quote)) {
      return refuse('unsupported-declaration-profile', 'Only exact inline typed relation-array values are supported')
    }
    if (!['storeId', 'sourceId', 'artifactId', 'fieldId', 'actorBindingId'].every(k => text(authoring[k]))
      || authoring.sourceId !== source.id || authoring.fieldId !== field.id) return refuse('authoring-binding-mismatch', 'Existing opaque authoring binding must match this source and field')
    try {
      const bytes = Buffer.from(currentSourceBytes)
      // Fatal decoding of each segment refuses a split UTF-8 character.
      decode(bytes.subarray(0, field.start)); decode(bytes.subarray(field.end))
      if (decode(bytes.subarray(field.start, field.end)) !== field.quote) return refuse('binding-quote-mismatch', 'Declaration quote differs from exact source bytes')
      const parsed = metadata(bytes), declared = parsed.kg?.relations?.[relation.predicate]
      if (parsed.kg?.id !== node.id || !Array.isArray(declared) || !isDeepStrictEqual(declared, node.relations?.[relation.predicate])) {
        return refuse('binding-declaration-mismatch', 'Typed declaration differs from canonical graph metadata')
      }
      // Prove the byte range is THIS typed value, using the existing parser.
      // A matching quote in prose, another field or an overshadowed key fails.
      const sentinel = `kh-locator-probe-${assessmentDigest(bytes).slice(0, 16)}`
      const probe = Buffer.concat([bytes.subarray(0, field.start), Buffer.from(JSON.stringify([sentinel])), bytes.subarray(field.end)])
      const expected = clone(parsed); expected.kg.relations[relation.predicate] = [sentinel]
      if (!isDeepStrictEqual(metadata(probe), expected)) return refuse('binding-not-declaration', 'Byte range does not uniquely address the selected typed declaration')
    } catch { return refuse('binding-decode-or-profile', 'Source or declaration does not fit the supported exact-byte profile') }

    result.currency = 'current'
    evidence.bindingSha256 = digestObject(binding)
    evidence.comparisonSha256 = digestObject({ ...evidence, binding })
    result.status = result.coverage === 'partial' ? 'partial'
      : result.coverage === 'unknown' ? 'uncertain' : report.status
    if (checked.matchingEdges === 0) result.findings.push({ referenceKey: `required-direction:${relationId}`,
      originalMessage: warning, check: clone(checker), relation: clone(relation), questionId,
      source: clone(source), declaration: clone(field), authoringBinding: clone(authoring),
      actionable: result.coverage === 'complete', uncertainty: ['semantic-support-unassessed',
        ...(result.coverage !== 'complete' ? ['coverage-incomplete'] : [])],
      action: { kind: 'review-source-declaration', sourceMutation: false, canonicalAcceptance: false } })
    return result
  }
}
