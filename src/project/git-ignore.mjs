import { spawnSync } from 'node:child_process'

const GIT_IGNORE_TIMEOUT_MS = 8000

// One batched call per root. Per-file `git check-ignore` is correct but too slow
// once a workspace has thousands of files, which is how adopters end up skipping
// the check entirely and shipping a machine-dependent census.
export function gitIgnoredPaths(root) {
  const ignored = new Set()
  if (!root) return ignored
  const result = spawnSync('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
    encoding: 'utf8',
    timeout: GIT_IGNORE_TIMEOUT_MS,
  })
  if (result.status !== 0 || !result.stdout) return ignored
  for (const entry of result.stdout.split('\0')) {
    if (entry) ignored.add(entry.replace(/\/+$/, ''))
  }
  return ignored
}

export const includeEverything = () => false

// `--directory` collapses a fully ignored directory to a single entry, so callers
// must test each directory before descending into it; a file deep inside an
// ignored directory is not itself listed.
export function gitIgnoreFilter(root) {
  const ignored = gitIgnoredPaths(root)
  if (!ignored.size) return includeEverything
  return (rel) => ignored.has(String(rel ?? '').replace(/\/+$/, ''))
}
