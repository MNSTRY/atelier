#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createCliReader } from './cli-reader.mjs';
import { assessCapture } from './assessment-core.mjs';
import { summarizeMeasurements } from './measurements.mjs';

const options = { metrics: [] };
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--atelier-entry': 'entry', '--binding': 'binding', '--workspace': 'workspace', '--metrics': 'metrics', '--floor': 'floor' }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --atelier-entry PATH --binding JSON --workspace PATH; optional --metrics JSON and --floor JSON.');
    if (key === 'metrics') options.metrics.push(path.resolve(args[i + 1]));
    else options[key] = path.resolve(args[i + 1]);
  }
  if (!options.entry || !options.binding || !options.workspace) throw new Error('Select an installed Atelier entry, its receiving binding, and a permitted workspace.');
  const json = file => {
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('Input must be a bounded regular JSON file.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const reader = createCliReader({ entry: options.entry, binding: json(options.binding) });
  const records = options.metrics.flatMap(f => { const v = json(f); return Array.isArray(v) ? v : [v]; });
  const capture = reader.collect(options.workspace);
  const report = assessCapture(capture, summarizeMeasurements(records, options.floor ? json(options.floor) : null));
  console.log(JSON.stringify({ capture, report }, null, 2));
  if (report.summary.fail) process.exitCode = 2;
} catch (error) { console.error(`assessment unavailable: ${error.message}`); process.exitCode = 1; }
