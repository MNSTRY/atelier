import { execFileSync } from 'node:child_process'
import { bytesAt, workspaceRoot, digest } from '../capabilities/files.mjs'
import { harnessRef } from '../harnesses/contracts.mjs'
import { inspectBuild } from './ledger.mjs'

// Read-only local adapter. A host still owns commands, writer custody and CI.
export function prepareGitCandidate({ workspaceRoot: input, records, artifact, writer }) {
  const root = workspaceRoot(input), state = inspectBuild(records)
  if (!state.establishment) throw new Error('build objective missing')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  const git = args => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('candidate requires clean repository sources')
  const commit = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}'])
  const artifactDigest = digest(bytesAt(root, artifact))
  if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain', '--untracked-files=all']) || digest(bytesAt(root, artifact)) !== artifactDigest) throw new Error('candidate changed during capture')
  return { data: { objective: harnessRef(state.establishment), repository: state.establishment.data.repository, commit, tree, artifactDigest, writer,
    ...(state.candidate ? { supersedes: harnessRef(state.candidate) } : {}) }, artifact, assurance: 'local-bytes-and-git-observation; writer-is-caller-reported', authority: 'none' }
}
