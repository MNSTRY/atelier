#!/usr/bin/env node
import { commandProject } from '../project/config.mjs'
const project = commandProject()
const report = process.argv.includes('--explain')
  ? { ok: true, schema: project.schema, configSource: project.source, repos: project.repos.map((repo) => ({
    name: repo.name, pathSource: repo.pathSource, resolved: repo.path !== null, readBoundary: repo.readBoundary, external: repo.external,
  })) }
  : { ok: true, schema: project.schema, configPath: project.configPath, repos: project.repos.map((repo) => repo.name) }
console.log(JSON.stringify(report, null, 2))
