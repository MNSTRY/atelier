// Isolated, disposable Obsidian test instance.
//
// Isolation has two independent parts: a private HOME (the CLI socket lives at
// $HOME/.obsidian-cli.sock, so neither this app nor this CLI can reach another
// session) and a private Electron profile (--user-data-dir). The only vault
// registered in that profile is a synthetic one created here. The private HOME
// has no login keychain, so Chromium's mock keychain is used; without it macOS
// raises a "Keychain Not Found" dialog on the desktop at every launch.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildEvalCode } from './bridge.mjs';

const run = promisify(execFile);
const APP_DIR = process.env.ATELIER_OBSIDIAN_APP_DIR || '/Applications/Obsidian.app/Contents/MacOS';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// dataRoot lets the vault, staging and recovery live on another volume (the
// disk-full case) while the app profile stays on a healthy one. With an owned
// run, a root created here is that run's to remove and is recorded before it
// is populated; a root the caller names stays the caller's.
export function createLayout(root, dataRoot, { custody, io = fs } = {}) {
  root ??= custody ? custody.allocateRoot('atelier-g00-') : io.mkdtempSync(path.join(io.realpathSync(os.tmpdir()), 'atelier-g00-'));
  dataRoot ??= root;
  const layout = { root, home: path.join(root, 'home'), profile: path.join(root, 'profile'), vault: path.join(dataRoot, 'vault'),
    staging: path.join(dataRoot, 'staging'), recovery: path.join(dataRoot, 'recovery') };
  for (const dir of [layout.home, layout.profile, path.join(layout.vault, 'notes'), layout.staging, layout.recovery]) io.mkdirSync(dir, { recursive: true });
  if (process.env.ATELIER_OBSIDIAN_ASAR) io.copyFileSync(process.env.ATELIER_OBSIDIAN_ASAR, path.join(layout.profile, path.basename(process.env.ATELIER_OBSIDIAN_ASAR)));
  io.writeFileSync(path.join(layout.profile, 'obsidian.json'), JSON.stringify({
    vaults: { atelierg00synthetic: { path: layout.vault, ts: Date.now(), open: true } }, cli: true, updateDisabled: true }));
  return layout;
}

// ---------------------------------------------------------------------------
// Owned run: one lifecycle that ends the processes it started, removes the
// directories it created, and bounds the output it keeps.
//
// What it may signal and what it may remove is decided by identity it
// recorded itself, never by a name:
//   - a process it spawned is held by the handle spawn returned. Until that
//     handle reports an exit the process number cannot belong to anything
//     else, and a handle that has reported one is never signalled;
//   - a process further down is owned only by lineage: the process table
//     showed it as the child of a process already owned, and its number, user,
//     start time and command are read again immediately before every signal;
//   - a directory is owned only when this run created it, and is removed only
//     while the path still names that same directory (device and file number).
// A process that merely names one of the run's directories on its command line
// is never signalled. While one is still there the roots are kept and the run
// says so.
// A process table that cannot be read is unknown custody, never proof of exit.
//
// Limits, stated rather than hidden. The deadline is cooperative: synchronous
// work is not interrupted. Between a descendant's readback and its signal
// there remains the time of one system call. A process that detaches itself
// from the app and names none of the run's directories is not seen at all;
// the app's output streams, which such a process inherits, must still close
// before the run counts the app as gone.
// ---------------------------------------------------------------------------

const PS_ARGS = ['-ww', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='];
// One row per process. The user number is signed (the unprivileged account is
// negative on macOS). State Z is a process that has exited and only awaits
// collection by its parent.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/;

export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    const match = PS_ROW.exec(line);
    // The row is never quoted in the error: it can carry another program's arguments.
    if (!match) throw new Error('Unrecognized process table row');
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), exited: match[4].startsWith('Z'), start: match[5].replace(/\s+/g, ' '), command: match[6] ?? '' });
  }
  return rows;
}

// LC_ALL=C keeps the start time in one format whatever the session's locale.
export const readProcessTable = (timeout = 5000) => parseProcessTable(execFileSync('/bin/ps', PS_ARGS, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }));

const sameProcess = (a, b) => a.pid === b.pid && a.uid === b.uid && a.start === b.start && a.command === b.command;
const namesProfile = (command, profile) => {
  const flag = `--user-data-dir=${profile}`;
  const at = command.indexOf(flag);
  return at >= 0 && (at + flag.length === command.length || /\s/.test(command[at + flag.length]));
};
// Whether a command line mentions a directory: the path itself or something under it, not a longer name.
const mentionsDirectory = (command, directory) => {
  for (let at = command.indexOf(directory); at >= 0; at = command.indexOf(directory, at + 1)) {
    const next = command[at + directory.length];
    if (next === undefined || next === '/' || /\s/.test(next)) return true;
  }
  return false;
};
// lstat, never stat: a link standing where a directory was is not that directory.
const directoryIdentity = (io, target) => {
  const stat = io.lstatSync(target, { bigint: true });
  return stat.isSymbolicLink() || !stat.isDirectory() ? null : `${stat.dev}:${stat.ino}`;
};
const outputRefusal = () => Object.assign(new Error('Whole-run output bound exceeded'), { code: 'output-budget-exceeded' });

export class OwnedRun {
  constructor({ readTable = readProcessTable, signal = (pid, name) => process.kill(pid, name), now = Date.now, pause = sleep, uid = process.getuid?.(), self = process.pid, io = fs,
    workMs = 900000, cleanupMs = 120000, watchMs = 1000, outputBytes = 64 * 1024 * 1024 } = {}) {
    this.readTable = readTable; this.signal = signal; this.now = now; this.pause = pause; this.uid = uid; this.self = self; this.io = io;
    this.deadline = now() + workMs; this.cleanupMs = cleanupMs; this.watchMs = watchMs;
    this.outputLimit = outputBytes; this.outputUsed = 0; this.failureOutputReserve = Math.min(4096, Math.floor(outputBytes / 16)); this.failureOutputUsed = 0;
    this.roots = new Map(); // path -> identity of the directory this run created there
    this.profiles = new Set(); // profile directories of the apps this run started; like the roots, observed and never a reason to signal
    this.children = new Set(); // processes this run spawned and has not yet seen closed, each held by its handle
    this.descendants = new Map(); // number -> identity of a process seen as the child of an owned process
    this.strays = new Map(); // number -> identity of a process tied to this run that it does not own, and so never signals
    this.unknown = new Set(); this.watchers = new Set();
  }

  assertActive() { if (this.failure) throw this.failure; if (this.now() >= this.deadline) throw this.fail('Whole-run deadline exceeded'); }
  fail(message) { return this.failure ??= new Error(message); }

  // -- directories ----------------------------------------------------------

  // The only way a directory becomes this run's to remove. It is recorded the
  // moment it exists, before anything is put in it.
  allocateRoot(prefix) {
    this.assertActive();
    const root = this.io.mkdtempSync(path.join(this.io.realpathSync(os.tmpdir()), prefix));
    this.roots.set(root, null); // a root whose identity could not be read is kept and reported, never removed
    this.roots.set(root, directoryIdentity(this.io, root));
    return root;
  }

  // Removes one root, and only while the path still names the directory this
  // run created. Links inside it are removed as links and never entered.
  removeRoot(root) {
    const recorded = this.roots.get(root);
    if (typeof recorded !== 'string') throw new Error('no identity was recorded for this directory');
    let current;
    try { current = directoryIdentity(this.io, root); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
    if (current !== recorded) throw new Error('the path no longer names the directory this run created');
    this.io.rmSync(root, { recursive: true, force: true });
    return 'removed';
  }

  // -- output ---------------------------------------------------------------

  get outputAllowance() { return this.outputLimit - this.failureOutputReserve; }
  reserveOutput(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.outputUsed + bytes > this.outputAllowance) { const error = outputRefusal(); this.failure ??= error; throw error; }
    this.outputUsed += bytes;
  }
  consume(bytes) { this.assertActive(); this.reserveOutput(bytes); }
  // The bytes the receipt writer will write (two-space JSON and a newline). A
  // document that does not fit is refused whole; it is never shortened to fit.
  serializeFinal(value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text) > this.outputAllowance - this.outputUsed) throw outputRefusal();
    return text;
  }
  // One reservation for everything the final output will write, made before any of it is written.
  async commitFinalOutput({ bytes, commit }) { this.reserveOutput(bytes); return commit(); }
  // What a failed run says when it can promise nothing else: bounded, paid from
  // its own reserve, naming the roots it kept. It is not a receipt.
  failureDiagnostic({ procedureId = null, error = null, retainedRoots = [] } = {}) {
    const base = { procedureId: procedureId === null ? null : String(procedureId).slice(0, 32), outcome: 'failed', closes: false, humanAcceptance: null, code: 'owned-run-failed', inspectEvidenceIfPresent: true };
    const full = { ...base, message: String(error?.message ?? error ?? '').slice(0, 600), retainedRoots: retainedRoots.slice(0, 8).map((root) => String(root).slice(0, 256)) };
    const remaining = this.failureOutputReserve - this.failureOutputUsed;
    const text = [full, base].map((value) => `${JSON.stringify(value)}\n`).find((candidate) => Buffer.byteLength(candidate) <= remaining);
    if (text === undefined) throw new Error('Failure diagnostic reserve exhausted');
    const bytes = Buffer.byteLength(text);
    this.failureOutputUsed += bytes; this.outputUsed += bytes;
    return text;
  }

  // -- processes ------------------------------------------------------------

  // Call in the same turn as spawn, before anything can fail or yield.
  adopt(child) {
    const entry = { child, closed: false };
    this.children.add(entry);
    child.once('close', () => { entry.closed = true; this.children.delete(entry); });
    // A spawn that never produced a process has nothing to end. Any other error (a signal that could not be
    // delivered, say) leaves the process where it was, so it does not count as closed.
    child.on('error', () => { if (!Number.isInteger(child.pid)) { entry.closed = true; this.children.delete(entry); } });
    return entry;
  }
  unreaped(entry) { return Number.isInteger(entry.child.pid) && entry.child.exitCode === null && entry.child.signalCode === null; }
  signalChild(entry, name) { return this.unreaped(entry) ? entry.child.kill(name) : false; }

  // Reads the process table once and brings the record of descendants up to date. Signals nothing.
  observe() {
    const remaining = (this.cleanupUntil ?? this.deadline) - this.now();
    let rows;
    try {
      if (remaining <= 0) throw new Error('Process readback deadline exceeded');
      rows = this.readTable(Math.max(1, Math.min(5000, remaining)));
    } catch (error) { this.unknown.add(`process-readback:${error.message}`); error.readback = true; throw error; }
    const current = new Map(rows.map((row) => [row.pid, row]));
    // A recorded descendant that is gone, or has exited, is released: whatever holds that number later is not
    // this run's. One that answers with another identity is released too, and the run no longer claims a clean end.
    for (const [pid, recorded] of this.descendants) {
      const row = current.get(pid);
      if (!row || row.exited) this.descendants.delete(pid);
      else if (!sameProcess(recorded, row)) { this.descendants.delete(pid); this.unknown.add(`changed:${pid}`); }
    }
    const spawned = new Set([...this.children].filter((entry) => this.unreaped(entry)).map((entry) => entry.child.pid));
    const owned = (pid) => spawned.has(pid) || this.descendants.has(pid);
    const adoptable = (row) => !row.exited && row.pid > 1 && row.pid !== this.self && !owned(row.pid) && owned(row.ppid);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) if (adoptable(row) && row.uid === this.uid) { this.descendants.set(row.pid, row); grew = true; }
    }
    // What is tied to this run without being its own (a child that runs as another user, or anything whose
    // command line mentions one of the run's directories, such as a helper that detached itself from the app) is
    // remembered until it is seen gone, and is never signalled.
    const places = [...this.roots.keys(), ...this.profiles];
    for (const [pid, recorded] of this.strays) {
      const row = current.get(pid);
      if (!row || row.exited || !sameProcess(recorded, row)) this.strays.delete(pid);
    }
    for (const row of rows) {
      if (row.exited || row.pid === this.self || owned(row.pid) || this.strays.has(row.pid)) continue;
      if (adoptable(row) || places.some((place) => mentionsDirectory(row.command, place))) this.strays.set(row.pid, row);
    }
    return rows;
  }

  // A descendant has no handle, so its identity is read again immediately before every signal.
  signalDescendant(pid, name) {
    this.observe();
    if (!this.descendants.has(pid) || !Number.isInteger(pid) || pid <= 1 || pid === this.self) return false;
    try { this.signal(pid, name); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }

  // Reads a spawned process back from the process table: this run's own child, running the program it was asked
  // to run. A child that cannot be read back stays held by its handle, and the run stops.
  async bind(entry, { program, profile } = {}) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const row = this.observe().find((item) => item.pid === entry.child.pid);
      if (row && !row.exited && row.uid === this.uid && row.ppid === this.self && (row.command === program || row.command.startsWith(`${program} `)) && (!profile || namesProfile(row.command, profile))) return row;
      if (entry.closed || !this.unreaped(entry)) return null;
      await this.pause(10);
    }
    this.unknown.add(`unbound:${entry.child.pid}`);
    throw this.fail('Spawn identity could not be bound');
  }

  // Keeps the record of descendants current while the app runs: one that outlives its parent unseen can only be
  // reported afterwards, never ended.
  watch() {
    const watcher = setInterval(() => { try { this.assertActive(); this.observe(); } catch (error) { this.fail(error.message); } }, this.watchMs);
    watcher.unref();
    this.watchers.add(watcher);
    return watcher;
  }

  settled() { return this.children.size === 0 && this.descendants.size === 0 && this.strays.size === 0; }

  async cleanup({ until = this.cleanupUntil ?? this.now() + this.cleanupMs } = {}) {
    this.cleanupUntil = until;
    for (const watcher of this.watchers) clearInterval(watcher);
    this.watchers.clear();
    // The descendants are read before the first signal: once their parent is gone the lineage cannot be read.
    let readable = true;
    const read = (step) => { try { step(); } catch (error) { readable = false; if (!error.readback) this.unknown.add(`process-cleanup:${error.message}`); } };
    // Without a readable table only the spawned processes can be joined, and the run reports unknown custody.
    const done = () => (readable ? this.settled() : this.children.size === 0);
    read(() => this.observe());
    for (const [name, stage] of [['SIGTERM', Math.min(until, this.now() + 10000)], ['SIGKILL', until]]) {
      // Spawned processes are signalled through their handles, which needs no process table.
      for (const entry of this.children) this.signalChild(entry, name);
      if (readable) read(() => { for (const pid of [...this.descendants.keys()]) { if (this.now() >= until) throw new Error('Cleanup deadline exceeded'); this.signalDescendant(pid, name); } });
      for (;;) {
        if (readable) read(() => this.observe());
        if (done() || this.now() >= stage) break;
        await this.pause(100);
        // With no time left to look again, the last readback stands.
        if (this.now() >= stage) break;
      }
      if (done()) break;
    }
    if (readable && !this.settled()) {
      this.unknown.add('process-join-incomplete');
      for (const pid of this.strays.keys()) this.unknown.add(`unowned-process-remains:${pid}`);
    } else if (!readable && this.children.size > 0) this.unknown.add('process-join-incomplete');
    return { joined: this.unknown.size === 0, unknown: [...this.unknown], roots: [...this.roots.keys()], outputBytes: this.outputUsed };
  }

  async execute(work, { keep = false, finalize } = {}) {
    let timer, value, error, settled = false;
    const task = Promise.resolve().then(() => { this.assertActive(); return work(); }).then((result) => { settled = true; return result; }, (failure) => { settled = true; throw failure; });
    try { value = await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(this.fail('Whole-run deadline exceeded')), Math.max(0, this.deadline - this.now())); })]); }
    catch (failure) { error = failure; }
    finally { clearTimeout(timer); }
    this.fail('Owned lifecycle is closing');
    const until = this.cleanupUntil ?? this.now() + this.cleanupMs;
    // Owned processes are ended first; work that has not returned shares what is left of the cleanup budget.
    const cleanup = await this.cleanup({ until });
    while (!settled && this.now() < until) await this.pause(100);
    if (!settled) { this.unknown.add('work-join-incomplete'); cleanup.joined = false; cleanup.unknown.push('work-join-incomplete'); }
    // The final output is committed while the roots still exist, after a failed run too.
    if (finalize) {
      cleanup.rootDispositionAtFinalOutput = 'retained-until-output-commit';
      try { value = await finalize(value, cleanup, error); }
      catch (failure) { if (error) failure.cause ??= error; error = failure; keep = true; }
    }
    cleanup.removedRoots = []; cleanup.absentRoots = [];
    if (cleanup.joined && !keep) {
      for (const root of this.roots.keys()) {
        try { cleanup[this.removeRoot(root) === 'removed' ? 'removedRoots' : 'absentRoots'].push(root); }
        catch (failure) { cleanup.joined = false; cleanup.unknown.push(`root-removal:${failure.message}`); }
      }
    }
    cleanup.retainedRoots = [...this.roots.keys()].filter((root) => !cleanup.removedRoots.includes(root) && !cleanup.absentRoots.includes(root));
    cleanup.retained = cleanup.retainedRoots.length > 0;
    if (error || !cleanup.joined) { const failure = error ?? new Error('Owned cleanup could not be verified'); failure.cleanup = cleanup; throw failure; }
    return { value, cleanup };
  }
}

export class Instance {
  constructor(layout, { custody } = {}) { this.custody = custody; this.layout = layout; this.env = { ...process.env, HOME: layout.home }; this.transportRetries = []; }

  get socket() { return path.join(this.layout.home, '.obsidian-cli.sock'); }

  // readyTimeoutMs bounds the wait for the CLI socket and the vault listing;
  // a large vault takes the app longer to open than the 30 s default.
  async launch({ readyTimeoutMs = 30000 } = {}) {
    this.custody?.assertActive();
    this.custody?.profiles.add(this.layout.profile);
    fs.rmSync(this.socket, { force: true });
    const program = path.join(APP_DIR, 'Obsidian');
    const logPath = path.join(this.layout.root, 'app.log');
    const log = this.custody ? 'pipe' : fs.openSync(logPath, 'a');
    this.child = spawn(program, [`--user-data-dir=${this.layout.profile}`, '--use-mock-keychain', '--password-store=basic',
      // Real typing implies a focused window. The test window is usually hidden, and Chromium then throttles the
      // app's own save timers, which is not a condition a typing user can be in.
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'], { env: this.env, detached: true, stdio: ['ignore', log, log] });
    if (this.custody) {
      // Held by its handle from the turn it was spawned; its output is counted before it is kept.
      const entry = this.custody.adopt(this.child);
      for (const stream of [this.child.stdout, this.child.stderr]) stream?.on('data', (chunk) => {
        try { this.custody.consume(chunk.length); fs.appendFileSync(logPath, chunk); } catch (error) { this.custody.fail(error.message); }
      });
      await this.custody.bind(entry, { program, profile: this.layout.profile });
      this.custody.assertActive();
      this.watcher = this.custody.watch();
    } else this.child.unref();
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      this.custody?.assertActive();
      if (fs.existsSync(this.socket)) {
        try { if ((await this.cli('vaults', 'verbose')).includes(this.layout.vault)) { await sleep(1500); return this.assertIsolated(); } } catch { /* still starting */ }
      }
      await sleep(250);
    }
    // The app was started detached; a launch that gives up must not leave it running.
    if (!this.custody) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } } }
    throw new Error('Isolated Obsidian instance did not become ready');
  }

  async assertIsolated() {
    const vaults = (await this.cli('vaults', 'verbose')).trim().split('\n');
    if (vaults.length !== 1 || !vaults[0].endsWith(this.layout.vault)) throw new Error(`Refusing: unexpected vaults visible: ${vaults.join(' | ')}`);
    return this;
  }

  // A CLI call that outlives its timeout is killed outright (the CLI ignores
  // SIGTERM while waiting on the app) and reported with a renderer probe.
  async cli(...args) {
    if (this.custody) return this.ownedCli(args);
    try {
      const { stdout, stderr } = await run(path.join(APP_DIR, 'obsidian-cli'), args, { env: this.env, maxBuffer: 64 * 1024 * 1024, timeout: 20000, killSignal: 'SIGKILL' });
      return stdout || stderr;
    } catch (error) {
      if (!error.killed) throw error;
      const probe = await run(path.join(APP_DIR, 'obsidian-cli'), ['eval', 'code=1+1'], { env: this.env, timeout: 8000, killSignal: 'SIGKILL' }).then(({ stdout }) => stdout.trim(), () => 'renderer-unresponsive');
      throw new Error(`CLI call timed out: ${args[0]} ${String(args[1] || '').slice(0, 60)}; renderer probe: ${probe}`);
    }
  }

  // The same call under an owned run: this run's own child, held by its handle, its output counted against the
  // run's bound as it arrives, and ended through that handle whatever the outcome.
  async ownedCli(args) {
    const custody = this.custody;
    custody.assertActive();
    let timer;
    const child = spawn(path.join(APP_DIR, 'obsidian-cli'), args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = custody.adopt(child);
    const completion = new Promise((resolve, reject) => {
      const stdout = [], stderr = [];
      for (const [stream, sink] of [[child.stdout, stdout], [child.stderr, stderr]]) stream?.on('data', (chunk) => {
        try { custody.consume(chunk.length); sink.push(chunk); } catch (error) { reject(error); }
      });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve(Buffer.concat(stdout.length ? stdout : stderr).toString('utf8')) : reject(new Error(`CLI exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`))));
    });
    completion.catch(() => {});
    try {
      return await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CLI call timed out: ${args[0]} ${String(args[1] || '').slice(0, 60)}`)), Math.max(0, Math.min(20000, custody.deadline - custody.now()))); })]);
    } finally {
      clearTimeout(timer);
      // The CLI ignores SIGTERM while it waits on the app. A call that has already exited is not signalled.
      custody.signalChild(entry, 'SIGKILL');
    }
  }

  async version() { return (await this.cli('version')).trim(); }

  // Read-only calls retry. A publish is never resent: when its reply is lost
  // the outcome is re-read from the app, and an absent record means it never ran.
  async bridge(payload) {
    if (payload.op !== 'publish') {
      for (let attempt = 0; ; attempt += 1) {
        try { return await this.bridgeOnce(payload); } catch (error) { if (attempt >= 2 || !/timed out/.test(error.message)) throw error; this.transportRetries.push(payload.op); }
      }
    }
    try { return await this.bridgeOnce(payload); } catch (error) {
      if (!/timed out/.test(error.message)) throw error;
      this.transportRetries.push('publish-reply-lost');
      const record = await this.bridge({ op: 'collect', path: payload.path });
      if (record.missing || record.stagedPath !== payload.stagedPath) throw new Error(`Publish reply lost and no outcome recorded: ${error.message}`);
      return { ...record, status: record.outcome, replyLost: true };
    }
  }

  async bridgeOnce(payload) {
    const out = await this.cli('eval', `code=${buildEvalCode(payload)}`);
    const start = out.indexOf('=> ');
    if (start < 0) throw new Error(`Bridge returned no value: ${JSON.stringify(out.slice(0, 600))}`);
    return JSON.parse(out.slice(start + 3));
  }

  // Test stimulus only (not part of the protocol): fixed scripts that open
  // notes and place the caret. Real typing goes through typeText (CDP input).
  async stimulus(name, notePath, extra = {}) {
    const scripts = {
      // Always open in the main window: after a pop-out closes, the "current" leaf can belong to a window that is going away.
      open: `app.workspace.createLeafInParent(app.workspace.rootSplit,0).openFile(app.vault.getFileByPath(P.path)).then(()=>'ok')`,
      openPopout: `app.workspace.openPopoutLeaf().openFile(app.vault.getFileByPath(P.path)).then(()=>'ok')`,
      closeAll: `(app.workspace.getLeavesOfType('markdown').forEach(l=>l.detach()),'ok')`,
      focusAt: `(()=>{const v=app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file&&v.file.path===P.path&&v.containerEl.ownerDocument===document);app.workspace.setActiveLeaf(v.leaf,{focus:true});v.editor.focus();const at=v.editor.getValue().indexOf(P.anchor);v.editor.setCursor(v.editor.offsetToPos(at+P.anchor.length));return 'ok'})()`,
      popoutEdit: `(()=>{const v=app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file&&v.file.path===P.path&&v.containerEl.ownerDocument!==document);const at=v.editor.getValue().indexOf(P.anchor);v.editor.replaceRange(P.text,v.editor.offsetToPos(at),v.editor.offsetToPos(at+P.anchor.length));return 'ok'})()`,
    };
    if (!scripts[name]) throw new Error(`Unknown stimulus ${name}`);
    const data = Buffer.from(JSON.stringify({ path: notePath, ...extra }), 'utf8').toString('base64');
    const code = `code=(()=>{const P=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${data}'),c=>c.charCodeAt(0))));return ${scripts[name]}})()`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const reply = await this.cli('eval', code);
        if (!reply.includes('=> ok')) throw new Error(`Stimulus ${name} failed: ${reply.slice(0, 300)}`);
        return reply;
      } catch (error) {
        // popoutEdit changes text, so it is never repeated blindly.
        if (attempt >= 2 || name === 'popoutEdit' || !/timed out/.test(error.message)) throw error;
        this.transportRetries.push(`stimulus:${name}`);
      }
    }
  }

  // Real input path: Chromium dispatches this like keyboard text entry into
  // the focused editor of the main window.
  // When a typing call's reply is lost, retype only if the text did not arrive.
  async typeText(text, notePath) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.cli('dev:cdp', 'method=Input.insertText', `params=${JSON.stringify({ text })}`); } catch (error) {
        if (attempt >= 2 || !notePath || !/timed out/.test(error.message)) throw error;
        this.transportRetries.push('typeText');
        const state = await this.bridge({ op: 'inspect', path: notePath });
        if (state.views.some((view) => Buffer.from(view.bufferBase64, 'base64').toString('utf8').includes(text))) return 'arrived';
      }
    }
  }

  async quit() {
    clearInterval(this.watcher);
    if (this.custody) {
      const cleanup = await this.custody.cleanup();
      if (!cleanup.joined) throw Object.assign(new Error('Owned app/helper/CLI cleanup unknown'), { cleanup });
      return cleanup;
    }

    if (!this.child) return;
    try { process.kill(this.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { process.kill(this.child.pid, 0); } catch { return; }
      await sleep(250);
    }
    try { process.kill(this.child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
