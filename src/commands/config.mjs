#!/usr/bin/env node
import { commandProject } from '../project/config.mjs'
const project = commandProject()
console.log(JSON.stringify({ ok: true, schema: project.schema, configPath: project.configPath, repos: project.repos.map((repo) => repo.name) }, null, 2))
