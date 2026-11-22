import {appendFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const artifactDir=process.env.FLUTTER_SOAK_ARTIFACTS_DIR || 'artifacts/flutter-soak';
await mkdir(artifactDir,{recursive:true});
let stop=false; process.on('SIGTERM',()=>{stop=true});process.on('SIGINT',()=>{stop=true});
while(!stop){
 const at=new Date().toISOString();
 const record:{at:string;httpStatus?:number;responseMs?:number;lastUsage?:string;core?:string|null;error?:string}={at};
 try {
  const begin=performance.now();const health=await fetch('http://127.0.0.1:18080/health',{signal:AbortSignal.timeout(5000)});
  record.httpStatus=health.status;record.responseMs=Math.round(performance.now()-begin);
  const {stdout}=await exec('docker',['exec','hackinterview-sub2api-postgres-1','psql','-U','sub2api','-d','sub2api','-t','-A','-F','|','-c','SELECT id,account_id,model,first_token_ms,duration_ms,input_tokens,cache_read_tokens,created_at FROM usage_logs ORDER BY id DESC LIMIT 1'],{timeout:10000});
  record.lastUsage=stdout.trim();
  const {stdout:processStats}=await exec('ps',['-Ao','pid,pcpu,rss,comm'],{timeout:5000});
  record.core=processStats.split('\n').find(line=>line.includes('/HackInterviewCore'))?.trim()??null;
  await appendFile(`${artifactDir}/service-monitor.jsonl`,JSON.stringify(record)+'\n');
  if(!health.ok)console.error(JSON.stringify(record));
 } catch(e){record.error=String(e);await appendFile(`${artifactDir}/service-monitor.jsonl`,JSON.stringify(record)+'\n');console.error(JSON.stringify(record));}
 await new Promise(r=>setTimeout(r,30000));
}
