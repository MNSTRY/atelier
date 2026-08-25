#!/usr/bin/env node
import {
  enrollRepository,
  executeUserConfirmedCommit,
  operationTrace,
  planUserConfirmedCommit,
  reconcileRepository,
  runtimeStatus,
  setRepositoryPaused,
} from '../runtime/supervisor.mjs'
import { firstString, parseArgs } from '../project/config.mjs'

function valuesFor(argv, name) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === `--${name}` && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      values.push(argv[index + 1])
      index += 1
    } else if (arg.startsWith(`--${name}=`)) {
      values.push(arg.slice(name.length + 3))
    }
  }
  return values
}

function integer(value, fallback) {
  if (value == null || value === true) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('interval and retry values must be positive integers')
  return parsed
}

function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function runLoop({ repoPath, intervalMs, fetchAttempts, once }) {
  do {
    const result = reconcileRepository({ repoPath, fetchAttempts })
    print(result)
    if (once) return result.ok ? 0 : 1
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  } while (true)
}

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const subcommand = args._[0] || 'status'
const repoPath = firstString(args.repo) || process.cwd()

try {
  if (subcommand === 'enroll') {
    const result = enrollRepository({ repoPath, projectConfig: firstString(args.project, args['project-config']), gitExecutable: firstString(args.git) })
    print(result)
    process.exitCode = result.ok ? 0 : 1
  } else if (subcommand === 'status' || subcommand === 'audit') {
    const result = runtimeStatus({ repoPath })
    print(result)
    process.exitCode = result.ok ? 0 : 1
  } else if (subcommand === 'reconcile') {
    const result = reconcileRepository({ repoPath, fetchAttempts: integer(args.retries, 3) })
    print(result)
    process.exitCode = result.ok ? 0 : 1
  } else if (subcommand === 'run') {
    process.exitCode = await runLoop({
      repoPath,
      intervalMs: integer(args.interval, 30) * 1000,
      fetchAttempts: integer(args.retries, 3),
      once: Boolean(args.once),
    })
  } else if (subcommand === 'plan') {
    print(planUserConfirmedCommit({
      repoPath,
      paths: valuesFor(argv, 'path'),
      message: firstString(args.message),
      publish: Boolean(args.publish),
      fetchAttempts: integer(args.retries, 3),
    }))
  } else if (subcommand === 'commit') {
    print(executeUserConfirmedCommit({
      repoPath,
      operationId: firstString(args.operation),
      confirmation: firstString(args.confirm),
    }))
  } else if (subcommand === 'pause' || subcommand === 'freeze') {
    print(setRepositoryPaused({ repoPath, paused: true, reason: firstString(args.reason) || (subcommand === 'freeze' ? 'frozen by user' : 'paused by user') }))
  } else if (subcommand === 'resume') {
    print(setRepositoryPaused({ repoPath, paused: false }))
  } else if (subcommand === 'trace') {
    print({ ok: true, operations: operationTrace({ repoPath }) })
  } else {
    throw new Error(`unknown sync command: ${subcommand}`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
