import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { ensureContainedPrivateDirectory, openRegularFileNoFollow, readRegularTextNoFollow, syncPrivateDirectory } from './private-state.mjs';

const host = createHash('sha256').update(hostname()).digest('hex');
const pendingPattern = /^\.atelier-write-[a-f0-9-]{36}\.tmp$/;
export const isPendingPrivateWrite = name => pendingPattern.test(name);

export { syncPrivateDirectory };

// Publish a complete immutable file with an atomic, non-overwriting hard link.
// A process interruption can leave a private staging file, never a partial final.
export function publishPrivateFile(file, bytes) {
  const directory = path.dirname(file);
  const pending = path.join(directory, `.atelier-write-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openRegularFileNoFollow(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(pending, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = openRegularFileNoFollow(file);
      try { if (!fs.readFileSync(existing).equals(Buffer.from(bytes))) throw error; }
      finally { fs.closeSync(existing); }
    }
    syncPrivateDirectory(directory);
    const actual = openRegularFileNoFollow(file);
    try { if (!fs.readFileSync(actual).equals(Buffer.from(bytes))) throw new Error('published file readback mismatch'); }
    finally { fs.closeSync(actual); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(pending); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function unavailable(diagnostic = { reason: 'ownership changed' }) {
  return Object.assign(new Error(`EEXIST: private state is locked (${diagnostic.reason}${diagnostic.file ? `: ${diagnostic.file}` : ''}); inspectPrivateLock and preserve ownership records before offline recovery`), { code: 'EEXIST', diagnostic });
}
function ownerState(record, legacy = false) {
  const pid = typeof record === 'number' ? record : record?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'invalid owner';
  if (!legacy && record?.host !== host) return 'host identity differs';
  try { process.kill(pid, 0); return 'process exists'; }
  catch (error) { return error.code === 'ESRCH' ? 'absent' : 'process identity unavailable'; }
}

// Read-only diagnosis. Older tickets were superseded by a successful successor;
// only the newest ticket owns this lock. A release marker prevents a completed
// successor from disappearing and resurrecting an obsolete owner on PID reuse.
export function inspectPrivateLock(lockPath) {
  const directory = `${lockPath}.owners`;
  let names;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { available: false, reason: 'unsafe ownership directory' };
    names = fs.readdirSync(directory).filter(name => !isPendingPrivateWrite(name)).sort();
  } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  const unexpected = names.find(name => !/^\d{12}\.(json|released)$/.test(name));
  if (unexpected) return { available: false, reason: 'unknown ownership file', file: unexpected };
  const nameSet = new Set(names);
  const tickets = names.filter(name => name.endsWith('.json'));
  const orphan = names.find(name => name.endsWith('.released') && !nameSet.has(name.replace(/\.released$/, '.json')));
  if (orphan) return { available: false, reason: 'release without owner', file: orphan };
  let legacy, legacyDigest = null;
  try {
    const bytes = readRegularTextNoFollow(lockPath);
    legacy = JSON.parse(bytes); legacyDigest = createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (error.code !== 'ENOENT') return { available: false, reason: 'unreadable legacy owner', file: path.basename(lockPath) };
  }
  if (tickets.length) {
    const file = tickets.at(-1), generation = Number(file.slice(0, 12));
    let body, record;
    try { body = readRegularTextNoFollow(path.join(directory, file)); record = JSON.parse(body); }
    catch { return { available: false, reason: 'unreadable owner', file }; }
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || !/^[a-f0-9]{64}$/.test(record?.host) || !/^[a-f0-9-]{36}$/.test(record?.nonce)) return { available: false, reason: 'invalid owner', file };
    if (legacyDigest !== null && record.legacyDigest !== legacyDigest) {
      const reason = ownerState(legacy, true);
      if (reason !== 'absent') return { available: false, reason: `legacy ${reason}`, file: path.basename(lockPath) };
    }
    const marker = file.replace(/\.json$/, '.released');
    if (names.includes(marker)) {
      try {
        if (readRegularTextNoFollow(path.join(directory, marker)) !== body) return { available: false, reason: 'release identity differs', file: marker };
      } catch { return { available: false, reason: 'unreadable release', file: marker }; }
      return { available: true, reason: 'released', generation, file, legacyDigest };
    }
    const reason = ownerState(record);
    return { available: reason === 'absent', reason, generation, file, legacyDigest };
  }
  if (legacyDigest === null) return { available: true, reason: 'unused', generation: 0, legacyDigest };
  const reason = ownerState(legacy, true);
  return { available: reason === 'absent', reason, generation: 0, file: path.basename(lockPath), legacyDigest };
}

export function acquirePrivateLock(lockPath) {
  const parent = path.dirname(lockPath);
  const directory = ensureContainedPrivateDirectory({ workspaceRoot: parent, directory: `${lockPath}.owners`, label: 'private lock' });
  let ticket, body;
  try {
    const status = inspectPrivateLock(lockPath);
    if (!status.available) throw unavailable(status);
    const generation = status.generation;
    if (generation >= 999999999999) throw unavailable({ reason: 'ownership generation exhausted' });
    ticket = path.join(directory, `${String(generation + 1).padStart(12, '0')}.json`);
    body = JSON.stringify({ pid: process.pid, host, nonce: randomUUID(), legacyDigest: status.legacyDigest });
    publishPrivateFile(ticket, body);
    let released = false;
    return () => {
      if (released) return;
      if (readRegularTextNoFollow(ticket) !== body) throw unavailable();
      publishPrivateFile(ticket.replace(/\.json$/, '.released'), body);
      released = true;
    };
  } catch (error) {
    // No operation has started: clean up only this exact attempted owner.
    if (ticket && body) {
      try { if (readRegularTextNoFollow(ticket) === body) fs.unlinkSync(ticket); }
      catch { /* Preserve uncertain ownership for offline diagnosis. */ }
    }
    if (error.code === 'EEXIST' && !error.diagnostic) throw unavailable(); throw error;
  }
}

export function withPrivateLock(lockPath, operation) {
  const release = acquirePrivateLock(lockPath);
  try { return operation(); } finally { release(); }
}

// Revalidate file identities on every read; unchanged prefixes reuse their
// verified result. A changed existing file forces replay, a missing tail is
// refused for the lifetime of this reader. Startup always verifies all history.
export function createVerifiedFileSequence({ directory, initial, apply, ignoreFiles = [] }) {
  let names = [], identities = [], value = initial();
  const identity = file => {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('non-regular history refused');
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  };
  return () => {
    const listed = fs.readdirSync(directory).filter(n => !isPendingPrivateWrite(n)).sort();
    // Explicit adapter metadata exceptions must still be regular files. Never
    // hide unknown filenames or malformed committed records behind a glob.
    for (const name of listed.filter(n => ignoreFiles.includes(n))) identity(path.join(directory, name));
    const next = listed.filter(n => !ignoreFiles.includes(n));
    if (next.length < names.length) throw new Error('history shortened; preserve and inspect');
    const ids = next.map(n => identity(path.join(directory, n)));
    const reuse = names.every((n, i) => n === next[i] && identities[i] === ids[i]);
    // Replay into a copy: a refused read must not leave the verified value
    // half-applied, or every later read of this reader would be refused.
    let result = reuse ? structuredClone(value) : initial();
    for (let i = reuse ? names.length : 0; i < next.length; i++) {
      const file = path.join(directory, next[i]);
      result = apply(readRegularTextNoFollow(file), result, i + 1, next[i]);
      if (identity(file) !== ids[i]) throw new Error('history changed during verification');
    }
    names = next; identities = ids; value = result;
    return structuredClone(result);
  };
}
