import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommandHelpText } from '../src/cli/run.mjs'
import { BUILT_IN_OPERATIONS } from '../src/runtime/obsidian/extension-points.mjs'

test('`atelier obsidian --help` names every built-in obsidian operation, in its usage line and with a line of its own', () => {
  const help = buildCommandHelpText('obsidian')
  const [usage] = help.split('\n')
  const listed = usage.replace(/^Usage: \S+ obsidian /, '').split(' ')[0].split('|')
  for (const operation of BUILT_IN_OPERATIONS.filter((name) => name !== 'help')) {
    assert.ok(listed.includes(operation), `${operation} is in the usage line`)
    assert.match(help, new RegExp(`\\n  \\S+ obsidian ${operation}\\b`), `${operation} has a line of its own`)
  }
})
