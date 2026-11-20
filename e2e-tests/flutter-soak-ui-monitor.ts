import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';
import { remote } from 'webdriverio';
const bridge = JSON.parse(await readFile(`${homedir()}/Library/Application Support/HackInterview/companion_bridge.json`, 'utf8'));
const token = bridge.companionAccessToken;
const base = 'http://127.0.0.1:43821';
const out = 'artifacts/flutter-soak/ui-monitor.jsonl';
await mkdir('artifacts/flutter-soak', { recursive: true });
const desktop = await remote({ hostname:'127.0.0.1', port:4445, capabilities:{browserName:'tauri'}, logLevel:'error', transformRequest:(request:any)=>{request.headers?.delete('content-length');return request;} });
await desktop.switchToWindow('main');
const browser = await chromium.launch({headless:true, ...(process.env.COMPANION_UI_CHROMIUM_PATH ? { executablePath: process.env.COMPANION_UI_CHROMIUM_PATH } : {})});
const page = await browser.newPage({viewport:{width:390,height:844}});
const errors:string[]=[];
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
   const companion=await page.evaluate((wanted:string[])=>({present:wanted.filter(id=>Array.from(document.querySelectorAll('[data-msg-id]')).some(e=>e.getAttribute('data-msg-id')===id)),rows:document.querySelectorAll('.chat-row').length,body:!!document.querySelector('.chat-scroll')}),ids);
   const native=await desktop.execute((wanted:unknown)=>({present:(wanted as string[]).filter(id=>Array.from(document.querySelectorAll('[data-msg-id]')).some(e=>e.getAttribute('data-msg-id')===id)),rows:document.querySelectorAll('.chat-row').length,body:!!document.querySelector('.chat-scroll')}),ids);
   const record={at:new Date().toISOString(),recording:state.recording?.status,ids,companion,native,errors:errors.splice(0)};
   await appendFile(out,JSON.stringify(record)+'\n');
   console.log(JSON.stringify({at:record.at,recording:record.recording,tracked:ids.length,companionRows:companion.rows,desktopRows:native.rows,companionMissing:ids.filter((id:string)=>!companion.present.includes(id)),desktopMissing:ids.filter((id:string)=>!native.present.includes(id)),errors:record.errors}));
  } catch(e) { const error=String(e);await appendFile(out,JSON.stringify({at:new Date().toISOString(),error})+'\n');console.error(error); }
  await new Promise(r=>setTimeout(r,15000));
 }
} finally {await browser.close();await desktop.deleteSession();}
