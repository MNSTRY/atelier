#!/usr/bin/env node
import { commandProject, parseArgs } from '../project/config.mjs'
import { buildCanonicalGraph, createGraphFileCache } from '../graph/graph.mjs'
import { inspectKnowledgePlan } from '../knowledge/plan.mjs'
import {
  createKnowledgeContext,
  encodeKnowledgeOutput,
  evaluateKnowledgeQuestions,
} from '../knowledge/context.mjs'
import {
  knowledgeDashboard,
  loadKnowledgeWorkspace,
  readKnowledgePlan,
} from '../knowledge/workspace.mjs'
import { createKnowledgeSessions } from '../knowledge/sessions.mjs'

try {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const command = args._[0]
  if (
    !['check', 'context', 'evaluate', 'dashboard', 'session'].includes(
      command
    ) ||
    args._.length !== (command === 'session' ? 2 : 1)
  )
    throw new Error(
      'use knowledge check, context, evaluate, dashboard, or session; see knowledge --help'
    )
  const allowed = new Set([
    '_',
    'project',
    'project-config',
    'repo-path',
    'plan',
    ...(command === 'context' ? ['question', 'mode', 'max-bytes'] : []),
  ])
  if (Object.keys(args).some((key) => !allowed.has(key)))
    throw new Error('unknown knowledge option; see knowledge --help')
  const project = commandProject({ argv })
  if (command === 'session') {
    const operation = args._[1]
    if (!['start', 'read', 'event', 'recover', 'list'].includes(operation))
      throw new Error('unknown knowledge session operation')
    const sessions = createKnowledgeSessions(project, args.plan)
    let result
    if (operation === 'list') result = { ok: true, sessions: sessions.list() }
    else {
      const chunks = []
      let count = 0
      for await (const chunk of process.stdin) {
        count += chunk.length
        if (count > 1024 * 1024) throw new Error('request exceeds byte ceiling')
        chunks.push(chunk)
      }
      const input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      )
      if (operation === 'read') {
        if (!input || Object.keys(input).join(',') !== 'sessionId')
          throw new Error('read requires only sessionId')
        result = sessions.read(input.sessionId)
      } else result = sessions[operation](input)
    }
    process.stdout.write(encodeKnowledgeOutput(result))
  } else if (command === 'dashboard') {
    process.stdout.write(
      encodeKnowledgeOutput(
        knowledgeDashboard(loadKnowledgeWorkspace(project, args.plan))
      )
    )
  } else {
    const { plan } = readKnowledgePlan(project, args.plan)
    const cache = createGraphFileCache()
    const graph = buildCanonicalGraph(project, { fileCache: cache })
    if (command === 'check') {
      const result = inspectKnowledgePlan(plan, graph)
      process.stdout.write(encodeKnowledgeOutput(result))
      if (!result.ok) process.exitCode = 1
    } else {
      if (!graph.ok)
        throw new Error(
          'canonical graph is invalid; run atelier graph to inspect diagnostics'
        )
      const result =
        command === 'evaluate'
          ? evaluateKnowledgeQuestions({ project, plan, graph, cache })
          : createKnowledgeContext({
              project,
              plan,
              graph,
              cache,
              question: args.question,
              mode: args.mode || 'graph',
              maxBytes:
                args['max-bytes'] === undefined
                  ? plan.budget.maxContextBytes
                  : Number(args['max-bytes']),
            })
      process.stdout.write(encodeKnowledgeOutput(result))
      if (
        command === 'evaluate' &&
        result.cases.some(
          (c) =>
            !c.runs.graph.expectedEvidencePresent || c.runs.graph.stale.length
        )
      )
        process.exitCode = 1
    }
  }
} catch (error) {
  console.error(`knowledge: ${error.message}`)
  process.exitCode = 1
}
