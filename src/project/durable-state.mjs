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

function unavailable() { return Object.assign(new Error('EEXIST: private state is locked; preserve ownership records and retry'), { code: 'EEXIST' }); }
function absentOwner(record, legacy = false) {
  const pid = typeof record === 'number' ? record : record?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || (!legacy && record?.host !== host)) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// Dead ownership tickets remain as evidence. A successor claims the next fixed
// generation with atomic non-overwrite publication; it never deletes a stale
// lock. Competing recoverers contend for the SAME next generation. Live, reused,
// foreign-host and uncertain PIDs always block. No timeout grants ownership.
export function acquirePrivateLock(lockPath) {
  const parent = path.dirname(lockPath);
  const directory = ensureContainedPrivateDirectory({ workspaceRoot: parent, directory: `${lockPath}.owners`, label: 'private lock' });
  let ticket, body;
  try {
    let prior;
    try { prior = JSON.parse(readRegularTextNoFollow(lockPath)); } catch (error) { if (error.code !== 'ENOENT') throw unavailable(); }
    if (prior !== undefined && !absentOwner(prior, true)) throw unavailable();
    let generation = 0;
    for (const name of fs.readdirSync(directory).sort()) {
      if (isPendingPrivateWrite(name)) continue;
      if (!/^\d{12}\.json$/.test(name)) throw unavailable();
      const value = JSON.parse(readRegularTextNoFollow(path.join(directory, name)));
      if (!absentOwner(value)) throw unavailable();
      generation = Math.max(generation, Number(name.slice(0, 12)));
    }
    if (generation >= 999999999999) throw unavailable();
    ticket = path.join(directory, `${String(generation + 1).padStart(12, '0')}.json`);
    body = JSON.stringify({ pid: process.pid, host, nonce: randomUUID() });
    publishPrivateFile(ticket, body);
    let released = false;
    return () => {
      if (released) return;
      if (readRegularTextNoFollow(ticket) !== body) throw unavailable();
      fs.unlinkSync(ticket); syncPrivateDirectory(directory); released = true;
    };
  } catch (error) {
    // Publication may succeed before its directory flush fails. No operation
    // has started yet: release only this nonce, never a competing owner.
    if (ticket && body) {
      try { if (readRegularTextNoFollow(ticket) === body) fs.unlinkSync(ticket); }
      catch { /* Retain uncertain ownership for explicit diagnosis. */ }
    }
    if (error.code === 'EEXIST') throw unavailable(); throw error;
  }
}

export function withPrivateLock(lockPath, operation) {
  const release = acquirePrivateLock(lockPath);
  try { return operation(); } finally { release(); }
}

// Revalidate file identities on every read; unchanged prefixes reuse their
// verified result. A changed existing file forces replay, a missing tail is
// refused for the lifetime of this reader. Startup always verifies all history.
export function createVerifiedFileSequence({ directory, initial, apply }) {
  let names = [], identities = [], value = initial();
  const identity = file => {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('non-regular history refused');
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  };
  return () => {
    const next = fs.readdirSync(directory).filter(n => !isPendingPrivateWrite(n)).sort();
    if (next.length < names.length) throw new Error('history shortened; preserve and inspect');
    const ids = next.map(n => identity(path.join(directory, n)));
    const reuse = names.every((n, i) => n === next[i] && identities[i] === ids[i]);
    let result = reuse ? value : initial();
    for (let i = reuse ? names.length : 0; i < next.length; i++) {
      const file = path.join(directory, next[i]);
      result = apply(readRegularTextNoFollow(file), result, i + 1, next[i]);
      if (identity(file) !== ids[i]) throw new Error('history changed during verification');
    }
    names = next; identities = ids; value = result;
    return structuredClone(result);
  };
}
