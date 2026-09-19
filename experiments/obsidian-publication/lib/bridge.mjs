// Fixed in-app bridge for the G00 publication feasibility prototype.
//
// The script body below is a constant. The only variable part of an eval call
// is a base64-encoded JSON payload that is validated here before it is sent.
// Note text never becomes code: candidate and recovery bytes travel as files
// and are bound by SHA-256, not interpolated.

const OPS = new Set(['inspect', 'publish', 'collect']);
const HALTS = new Set(['none', 'after-link', 'after-rename']);
const EXCHANGES = new Set(['atomic-swap', 'link-rename']);
// 'app-save' is the rejected variant, kept only as the negative control for the
// no-write-after-publication regression: it lets the app rewrite the note in place.
const EDITOR_ROUTES = new Set(['no-write', 'app-save']);
const SHA = /^[0-9a-f]{64}$/;

export const PROTOCOL_ID = 'obsidian-cli-critical-section/v1-prototype';

export function validatePayload(payload) {
  const fail = (message) => { throw new TypeError(`Invalid bridge payload: ${message}`); };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('object required');
  const allowed = ['op', 'path', 'baseSha256', 'candidateSha256', 'stagedPath', 'recoveryLinkPath', 'guardMs', 'haltAt', 'exchange', 'editorRoute'];
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) fail(`unknown key ${key}`);
  if (!OPS.has(payload.op)) fail('unknown op');
  const notePath = payload.path;
  if (typeof notePath !== 'string' || !notePath.endsWith('.md') || notePath.startsWith('/')
    || notePath.split('/').some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('path must be a relative visible Markdown path');
  }
  if (payload.op === 'publish') {
    if (!SHA.test(payload.baseSha256) || !SHA.test(payload.candidateSha256)) fail('sha256 digests required');
    for (const key of ['stagedPath', 'recoveryLinkPath']) {
      if (typeof payload[key] !== 'string' || !payload[key].startsWith('/')) fail(`${key} must be absolute`);
    }
    if (!Number.isInteger(payload.guardMs) || payload.guardMs < 0 || payload.guardMs > 30000) fail('guardMs out of range');
    if (!HALTS.has(payload.haltAt ?? 'none')) fail('unknown haltAt');
    if (!EXCHANGES.has(payload.exchange)) fail('unknown exchange');
    if (!EDITOR_ROUTES.has(payload.editorRoute ?? 'no-write')) fail('unknown editorRoute');
  } else if (Object.keys(payload).some((key) => !['op', 'path'].includes(key))) {
    fail('inspect and collect accept only op and path');
  }
  return payload;
}

// Runs inside the Obsidian renderer. Everything between "critical section
// begins" and "critical section ends" is synchronous, so no editor input
// event in any window of this vault can interleave with it.
function inApp(P) {
  const fs = require('fs');
  const nodePath = require('path');
  const crypto = require('crypto');
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const t0 = performance.now();
  const trace = [];
  const step = (event, detail) => trace.push({ ms: Number((performance.now() - t0).toFixed(3)), event, ...(detail || {}) });
  const full = nodePath.join(app.vault.adapter.getBasePath(), P.path);
  const views = () => {
    const found = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view && view.file && view.file.path === P.path && view.editor && typeof view.getViewData === 'function') found.push(view);
    });
    return found;
  };
  const describe = (view) => {
    const text = view.getViewData();
    return { dirty: Boolean(view.dirty), bufferSha256: sha(text), bufferBase64: Buffer.from(text, 'utf8').toString('base64'),
      popout: view.containerEl.ownerDocument !== document };
  };
  const disk = () => (fs.existsSync(full) ? sha(fs.readFileSync(full)) : null);
  const snapshot = () => ({ diskSha256: disk(), views: views().map(describe) });
  const done = (status, extra) => JSON.stringify({ status, trace, ...(extra || {}) });

  if (P.op === 'inspect') return done('inspected', snapshot());
  const store = (window.__atelierG00 = window.__atelierG00 || {});
  if (P.op === 'collect') return JSON.stringify({ status: 'collected', ...(store[P.path] || { missing: true }), ...snapshot() });

  // ---- critical section begins (synchronous) ----
  step('enter');
  if (!fs.existsSync(full)) return done('note-missing', snapshot());
  const open = views();
  // Capability floor: the no-write editor update below relies on the view's
  // saved-content marker. Refuse open notes on an app build that lacks it.
  if (open.some((view) => typeof view.lastSavedData !== 'string')) return done('unsupported-app', { wrote: false });
  const edited = open.filter((view) => view.dirty || sha(view.getViewData()) !== P.baseSha256);
  if (edited.length) return done('editor-edit', { ...snapshot(), wrote: false });
  if (disk() !== P.baseSha256) return done('disk-changed', { ...snapshot(), wrote: false });
  const candidate = fs.readFileSync(P.stagedPath);
  if (sha(candidate) !== P.candidateSha256) return done('staged-mismatch', { wrote: false });
  let externalCaptured = false;
  if (P.exchange === 'atomic-swap') {
    // Atomic exchange: whatever occupied the note path at this instant lands at
    // the staged path, so no concurrent replacement of the note can be lost.
    const SWAP = 'import ctypes,sys\nl=ctypes.CDLL(None,use_errno=True)\nr=l.renamex_np(sys.argv[1].encode(),sys.argv[2].encode(),2)\nsys.exit(0 if r==0 else (ctypes.get_errno() or 1))';
    require('child_process').execFileSync('/usr/bin/python3', ['-c', SWAP, P.stagedPath, full], { stdio: 'ignore' });
    step('swapped');
    if (P.haltAt === 'after-link') process.kill(process.pid, 'SIGKILL');
    fs.renameSync(P.stagedPath, P.recoveryLinkPath);
    externalCaptured = sha(fs.readFileSync(P.recoveryLinkPath)) !== P.baseSha256;
    step('recovered', { externalCaptured });
  } else {
    fs.linkSync(full, P.recoveryLinkPath);
    step('linked');
    if (sha(fs.readFileSync(P.recoveryLinkPath)) !== P.baseSha256) return done('disk-changed', { ...snapshot(), wrote: false, recoveryLinkRetained: true });
    if (P.haltAt === 'after-link') process.kill(process.pid, 'SIGKILL');
    fs.renameSync(P.stagedPath, full);
    step('renamed');
  }
  if (P.haltAt === 'after-rename') process.kill(process.pid, 'SIGKILL');
  const captured = [];
  const guard = app.workspace.on('editor-change', (editor, info) => {
    if (info && info.file && info.file.path === P.path) {
      const text = editor.getValue();
      step('editor-change', { buffer: sha(text).slice(0, 8), dirty: views().map((view) => Boolean(view.dirty)) });
      captured.push({ ms: Number((performance.now() - t0).toFixed(3)), bufferSha256: sha(text), bufferBase64: Buffer.from(text, 'utf8').toString('base64') });
    }
  });
  // Evidence only: vault events for this note during the guard window.
  const vaultRefs = ['modify', 'delete', 'create', 'rename'].map((name) => app.vault.on(name, (file) => {
    if (file && file.path === P.path) step(`vault-${name}`, { views: views().map((view) => ({ dirty: Boolean(view.dirty), buffer: sha(view.getViewData()).slice(0, 8) })) });
  }));
  const candidateText = candidate.toString('utf8');
  open.forEach((view) => {
    // Route the change through the editor so Obsidian never takes its lossy
    // external-modification merge path for this view. Obsidian must not write
    // the file itself afterwards: an in-place save here would overwrite an
    // outside writer that replaced the note after the exchange (observed).
    // Minimal line hunks in one transaction keep carets and selections in
    // untouched text where the user left them.
    const a = view.getViewData().split(/(?<=\n)/);
    const b = candidateText.split(/(?<=\n)/);
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    const starts = [0];
    for (const line of a) starts.push(starts[starts.length - 1] + line.length);
    const changes = [];
    let current = null;
    for (let i = 0, j = 0; i < a.length || j < b.length;) {
      if (i < a.length && j < b.length && a[i] === b[j]) { current = null; i += 1; j += 1; continue; }
      if (!current) { current = { from: starts[i], to: starts[i], old: '', text: '' }; changes.push(current); }
      if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) { current.text += b[j]; j += 1; } else { current.old += a[i]; i += 1; current.to = starts[i]; }
    }
    for (const change of changes) {
      let head = 0;
      while (head < change.old.length && head < change.text.length && change.old[head] === change.text[head]) head += 1;
      let tail = 0;
      while (tail < change.old.length - head && tail < change.text.length - head
        && change.old[change.old.length - 1 - tail] === change.text[change.text.length - 1 - tail]) tail += 1;
      change.from += head; change.to -= tail; change.text = change.text.slice(head, change.text.length - tail);
    }
    view.editor.transaction({ changes: changes.map((change) => ({ from: view.editor.offsetToPos(change.from), to: view.editor.offsetToPos(change.to), text: change.text })) });
    if (view.getViewData() !== candidateText) { step('hunk-fallback'); view.editor.setValue(candidateText); }
    if (P.editorRoute === 'app-save') view.save();
    else view.lastSavedData = candidateText; // the delayed save now sees nothing to write
  });
  captured.length = 0; // our own transaction is not a user edit
  step('editor-routed', { openViews: open.length });
  // ---- critical section ends ----

  // Return at once; evidence for the guard window is fetched later with
  // op "collect" so no CLI call stays open while other calls are made.
  const evidence = (store[P.path] = { trace, capturedEdits: captured, guardOpen: true });
  setTimeout(() => {
    app.workspace.offref(guard);
    vaultRefs.forEach((ref) => app.vault.offref(ref));
    step('settled');
    evidence.guardOpen = false;
  }, P.guardMs);
  return done(externalCaptured ? 'published-external-captured' : 'published', { ...snapshot(), wrote: true, openViews: open.length, externalCaptured });
}

export function buildEvalCode(payload) {
  const encoded = Buffer.from(JSON.stringify(validatePayload(payload)), 'utf8').toString('base64');
  return `(${inApp.toString()})(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'),c=>c.charCodeAt(0)))))`;
}
