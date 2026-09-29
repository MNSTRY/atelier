#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { commandProject, parseArgs } from '../project/config.mjs'
import { buildCanonicalGraph, createGraphFileCache } from '../graph/graph.mjs'
import { inspectKnowledgePlan, validateKnowledgePlan } from '../knowledge/plan.mjs'
import { createKnowledgeContext, encodeKnowledgeOutput, evaluateKnowledgeQuestions } from '../knowledge/context.mjs'
import { openRegularFileNoFollow } from '../project/private-state.mjs'

try {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const command = args._[0]
  if (!['check', 'context', 'evaluate'].includes(command) || args._.length !== 1) throw new Error('use knowledge check, context, or evaluate; see knowledge --help')
  const allowed = new Set(['_', 'project', 'project-config', 'repo-path', 'plan', ...(command === 'context' ? ['question', 'mode', 'max-bytes'] : [])])
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('unknown knowledge option; see knowledge --help')
  const project = commandProject({ argv })
  const planFile = path.resolve(project.configDir, args.plan || 'knowledge-plan.json')
  const fd = openRegularFileNoFollow(planFile)
  let plan
  try {
    if (fs.fstatSync(fd).size > 65536) throw new Error('knowledge plan exceeds 65536 bytes')
    const buffer = Buffer.alloc(65537)
    let count = 0
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null)
      if (!read) break
      count += read
    }
    if (count > 65536) throw new Error('knowledge plan exceeds 65536 bytes')
    plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)))
  } finally { fs.closeSync(fd) }
  const errors = validateKnowledgePlan(plan)
  if (errors.length) throw new Error(`invalid knowledge plan: ${errors.join('; ')}`)
  const cache = createGraphFileCache()
  const graph = buildCanonicalGraph(project, { fileCache: cache })
  if (command === 'check') {
    const result = inspectKnowledgePlan(plan, graph)
    process.stdout.write(encodeKnowledgeOutput(result))
    if (!result.ok) process.exitCode = 1
  } else {
    if (!graph.ok) throw new Error('canonical graph is invalid; run atelier graph to inspect diagnostics')
    const result = command === 'evaluate'
      ? evaluateKnowledgeQuestions({ project, plan, graph, cache })
      : createKnowledgeContext({ project, plan, graph, cache, question: args.question,
        mode: args.mode || 'graph', maxBytes: args['max-bytes'] === undefined ? plan.budget.maxContextBytes : Number(args['max-bytes']) })
    process.stdout.write(encodeKnowledgeOutput(result))
    if (command === 'evaluate' && result.cases.some(c => !c.runs.graph.expectedEvidencePresent || c.runs.graph.stale.length)) process.exitCode = 1
  }
} catch (error) {
  console.error(`knowledge: ${error.message}`)
  process.exitCode = 1
}
