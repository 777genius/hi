import { writeFile } from 'node:fs/promises';
import { loadFlutterPrompt, loadLlmEnvironment, prepareFlutterArtifacts } from './flutter-tooling.ts';
await prepareFlutterArtifacts();
const env = await loadLlmEnvironment();
const prompt = await loadFlutterPrompt();
const questions=[
 {id:'bloc',q:'В Bloc есть on<SearchChanged>(restartable) и on<FilterChanged>(sequential), оба пишут результаты одного поиска. Гарантирован ли порядок? Как исключить stale response, и отменяет ли restartable HTTP?',required:['per-event buckets, not global order','generation/version across both handlers','actual request cancellation independent of restartable']},
 {id:'riverpod',q:'AsyncNotifier загрузил данные, затем provider пересоздан из-за watch-зависимости, а старый запрос вернулся. Достаточно ref.mounted? Как защитить результат и побочные эффекты, учитывая retry и dispose?',required:['mounted is lifecycle not freshness','generation/cancellation and cleanup','retry unsafe for non-idempotent side effects']},
 {id:'rendering',q:'В profile mode build занимает 2 ms, но на 120 Hz кадры по 15 ms. На экране список карточек с изображениями, blur и opacity. Почему const и RepaintBoundary могут не помочь и что измерить/исправить?',required:['8.3ms budget and raster/GPU bottleneck','boundaries do not stop layout/rebuild and have cost','image decoding/texture sizing, blur/saveLayer/overdraw','measure UI and raster separately']},
 {id:'native',q:'Из Flutter вызываем Swift actor, внутри await; на Android аналог реализован suspend-функцией. Защищён ли инвариант состояния actor через await и гарантирует ли suspend работу вне main thread? Как обеспечить корректность?',required:['actor reentrancy and revalidate after await','suspend is not dispatcher switch','MainActor for UI; IO blocking/Default CPU','structured lifecycle/cancellation']},
 {id:'offline',q:'Flutter-приложение офлайн повторно отправляет перевод после timeout; процесс убит при возврате из 3DS, а WebSocket прислал дубликат результата. Как восстановить UI без второго списания и противоречивого локального состояния?',required:['server authoritative and operation ID','same idempotency key, timeout unknown','persist pending intent and reconcile on restart','dedup/version updates; cancellation not payment rollback']},
];
const results:any[]=[];
async function run(effort:string,q:string){
 const start=performance.now();let first:number|undefined,text='',usage:any,status='';
 const payload={model:env.OPENAI_RESPONSES_MODEL,instructions:'Follow the developer message.',input:[{role:'developer',content:[{type:'input_text',text:prompt}]},{role:'user',content:[{type:'input_text',text:'Use this candidate profile as reference for the interview.'}]},{role:'assistant',content:[{type:'output_text',text:'OK'}]},{role:'user',content:[{type:'input_text',text:q}]}],stream:true,store:false,max_output_tokens:600,reasoning:{effort},prompt_cache_key:'hi-effort-comparison-flutter-v1',prompt_cache_options:{mode:'implicit',ttl:'30m'}};
 const r=await fetch(env.OPENAI_BASE_URL.replace(/\/$/,'')+'/responses',{method:'POST',headers:{authorization:'Bearer '+env.OPENAI_API_KEY,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw new Error('HTTP '+r.status);let buffer='';const decoder=new TextDecoder();
 for await(const chunk of r.body!){buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const part=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of part.split('\n'))if(line.startsWith('data: ')&&line!=='data: [DONE]'){const e=JSON.parse(line.slice(6));if(e.type==='response.output_text.delta'){first??=performance.now()-start;text+=e.delta;}if(e.type==='response.completed'){usage=e.response.usage;status='completed';}if(['response.failed','response.incomplete','error'].includes(e.type))status=e.type;}}}
 return {firstMs:Math.round(first??0),finalMs:Math.round(performance.now()-start),text,usage,status};
}
for(const effort of ['low','medium'])console.log('WARM',effort,JSON.stringify(await run(effort,'Ответь только OK.')));
for(let i=0;i<questions.length;i++)for(const effort of (i%2?['medium','low']:['low','medium'])){
 const q=questions[i];const result={id:q.id,question:q.q,required:q.required,effort,...await run(effort,q.q)};results.push(result);console.log(JSON.stringify(result));await writeFile('artifacts/flutter-interview/effort-comparison.json',JSON.stringify(results,null,2));
}
