import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';
import { remote } from 'webdriverio';
const bridge = JSON.parse(await readFile(`${homedir()}/Library/Application Support/HackInterview/companion_bridge.json`, 'utf8'));
const token = bridge.companionAccessToken;
const base = 'http://127.0.0.1:43821';
const artifactDir = process.env.FLUTTER_SOAK_ARTIFACTS_DIR || 'artifacts/flutter-soak';
const out = `${artifactDir}/ui-monitor.jsonl`;
await mkdir(artifactDir, { recursive: true });
const desktop = await remote({ hostname:'127.0.0.1', port:4445, capabilities:{browserName:'tauri'}, logLevel:'error', transformRequest:(request:any)=>{request.headers?.delete('content-length');return request;} });
await desktop.switchToWindow('main');
const browser = await chromium.launch({headless:true, ...(process.env.COMPANION_UI_CHROMIUM_PATH ? { executablePath: process.env.COMPANION_UI_CHROMIUM_PATH } : {})});
const page = await browser.newPage({viewport:{width:390,height:844}});
const errors:string[]=[];
const observed = new Map<string, string>();
page.on('pageerror',(e:Error)=>errors.push(e.message));
await page.goto(`${base}/companion.html?token=${encodeURIComponent(token)}`, {waitUntil:'domcontentloaded'});
let stop=false; process.on('SIGTERM',()=>{stop=true}); process.on('SIGINT',()=>{stop=true});
try {
 while(!stop){
  try {
   const res=await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`,{signal:AbortSignal.timeout(10000)});
   if(!res.ok)throw new Error(`state ${res.status}`);
   const raw:any=await res.json(), state=raw.data??raw;
   const messages=(state.timeline??[]).filter((m:any)=>['stt','mic','haiku'].includes(m.kind)&&!m.deleted).slice(-12);
   const ids=messages.map((m:any)=>m.id);
   const probeRows = (wanted:unknown) => {
     const rows=Array.from(document.querySelectorAll<HTMLElement>('[data-msg-id]'));
     return {present:(wanted as string[]).filter(id=>rows.some(e=>e.dataset.msgId===id)),rows:document.querySelectorAll('.chat-row').length,body:!!document.querySelector('.chat-scroll'),rendered:rows.filter(e=>(wanted as string[]).includes(e.dataset.msgId??'')).map(e=>{const style=getComputedStyle(e);return {id:e.dataset.msgId,text:e.textContent??'',partial:e.classList.contains('partial'),error:e.classList.contains('error'),displayed:style.display!=='none'&&style.visibility!=='hidden'&&e.getBoundingClientRect().height>0};})};
   };
   const normalize=(value:string)=>value.replace(/[*_`#~]/g,'').replace(/\s+/g,' ').trim();
   const mismatches=(probe:ReturnType<typeof probeRows>)=>messages.flatMap((m:any)=>{
     const row=probe.rendered.find(r=>r.id===m.id);
     if(!row)return [{id:m.id,reason:'missing'}];
     if(!row.displayed)return [{id:m.id,reason:'hidden'}];
     if(!normalize(row.text))return [{id:m.id,reason:'empty'}];
     if(m.status==='final'&&row.partial)return [{id:m.id,reason:'stale-streaming-status'}];
     if(m.status==='final'&&!normalize(row.text).includes(normalize(m.text).slice(0,60)))return [{id:m.id,reason:'text-mismatch'}];
     return [];
   });
   const companionStart = performance.now();
   const companion=await page.evaluate(probeRows,ids);
   const companionProbeMs = Math.round(performance.now() - companionStart);
   const nativeStart = performance.now();
   const native=await desktop.execute(probeRows,ids);
   const desktopProbeMs = Math.round(performance.now() - nativeStart);
   const changed = (state.timeline ?? []).filter((m:any) => {
     const fingerprint = JSON.stringify([m.text, m.status, m.deleted]);
     if (observed.get(m.id) === fingerprint) return false;
     observed.set(m.id, fingerprint);
     return true;
   }).map((m:any) => ({id:m.id,seq:m.seq,kind:m.kind,status:m.status,text:m.text,createdAtMs:m.createdAtMs}));
   const record={at:new Date().toISOString(),recording:state.recording?.status,ids,companion,native,companionProbeMs,desktopProbeMs,companionMismatches:mismatches(companion),desktopMismatches:mismatches(native),changed,live:state.live,errors:errors.splice(0)};
   await appendFile(out,JSON.stringify(record)+'\n');
   console.log(JSON.stringify({at:record.at,recording:record.recording,tracked:ids.length,companionRows:companion.rows,desktopRows:native.rows,companionMissing:ids.filter((id:string)=>!companion.present.includes(id)),desktopMissing:ids.filter((id:string)=>!native.present.includes(id)),errors:record.errors}));
  } catch(e) { const error=String(e);await appendFile(out,JSON.stringify({at:new Date().toISOString(),error})+'\n');console.error(error); }
  await new Promise(r=>setTimeout(r,15000));
 }
} finally {await browser.close();await desktop.deleteSession();}
