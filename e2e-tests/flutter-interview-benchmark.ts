import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareFlutterArtifacts } from './flutter-tooling.ts';
const base = 'http://127.0.0.1:43821';
const bridge = JSON.parse(await readFile(`${homedir()}/Library/Application Support/HackInterview/companion_bridge.json`, 'utf8'));
const token: string = bridge.companionAccessToken;
const runId = randomUUID().slice(0,8);
await prepareFlutterArtifacts();
let desktop: any;
if (process.env.BENCH_DESKTOP === '1') {
 const { remote } = await import('webdriverio');
 desktop = await remote({hostname:'127.0.0.1',port:4445,capabilities:{browserName:'tauri'},logLevel:'error',transformRequest:(request:any)=>{request.headers?.delete('content-length');return request;}});
 await desktop.switchToWindow('main');
}
const turns = [
 ['Расскажите о вашем опыте Flutter и проектах.', 'У меня более пяти лет Flutter: m10, KiberPay и ro:. В m10 я руководил командой из 11, в ro: — из 6.'],
 ['Какие мои проекты лучше всего показывают опыт модульной архитектуры Flutter и как именно?', ''],
 ['Чем отличаются Widget, Element и RenderObject?', 'Widget — конфигурация, Element хранит идентичность, RenderObject отвечает за layout и paint.'],
 ['Почему const и RepaintBoundary не решают все проблемы производительности?', ''],
 ['Что происходит с запросом поиска после ухода со страницы?', 'Проверяю mounted и отменяю запрос; от старого ответа отдельно защищаюсь номером поколения.'],
 ['Развейте мой предыдущий ответ: почему mounted недостаточно и как исправить stale response?', ''],
 ['Как вы организовали бы Bloc для поиска и оплаты?', 'Для поиска restartable, для оплаты UI guard и server idempotency.'],
 ['Гарантирует ли sequential порядок всех событий Bloc, а restartable отмену HTTP? Объясните.', ''],
 ['Назовите мой подтверждённый стек и опыт лидерства.', 'В KiberPay команда 10 разработчиков, включая 3 Flutter. Использовал Bloc, GetIt, Injectable и Syncfusion.'],
 ['Сравните именно мои команды m10, KiberPay и ro:, не смешивая численность и подтверждённый стек.', ''],
 ['На переводе произошёл timeout после 3DS.', 'Не объявляю платёж неуспешным: проверяю operation ID и серверный статус, после process death восстанавливаю его.'],
 ['Подведите итог нашего обсуждения поиска и платежей: какие две разные защиты от гонок мы выбрали и почему?', ''],
] as const;
type Message = {id:string;kind:string;status:string;text:string;seq:number;createdAtMs:number};
type Snapshot = {timeline:Message[];recording:{status:string}};
async function request(path:string, body?:unknown):Promise<any> {
 const r=await fetch(base+path,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{'content-type':'application/json','x-companion-token':token,'x-request-id':randomUUID()},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(`${path}: ${r.status}`);const j=await r.json();return j.data??j;
}
const observationErrors: string[] = [];
async function state():Promise<Snapshot> {
 try { return await request('/api/state?token='+encodeURIComponent(token)); }
 catch(error) {
  observationErrors.push(String(error));
  await new Promise(resolve=>setTimeout(resolve,250));
  return await request('/api/state?token='+encodeURIComponent(token));
 }
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const report:{runId:string;startedAt:string;turns:any[];errors:string[]}={runId,startedAt:new Date().toISOString(),turns:[],errors:[]};
const artifact=`artifacts/flutter-interview/${runId}.json`;
console.log(`REPORT ${artifact}`);
try {
 if((await state()).recording.status!=='Idle')throw new Error('Recording active; no audio will be started');
 for(let i=0;i<turns.length;i++){
  const [question,mic]=turns[i];const started=performance.now();
  await request('/api/e2e/timeline/system',{text:`[Flutter interview ${runId}, ${i+1}] ${question}`,sessionId:730001});
  const row:any={turn:i+1,question,source:mic?'microphone':'llm'};
  if(mic){await request('/api/e2e/timeline/microphone',{text:mic,sessionId:730001});row.answer=mic;}
  else {
   const ids=new Set((await state()).timeline.map(m=>m.id));const sent=performance.now();
   await request('/api/ai/request',{openaiResponsesWebSearch:false});
   let finished=false;
   while(performance.now()-sent<90000){
    const snap=await state();if(snap.recording.status!=='Idle')throw new Error('Unexpected recording');
    const answer=snap.timeline.find(m=>!ids.has(m.id)&&m.kind==='haiku');
    if(answer?.text&&row.firstTextMs===undefined)row.firstTextMs=Math.round(performance.now()-sent);
    if (answer && desktop) {
     const visible = await desktop.execute((id:string) => {
      const e=document.querySelector(`[data-msg-id="${id}"] .chat-markdown`);
      return e?.textContent?.trim() || '';
     }, answer.id);
     if(visible && row.desktopFirstTextMs===undefined)row.desktopFirstTextMs=Math.round(performance.now()-sent);
    }
    if(answer?.status==='error')throw new Error(answer.text);
    if(answer?.status==='final'){row.answer=answer.text;row.finalMs=Math.round(performance.now()-sent);row.answerId=answer.id;finished=true;break;}
    await sleep(120);
   }
   if(!finished)throw new Error('LLM timeout');
  }
  const timeline=(await state()).timeline;row.order=timeline.filter(m=>m.text.includes(runId)||m.id===row.answerId).map(m=>({id:m.id,seq:m.seq,kind:m.kind}));
  report.turns.push(row);await writeFile(artifact,JSON.stringify(report,null,2));console.log(JSON.stringify(row));
  await sleep(Math.max(0,Number(process.env.BENCH_INTERVAL_MS || 25000)-(performance.now()-started)));
  if(process.env.BENCH_MAX_TURNS && i+1>=Number(process.env.BENCH_MAX_TURNS))break;
 }
}catch(e){report.errors.push(String(e));process.exitCode=1;}
await writeFile(artifact,JSON.stringify({...report,observationErrors},null,2));
console.log(`DONE ${artifact}`);
