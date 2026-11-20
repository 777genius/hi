import { writeFile } from 'node:fs/promises';
import { loadFlutterPrompt, loadLlmEnvironment, prepareFlutterArtifacts } from './flutter-tooling.ts';
await prepareFlutterArtifacts();
const env = await loadLlmEnvironment();
const prompt = await loadFlutterPrompt();
const results: any[] = [];
for(const mode of ['developer-explicit'] as string[])for(let i=0;i<2;i++){
 const start=performance.now();let first:number|undefined,text='',usage:any;const payload:any={model:env.OPENAI_RESPONSES_MODEL,stream:true,store:false,max_output_tokens:32,reasoning:{effort:'minimal'},input:[{role:'user',content:[{type:'input_text',text:'Ответь только OK. Проверка '+i}]}]};
 if(mode==='instructions')payload.instructions=prompt;else { payload.input.unshift({role:'developer',content:[{type:'input_text',text:prompt}]}); payload.input.splice(1,0,{role:'user',content:[{type:'input_text',text:'Use this candidate profile as reference for the interview.'}]},{role:'assistant',content:[{type:'output_text',text:'OK'}]}); payload.instructions='Follow the developer message.'; payload.prompt_cache_key='flutter-benchmark-profile-v3'; payload.prompt_cache_options={mode:'implicit',ttl:'30m'}; }
 const r=await fetch(env.OPENAI_BASE_URL.replace(/\/$/,'')+'/responses',{method:'POST',headers:{authorization:'Bearer '+env.OPENAI_API_KEY,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(45000)});
 if(!r.ok)throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,500));let buffer='';const decoder=new TextDecoder();
 for await(const chunk of r.body!){buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const part=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of part.split('\n'))if(line.startsWith('data: ')&&line!=='data: [DONE]'){const e=JSON.parse(line.slice(6));if(e.type==='response.output_text.delta'){first??=performance.now()-start;text+=e.delta;}if(e.type==='response.completed')usage=e.response.usage;}}}
 results.push({mode,iteration:i+1,firstMs:Math.round(first??0),finalMs:Math.round(performance.now()-start),text,usage});console.log(JSON.stringify(results.at(-1)));
}
await writeFile('artifacts/flutter-interview/cache-probe-boundary.json',JSON.stringify(results,null,2));
