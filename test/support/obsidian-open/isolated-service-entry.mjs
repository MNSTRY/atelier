#!/usr/bin/env node
// Entry of the Obsidian maintenance service for the opt-in real-app suite of
// `open`. It is the production service with the production command-line
// adapter, the version-qualified adapter factory and the app observation of
// service-main.mjs, with one difference: the process table is read for the
// isolated app only, the one whose profile --isolated-profile names, so
// an Obsidian the person runs on the same desktop is neither seen nor reached.
// The app is reached through the private HOME this process was started with.
//
//   --isolated-profile=<absolute directory>   required
import { fileURLToPath } from 'node:url'
import { firstString, parseArgs } from '../../../src/project/config.mjs'
import { createObsidianCliAdapter } from '../../../src/projection/obsidian/publication/transport.mjs'
import { obsidianUserDataDir, readObsidianSettings } from '../../../src/projection/obsidian/publication/vault-list.mjs'
import { createQualifiedAdapterFactory } from '../../../src/runtime/obsidian/app-capability.mjs'
import { createProductionAppProbe } from '../../../src/runtime/obsidian/app-production-seams.mjs'
import { appStateSignature } from '../../../src/runtime/obsidian/app-registration.mjs'
import { runServiceProcess, serviceOptionsFromArgv } from '../../../src/runtime/obsidian/service-main.mjs'
import { CLI_PATH, isolatedProcessProbe } from './isolated-app.mjs'

const argv = process.argv.slice(2)
const { adapter: _never, ...options } = serviceOptionsFromArgv(argv)
const profile = firstString(parseArgs(argv)['isolated-profile'])
const processProbe = isolatedProcessProbe(profile)
if (obsidianUserDataDir() !== profile) throw new Error('the isolated profile must be the one HOME names')

const adapterFactory = createQualifiedAdapterFactory({ appProbe: createProductionAppProbe({ processProbe, cliPath: CLI_PATH }), createAdapter: ({ qualification }) => createObsidianCliAdapter({ qualification, processProbe, cliPath: CLI_PATH }) })
await runServiceProcess({
  ...options,
  entryPath: fileURLToPath(import.meta.url),
  adapterFactory,
  appStatus: () => { const known = adapterFactory.lastQualification(); return known === null ? null : { outcome: known.outcome, reason: known.reason, version: known.version, floor: known.floor } },
  engineOptions: { observeApp: () => appStateSignature({ qualification: adapterFactory.qualification(), settings: readObsidianSettings({ userDataDir: profile }) }) },
})
