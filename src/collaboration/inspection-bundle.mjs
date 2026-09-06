import fs from 'node:fs'
import path from 'node:path'
import {
  loadBoundRun,
  hashEvidence,
  validBoundRun,
} from '../readiness-protocols/evidence.mjs'
import { validReviewArtifact } from './review-contracts.mjs'
import { createReviewStore, validContribution } from './review-store.mjs'
import {
  compileDisclosurePatterns,
  scanDisclosureText,
} from '../disclosure/content-scan.mjs'
import { openRegularFileNoFollow } from '../project/private-state.mjs'

function prohibitedKeys(value, depth = 0) {
  if (
    typeof value === 'string' &&
    (/^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/.test(value) ||
      /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value))
  )
    throw new Error(
      'machine path or credential-bearing URL in selected content',
    )
  if (depth > 32) throw new Error('bundle nesting exceeds bounds')
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (
        /nonce|session|grant|credential|password|token|secret|private.?key|authorization/i.test(
          key,
        )
      )
        throw new Error('nontransferable field in selected content')
      prohibitedKeys(child, depth + 1)
    }
}
export function prepareInspectionBundle(
  project,
  runIds,
  { denylistDocument, responseIds = [] } = {},
) {
  if (!denylistDocument || !Array.isArray(denylistDocument.patterns))
    throw new Error('private disclosure policy required before export')
  if (
    !Array.isArray(runIds) ||
    !runIds.length ||
    runIds.length > 20 ||
    new Set(runIds).size !== runIds.length
  )
    throw new Error('select 1 to 20 unique run IDs')
  const history = createReviewStore(project).records()
  if (!history.ok) throw new Error(history.error)
  if (
    !Array.isArray(responseIds) ||
    responseIds.length > 2000 ||
    new Set(responseIds).size !== responseIds.length
  )
    throw new Error('invalid response selection')
  const responses = responseIds.map((id) => {
    const record = history.records.find(
      (entry) =>
        entry.input.requestId === id && entry.input.kind !== 'decision',
    )
    if (!record) throw new Error('selected response unavailable')
    return record
  })
  prohibitedKeys(responses)
  const members = runIds.map((id) => {
    const bound = loadBoundRun(project, id)
    if (!bound.ok) throw new Error(bound.error)
    const value = {
      schema: bound.schema,
      run: bound.run,
      runDigest: bound.runDigest,
      snapshot: bound.snapshot,
      decisions: history.records.filter(
        (record) =>
          record.input.kind === 'decision' && record.input.runId === id,
      ),
    }
    prohibitedKeys(value)
    return {
      id,
      bytes: Buffer.byteLength(JSON.stringify(value)),
      digest: hashEvidence(value),
      value,
    }
  })
  const body = {
    schema: 'atelier-inspection-bundle@v1',
    purpose: 'historical-inspection-only',
    classification: 'owner-selected-private-review',
    members,
    responses,
  }
  const bytes = JSON.stringify(body, null, 2)
  const disclosure = scanDisclosureText(bytes, {
    denylistPatterns: compileDisclosurePatterns(denylistDocument.patterns),
  })
  if (!disclosure.ok)
    throw new Error('selected content failed disclosure policy; export refused')
  const bundle = { ...body, digest: hashEvidence(body) }
  inspectBundle(bundle)
  return bundle
}
export function inspectBundle(bundle) {
  const serialized = JSON.stringify(bundle)
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
    throw new Error('bundle exceeds byte bound')
  if (!validReviewArtifact('bundle', bundle))
    throw new Error('inspection bundle contract invalid')
  if (
    !bundle ||
    bundle.schema !== 'atelier-inspection-bundle@v1' ||
    bundle.purpose !== 'historical-inspection-only' ||
    !Array.isArray(bundle.members) ||
    !bundle.members.length ||
    bundle.members.length > 20 ||
    Object.keys(bundle).some(
      (key) =>
        ![
          'schema',
          'purpose',
          'classification',
          'members',
          'responses',
          'digest',
          'ext',
          'contractVersion',
        ].includes(key),
    )
  )
    throw new Error('unsupported inspection bundle')
  const { digest, ...body } = bundle
  if (digest !== hashEvidence(body)) throw new Error('bundle digest mismatch')
  const ids = new Set(),
    requests = new Set()
  const verifyRecord = (record) => {
    if (!validContribution(record) || requests.has(record.input.requestId))
      throw new Error('invalid or duplicate historical contribution')
    requests.add(record.input.requestId)
  }
  prohibitedKeys(bundle.responses)
  for (const record of bundle.responses) {
    verifyRecord(record)
    if (record.input.kind === 'decision')
      throw new Error('decision outside run member')
  }
  for (const member of bundle.members) {
    if (
      !member ||
      !/^readiness-run-[a-z0-9-]+$/.test(member.id ?? '') ||
      ids.has(member.id) ||
      Object.keys(member).some(
        (key) => !['id', 'bytes', 'digest', 'value', 'ext'].includes(key),
      ) ||
      member.digest !== hashEvidence(member.value) ||
      member.bytes !== Buffer.byteLength(JSON.stringify(member.value))
    )
      throw new Error('invalid, duplicate or changed bundle member')
    prohibitedKeys(member.value)
    ids.add(member.id)
    const value = member.value,
      { digest: snapshotDigest, ...snapshot } = value.snapshot ?? {}
    const { decisions, ...bound } = value
    if (
      !validBoundRun(bound) ||
      value.schema !== 'atelier-bound-run@v1' ||
      value.run?.runId !== member.id ||
      value.runDigest !== hashEvidence(value.run) ||
      snapshotDigest !== hashEvidence(snapshot) ||
      !Array.isArray(value.decisions)
    )
      throw new Error('invalid historical evidence')
    for (const record of value.decisions) {
      verifyRecord(record)
      if (
        record.input.kind !== 'decision' ||
        record.input.runId !== member.id ||
        record.input.evidenceDigest !== snapshotDigest ||
        !value.run.claims.some(
          (claim) => claim.claimId === record.input.targetId,
        )
      )
        throw new Error('decision does not bind selected evidence')
    }
  }
  return {
    ok: true,
    schema: 'atelier-inspection-report@v1',
    approvalAuthority: false,
    authorship: 'unverified-historical-assertions',
    writes: false,
    members: bundle.members,
    responses: bundle.responses,
  }
}
export function readInspectionBundle(file) {
  const descriptor = openRegularFileNoFollow(file)
  try {
    if (fs.fstatSync(descriptor).size > 4 * 1024 * 1024)
      throw new Error('bundle exceeds byte bound')
    return inspectBundle(JSON.parse(fs.readFileSync(descriptor, 'utf8')))
  } finally {
    fs.closeSync(descriptor)
  }
}
export function writeInspectionBundle(file, bundle) {
  inspectBundle(bundle)
  if (path.extname(file) !== '.json')
    throw new Error('inspection bundle output must be a JSON file')
  const descriptor = openRegularFileNoFollow(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, JSON.stringify(bundle, null, 2) + '\n')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}
