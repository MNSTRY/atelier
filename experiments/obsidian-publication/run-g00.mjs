#!/usr/bin/env node
// G00 publication feasibility runner. Drives a real, isolated Obsidian
// instance through the interleavings named in the initiative architecture and
// writes a receipt with traces and byte digests. A case passes only when no
// user or external bytes are lost; a refusal to publish is an acceptable
// outcome, a silent loss never is.
//
// Usage: node experiments/obsidian-publication/run-g00.mjs [--exchange atomic-swap|link-rename] [--races N] [--out FILE]

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_ID } from './lib/bridge.mjs';
import { createLayout, Instance, sha256 } from './lib/instance.mjs';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const exchange = arg('exchange', 'atomic-swap');
const races = Number(arg('races', '20'));
const out = arg('out', path.resolve('.artifacts/obsidian/acceptance/G00.json'));

const BASE = '# Synthetic note\n\nThe quick brown fox jumps.\n\nUnrelated closing paragraph.\n';
const CANDIDATE = '# Synthetic note\n\nThe quick GENERATED fox jumps.\n\nUnrelated closing paragraph.\n\nGenerated relation: [[Other]]\n';

const layout = createLayout();
let app = new Instance(layout);
const results = [];
const transportRetries = [];
let serial = 0;

const notePath = (id) => `notes/${id}.md`;
const full = (id) => path.join(layout.vault, notePath(id));
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const buffers = (reply) => (reply.views || []).map((view) => Buffer.from(view.bufferBase64, 'base64').toString('utf8'));

async function seed(id, { open = true } = {}) {
  fs.writeFileSync(full(id), BASE);
  await sleep(1200);
  await app.stimulus('closeAll', notePath(id));
  if (!open) return;
  await app.stimulus('open', notePath(id));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await app.bridge({ op: 'inspect', path: notePath(id) });
    if (state.views.length === 1 && !state.views[0].dirty && state.views[0].bufferSha256 === sha256(BASE)) { await sleep(300); return; }
    if (attempt % 10 === 9) { await app.stimulus('closeAll', notePath(id)); await app.stimulus('open', notePath(id)); }
    await sleep(250);
  }
  throw new Error(`Seeded note ${id} never became a clean open view`);
}

function publish(id, options = {}) {
  serial += 1;
  const staged = path.join(layout.staging, `${id}-${serial}.md`);
  const recovery = path.join(layout.recovery, `${id}-${serial}.prev`);
  fs.writeFileSync(staged, CANDIDATE);
  return app.bridge({ op: 'publish', path: notePath(id), baseSha256: sha256(options.base ?? BASE), candidateSha256: sha256(CANDIDATE),
    stagedPath: staged, recoveryLinkPath: recovery, guardMs: options.guardMs ?? 2600, haltAt: options.haltAt ?? 'none', exchange, editorRoute: options.editorRoute ?? 'no-write' })
    .then((reply) => ({ ...reply, staged, recovery }));
}

const only = arg('only', '').split(',').filter(Boolean);

async function record(id, title, body) {
  if (only.length && !only.includes(id)) return;
  const started = Date.now();
  try {
    const verdict = await body();
    results.push({ id, title, pass: verdict.pass, ...verdict, ms: Date.now() - started });
  } catch (error) {
    results.push({ id, title, pass: false, error: String(error && error.stack || error), ms: Date.now() - started });
  }
  transportRetries.push(...app.transportRetries.splice(0));
  const last = results[results.length - 1];
  console.log(`${last.pass ? 'PASS' : 'FAIL'} ${id} ${title}${last.pass ? '' : ` :: ${last.reason || last.error}`}`);
}

const kept = (token, ...texts) => texts.every((text) => typeof text === 'string' && text.includes(token));

async function main() {
  await app.launch();
  const version = await app.version();

  await record('I00', 'clean open note publishes and editor shows the candidate', async () => {
    await seed('i00');
    const reply = await publish('i00');
    const pass = reply.status === 'published' && read(full('i00')) === CANDIDATE && buffers(reply).every((text) => text === CANDIDATE) && read(reply.recovery) === BASE;
    return { pass, status: reply.status, trace: reply.trace, diskSha256: reply.diskSha256 };
  });

  await record('I01', 'saved edit before capture refuses without writing', async () => {
    await seed('i01');
    await app.stimulus('focusAt', notePath('i01'), { anchor: 'brown' });
    await app.typeText('SAVEDEDIT', notePath('i01'));
    await sleep(3200);
    const before = read(full('i01'));
    const reply = await publish('i01');
    const pass = ['disk-changed', 'editor-edit'].includes(reply.status) && reply.wrote === false && read(full('i01')) === before && kept('SAVEDEDIT', before, ...buffers(reply));
    return { pass, status: reply.status, beforeSha256: sha256(before), afterSha256: sha256(read(full('i01'))) };
  });

  await record('I02', 'save landing between capture and conditional update refuses without writing', async () => {
    await seed('i02');
    const captured = sha256(read(full('i02'))); // driver capture happens here
    await app.stimulus('focusAt', notePath('i02'), { anchor: 'brown' });
    await app.typeText('MIDSAVE', notePath('i02'));
    await sleep(3200); // Obsidian's own delayed save lands after capture
    const reply = await publish('i02');
    const pass = captured === sha256(BASE) && ['disk-changed', 'editor-edit'].includes(reply.status) && reply.wrote === false && kept('MIDSAVE', read(full('i02')), ...buffers(reply));
    return { pass, status: reply.status, capturedSha256: captured, afterSha256: sha256(read(full('i02'))) };
  });

  await record('I03', 'unsaved active buffer refuses, then the delayed save keeps the edit', async () => {
    await seed('i03');
    await app.stimulus('focusAt', notePath('i03'), { anchor: 'brown' });
    await app.typeText('UNSAVED', notePath('i03'));
    const reply = await publish('i03');
    const diskAtRefusal = read(full('i03'));
    await sleep(3200);
    const pass = reply.status === 'editor-edit' && reply.wrote === false && diskAtRefusal === BASE && kept('UNSAVED', read(full('i03')), ...buffers(reply));
    return { pass, status: reply.status, views: reply.views.map(({ dirty, bufferSha256 }) => ({ dirty, bufferSha256 })) };
  });

  await record('I04', `real typing racing the critical section never loses the typed text (${races} rounds)`, async () => {
    const rounds = [];
    for (let round = 0; round < races; round += 1) {
      const id = `i04r${round}`;
      const typed = `RACE${round}X`;
      await seed(id);
      await app.stimulus('focusAt', notePath(id), { anchor: 'brown' }); // caret inside the text the generator rewrites
      const delay = (round * 7) % 90;
      const typing = sleep(delay).then(() => app.typeText(typed, notePath(id)));
      const reply = await publish(id, { guardMs: 25000 });
      await typing;
      let final;
      let safe = false;
      for (const started = Date.now(); Date.now() - started < 20000 && !safe;) {
        await sleep(1000);
        final = await app.bridge({ op: 'collect', path: notePath(id) });
        safe = kept(typed, read(full(id)), ...buffers(final)) && final.views.every((view) => !view.dirty);
      }
      rounds.push({ round, delayMs: delay, status: reply.status, replyLost: reply.replyLost || undefined, safe, capturedEdits: (final.capturedEdits || []).length, trace: safe ? undefined : final.trace });
      if (!safe) return { pass: false, reason: `typed token lost in round ${round}`, rounds, disk: read(full(id)), buffers: buffers(final) };
    }
    const statuses = rounds.reduce((tally, { status }) => ({ ...tally, [status]: (tally[status] || 0) + 1 }), {});
    return { pass: true, statuses, rounds };
  });

  await record('I05', 'separate window holding an unsaved edit refuses; clean windows both receive the candidate', async () => {
    await seed('i05');
    await app.stimulus('openPopout', notePath('i05'));
    await sleep(1500);
    const clean = await publish('i05');
    const cleanOk = clean.status === 'published' && clean.openViews === 2 && clean.views.some((view) => view.popout) && buffers(clean).every((text) => text === CANDIDATE);
    fs.writeFileSync(full('i05'), BASE);
    await sleep(2500);
    await app.stimulus('popoutEdit', notePath('i05'), { anchor: 'brown', text: 'POPOUTEDIT' });
    const dirty = await publish('i05');
    await sleep(3200);
    const pass = cleanOk && dirty.status === 'editor-edit' && dirty.wrote === false && kept('POPOUTEDIT', read(full('i05')));
    await app.stimulus('closeAll', notePath('i05'));
    return { pass, clean: clean.status, cleanViews: clean.openViews, dirty: dirty.status, inputPath: 'editor API transaction (popout is not reachable by CDP input)' };
  });

  await record('I06', `external atomic-rename writer racing publication never loses external bytes (${races} rounds)`, async () => {
    const rounds = [];
    for (let round = 0; round < races; round += 1) {
      const id = `i06r${round}`;
      const external = `${BASE}EXTERNAL${round}\n`;
      await seed(id, { open: round % 2 === 0 });
      const writer = spawn(process.execPath, ['-e', `const fs=require('fs');setTimeout(()=>{fs.writeFileSync(process.argv[1]+'.ext~',process.argv[2]);fs.renameSync(process.argv[1]+'.ext~',process.argv[1]);},${(round * 11) % 120})`, full(id), external], { stdio: 'ignore' });
      const exited = new Promise((resolve) => writer.on('exit', resolve));
      const reply = await publish(id, { guardMs: 1500 });
      await exited;
      await sleep(2500);
      const disk = read(full(id));
      const recovered = read(reply.recovery);
      const safe = disk === external || recovered === external || (disk || '').includes(`EXTERNAL${round}`);
      rounds.push({ round, status: reply.status, safe, where: disk === external ? 'disk' : recovered === external ? 'recovery' : 'merged-by-editor' });
      if (!safe) return { pass: false, reason: `external bytes lost in round ${round}`, rounds, disk, recovered };
    }
    const statuses = rounds.reduce((tally, { status }) => ({ ...tally, [status]: (tally[status] || 0) + 1 }), {});
    return { pass: true, statuses, rounds };
  });

  // Regression for the observed loss (20-round run, I06 round 12): after the
  // exchange the app rewrote the open note in place and overwrote an outside
  // writer. The invariant is that publication causes no later write by the app.
  const stamp = (file) => { const s = fs.statSync(file, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; };
  for (const [id, editorRoute, expectWrite] of [['I06a', 'no-write', false], ['I06b', 'app-save', true]]) {
    await record(id, expectWrite ? 'negative control: the rejected app-save route is detected rewriting the note' : 'open note is never rewritten by the app after publication; a following outside write survives', async () => {
      const note = id.toLowerCase();
      await seed(note);
      const reply = await publish(note, { editorRoute, guardMs: 500 });
      const published = reply.recovery && stamp(full(note));
      const first = Date.now();
      let rewritten = false;
      while (Date.now() - first < 4000) { if (stamp(full(note)) !== published) { rewritten = true; break; } await sleep(5); }
      if (expectWrite) return { pass: reply.status === 'published' && rewritten, status: reply.status, rewritten };
      const external = `${CANDIDATE}OUTSIDE WRITER\n`;
      fs.writeFileSync(`${full(note)}.ext~`, external); fs.renameSync(`${full(note)}.ext~`, full(note));
      await sleep(4000);
      const final = await app.bridge({ op: 'inspect', path: notePath(note) });
      return { pass: reply.status === 'published' && !rewritten && read(full(note)) === external && buffers(final).every((text) => text === external), status: reply.status, rewritten };
    });
  }

  await record('I07', 'note removed before publication refuses and creates nothing', async () => {
    await seed('i07');
    fs.rmSync(full('i07'));
    await sleep(1500);
    const reply = await publish('i07');
    return { pass: reply.status === 'note-missing' && !fs.existsSync(full('i07')), status: reply.status };
  });

  for (const [id, haltAt, title] of [['I08', 'after-link', 'app killed after the preserved-bytes step and before the update'], ['I09', 'after-rename', 'app killed after the update and before any manifest commit']]) {
    await record(id, title, async () => {
      const note = id.toLowerCase();
      await seed(note);
      await app.stimulus('focusAt', notePath(note), { anchor: 'Unrelated' });
      const crashed = await publish(note, { haltAt }).then(() => 'returned', () => 'connection-lost');
      await sleep(1500);
      await app.quit();
      app = new Instance(layout);
      await app.launch();
      const disk = read(full(note));
      const artifacts = fs.readdirSync(layout.recovery).filter((name) => name.startsWith(`${note}-`)).map((name) => read(path.join(layout.recovery, name)));
      const staged = fs.readdirSync(layout.staging).filter((name) => name.startsWith(`${note}-`)).map((name) => read(path.join(layout.staging, name)));
      const everything = [disk, ...artifacts, ...staged];
      const coherent = disk === BASE || disk === CANDIDATE;
      const pass = crashed === 'connection-lost' && coherent && everything.includes(BASE) && everything.includes(CANDIDATE);
      return { pass, crashed, diskIs: disk === BASE ? 'base' : disk === CANDIDATE ? 'candidate' : 'other', preservedBase: everything.includes(BASE), preservedCandidate: everything.includes(CANDIDATE) };
    });
  }

  await record('I10', 'shutdown while publishing leaves a coherent note and a retryable state', async () => {
    await seed('i10');
    const pending = publish('i10', { guardMs: 5000 }).then((reply) => reply.status, () => 'connection-lost');
    await sleep(400);
    await app.quit();
    const outcome = await pending;
    app = new Instance(layout);
    await app.launch();
    const disk = read(full('i10'));
    return { pass: disk === BASE || disk === CANDIDATE, outcome, diskIs: disk === BASE ? 'base' : disk === CANDIDATE ? 'candidate' : 'other' };
  });

  await record('I11', 'full disk: staging refuses, a pre-staged publication stays all-or-nothing, typed text survives until space returns', async () => {
    if (process.platform !== 'darwin') return { pass: false, reason: 'disk-full case is implemented for macOS disk images only' };
    await app.quit();
    const image = path.join(layout.root, 'full.dmg');
    const mount = path.join(layout.root, 'fullvol');
    fs.mkdirSync(mount);
    execFileSync('/usr/bin/hdiutil', ['create', '-size', '24m', '-fs', 'APFS', '-volname', 'AtelierG00Full', image], { stdio: 'ignore' });
    execFileSync('/usr/bin/hdiutil', ['attach', image, '-nobrowse', '-mountpoint', mount], { stdio: 'ignore' });
    const small = createLayout(undefined, mount); // own short root: the CLI socket path must stay under the 104-byte limit
    const full2 = (id) => path.join(small.vault, notePath(id));
    const filler = path.join(mount, 'filler.bin');
    const fill = () => { const fd = fs.openSync(filler, 'a'); try { for (const size of [1 << 20, 1 << 14, 1 << 9, 1]) { const chunk = Buffer.alloc(size, 1); for (;;) { try { fs.writeSync(fd, chunk); } catch { break; } } } } finally { fs.closeSync(fd); } };
    const previous = app;
    app = new Instance(small);
    try {
      await app.launch();
      fs.writeFileSync(full2('i11'), BASE);
      await sleep(1500);
      await app.stimulus('open', notePath('i11'));
      await sleep(1500);
      const staged = path.join(small.staging, 'i11.md');
      fs.writeFileSync(staged, CANDIDATE);
      fill();
      // A candidate larger than the space left cannot be staged; the partial file it leaves must be refused by digest.
      const big = Buffer.from(`${CANDIDATE}${'x'.repeat(4 << 20)}`);
      const partial = path.join(small.staging, 'partial.md');
      let stagingRefused = false;
      try { fs.writeFileSync(partial, big); } catch (error) { stagingRefused = error.code === 'ENOSPC'; }
      const partialReply = await app.bridge({ op: 'publish', path: notePath('i11'), baseSha256: sha256(BASE), candidateSha256: sha256(big), stagedPath: partial,
        recoveryLinkPath: path.join(small.recovery, 'partial.prev'), guardMs: 0, haltAt: 'none', exchange, editorRoute: 'no-write' }).catch((error) => ({ status: `error: ${error.message.slice(0, 80)}` }));
      stagingRefused = stagingRefused && ['staged-mismatch'].includes(partialReply.status) && read(full2('i11')) === BASE;
      const reply = await app.bridge({ op: 'publish', path: notePath('i11'), baseSha256: sha256(BASE), candidateSha256: sha256(CANDIDATE), stagedPath: staged,
        recoveryLinkPath: path.join(small.recovery, 'i11.prev'), guardMs: 1000, haltAt: 'none', exchange, editorRoute: 'no-write' });
      const disk = read(full2('i11'));
      const everything = [disk, read(staged), read(path.join(small.recovery, 'i11.prev'))];
      const allOrNothing = (reply.wrote ? disk === CANDIDATE : disk === BASE) && everything.includes(BASE);
      await app.stimulus('focusAt', notePath('i11'), { anchor: 'Unrelated' });
      await app.typeText('TYPEDWHILEFULL', notePath('i11'));
      await sleep(5000);
      const whileFull = await app.bridge({ op: 'inspect', path: notePath('i11') });
      const bufferKept = kept('TYPEDWHILEFULL', ...buffers(whileFull));
      const diskWhileFull = read(full2('i11'));
      fs.rmSync(filler);
      await app.typeText('!');
      let recovered = false;
      for (const started = Date.now(); Date.now() - started < 20000 && !recovered;) { await sleep(1000); recovered = kept('TYPEDWHILEFULL', read(full2('i11'))); }
      return { pass: stagingRefused && allOrNothing && bufferKept && recovered, stagingRefused, partialStatus: partialReply.status, publishStatus: reply.status, exchangeExit: reply.exitStatus, allOrNothing, bufferKept,
        diskWhileFull: diskWhileFull === null ? 'missing' : diskWhileFull.length === 0 ? 'EMPTY (app truncated its own file)' : kept('TYPEDWHILEFULL', diskWhileFull) ? 'has typed text' : 'previous content', recoveredAfterSpaceReturned: recovered };
    } finally {
      await app.quit();
      try { execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' }); } catch { /* already detached */ }
      app = previous;
    }
  });

  return version;
}

let version = null;
let fatal = null;
try { version = await main(); } catch (error) { fatal = String(error && error.stack || error); }
await app.quit();
const receipt = { gate: 'G00', protocol: PROTOCOL_ID, exchange, generatedAt: new Date().toISOString(), obsidian: version,
  host: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
  synthetic: true, passed: !fatal && results.every((result) => result.pass), fatal, selectedCases: only.length ? only : 'all', transportRetries, notCovered: [], results };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`${receipt.passed ? 'ALL LISTED CASES PASSED' : 'NOT PASSED'}; receipt ${out}; evidence root ${layout.root}`);
process.exit(receipt.passed ? 0 : 1);
