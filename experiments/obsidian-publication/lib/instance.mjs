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
// is populated; a root the caller names stays the caller's. As before, only
// an omitted root or data root is defaulted: an explicit null is refused. A
// root created here is also the only place an instance's HOME may be (see
// assertPrivateHome).
export function createLayout(root, dataRoot, { custody, io = fs } = {}) {
  if (root === undefined) {
    root = custody ? custody.allocateRoot('atelier-g00-') : io.mkdtempSync(path.join(io.realpathSync(os.tmpdir()), 'atelier-g00-'));
    CREATED_ROOTS.set(realPath(root), directoryIdentity(io, root));
  }
  if (dataRoot === undefined) dataRoot = root;
  const layout = { root, home: path.join(root, 'home'), profile: path.join(root, 'profile'), vault: path.join(dataRoot, 'vault'),
    staging: path.join(dataRoot, 'staging'), recovery: path.join(dataRoot, 'recovery') };
  for (const dir of [layout.home, layout.profile, path.join(layout.vault, 'notes'), layout.staging, layout.recovery]) io.mkdirSync(dir, { recursive: true });
  if (process.env.ATELIER_OBSIDIAN_ASAR) io.copyFileSync(process.env.ATELIER_OBSIDIAN_ASAR, path.join(layout.profile, path.basename(process.env.ATELIER_OBSIDIAN_ASAR)));
  io.writeFileSync(path.join(layout.profile, 'obsidian.json'), JSON.stringify({
    vaults: { atelierg00synthetic: { path: layout.vault, ts: Date.now(), open: true } }, cli: true, updateDisabled: true }));
  return layout;
}

// The layout roots createLayout made in this process: real path -> device and file number when it was made.
const CREATED_ROOTS = new Map();
// The path the system resolves, links included; on macOS in the case the volume stores it.
const realPath = (target) => { try { return fs.realpathSync.native(target); } catch { return path.resolve(target); } };
// macOS and Windows volumes ignore case by default, so a path that differs only in case may name the same directory.
const foldCase = (value) => (process.platform === 'darwin' || process.platform === 'win32' ? value.toLowerCase() : value);
// Device and file number, links followed: a HOME reached through a link is the directory the link leads to.
const reachedIdentity = (target) => { try { const stat = fs.statSync(target, { bigint: true }); return `${stat.dev}:${stat.ino}`; } catch { return null; } };
const ownHomes = () => {
  const homes = [os.homedir(), process.env.HOME];
  try { homes.push(os.userInfo().homedir); } catch { /* no account entry to read */ }
  return homes.filter((home) => typeof home === 'string' && home !== '');
};

// An instance's HOME holds the command-line socket that launch removes, and the app it starts listens there. It must
// not be this user's own HOME, however it is reached (the account's home, os.homedir(), $HOME, through a link, or in
// another case), and it must lie inside a layout root this process made that is still that directory.
export function assertPrivateHome(home) {
  const real = realPath(home);
  const identity = reachedIdentity(home);
  for (const own of ownHomes()) {
    if ((identity !== null && identity === reachedIdentity(own)) || foldCase(real) === foldCase(realPath(own))) throw new Error('Refusing: the instance HOME is this user\'s own');
  }
  const inside = [...CREATED_ROOTS].some(([root, recorded]) => {
    let current;
    try { current = directoryIdentity(fs, root); } catch { return false; }
    const relative = path.relative(foldCase(root), foldCase(real));
    return recorded !== null && current === recorded && relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
  });
  if (!inside) throw new Error('Refusing: the instance HOME is not inside a layout root this process created');
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
//     showed it as the child of a process already owned. A table takes time
//     to read and describes the past, so lineage starts only at a handle the
//     run held before that table was read and still holds after it; for the
//     whole read that number was this run's own child's. It continues only
//     through a process recorded by an earlier read that still answers with
//     its recorded identity when read back alone after the table: it existed
//     before the read began and was itself after it ended, so for the whole
//     read that number was its. A process first recorded from a table passes
//     lineage on only from the next read, because that table may have read
//     its children's rows while its number still belonged to another
//     process. Immediately before every signal the process is read back
//     alone, and it is signalled only if its number, user, start time and
//     command are still the ones recorded;
//   - a directory is owned only when this run created it, and is removed only
//     while the path still names that same directory (device and file number).
// A process that merely names one of the run's directories on its command line
// is never signalled. While one is still there the roots are kept and the run
// says so.
// A process table that cannot be read is unknown custody, never proof of exit.
//
// Limits, stated rather than hidden.
//   - The deadline is cooperative: synchronous work is not interrupted.
//   - Seeing takes time. Reading the whole table takes most of a second on a
//     busy desktop, and the watcher begins a read one second after the last
//     one ended. A process is recorded by the first read that begins after it
//     exists and after its parent became the run's (a handle, or a process
//     recorded by an earlier read), and ends while that parent is still the
//     run's (held, or answering with its recorded identity). The run
//     therefore learns its tree one level per read: the child of a helper is
//     recorded at the earliest by the read after the one that recorded the
//     helper. Before its first signal, cleanup reads again until a read
//     records nothing new (within the first half of the time SIGTERM is
//     given), so what is there when cleanup begins is recorded before any
//     parent is ended. The children of a process that exits before they are
//     recorded cannot be recorded at all. Such a process, and one that
//     detaches itself from the app between two reads, is never signalled.
//     When a table still shows it under a parent that was the run's before
//     that read began and has exited, or changed, by its end, the run
//     remembers it by identity until it is seen gone, and keeps the roots
//     while it is there; what a table shows under a remembered process is
//     remembered with it. Otherwise it is reported, and the roots kept, only
//     if its command line names one of the run's directories. That includes
//     a daemon's double fork: a process that starts a child and exits at once
//     leaves that child unseen unless a table read while both existed shows
//     it under its parent, and reads are about a second apart.
//   - A recorded descendant is known by number, user, start time (to the
//     second) and command. Another process with the same number, user and
//     command that started within that same second would be taken for it.
//   - A descendant's readback and its signal run in one turn of this process
//     with nothing scheduled between them, but the readback is a separate ps
//     process: from ps reading the identity to the signal lies that
//     process's exit and this one's return from waiting on it, a few
//     milliseconds on an idle host and more on a loaded one. A descendant
//     that exits inside that time and whose number is given to a new process
//     at once would be signalled; macOS offers no handle on a process that is
//     not one's own child that would close this.
//   - The app's output streams, which a process it starts inherits, must
//     close before the run counts the app as gone; when they do not, the run
//     stops waiting on them so that it can end and report.
//
// Outside an owned run (the other desktop procedures and the experiment
// script) nothing is recorded, and nothing is signalled by number. The app and
// each command-line call are signalled only through the handle spawn returned,
// which signals nothing once the process has exited. A launch that gives up
// signals the app's process group, which the app leads because it was started
// detached, only while that handle still holds the app: until the app is
// collected its number, and so the group's, cannot be given to another
// process. Limits of that:
//   - nothing below the app is ended by this module: a helper that leaves the
//     app's group, or outlives an app that exited before the launch gave up,
//     keeps running, and quitting leaves the helpers to the app's own shutdown;
//   - the stale command-line socket under the instance's HOME is removed by
//     path before each launch. A launch is refused first unless that HOME lies
//     inside a layout root this process made and still holds, and is not this
//     user's own however it is reached (assertPrivateHome), so the socket of
//     the person's own app is never removed.
// ---------------------------------------------------------------------------

const PS_FIELDS = ['-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='];
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
const psOptions = (timeout) => ({ encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
const psFailure = (what, error) => new Error(`${what} could not be read (${error.code ?? error.signal ?? error.status ?? 'failed'})`);

// The whole table, read without blocking this process: on a busy desktop one
// read takes most of a second, and the app's output must be read meanwhile.
export const readProcessTable = (timeout = 5000) => new Promise((resolve, reject) => {
  execFile('/bin/ps', ['-ww', '-A', ...PS_FIELDS], psOptions(timeout), (error, stdout) => {
    if (error) { reject(psFailure('The process table', error)); return; }
    try { resolve(parseProcessTable(stdout)); } catch (failure) { reject(failure); }
  });
});

// One process, read synchronously so that its signal can follow in the same
// turn. Null when no process holds the number (ps answers 1 and prints nothing).
export function readOneProcess(pid, timeout = 5000) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('A process number is a positive integer');
  let text;
  try { text = execFileSync('/bin/ps', ['-ww', '-p', String(pid), ...PS_FIELDS], { ...psOptions(timeout), stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    if (error.status === 1 && String(error.stdout ?? '').trim() === '' && String(error.stderr ?? '').trim() === '') return null;
    throw psFailure(`Process ${pid}`, error);
  }
  const rows = parseProcessTable(text);
  if (rows.length !== 1 || rows[0].pid !== pid) throw new Error(`Process ${pid} could not be read (unexpected answer)`);
  return rows[0];
}

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
// The room in the reserve kept for the failure line; the rest of the reserve may hold a failed receipt.
export const FAILURE_LINE_BYTES = 4096;

export class OwnedRun {
  constructor({ readTable = readProcessTable, readOne = readOneProcess, signal = (pid, name) => process.kill(pid, name), now = Date.now, pause = sleep, uid = process.getuid?.(), self = process.pid, io = fs,
    workMs = 900000, cleanupMs = 120000, watchMs = 1000, outputBytes = 64 * 1024 * 1024 } = {}) {
    this.readTable = readTable; this.readOne = readOne; this.signal = signal; this.now = now; this.pause = pause; this.uid = uid; this.self = self; this.io = io;
    this.deadline = now() + workMs; this.cleanupMs = cleanupMs; this.watchMs = watchMs;
    // The output bound: everything the run keeps, counted once. A reserve (a sixteenth, at most 256 KiB) is set
    // aside for what a failed run still says: a failed receipt with shortened evidence, and a failure line.
    this.outputLimit = outputBytes; this.outputUsed = 0; this.failureOutputReserve = Math.min(256 * 1024, Math.floor(outputBytes / 16)); this.failureOutputUsed = 0;
    this.nativeUsed = 0; this.nativeCredited = 0; // app and command-line output counted as it arrived, and how much of it a final copy has replaced
    this.outputOverAllowance = 0; this.outputCreditChargedBack = 0; // by how much what the run keeps exceeds its allowance once a credit was charged back, and that credit
    this.roots = new Map(); // path -> identity of the directory this run created there
    this.profiles = new Set(); // profile directories of the apps this run started; like the roots, observed and never a reason to signal
    this.children = new Set(); // processes this run spawned and has not yet seen closed, each held by its handle
    this.descendants = new Map(); // number -> identity of a process seen as the child of an owned process
    this.strays = new Map(); // number -> identity of a process tied to this run that it does not own, and so never signals
    this.orphans = new Map(); // number -> identity of a process a table showed, unrecorded, under a parent that lapsed during the read
    this.unknown = new Set(); this.watchers = new Set(); this.reading = null; this.tableReads = 0;
    this.lastRecorded = 0; // how many descendants the last read recorded for the first time
  }

  assertActive() { if (this.failure) throw this.failure; if (this.now() >= this.deadline) throw this.fail('Whole-run deadline exceeded'); }
  fail(message) { return this.failure ??= new Error(message); }
  readbackMs() { return Math.max(1, Math.min(5000, (this.cleanupUntil ?? this.deadline) - this.now())); }

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
  // App and command-line output, counted as it arrives and before it is kept.
  consume(bytes) { this.assertActive(); this.reserveOutput(bytes); this.nativeUsed += bytes; }
  // The bytes the receipt writer will write (two-space JSON and a newline). A
  // document that does not fit is refused whole; it is never shortened to fit.
  serializeFinal(value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text) > this.outputAllowance - this.outputUsed) throw outputRefusal();
    return text;
  }
  // What the final output adds to the bound: all of it, except evidence bytes that are a copy of output already
  // counted when it arrived and whose original is about to be removed with the run's roots. Such a copy
  // replaces the original, so it is counted once. Nothing else is credited, whatever its size. The credit is a
  // prediction: when a root is kept after all, it is charged back (see chargeBackCredit).
  finalCharge({ bytes = 0, evidenceBytes = 0, nativeCopyBytes = 0 }) {
    const credit = Math.max(0, Math.min(nativeCopyBytes, evidenceBytes, this.nativeUsed - this.nativeCredited));
    return { charge: bytes + evidenceBytes - credit, credit };
  }
  // One reservation for everything the final output will write, made before any of it is written.
  async commitFinalOutput({ bytes, evidenceBytes = 0, nativeCopyBytes = 0, commit }) {
    const { charge, credit } = this.finalCharge({ bytes, evidenceBytes, nativeCopyBytes });
    this.reserveOutput(charge);
    this.nativeCredited += credit;
    return commit();
  }
  // A copy credited at the final commit replaced its original only if the roots were then removed. When a root is
  // kept after all (the final output failed after its reservation, or a removal failed), the original may still
  // be beside its copy, so the whole credit is charged back: which root held the original is not asked, and
  // counting a copy in full is never an undercount. The bytes are on disk already, so the charge cannot be
  // refused; when what the run keeps then exceeds its allowance, the run says by how much.
  chargeBackCredit(cleanup) {
    if (!cleanup.retained || this.nativeCredited === 0) return;
    const credit = this.nativeCredited;
    this.nativeCredited = 0; this.outputUsed += credit;
    this.outputCreditChargedBack = credit; cleanup.outputCreditChargedBack = credit;
    const over = this.outputUsed - this.failureOutputUsed - this.outputAllowance;
    if (over > 0) { this.outputOverAllowance = over; cleanup.outputOverAllowance = over; }
  }
  // What a failed receipt may use: the reserve, less the room kept for the failure line.
  get reducedAllowance() { return Math.max(0, this.failureOutputReserve - this.failureOutputUsed - Math.min(FAILURE_LINE_BYTES, this.failureOutputReserve)); }
  async commitFromReserve({ bytes, commit }) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.reducedAllowance) throw outputRefusal();
    this.failureOutputUsed += bytes; this.outputUsed += bytes;
    return commit();
  }
  // What a failed run says when it can promise nothing else: bounded, paid from
  // its own reserve, naming the roots it kept and, when a credit was charged
  // back, that credit and by how much what the run keeps exceeds its allowance. It is not a receipt.
  failureDiagnostic({ procedureId = null, error = null, retainedRoots = [] } = {}) {
    const base = { procedureId: procedureId === null ? null : String(procedureId).slice(0, 32), outcome: 'failed', closes: false, humanAcceptance: null, code: 'owned-run-failed', inspectEvidenceIfPresent: true,
      ...(this.outputCreditChargedBack > 0 ? { outputCreditChargedBackBytes: this.outputCreditChargedBack } : {}), ...(this.outputOverAllowance > 0 ? { outputOverAllowanceBytes: this.outputOverAllowance } : {}) };
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

  // Reads the whole table, without blocking, and brings the record of descendants up to date. Signals nothing.
  // A read already under way is shared: two never run at once.
  observe() {
    this.reading ??= this.readAndRecord().finally(() => { this.reading = null; });
    return this.reading;
  }
  // A read that begins now: one already under way began earlier and may not show what exists now.
  async observeFresh() {
    while (this.reading) await this.reading.catch(() => {});
    return this.observe();
  }
  heldNumbers() { return new Set([...this.children].filter((entry) => this.unreaped(entry)).map((entry) => entry.child.pid)); }
  async readAndRecord() {
    // The handles lineage may start from are fixed before the table is read. A child adopted while the read is
    // under way is not among them: the table may show its number as whatever held it before. So are the recorded
    // descendants it may continue through: one first recorded from this table is not among them.
    const heldBefore = [...this.children].filter((entry) => this.unreaped(entry));
    const recordedBefore = new Map(this.descendants);
    let rows;
    try {
      if ((this.cleanupUntil ?? this.deadline) - this.now() <= 0) throw new Error('Process readback deadline exceeded');
      rows = await this.readTable(this.readbackMs());
    } catch (error) { this.unknown.add(`process-readback:${error.message}`); error.readback = true; throw error; }
    this.tableReads += 1;
    this.record(rows, heldBefore, recordedBefore);
    return rows;
  }
  // `rows` is a table read some time ago; `heldBefore` are the handles the run held before that read began, and
  // `recordedBefore` the descendants it had recorded then (number -> the recorded identity).
  record(rows, heldBefore, recordedBefore = new Map()) {
    const current = new Map(rows.map((row) => [row.pid, row]));
    // The numbers the run's own handles hold now. They are used only to leave rows out: the table is older than
    // they are, so what it says of such a number may be about whatever held it before.
    const held = this.heldNumbers();
    // A recorded descendant that is gone, has exited, or whose number one of the run's own handles now holds, is
    // released: whatever holds that number later is not this run's descendant. One that answers with another
    // identity is released too, and the run no longer claims a clean end.
    for (const [pid, recorded] of this.descendants) {
      const row = current.get(pid);
      if (!row || row.exited || held.has(pid)) this.descendants.delete(pid);
      else if (!sameProcess(recorded, row)) { this.descendants.delete(pid); this.unknown.add(`changed:${pid}`); }
    }
    // Lineage starts only at a handle held before this table was read and still held now: an uncollected child
    // keeps its number, so for the whole read that number was this run's own child's, and the table's row for
    // it is that child's. The row must say so too: this process is its parent, and it started when it was bound.
    const roots = new Set();
    // Numbers that were the run's when this read began and are not by its end: a handle collected meanwhile, a
    // descendant found gone or changed.
    const lapsed = new Set();
    for (const entry of heldBefore) {
      if (!this.unreaped(entry)) { lapsed.add(entry.child.pid); continue; }
      const row = current.get(entry.child.pid);
      if (!row) continue;
      if (row.ppid !== this.self || (entry.bound && row.start !== entry.bound.start)) { this.unknown.add(`spawned-row-mismatch:${row.pid}`); continue; }
      roots.add(row.pid);
    }
    // A recorded descendant has no handle, and ps does not read every row at one instant: a row read a moment
    // before or after its own may name as parent a process that held its number then. Lineage continues only
    // through a descendant recorded by an earlier read, still recorded with that same identity, that answers with
    // it when read back alone after this table: it held the number before the read began and after it ended, so
    // for the whole read the number was its. One first recorded from this table passes lineage on only from the
    // next read: its own row shows it from that row on, not for the rows read before it.
    const confirmed = new Map();
    const stillItself = (pid) => { if (!confirmed.has(pid)) confirmed.set(pid, this.confirmDescendant(pid)); return confirmed.get(pid); };
    const earlier = (pid) => recordedBefore.has(pid) && this.descendants.get(pid) === recordedBefore.get(pid);
    const owned = (pid) => roots.has(pid) || (earlier(pid) && stillItself(pid));
    // A number just found not to be itself is not recorded again from this table, which is older than that finding.
    const adoptable = (row) => !row.exited && row.pid > 1 && row.pid !== this.self && !held.has(row.pid) && !this.descendants.has(row.pid) && confirmed.get(row.pid) !== false && owned(row.ppid);
    // One pass: what may pass lineage on was fixed before this table was read, so nothing recorded here changes it.
    let recordedNow = 0;
    for (const row of rows) if (adoptable(row) && row.uid === this.uid) { this.descendants.set(row.pid, row); recordedNow += 1; }
    this.lastRecorded = recordedNow;
    // What is tied to this run without being its own (a child that runs as another user, or anything whose
    // command line mentions one of the run's directories, such as a helper that detached itself from the app) is
    // remembered until it is seen gone, and is never signalled.
    const places = [...this.roots.keys(), ...this.profiles];
    for (const [pid, recorded] of this.strays) {
      const row = current.get(pid);
      if (!row || row.exited || held.has(pid) || !sameProcess(recorded, row)) this.strays.delete(pid);
    }
    for (const row of rows) {
      if (row.exited || row.pid === this.self || held.has(row.pid) || this.descendants.has(row.pid) || this.strays.has(row.pid)) continue;
      if (adoptable(row) || places.some((place) => mentionsDirectory(row.command, place))) this.strays.set(row.pid, row);
    }
    // A process this table shows, unrecorded, under a number that lapsed during the read may be a child that
    // number's process left behind, which can no longer be recorded. It is never signalled. Like a stray it is
    // remembered by identity until it is seen gone (or recorded after all), and while it is there the run does not
    // claim a clean end and keeps its roots. Remembering signals nothing: a stale row can only keep a root.
    // A remembered process that is gone, or changed, by this table is itself a parent that lapsed; one recorded after
    // all is the run's own, and its children are recorded by lineage.
    for (const [pid, recorded] of this.orphans) {
      const row = current.get(pid);
      if (row && !row.exited && this.descendants.has(pid)) this.orphans.delete(pid);
      else if (!row || row.exited || held.has(pid) || !sameProcess(recorded, row)) { this.orphans.delete(pid); lapsed.add(pid); }
    }
    for (const pid of recordedBefore.keys()) if (!earlier(pid)) lapsed.add(pid);
    const rememberable = (row) => !row.exited && row.uid === this.uid && row.pid > 1 && row.pid !== this.self && !held.has(row.pid) && !this.descendants.has(row.pid) && !this.orphans.has(row.pid);
    for (const row of rows) if (lapsed.has(row.ppid) && rememberable(row)) this.orphans.set(row.pid, row);
    // What a remembered process starts is remembered with it, as far as this table shows it under one still here:
    // closed within the table, so the child a forking process leaves behind holds the roots after its parent exits.
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) if (this.orphans.has(row.ppid) && rememberable(row)) { this.orphans.set(row.pid, row); grew = true; }
    }
  }

  // Reads one recorded descendant back alone, now, synchronously. One that is gone, has exited, or whose number
  // one of the run's own handles now holds is released; one that answers with another identity is released and
  // the run no longer claims a clean end. True only while it still answers with the identity recorded.
  confirmDescendant(pid) {
    const recorded = this.descendants.get(pid);
    if (!recorded) return false;
    // A number one of the run's own handles holds is that handle's, and is only ever signalled through it.
    if (this.heldNumbers().has(pid)) { this.descendants.delete(pid); return false; }
    let current;
    try { current = this.readOne(pid, this.readbackMs()); } catch (error) { this.unknown.add(`process-readback:${error.message}`); error.readback = true; throw error; }
    if (!current || current.exited) { this.descendants.delete(pid); return false; }
    if (!sameProcess(recorded, current)) { this.descendants.delete(pid); this.unknown.add(`changed:${pid}`); return false; }
    return true;
  }

  // A descendant has no handle. It is read back alone and signalled in the same turn, with nothing scheduled in
  // between, only while its number, user, start time and command are still the ones recorded.
  signalDescendant(pid, name) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === this.self || !this.confirmDescendant(pid)) return false;
    try { this.signal(pid, name); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }

  // Reads a spawned process back alone: this run's own child, of this user, running the program it was asked to
  // run. A child that cannot be read back stays held by its handle, and the run stops.
  async bind(entry, { program, profile } = {}) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let row;
      try { row = this.readOne(entry.child.pid, this.readbackMs()); } catch (error) { this.unknown.add(`process-readback:${error.message}`); throw error; }
      if (row && !row.exited && row.uid === this.uid && row.ppid === this.self && (row.command === program || row.command.startsWith(`${program} `)) && (!profile || namesProfile(row.command, profile))) { entry.bound = row; return row; }
      if (entry.closed || !this.unreaped(entry)) return null;
      await this.pause(10);
    }
    this.unknown.add(`unbound:${entry.child.pid}`);
    throw this.fail('Spawn identity could not be bound');
  }

  // Keeps the record of descendants current while the app runs: one that outlives its parent unseen can only be
  // reported afterwards, never ended. The next read is scheduled only once the last one has finished.
  watch() {
    const watcher = { timer: null, stopped: false };
    const schedule = () => {
      if (watcher.stopped) return;
      watcher.timer = setTimeout(async () => {
        try { this.assertActive(); await this.observe(); } catch (error) { this.fail(error.message); return; }
        schedule();
      }, this.watchMs);
      watcher.timer.unref?.();
    };
    schedule();
    this.watchers.add(watcher);
    return watcher;
  }
  stopWatching() {
    for (const watcher of this.watchers) { watcher.stopped = true; clearTimeout(watcher.timer); }
    this.watchers.clear();
  }

  settled() { return this.children.size === 0 && this.descendants.size === 0 && this.strays.size === 0 && this.orphans.size === 0; }

  // A spawned process whose streams did not close (a process the run cannot see still holds them, or it could
  // not be ended) must not keep this process alive once the run has reported it: its streams are closed on this
  // side and its handle no longer holds the event loop. It stays recorded as unknown custody.
  release() {
    for (const { child } of this.children) {
      for (const stream of child.stdio ?? [child.stdin, child.stdout, child.stderr]) stream?.destroy?.();
      child.unref?.();
    }
  }

  async cleanup({ until = this.cleanupUntil ?? this.now() + this.cleanupMs } = {}) {
    this.cleanupUntil = until;
    this.stopWatching();
    let readable = true;
    const read = async (step) => { try { await step(); } catch (error) { readable = false; if (!error.readback) this.unknown.add(`process-cleanup:${error.message}`); } };
    // Without a readable table only the spawned processes can be joined, and the run reports unknown custody.
    const done = () => (readable ? this.settled() : this.children.size === 0);
    // SIGTERM is given at most ten seconds and at most half the budget, so SIGKILL always has time of its own.
    const terminate = this.now() + Math.max(0, Math.min(10000, (until - this.now()) / 2));
    // The descendants are read before the first signal: once their parent is gone the lineage cannot be read. A read
    // that begins now, while what was spawned is still running (a read the watcher began earlier is older), and
    // again until a read records nothing new, because each read learns one level of the tree. These reads use at
    // most the first half of the time SIGTERM is given, as far as the last read's length predicts the next one's, so
    // that SIGTERM keeps a grace of its own. A read is never cut short: one that timed out would leave the table
    // unread, and then nothing could be signalled by lineage.
    const readsUntil = this.now() + (terminate - this.now()) / 2;
    const freshRead = async () => { const began = this.now(); await read(() => this.observeFresh()); return this.now() - began; };
    for (let took = await freshRead(); readable && this.lastRecorded > 0 && this.now() + took < readsUntil;) took = await freshRead();
    for (const [name, stage] of [['SIGTERM', terminate], ['SIGKILL', until]]) {
      // Spawned processes are signalled through their handles, which needs no process table.
      for (const entry of this.children) this.signalChild(entry, name);
      if (readable) await read(() => { for (const pid of [...this.descendants.keys()]) { if (this.now() >= until) throw new Error('Cleanup deadline exceeded'); this.signalDescendant(pid, name); } });
      for (;;) {
        if (readable && this.now() < until) await read(() => this.observe());
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
      for (const pid of this.orphans.keys()) this.unknown.add(`unrecorded-child-remains:${pid}`);
    } else if (!readable && this.children.size > 0) this.unknown.add('process-join-incomplete');
    if (this.children.size > 0) this.release();
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
    this.chargeBackCredit(cleanup);
    if (error || !cleanup.joined) { const failure = error ?? new Error('Owned cleanup could not be verified'); failure.cleanup = cleanup; throw failure; }
    return { value, cleanup };
  }
}

// The installed app and its command-line tool. A test names a harmless stand-in
// instead: the command and the arguments that come before the real ones.
export const DEFAULT_LAUNCHER = Object.freeze({ app: Object.freeze([path.join(APP_DIR, 'Obsidian')]), cli: Object.freeze([path.join(APP_DIR, 'obsidian-cli')]) });

export class Instance {
  constructor(layout, { custody, launcher = DEFAULT_LAUNCHER } = {}) {
    this.custody = custody; this.layout = layout; this.env = { ...process.env, HOME: layout.home }; this.transportRetries = [];
    this.launcher = { app: [...(launcher.app ?? DEFAULT_LAUNCHER.app)], cli: [...(launcher.cli ?? DEFAULT_LAUNCHER.cli)] };
  }

  get socket() { return path.join(this.layout.home, '.obsidian-cli.sock'); }

  // readyTimeoutMs bounds the wait for the CLI socket and the vault listing;
  // a large vault takes the app longer to open than the 30 s default.
  async launch({ readyTimeoutMs = 30000 } = {}) {
    this.custody?.assertActive();
    // The stale socket is removed next. Under this user's own HOME it would be the person's own app's.
    assertPrivateHome(this.layout.home);
    this.custody?.profiles.add(this.layout.profile);
    fs.rmSync(this.socket, { force: true });
    const [command, ...leading] = this.launcher.app;
    const logPath = path.join(this.layout.root, 'app.log');
    const log = this.custody ? 'pipe' : fs.openSync(logPath, 'a');
    this.child = spawn(command, [...leading, `--user-data-dir=${this.layout.profile}`, '--use-mock-keychain', '--password-store=basic',
      // Real typing implies a focused window. The test window is usually hidden, and Chromium then throttles the
      // app's own save timers, which is not a condition a typing user can be in.
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'], { env: this.env, detached: true, stdio: ['ignore', log, log] });
    if (this.custody) {
      // Held by its handle from the turn it was spawned; its output is counted before it is kept.
      const entry = this.custody.adopt(this.child);
      for (const stream of [this.child.stdout, this.child.stderr]) stream?.on('data', (chunk) => {
        try { this.custody.consume(chunk.length); fs.appendFileSync(logPath, chunk); } catch (error) { this.custody.fail(error.message); }
      });
      await this.custody.bind(entry, { program: this.launcher.app.join(' '), profile: this.layout.profile });
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
    if (!this.custody) this.endGroup('SIGKILL');
    throw new Error('Isolated Obsidian instance did not become ready');
  }

  // Outside an owned run. The app leads its own process group (it was started detached), and the group is
  // signalled only while this handle still holds the app: until the app is collected, its number, which is the
  // group's, cannot be given to another process. Otherwise only the handle is used, which signals nothing once
  // the app has exited.
  endGroup(name) {
    const child = this.child;
    if (Number.isInteger(child?.pid) && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, name); return; } catch { /* no such group: fall back to the handle */ }
    }
    try { child?.kill(name); } catch { /* already gone */ }
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
      const [command, ...leading] = this.launcher.cli;
      const { stdout, stderr } = await run(command, [...leading, ...args], { env: this.env, maxBuffer: 64 * 1024 * 1024, timeout: 20000, killSignal: 'SIGKILL' });
      return stdout || stderr;
    } catch (error) {
      if (!error.killed) throw error;
      const [command, ...leading] = this.launcher.cli;
      const probe = await run(command, [...leading, 'eval', 'code=1+1'], { env: this.env, timeout: 8000, killSignal: 'SIGKILL' }).then(({ stdout }) => stdout.trim(), () => 'renderer-unresponsive');
      throw new Error(`CLI call timed out: ${args[0]} ${String(args[1] || '').slice(0, 60)}; renderer probe: ${probe}`);
    }
  }

  // The same call under an owned run: this run's own child, held by its handle, its output counted against the
  // run's bound as it arrives, and ended through that handle whatever the outcome. `onSpawn` is given the handle
  // the turn the call is spawned.
  async ownedCli(args, { onSpawn } = {}) {
    const custody = this.custody;
    custody.assertActive();
    let timer;
    const [command, ...leading] = this.launcher.cli;
    const child = spawn(command, [...leading, ...args], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = custody.adopt(child);
    onSpawn?.(entry);
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

  // How many processes one command-line call becomes. Under an owned run only, and read-only: the app holds one
  // `eval` call open for `holdMs` (a promise it resolves later), and while that call, the run's own child, is
  // still held, the run reads the table once as it always does and counts the rows under the call's number, its
  // children and theirs as that table shows them. Nothing else is started and nothing is signalled. It needs the
  // app, which answers the call, so it cannot be made before a launch; the run makes it right after its
  // isolation checks. A call that ended before the read did is reported as such, and its count may be short.
  async cliProcessShape({ holdMs = 3000 } = {}) {
    const custody = this.custody;
    if (!custody) throw new Error('The command-line process shape is read under an owned run only');
    if (!Number.isSafeInteger(holdMs) || holdMs < 0) throw new Error('holdMs is a non-negative integer');
    let entry = null;
    const call = this.ownedCli(['eval', `code=new Promise((resolve)=>setTimeout(()=>resolve('held'),${holdMs}))`], { onSpawn: (spawned) => { entry = spawned; } });
    call.catch(() => {});
    // A call refused before it was spawned (the run has stopped) has nothing to read; its refusal is the answer.
    if (entry === null) { await call; throw new Error('The command-line call was not spawned'); }
    const shape = { pid: entry.child.pid, holdMs, readWhileHeld: false, processes: null, error: null };
    try {
      const rows = await custody.observeFresh();
      shape.readWhileHeld = custody.unreaped(entry);
      const under = new Set([shape.pid]);
      for (let grew = true; grew;) { grew = false; for (const row of rows) if (!row.exited && !under.has(row.pid) && under.has(row.ppid)) { under.add(row.pid); grew = true; } }
      shape.processes = under.size;
    } catch (error) { shape.error = String(error.message).slice(0, 200); }
    try { shape.answered = (await call).includes('=> held'); } catch (error) { shape.answered = false; shape.error ??= String(error.message).slice(0, 200); }
    return shape;
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
    if (this.custody) {
      const cleanup = await this.custody.cleanup();
      if (!cleanup.joined) throw Object.assign(new Error('Owned app/helper/CLI cleanup unknown'), { cleanup });
      return cleanup;
    }

    // Through the handle spawn returned, never by number: once the app has exited the handle signals nothing,
    // whatever holds its number afterwards, and the wait reads the handle, not the number.
    const child = this.child;
    if (!child) return;
    const running = () => Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null;
    if (running()) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    for (let attempt = 0; attempt < 40 && running(); attempt += 1) await sleep(250);
    if (running()) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}
