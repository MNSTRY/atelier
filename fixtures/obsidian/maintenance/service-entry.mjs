#!/usr/bin/env node
// Test entry of the Obsidian maintenance service. It is the production service
// body with two differences, both fixed here and neither reachable from the
// production entry: the editor adapter always reports that no app runs, so
// nothing outside the temporary directories of a test is ever contacted, and
// two failures can be injected from the command line.
//
//   --fail-tick-once=<CODE>       the first canonical graph build throws an untyped error with that code
//   --crash-on-publication=<N>    the process kills itself, hard, during its Nth publication
//   --crash-at=<point>            where in that publication (a point of the publisher's crash seam; default after-staging)
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../../../src/project/config.mjs'
import { createEditorAdapter, publishView } from '../../../src/projection/obsidian/publication/index.mjs'
import { CRASH_INJECTION_TEST_SEAM } from '../../../src/projection/obsidian/publication/test-seam.mjs'
import { buildGraph } from '../../../src/runtime/obsidian/pipeline.mjs'
import { runServiceProcess, serviceOptionsFromArgv } from '../../../src/runtime/obsidian/service-main.mjs'
import { createNullWatcherFactory } from '../../../src/runtime/obsidian/watchers.mjs'

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const { adapter: _never, ...options } = serviceOptionsFromArgv(argv)

let failuresLeft = typeof args['fail-tick-once'] === 'string' ? 1 : 0
const crashOn = Number(args['crash-on-publication'] ?? 0)
let publications = 0

const seams = {
  buildGraph(input) {
    if (failuresLeft > 0) { failuresLeft -= 1; throw Object.assign(new Error('injected: no space left on device'), { code: args['fail-tick-once'] }) }
    return buildGraph(input)
  },
  publishView(input) {
    publications += 1
    if (publications !== crashOn) return publishView(input)
    return publishView({ ...input, [CRASH_INJECTION_TEST_SEAM]: { at: typeof args['crash-at'] === 'string' ? args['crash-at'] : 'after-staging', halt: () => process.kill(process.pid, 'SIGKILL') } })
  },
}

await runServiceProcess({
  ...options,
  entryPath: fileURLToPath(import.meta.url),
  adapterFactory: () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' }),
  engineOptions: { quietPeriodMs: 0, watcherFactory: createNullWatcherFactory(), seams },
})
