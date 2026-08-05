import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMigration } from '../src/upgrade/upgrade.mjs'

test('applyMigration treats apply none as an explicit no-op', () => {
  const project = {}
  assert.doesNotThrow(() => applyMigration(project, { id: 'breaking-placeholder@0.1.0-alpha.0', apply: 'none' }))
  assert.deepEqual(project, {}, 'the none branch must not touch the project')
})

test('applyMigration throws on an unrecognized apply action', () => {
  assert.throws(
    () => applyMigration({}, { id: 'x@y', apply: 'definitely-bogus' }),
    /unrecognized apply action/,
  )
})
