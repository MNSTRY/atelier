// Deterministic alignment of two byte strings: the authored body a view was
// published with, and the same body after somebody edited it.
//
// The result is a list of matched runs { p, e, length }: `length` bytes at
// offset `p` of the published body equal the bytes at offset `e` of the edited
// body. Runs are strictly increasing in both coordinates. Everything between
// two runs was replaced, inserted or deleted.
//
//   1. The common prefix and the common suffix are trimmed. One contiguous
//      edit, however large, is aligned exactly by this step alone.
//   2. What remains is compared line by line (a line ends after its 0x0a) with
//      a shortest-edit-script search.
//   3. Each replaced group of lines the caller cares about is compared byte by
//      byte with the same search.
//
// Both searches are bounded by an edit distance and by a step budget, so the
// cost is never quadratic in the size of a note. A search that runs out
// returns no runs for its range and reports the range as `coarse`; the caller
// decides what an unaligned range means and never receives a guess.

export const ALIGN_LIMITS = Object.freeze({ maxLineEdits: 1500, maxByteEdits: 1500, stepBudget: 40_000_000 })

export function commonPrefixLength(left, right, leftFrom = 0, rightFrom = 0, limit = Infinity) {
  const max = Math.min(left.length - leftFrom, right.length - rightFrom, limit)
  let length = 0
  // Whole blocks first; Buffer.compare is native.
  const block = 4096
  while (length + block <= max && left.compare(right, rightFrom + length, rightFrom + length + block, leftFrom + length, leftFrom + length + block) === 0) length += block
  while (length < max && left[leftFrom + length] === right[rightFrom + length]) length += 1
  return length
}

export function commonSuffixLength(left, right, leftEnd = left.length, rightEnd = right.length, limit = Infinity) {
  const max = Math.min(leftEnd, rightEnd, limit)
  let length = 0
  const block = 4096
  while (length + block <= max && left.compare(right, rightEnd - length - block, rightEnd - length, leftEnd - length - block, leftEnd - length) === 0) length += block
  while (length < max && left[leftEnd - length - 1] === right[rightEnd - length - 1]) length += 1
  return length
}

// Shortest edit script (Myers, greedy forward) over two indexable sequences of
// integers. Returns matched runs { p, e, length } in sequence coordinates, or
// null when the script is longer than `maxEdits` or the budget is spent.
export function shortestEditRuns(left, leftFrom, leftTo, right, rightFrom, rightTo, { maxEdits, budget }) {
  const n = leftTo - leftFrom
  const m = rightTo - rightFrom
  if (n === 0 || m === 0) return []
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  const furthest = new Int32Array(2 * max + 3)
  const trace = []
  for (let d = 0; d <= max; d += 1) {
    trace.push(furthest.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1]) ? furthest[offset + k + 1] : furthest[offset + k - 1] + 1
      let y = x - k
      const startX = x
      while (x < n && y < m && left[leftFrom + x] === right[rightFrom + y]) { x += 1; y += 1 }
      budget.steps -= x - startX + 1
      furthest[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, offset, n, m, leftFrom, rightFrom)
    }
    if (budget.steps < 0) return null
  }
  return null
}

function backtrack(trace, offset, n, m, leftFrom, rightFrom) {
  const runs = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const furthest = trace[d]
    const k = x - y
    const previousK = k === -d || (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1]) ? k + 1 : k - 1
    const previousX = furthest[offset + previousK]
    const previousY = previousX - previousK
    let length = 0
    while (x > previousX && y > previousY && x > 0 && y > 0) { x -= 1; y -= 1; length += 1 }
    if (length > 0) runs.push({ p: leftFrom + x, e: rightFrom + y, length })
    if (d > 0) { x = previousX; y = previousY }
  }
  return runs.reverse()
}

// Length of the longest common subsequence of two byte strings, or null when
// the bounded search cannot tell.
export function commonSubsequenceLength(left, right, limits = ALIGN_LIMITS) {
  const head = commonPrefixLength(left, right)
  const tail = commonSuffixLength(left, right, left.length, right.length, Math.min(left.length, right.length) - head)
  const runs = shortestEditRuns(left, head, left.length - tail, right, head, right.length - tail, { maxEdits: limits.maxByteEdits, budget: { steps: limits.stepBudget } })
  return runs === null ? null : head + tail + runs.reduce((total, run) => total + run.length, 0)
}

// Line starts of buffer[from, to): a line ends after 0x0a or at `to`.
function lineTable(buffer, from, to) {
  const starts = []
  let offset = from
  while (offset < to) {
    starts.push(offset)
    const newline = buffer.indexOf(0x0a, offset)
    offset = newline === -1 || newline >= to ? to : newline + 1
  }
  starts.push(to)
  return starts
}

function mergeRuns(runs) {
  const merged = []
  for (const run of runs) {
    if (run.length === 0) continue
    const last = merged.at(-1)
    if (last && last.p + last.length === run.p && last.e + last.length === run.e) last.length += run.length
    else merged.push({ ...run })
  }
  return merged
}

// `wanted(pFrom, pTo)` says whether the caller needs byte precision inside a
// replaced range of the published body. Returns { runs, coarse } where
// `coarse` lists the published ranges no search could align.
export function alignBodies(published, edited, { wanted = () => true, limits = ALIGN_LIMITS } = {}) {
  const budget = { steps: limits.stepBudget }
  const prefix = commonPrefixLength(published, edited)
  const suffix = commonSuffixLength(published, edited, published.length, edited.length, Math.min(published.length, edited.length) - prefix)
  const runs = [{ p: 0, e: 0, length: prefix }]
  const coarse = []
  const window = { pFrom: prefix, pTo: published.length - suffix, eFrom: prefix, eTo: edited.length - suffix }

  const refineBytes = (pFrom, pTo, eFrom, eTo) => {
    if (pFrom === pTo || eFrom === eTo || !wanted(pFrom, pTo)) return
    const head = commonPrefixLength(published, edited, pFrom, eFrom, Math.min(pTo - pFrom, eTo - eFrom))
    const tail = commonSuffixLength(published, edited, pTo, eTo, Math.min(pTo - pFrom, eTo - eFrom) - head)
    runs.push({ p: pFrom, e: eFrom, length: head })
    const inner = shortestEditRuns(published, pFrom + head, pTo - tail, edited, eFrom + head, eTo - tail, { maxEdits: limits.maxByteEdits, budget })
    if (inner === null) coarse.push({ start: pFrom + head, end: pTo - tail })
    else runs.push(...inner)
    runs.push({ p: pTo - tail, e: eTo - tail, length: tail })
  }

  if (window.pFrom < window.pTo && window.eFrom < window.eTo && wanted(window.pFrom, window.pTo)) {
    const pLines = lineTable(published, window.pFrom, window.pTo)
    const eLines = lineTable(edited, window.eFrom, window.eTo)
    const ids = new Map()
    const idOf = (buffer, starts, index) => {
      const key = buffer.toString('latin1', starts[index], starts[index + 1])
      if (!ids.has(key)) ids.set(key, ids.size)
      return ids.get(key)
    }
    const pIds = Int32Array.from({ length: pLines.length - 1 }, (_, index) => idOf(published, pLines, index))
    const eIds = Int32Array.from({ length: eLines.length - 1 }, (_, index) => idOf(edited, eLines, index))
    const lineRuns = shortestEditRuns(pIds, 0, pIds.length, eIds, 0, eIds.length, { maxEdits: limits.maxLineEdits, budget })
    if (lineRuns === null) {
      refineBytes(window.pFrom, window.pTo, window.eFrom, window.eTo)
    } else {
      let pLine = 0
      let eLine = 0
      for (const run of [...lineRuns, { p: pIds.length, e: eIds.length, length: 0 }]) {
        refineBytes(pLines[pLine], pLines[run.p], eLines[eLine], eLines[run.e])
        runs.push({ p: pLines[run.p], e: eLines[run.e], length: pLines[run.p + run.length] - pLines[run.p] })
        pLine = run.p + run.length
        eLine = run.e + run.length
      }
    }
  }
  runs.push({ p: published.length - suffix, e: edited.length - suffix, length: suffix })
  return { runs: mergeRuns(runs), coarse }
}
