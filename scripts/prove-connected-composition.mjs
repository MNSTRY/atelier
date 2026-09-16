// Synthetic proof only: two intercepted origins, no listener and no live auth.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { createFixtureHost } from '../examples/connected-composition/fixture-host.mjs';
import { digestBytes } from '../src/composition/registry.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const output = path.resolve(process.env.ATELIER_CONNECTED_PROOF_OUTPUT || path.join(root,'.artifacts/connected-composition'));
fs.mkdirSync(output,{recursive:true});
const workspace = fs.mkdtempSync(path.join(output,'workspace-'));
const example = path.join(workspace,'examples/connected-composition');
fs.mkdirSync(path.dirname(example),{recursive:true});
fs.cpSync(path.join(root,'examples/connected-composition'),example,{recursive:true,filter:file=>!['node_modules','dist','.astro'].includes(path.basename(file))});
fs.mkdirSync(path.join(workspace,'src'),{recursive:true});
for(const name of ['composition','preview']) fs.cpSync(path.join(root,'src',name),path.join(workspace,'src',name),{recursive:true});
// Use an explicitly supplied installed Astro runtime, not a download or lock edit.
const runtime = process.env.ATELIER_ASTRO_RUNTIME || path.join(root,'examples/connected-composition/node_modules');
assert(fs.existsSync(path.join(runtime,'astro/bin/astro.mjs')), 'install the example Astro runtime first');
fs.symlinkSync(runtime,path.join(example,'node_modules'),'dir');
function build() {
  const log=execFileSync('fnm',['exec','--using=22.22.2','node',path.join(runtime,'astro/bin/astro.mjs'),'build'],{cwd:example,encoding:'utf8',env:{...process.env,ASTRO_TELEMETRY_DISABLED:'1'},maxBuffer:4*1024*1024});
  fs.writeFileSync(path.join(output,'build-'+buildCount+++'.log'),log);
}
function files(dir,prefix='') {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
    if(['node_modules','dist','.astro'].includes(e.name))return[];
    return e.isDirectory()?files(path.join(dir,e.name),prefix+e.name+'/'):e.isFile()?[[prefix+e.name,fs.readFileSync(path.join(dir,e.name))]]:[];
  });
}
const owned=['src/composition','src/access','src/preview','examples/connected-composition'];
const inputs=[...owned.flatMap(dir=>files(path.join(root,dir)).map(([name,bytes])=>[dir+'/'+name,bytes])),...['scripts/prove-connected-composition.mjs','test/connected-composition.test.mjs','test/connected-composition-channel.test.mjs','package.json','package-lock.json'].map(name=>[name,fs.readFileSync(path.join(root,name))])];
const receipt={schema:'atelier.connected-composition-proof/experimental-v1',sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),
  sourceFiles:Object.fromEntries(inputs.map(([n,b])=>[n,digestBytes(b)])),scope:'synthetic-two-origin-intercepted-Astro-build',
  productionAuthProven:false,realHostAccepted:false,nativeDeviceProven:false,visualBaselineAccepted:false,status:'running',runs:[],builds:[]};
let buildCount=0;
const sourceFile=path.join(example,'src/content/placement.json'),before=fs.readFileSync(sourceFile);
const after=Buffer.from(before.toString().replace('Workshop notes','Freshly revised workshop notes'));
const rendererBytes=fs.readFileSync(path.join(example,'src/pages/preview.astro'));
try {
  build();
  const originalBuild=new Map(files(path.join(example,'dist')).map(([n,b])=>['/'+n,b]));
  // Fixture-only source edit with compare-before-replace. No canonical source
  // writer or coauthor promotion authority is claimed by this proof.
  assert.equal(digestBytes(fs.readFileSync(sourceFile)),digestBytes(before));
  fs.writeFileSync(sourceFile+'.next',after);fs.renameSync(sourceFile+'.next',sourceFile);build();
  const changedBuild=new Map(files(path.join(example,'dist')).map(([n,b])=>['/'+n,b]));
  assert.notEqual(digestBytes(before),digestBytes(after));
  for(const [name,built,bytes] of [['before',originalBuild,before],['after',changedBuild,after]]) {
    assert(built.has('/index.html')&&built.has('/preview/index.html'));
    const totalBytes=[...built.values()].reduce((s,b)=>s+b.length,0);assert(totalBytes<100000,'bounded fixture build');
    const all=[...built.values()].map(b=>b.toString()).join('\n');
    for(const secret of ['fixture-private-canary','opaque-fixture-handle','fixture-host.mjs','createPreviewEnforcer','fixture.issuer']) assert(!all.includes(secret),'trusted host code entered browser output');
    receipt.builds.push({name,sourceDigest:digestBytes(bytes),totalBytes,files:Object.fromEntries([...built].map(([n,b])=>[n,digestBytes(b)]))});
  }
  for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
    const browser=await engine.launch({headless:true}),run={browser:name,version:browser.version(),checks:[],screenshots:[]};receipt.runs.push(run);
    try {
      const context=await browser.newContext({reducedMotion:'reduce',locale:'en-US',timezoneId:'UTC',deviceScaleFactor:1});context.setDefaultTimeout(12000);
      let built=originalBuild,hold=null;
      const host=createFixtureHost({sourceBytes:before,rendererBytes,hooks:{beforeService:async()=>{if(hold)await hold.promise;}}});
      let channel=host.newChannel();const requests=[],errors=[],wire=[];
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(!['https://127.0.0.1:4180','https://127.0.0.1:4181'].includes(url.origin)||route.request().method()!=='GET') {requests.push(url.origin);return route.abort();}
        const key=url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname;
        if(!built.has(key)){errors.push('missing '+key);return route.abort();}
        return route.fulfill({body:built.get(key),contentType:key.endsWith('.js')?'text/javascript':key.endsWith('.css')?'text/css':'text/html',headers:{'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src https://127.0.0.1:4181; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'",'Cache-Control':'no-store'}});
      });
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      const shellOnly=source=>assert(source.frame===page.mainFrame()&&new URL(source.frame.url()).origin==='https://127.0.0.1:4180','fixture bridge is shell-only');
      await page.exposeBinding('fixtureControl',(source,input)=>{shellOnly(source);assert.deepEqual(Object.keys(input).sort(),['adapter','identity']);host.setIdentity(input.identity,input.adapter);channel=host.newChannel();return {generation:host.snapshot().generation};});
      await page.exposeBinding('fixtureInvoke',async(source,bytes)=>{shellOnly(source);const bound=channel;const result=await host.handle(bound,bytes);wire.push(JSON.stringify(result));return result;});
      await page.setViewportSize({width:1200,height:1000});await page.goto('https://127.0.0.1:4180/');
      const preview=()=>page.frameLocator('iframe');
      await preview().getByText('Preview ready.',{exact:true}).waitFor();
      assert.equal(await preview().getByRole('heading',{name:'Workshop notes',exact:true}).count(),1);
      assert(await preview().getByRole('button').isDisabled());run.checks.push('two-origin-read','readonly-action-disabled');
      assert(await page.locator('select').evaluateAll(elements=>elements.every(e=>e.getBoundingClientRect().height>=44)));
      assert(await preview().getByRole('button').evaluate(e=>e.getBoundingClientRect().height>=44));run.checks.push('native-controls-minimum-target-size');
      // No preview access to either the host DOM or the Node-only authority port.
      const frame=page.frames().find(f=>f.url().includes('/preview/'));
      assert(await frame.evaluate(()=>{try{void parent.document.body;return false;}catch{return true;}}));
      assert(await frame.evaluate(async()=>{try{await window.fixtureInvoke('{}');return false;}catch{return true;}}));run.checks.push('cross-origin-DOM-refused','preview-host-bridge-refused');
      await frame.evaluate(()=>{
        window.dispatchEvent(new MessageEvent('message',{origin:'https://unrelated.atelier.test',data:'{}',source:window}));
        window.dispatchEvent(new MessageEvent('message',{origin:'https://127.0.0.1:4180',data:'{}',source:window}));
      });
      assert.equal(await preview().getByRole('heading',{name:'Workshop notes',exact:true}).count(),1);run.checks.push('foreign-origin-and-wrong-source-messages-ignored');
      for(const adapter of ['session-map','assertion-membership']) {
        await page.locator('#adapter').selectOption(adapter);await preview().getByText('Preview ready.',{exact:true}).waitFor();
        await page.locator('#mode').selectOption('sandbox-interactive');await preview().getByRole('button',{name:'Pin collection (reversible fixture)',exact:true}).waitFor();
        await preview().getByRole('button').click();await preview().getByRole('button',{name:'Unpin collection (reversible fixture)',exact:true}).waitFor();
        await preview().getByRole('button').click();await preview().getByRole('button',{name:'Pin collection (reversible fixture)',exact:true}).waitFor();run.checks.push(adapter+':read-pin-unpin');
      }
      await page.locator('#mode').selectOption('connected-read-only');await page.locator('#identity').selectOption('agent');await preview().getByText('Preview ready.',{exact:true}).waitFor();
      assert(await preview().getByRole('button').isDisabled());run.checks.push('scoped-agent-read');
      await page.locator('#mode').selectOption('sandbox-interactive');await preview().getByText('Preview is not permitted.',{exact:true}).waitFor();assert.equal(await preview().locator('#content').textContent(),'');run.checks.push('scoped-agent-action-refused');
      await page.locator('#identity').selectOption('other-tenant');await preview().getByText('Preview is not permitted.',{exact:true}).waitFor();run.checks.push('other-tenant-refused');
      await page.locator('#identity').selectOption('human');await preview().getByText('Preview ready.',{exact:true}).waitFor();
      let release;hold={promise:new Promise(resolve=>{release=resolve;})};
      await preview().getByRole('button').click();
      await page.locator('#identity').selectOption('signed-out');await preview().getByText('Sign in to preview.',{exact:true}).waitFor();
      release();hold=null;
      await page.waitForFunction(()=>document.getElementById('status').textContent==='Isolated fixture connected.');
      assert.equal(await preview().locator('#content').textContent(),'');run.checks.push('logout-clears-pending-frame-and-output');
      built=changedBuild;host.setSource(after);await page.reload();await preview().getByText('Preview ready.',{exact:true}).waitFor();
      assert.equal(await page.getByRole('heading',{name:'Freshly revised workshop notes',exact:true}).count(),1);
      assert.equal(await preview().getByRole('heading',{name:'Freshly revised workshop notes',exact:true}).count(),1);run.checks.push('exact-source-edit-build-refresh');
      for(const width of [320,390,768,1200]) {
        await page.setViewportSize({width,height:1000});
        for(const target of [page,page.frames().find(f=>f.url().includes('/preview/'))]) assert(await target.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
        run.checks.push('responsive:'+width);
        if([390,1200].includes(width)) {
          await page.locator('iframe').scrollIntoViewIfNeeded();
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          const file=name+'-'+width+'.png',bytes=await page.screenshot({path:path.join(output,file),fullPage:true});run.screenshots.push({file,sha256:digestBytes(bytes)});
        }
      }
      await page.setViewportSize({width:320,height:1000});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
      const reflow=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth).map(e=>e.tagName)}));
      assert(reflow.scroll<=reflow.width,JSON.stringify(reflow));run.checks.push('double-text-reflow');
      await page.reload();await page.keyboard.press(name==='webkit'&&process.platform==='darwin'?'Alt+Tab':'Tab');
      assert(await page.locator('.skip').evaluate(e=>e===document.activeElement));assert.notEqual(await page.locator('.skip').evaluate(e=>getComputedStyle(e).outlineStyle),'none');run.checks.push('native-keyboard-skip-focus');
      for(const result of wire) for(const secret of ['fixture-private-canary','membership','fixture.issuer','sample.tenant','policyRevision','delegationRef']) assert(!result.includes(secret));
      assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);run.checks.push('no-secret-projection','no-external-egress','no-browser-errors');
      await context.close();
      const offline=await browser.newContext({javaScriptEnabled:false});
      await offline.route('**/*',route=>route.fulfill({body:originalBuild.get('/index.html'),contentType:'text/html'}));
      const staticPage=await offline.newPage();await staticPage.goto('https://127.0.0.1:4180/');
      assert(await staticPage.getByRole('heading',{name:'Workshop notes',exact:true}).isVisible());assert(await staticPage.locator('#identity').isDisabled());assert.equal(await staticPage.locator('iframe').count(),0);
      run.checks.push('static-page-without-javascript-or-auth');await offline.close();
      console.log(name+': '+run.checks.length+' checks passed');
    } finally {await browser.close();}
  }
  for(const [name,bytes] of inputs) assert.equal(digestBytes(fs.readFileSync(path.join(root,name))),digestBytes(bytes),'proof input changed');
  receipt.status='passed';
} catch(error) {receipt.status='failed';receipt.error=error.stack;process.exitCode=1;}
finally {fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({status:receipt.status,checks:receipt.runs.reduce((s,r)=>s+r.checks.length,0),output,error:receipt.error},null,2));}
