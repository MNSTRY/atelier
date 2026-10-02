#!/usr/bin/env node
// Foundation's deterministic decision-practice consumer for this repository.
//
// For one real root pull request (exact base and head commits) it reads the
// recorded decisions in docs/integration-contract-decisions.md at the base, the
// repository files each decision links to, and how the pull request changed
// them. It runs the internal decision practice (src/judgment) once per cited
// decision with a deterministic assessment, and appends one measurement line.
//
// It calls no provider, appends to no Knowledge store, accepts or activates
// nothing, and writes only its measurement file. The Knowledge history it builds
// is reconstructed in memory from the base commit: the review and activation
// records stand for Foundation's adoption of this practice for its own
// repository, not an independent or human review. The assessment is a declared
// predicate, not a model, and its confidence is not calibrated.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decisionRequestDigest } from '../../src/decisions/contracts.mjs'
import { contentDigest, harnessRef } from '../../src/harnesses/contracts.mjs'
import { prepareDecisionPracticeContribution } from '../../src/judgment/practice.mjs'
import { evaluateDecisionPractice } from '../../src/judgment/practice-evaluation.mjs'
import { inspectKnowledge } from '../../src/knowledge/ledger.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CORPUS = 'docs/integration-contract-decisions.md'
export const MEASUREMENT_SCHEMA = 'atelier-practice-consumer-measurement@v0'
export const LABEL_SCHEMA = 'atelier-practice-consumer-label@v0'
export const LABELS = Object.freeze(['correct', 'missed', 'false-alarm', 'useful-abstention'])
const OWNER = 'atelier-root'
const BY = 'atelier-foundation'
const RUN = 'atelier-integration-decisions'
const TERM = 'decision-material'
const MAX_SOURCE_BYTES = 32768
const MAX_EXCERPT_LINES = 120
const CONTEXT_LINES = 3
const PROVIDER = Object.freeze({ id: 'foundation-deterministic', model: 'cited-source-predicate.v1' })

export const definition = () => JSON.parse(fs.readFileSync(path.join(HERE, 'definition.json'), 'utf8'))

// Git output must not depend on the caller's configuration or attributes: system
// and global config and attributes are ignored, configuration and attribute
// overrides from the environment are removed, diffs are forced to text and name
// their algorithm and options, and paths are passed from the repository top.
const GIT_ENV = (() => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1' }
  for (const key of ['GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_ATTR_SOURCE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key]
  return env
})()
const git = (repo, args, encoding = 'utf8') =>
  execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', '-c', `core.attributesFile=${os.devNull}`, ...args], { encoding, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
const DIFF_OPTIONS = ['--text', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers', '--no-indent-heuristic', '--inter-hunk-context=0']
const topPath = (file) => `:(top,literal)${file}`
const PR_RE = /^[1-9]\d*$/
const MIN_GIT = [2, 32]
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The object type at rev:file ('blob', 'tree', ...), or null when absent. */
function objectType(repo, rev, file) {
  try {
    return git(repo, ['cat-file', '-t', `${rev}:${file}`]).trim()
  } catch {
    return null
  }
}

function show(repo, rev, file) {
  try {
    return git(repo, ['show', `${rev}:${file}`], 'buffer')
  } catch {
    return null
  }
}

const utc = (repo, rev) => new Date(git(repo, ['show', '-s', '--format=%cI', rev]).trim()).toISOString().replace(/\.\d{3}Z$/, 'Z')
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item'
// Knowledge record ids are at most 64 characters including the longest suffix
// added here (-evaluation), so ids are a short slug plus a stable hash.
const shortId = (prefix, value) => `${prefix}-${slug(value).slice(0, 30).replace(/-+$/, '')}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8)}`
const textOf = (buffer) => (buffer && !buffer.includes(0) ? buffer.toString('utf8') : null)

/** Links in a markdown fragment that point at repository files, resolved from the corpus. */
export function citedPaths(fragment, corpus = CORPUS) {
  const out = []
  for (const match of fragment.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(corpus), target))
    if (!resolved.startsWith('..') && !out.includes(resolved)) out.push(resolved)
  }
  return out
}

/**
 * The recorded decisions: each `##` section's prose, and each row of a decision
 * table, with the line span it occupies and the files it links to.
 */
export function parseDecisions(markdown, corpus = CORPUS) {
  const lines = markdown.split('\n')
  const decisions = []
  let heading = null
  let prose = null
  const closeProse = () => {
    if (prose && prose.lines.some((line) => line.trim())) {
      const text = prose.lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim()
      if (text) decisions.push({ key: heading, title: heading, text, start: prose.start, end: prose.end, cited: citedPaths(text, corpus) })
    }
    prose = null
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('## ')) {
      closeProse()
      heading = line.slice(3).trim()
      continue
    }
    if (!heading) continue
    if (/^\s*<!--.*-->\s*$/.test(line)) {
      // A comment line separates blocks; it is never part of a decision.
      closeProse()
      continue
    }
    if (line.startsWith('|')) {
      closeProse()
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
      const separator = cells.every((cell) => /^:?-{3,}:?$/.test(cell))
      const header = index + 1 < lines.length && /^\|\s*:?-{3,}/.test(lines[index + 1])
      if (!separator && !header && cells[0]) {
        decisions.push({ key: `${heading}: ${cells[0]}`, title: `${heading}: ${cells[0]}`, text: line.trim(), start: index + 1, end: index + 1, cited: citedPaths(line, corpus) })
      }
      continue
    }
    // Prose runs from the first non-blank line after a heading or table up to
    // the next heading or table; blank lines inside it are kept.
    if (!prose && !line.trim()) continue
    if (!prose) prose = { start: index + 1, end: index + 1, lines: [] }
    prose.lines.push(line)
    if (line.trim()) prose.end = index + 1
  }
  closeProse()
  const seen = new Map()
  for (const decision of decisions) {
    const count = (seen.get(decision.key) ?? 0) + 1
    seen.set(decision.key, count)
    decision.id = shortId('d', count > 1 ? `${decision.key} ${count}` : decision.key)
    delete decision.key
  }
  return decisions
}

function record(kind, id, data, at) {
  return { schema: 'atelier-knowledge-record@v1', id, run: RUN, at, by: BY, kind, data }
}

function domainRecord(at) {
  return record('domain', RUN, {
    repository: 'atelier',
    purpose: 'Reconsider this repository\'s recorded integration decisions when the sources they cite change.',
    scope: 'Atelier root repository',
    owner: BY,
    audience: 'public',
    questions: [{ id: 'reconsider', question: 'Which recorded decisions need reconsideration after a source change?', acceptance: 'A person confirms or dismisses each draft against the exact change.' }],
    vocabulary: {
      types: [{ id: TERM, meaning: 'A recorded decision or a repository source it cites.' }],
      relations: [{ id: 'cites', meaning: 'A decision links to a repository source.', graphPredicate: 'supports' }],
    },
    identityRules: 'One contribution per recorded decision and per cited repository file at an exact commit.',
    sourcePolicy: 'Public repository files at exact commits; bytes are hashed and never edited.',
    acceptancePolicy: 'Foundation adopts this practice for its own repository; drafts stay pending until a person reviews them.',
  }, at)
}

function accepted(records, id, data, at) {
  const contribution = record('contribution', id, data, at)
  records.push(contribution)
  const evaluation = record('evaluation', `${id}-evaluation`, {
    contribution: harnessRef(contribution), judgment: 'uncertain',
    rationale: 'Recorded by Foundation for its own repository practice.',
    limitations: ['Deterministic predicate over file changes; no semantic or calibrated inference.'],
    scope: data.scope,
  }, at)
  records.push(evaluation)
  const review = record('review', `${id}-review`, { target: harnessRef(contribution), disposition: 'accepted', basis: 'Foundation adoption for its own repository (cfab92cd).', evaluations: [harnessRef(evaluation)] }, at)
  records.push(review)
  records.push(record('activation', `${id}-activation`, { reviews: [harnessRef(review)], purpose: 'Reconsider recorded decisions after source changes.', destination: 'atelier root repository', questions: ['reconsider'] }, at))
  return contribution
}

function captured(domain, { title, body, locator, category = 'source', basedOn = [] }) {
  return {
    domain: harnessRef(domain), category, term: TERM, title, body, audience: 'public', scope: domain.data.scope,
    origin: { method: 'captured', locator, contentDigest: contentDigest(body), rightsBasis: 'Public Apache-2.0 repository source.' }, basedOn,
  }
}

/** The in-memory Knowledge history for a base commit. */
export function buildHistory({ repo, base, decisions }) {
  const at = utc(repo, base)
  const records = [domainRecord(at)]
  const domain = records[0]
  const sources = new Map()
  const unusable = new Map()
  for (const decision of decisions) {
    for (const file of decision.cited) {
      if (sources.has(file)) continue
      // A cited path must be a file at the base; a directory would never register a change.
      const type = objectType(repo, base, file)
      if (type !== 'blob') {
        sources.set(file, null)
        unusable.set(file, type === null ? 'cited-path-missing' : 'cited-path-not-a-file')
        continue
      }
      const body = textOf(show(repo, base, file))
      if (body === null || !body.trim() || Buffer.byteLength(body) > MAX_SOURCE_BYTES) {
        sources.set(file, null)
        unusable.set(file, 'cited-source-unreadable-or-over-bounds')
        continue
      }
      sources.set(file, accepted(records, shortId('s', file), captured(domain, { title: file, body, locator: `${OWNER}:${file}@${base}` }), at))
    }
  }
  const decisionRecords = new Map()
  for (const decision of decisions) {
    const basedOn = decision.cited.map((file) => sources.get(file)).filter(Boolean)
      .map((source) => ({ contribution: harnessRef(source), quote: source.data.body.split('\n').find((line) => line.trim()) }))
    decisionRecords.set(decision.id, accepted(records, decision.id, captured(domain, {
      title: decision.title, body: decision.text, locator: `${OWNER}:${CORPUS}#${decision.id}`, category: 'decision-rationale', basedOn,
    }), at))
  }
  inspectKnowledge(records)
  const prepared = prepareDecisionPracticeContribution({ records, definition: definition(), title: 'Decision source reconsideration', term: TERM })
  if (prepared.status !== 'prepared') throw new Error(`practice definition was not prepared: ${prepared.reason}`)
  const practice = accepted(records, 'decision-practice', prepared.data, at)
  return { records, sources, unusable, decisionRecords, practice, at }
}

function hunks(repo, base, head, file) {
  const diff = git(repo, ['diff', ...DIFF_OPTIONS, '-U0', base, head, '--', topPath(file)])
  let removed = 0
  let added = 0
  const ranges = []
  let inBody = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inBody = false
      continue
    }
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (header) {
      inBody = true
      const start = Number(header[1])
      const count = header[2] === undefined ? 1 : Number(header[2])
      ranges.push([Math.max(1, start - CONTEXT_LINES), start + Math.max(count, 1) - 1 + CONTEXT_LINES])
      continue
    }
    // Count the actual changed lines, never hunk-header totals.
    if (!inBody) continue
    if (line.startsWith('-')) removed += 1
    else if (line.startsWith('+')) added += 1
  }
  return { binary: false, removed, added, ranges }
}

/** The deterministic assessment the rubric declares. */
export function assess(change, { removedAtHead = false } = {}) {
  if (change.binary || removedAtHead || change.oversize) return { status: 'abstained', reason: 'insufficient-evidence' }
  if (change.removed > 0) return { status: 'assessed', choice: 'affected' }
  if (change.added > 0) return { status: 'assessed', choice: 'unaffected' }
  return { status: 'assessed', choice: 'unclear' }
}

function excerpt(text, ranges) {
  const lines = text.split('\n')
  if (!ranges.length) return { start: 1, end: Math.min(lines.length, MAX_EXCERPT_LINES) }
  const start = Math.max(1, Math.min(...ranges.map(([a]) => a)))
  const end = Math.min(lines.length, Math.max(...ranges.map(([, b]) => b)))
  return { start, end: Math.min(end, start + MAX_EXCERPT_LINES - 1), oversize: end - start + 1 > MAX_EXCERPT_LINES }
}

function evidenceItem({ role, requestId, file, revision, text, start, end }) {
  return {
    role, requestId, sourceRef: `${OWNER}:${file}`, text,
    reference: { owner: OWNER, objectId: file, revision, selector: { type: 'text-lines', version: '1', value: `lines:${start}-${end}` }, contentDigest: contentDigest(text) },
  }
}

function resultFor(request, assessment) {
  const common = {
    schema: 'atelier-decision-result@v1', contractVersion: '1.0.0', requestId: request.id, requestDigest: decisionRequestDigest(request),
    task: request.task, rubricVersion: request.rubricVersion, scope: request.scope, provider: { ...PROVIDER },
    authority: 'proposal-only', mode: 'shadow', usage: null, elapsedMs: 0,
  }
  if (assessment.status === 'abstained') return { ...common, status: 'abstained', answers: {}, reason: assessment.reason }
  const criteria = Object.keys(request.questions.impact.criteria)
  const probabilities = Object.fromEntries(criteria.map((key) => [key, key === assessment.choice ? 1 : 0]))
  // A declared predicate, not a model: confidence is a fixed, uncalibrated value.
  return { ...common, status: 'assessed', answers: { impact: { type: 'choice', choice: assessment.choice, probabilities, confidence: 0.5 } } }
}

/** Measure one pull request. Returns the measurement; writes nothing. */
export function gitVersion() {
  const text = execFileSync('git', ['--version'], { encoding: 'utf8', env: GIT_ENV }).trim()
  const [major, minor] = (text.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  if (!(major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]))) throw new Error(`git ${MIN_GIT.join('.')} or later is required (found ${text})`)
  return text
}

export function measure({ repo, pr, base, head, mode = 'live' }) {
  if (!SHA_RE.test(String(base)) || !SHA_RE.test(String(head))) throw new Error('base and head must be full commit ids')
  if (!PR_RE.test(String(pr))) throw new Error('pr must be a positive integer')
  pr = Number(pr)
  if (!['live', 'retrospective'].includes(mode)) throw new Error('mode must be live or retrospective')
  const gitText = gitVersion()
  // Every path below is relative to the repository top, whatever directory was given.
  repo = git(repo, ['rev-parse', '--show-toplevel']).trim()
  // A pull request is measured from where it branched: the merge base of its base and head.
  const requested = base
  base = git(repo, ['merge-base', base, head]).trim()
  const corpusText = textOf(show(repo, base, CORPUS))
  if (corpusText === null) throw new Error(`${CORPUS} is not readable at ${base}`)
  const decisions = parseDecisions(corpusText)
  const history = buildHistory({ repo, base, decisions })
  const definitionRef = harnessRef(history.practice)
  const changed = new Set(git(repo, ['diff', '--no-renames', '--name-only', '-z', base, head, '--']).split('\0').filter(Boolean))
  const at = utc(repo, head)
  const rubric = definition().rubric
  const results = []
  for (const decision of decisions) {
    const target = history.decisionRecords.get(decision.id)
    const entry = { id: decision.id, title: decision.title, cited: decision.cited, changedCited: [], outcomes: [] }
    results.push(entry)
    for (const file of decision.cited) {
      const source = history.sources.get(file)
      if (!source) {
        entry.outcomes.push({ file, status: 'not-evaluated', reason: history.unusable.get(file) })
        continue
      }
      const didChange = changed.has(file)
      if (didChange) entry.changedCited.push(file)
      const headBuffer = show(repo, head, file)
      const headText = textOf(headBuffer)
      // Binary is decided from the contents at both commits, never from attributes.
      const change = didChange ? { ...hunks(repo, base, head, file), binary: headBuffer !== null && headText === null } : { binary: false, removed: 0, added: 0, ranges: [] }
      if (change.binary) change.ranges = []
      const region = excerpt(headText ?? source.data.body, change.ranges)
      // An unchanged source is not assessed. The evaluator validates the result,
      // a fixed placeholder here, and then stops on the false prerequisite.
      const assessment = didChange
        ? assess({ ...change, oversize: region.oversize }, { removedAtHead: headBuffer === null })
        : { status: 'abstained', reason: 'insufficient-evidence', placeholder: true }
      const sourceText = headText === null
        ? `(${file} is ${headBuffer === null ? 'removed' : 'not text'} at ${head})`
        : headText.split('\n').slice(region.start - 1, region.end).join('\n')
      const evidence = [
        evidenceItem({ role: 'source', requestId: 'e1', file, revision: head, text: sourceText, start: headText === null ? 1 : region.start, end: headText === null ? 1 : region.end }),
        evidenceItem({ role: 'decision', requestId: 'e2', file: CORPUS, revision: base, text: decision.text, start: decision.start, end: decision.end }),
      ]
      const request = { ...structuredClone(rubric), id: `pr${pr}-${decision.id}-${shortId('f', file)}`,
        state: evidence.map((item) => `${item.requestId}: ${item.text}`).join('\n'), evidence: evidence.map(({ requestId, sourceRef }) => ({ id: requestId, sourceRef })) }
      const instance = {
        id: shortId(`pr${pr}`, `${decision.id} ${file}`),
        evidence,
        snapshots: evidence.map((item) => ({ schema: 'atelier-evidence-snapshot@v1', reference: structuredClone(item.reference), currency: 'current', dependencies: [], validUntil: null })),
        at,
        prerequisites: [{ id: 'cited-source-changed', value: didChange }],
        spent: { stages: 0, evidence: 0, assessments: 0, proposals: 0 },
        request,
        result: resultFor(request, assessment),
        proposal: { type: 'reconsideration', target: harnessRef(target), term: TERM, title: `Reconsider "${decision.title}" after ${file} changed in pull request #${pr}` },
      }
      const outcome = evaluateDecisionPractice({ records: history.records, definitionRef, instance })
      // What the Knowledge harness itself marks once the changed source is recorded.
      let harnessReconsider = null
      if (didChange && headText !== null && Buffer.byteLength(headText) <= MAX_SOURCE_BYTES && headText !== source.data.body) {
        const revised = { ...source, id: shortId('r', `${file}@${head}`), data: { ...source.data, body: headText,
          origin: { ...source.data.origin, locator: `${OWNER}:${file}@${head}`, contentDigest: contentDigest(headText) }, supersedes: harnessRef(source), revisionReason: `Changed in pull request #${pr}.` } }
        harnessReconsider = inspectKnowledge([...history.records, revised]).reconsider.some((item) => item.id === decision.id)
      }
      entry.outcomes.push({
        file, prerequisite: didChange, change: { removed: change.removed, added: change.added, binary: change.binary },
        assessment: assessment.placeholder ? { status: 'not-assessed', reason: 'prerequisite-false' }
          : assessment.status === 'abstained' ? { status: 'abstained', reason: assessment.reason } : { status: 'assessed', choice: assessment.choice },
        status: outcome.status, reason: outcome.reason,
        draftDigest: outcome.proposal ? contentDigest(outcome.proposal.data.body) : null,
        harnessReconsider,
      })
    }
  }
  return {
    schema: MEASUREMENT_SCHEMA, pr: Number(pr), base: requested, mergeBase: base, head, mode, measuredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    definitionRef, definitionDigest: contentDigest(fs.readFileSync(path.join(HERE, 'definition.json'), 'utf8')),
    toolDigest: contentDigest(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')), git: gitText, corpusDigest: contentDigest(corpusText), provider: { ...PROVIDER }, decisions: results,
    summary: {
      decisions: results.length,
      cited: results.filter((item) => item.cited.length).length,
      changedCited: results.filter((item) => item.changedCited.length).length,
      drafts: results.flatMap((item) => item.outcomes).filter((item) => item.status === 'proceed').length,
      escalations: results.flatMap((item) => item.outcomes).filter((item) => item.status === 'escalate').length,
      refusals: results.flatMap((item) => item.outcomes).filter((item) => item.status === 'refuse').length,
    },
  }
}

/**
 * A reviewer's label for one measured decision. `by` names who labelled it;
 * `reviewMinutes` is the reviewer's effort, including confirming a correct outcome.
 */
export function label({ pr, decision, file, measurement, value, reviewMinutes, by, note = '' }) {
  if (!PR_RE.test(String(pr))) throw new Error('pr must be a positive integer')
  if (typeof decision !== 'string' || !/^d-[a-z0-9-]+-[0-9a-f]{8}$/.test(decision)) throw new Error('decision must be a measured decision id')
  if (typeof file !== 'string' || !file) throw new Error('file must name the cited file the outcome is about')
  if (typeof measurement !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(measurement)) throw new Error('measurement must be the digest of the measured line')
  if (!LABELS.includes(value)) throw new Error(`label must be one of ${LABELS.join(', ')}`)
  if (!Number.isFinite(reviewMinutes) || reviewMinutes < 0) throw new Error('review minutes must be a nonnegative number')
  if (typeof by !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(by)) throw new Error('by must name who labelled the outcome')
  return { schema: LABEL_SCHEMA, pr: Number(pr), decision, file, measurement, label: value, reviewMinutes, by, note, at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

function appendLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`)
}

function argsOf(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) out[arg.slice(2)] = argv[index + 1]?.startsWith('--') === false ? argv[++index] : true
    else out._.push(arg)
  }
  return out
}

const USAGE = `Usage:
  node scripts/practice-consumer/reconsider.mjs measure --pr N --base SHA --head SHA [--mode live|retrospective] [--repo DIR] [--out FILE | --print]
  node scripts/practice-consumer/reconsider.mjs label --pr N --decision ID --file PATH --label ${LABELS.join('|')} --minutes M --by NAME [--note TEXT] [--out FILE]`

export function main(argv = process.argv.slice(2)) {
  const args = argsOf(argv)
  const out = typeof args.out === 'string' ? args.out : path.join(HERE, 'measurements.jsonl')
  const sha = (value) => typeof value === 'string' && SHA_RE.test(value)
  if (args._[0] === 'measure') {
    if (!PR_RE.test(String(args.pr)) || !sha(args.base) || !sha(args.head)) throw new Error(USAGE)
    if (args.mode !== undefined && !['live', 'retrospective'].includes(args.mode)) throw new Error(USAGE)
    const value = measure({ repo: typeof args.repo === 'string' ? args.repo : process.cwd(), pr: args.pr, base: args.base, head: args.head, mode: args.mode ?? 'live' })
    if (args.print) console.log(JSON.stringify(value, null, 2))
    else {
      appendLine(out, value)
      console.log(JSON.stringify(value.summary))
    }
    return
  }
  if (args._[0] === 'label') {
    if (typeof args.minutes !== 'string' || !/^\d+(?:\.\d+)?$/.test(args.minutes)) throw new Error(USAGE)
    // A label refers to the latest measurement of this pull request in the file,
    // and to one outcome in it: the decision and the cited file.
    const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean) : []
    const measured = lines.filter((line) => JSON.parse(line).schema === MEASUREMENT_SCHEMA && String(JSON.parse(line).pr) === String(args.pr)).at(-1)
    if (!measured) throw new Error('no measurement of this pull request to label')
    const outcome = JSON.parse(measured).decisions.find((item) => item.id === args.decision)?.outcomes.find((item) => item.file === args.file)
    if (!outcome) throw new Error('the measurement has no outcome for this decision and file')
    appendLine(out, label({ pr: args.pr, decision: args.decision, file: args.file, measurement: contentDigest(measured), value: args.label, reviewMinutes: Number(args.minutes), by: args.by, note: typeof args.note === 'string' ? args.note : '' }))
    return
  }
  throw new Error(USAGE)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
}
