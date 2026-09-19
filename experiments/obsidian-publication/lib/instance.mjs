// Isolated, disposable Obsidian test instance.
//
// Isolation has two independent parts: a private HOME (the CLI socket lives at
// $HOME/.obsidian-cli.sock, so neither this app nor this CLI can reach another
// session) and a private Electron profile (--user-data-dir). The only vault
// registered in that profile is a synthetic one created here. The private HOME
// has no login keychain, so Chromium's mock keychain is used; without it macOS
// raises a "Keychain Not Found" dialog on the desktop at every launch.

import { execFile, spawn } from 'node:child_process';
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

export function createLayout(root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-g00-'))) {
  const layout = { root, home: path.join(root, 'home'), profile: path.join(root, 'profile'), vault: path.join(root, 'vault'),
    staging: path.join(root, 'staging'), recovery: path.join(root, 'recovery') };
  for (const dir of [layout.home, layout.profile, path.join(layout.vault, 'notes'), layout.staging, layout.recovery]) fs.mkdirSync(dir, { recursive: true });
  if (process.env.ATELIER_OBSIDIAN_ASAR) fs.copyFileSync(process.env.ATELIER_OBSIDIAN_ASAR, path.join(layout.profile, path.basename(process.env.ATELIER_OBSIDIAN_ASAR)));
  fs.writeFileSync(path.join(layout.profile, 'obsidian.json'), JSON.stringify({
    vaults: { atelierg00synthetic: { path: layout.vault, ts: Date.now(), open: true } }, cli: true, updateDisabled: true }));
  return layout;
}

export class Instance {
  constructor(layout) { this.layout = layout; this.env = { ...process.env, HOME: layout.home }; }

  get socket() { return path.join(this.layout.home, '.obsidian-cli.sock'); }

  async launch() {
    fs.rmSync(this.socket, { force: true });
    const log = fs.openSync(path.join(this.layout.root, 'app.log'), 'a');
    this.child = spawn(path.join(APP_DIR, 'Obsidian'), [`--user-data-dir=${this.layout.profile}`, '--use-mock-keychain', '--password-store=basic'], { env: this.env, detached: true, stdio: ['ignore', log, log] });
    this.child.unref();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (fs.existsSync(this.socket)) {
        try { if ((await this.cli('vaults', 'verbose')).includes(this.layout.vault)) { await sleep(1500); return this.assertIsolated(); } } catch { /* still starting */ }
      }
      await sleep(250);
    }
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
    try {
      const { stdout, stderr } = await run(path.join(APP_DIR, 'obsidian-cli'), args, { env: this.env, maxBuffer: 64 * 1024 * 1024, timeout: 20000, killSignal: 'SIGKILL' });
      return stdout || stderr;
    } catch (error) {
      if (!error.killed) throw error;
      const probe = await run(path.join(APP_DIR, 'obsidian-cli'), ['eval', 'code=1+1'], { env: this.env, timeout: 8000, killSignal: 'SIGKILL' }).then(({ stdout }) => stdout.trim(), () => 'renderer-unresponsive');
      throw new Error(`CLI call timed out: ${args[0]} ${String(args[1] || '').slice(0, 60)}; renderer probe: ${probe}`);
    }
  }

  async version() { return (await this.cli('version')).trim(); }

  async bridge(payload) {
    const out = await this.cli('eval', `code=${buildEvalCode(payload)}`);
    const start = out.indexOf('=> ');
    if (start < 0) throw new Error(`Bridge returned no value: ${JSON.stringify(out.slice(0, 600))}`);
    return JSON.parse(out.slice(start + 3));
  }

  // Test stimulus only (not part of the protocol): fixed scripts that open
  // notes and place the caret. Real typing goes through typeText (CDP input).
  async stimulus(name, notePath, extra = {}) {
    const scripts = {
      open: `app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(P.path)).then(()=>'ok')`,
      openPopout: `app.workspace.openPopoutLeaf().openFile(app.vault.getFileByPath(P.path)).then(()=>'ok')`,
      closeAll: `(app.workspace.getLeavesOfType('markdown').forEach(l=>l.detach()),'ok')`,
      focusAt: `(()=>{const v=app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file&&v.file.path===P.path&&v.containerEl.ownerDocument===document);app.workspace.setActiveLeaf(v.leaf,{focus:true});v.editor.focus();const at=v.editor.getValue().indexOf(P.anchor);v.editor.setCursor(v.editor.offsetToPos(at+P.anchor.length));return 'ok'})()`,
      popoutEdit: `(()=>{const v=app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file&&v.file.path===P.path&&v.containerEl.ownerDocument!==document);const at=v.editor.getValue().indexOf(P.anchor);v.editor.replaceRange(P.text,v.editor.offsetToPos(at),v.editor.offsetToPos(at+P.anchor.length));return 'ok'})()`,
    };
    if (!scripts[name]) throw new Error(`Unknown stimulus ${name}`);
    const data = Buffer.from(JSON.stringify({ path: notePath, ...extra }), 'utf8').toString('base64');
    const reply = await this.cli('eval', `code=(()=>{const P=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${data}'),c=>c.charCodeAt(0))));return ${scripts[name]}})()`);
    if (!reply.includes('=> ok')) throw new Error(`Stimulus ${name} failed: ${reply.slice(0, 300)}`);
    return reply;
  }

  // Real input path: Chromium dispatches this like keyboard text entry into
  // the focused editor of the main window.
  async typeText(text) { return this.cli('dev:cdp', 'method=Input.insertText', `params=${JSON.stringify({ text })}`); }

  async quit() {
    if (!this.child) return;
    try { process.kill(this.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { process.kill(this.child.pid, 0); } catch { return; }
      await sleep(250);
    }
    try { process.kill(this.child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
