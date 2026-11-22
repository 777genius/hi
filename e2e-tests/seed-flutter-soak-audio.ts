import { readFile, mkdir, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
const scenario=JSON.parse(await readFile('e2e-tests/scenarios/flutter-senior-soak.json','utf8'));
const turns=scenario.turns;
const cacheKey=createHash('sha256').update(JSON.stringify({turns:turns.map((t:any)=>[t.id,t.qSpeech||t.q,t.aSpeech||t.a,t.qVoice,t.aVoice]),voice:'Lesya',voiceExplicit:true,interviewerVoice:scenario.interviewerVoice,candidateVoice:scenario.candidateVoice,interviewerRate:scenario.interviewerRate,candidateRate:scenario.candidateRate,systemGain:1,micGain:2})).digest('hex').slice(0,20);
const oldDir=process.argv[2];if(!oldDir)throw new Error('Expected the verified completed synthesis directory');
const dest=join(tmpdir(),`hackinterview-soak-audio-${cacheKey}`);await mkdir(dest,{recursive:true});
const audio=[];
for(const turn of turns){
 const id=turn.id;
 for(const name of [`q${id}.wav`,`a${id}.wav`,`a${id}.pcm`]) await link(join(oldDir,name),join(dest,name)).catch((e:any)=>{if(e.code!=='EEXIST')throw e});
 const duration=async(name:string)=>Number((await run('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',join(dest,name)])).stdout.trim());
 const [qSec,aSec]=await Promise.all([duration(`q${id}.wav`),duration(`a${id}.wav`)]);
 audio.push({id,qWav:join(dest,`q${id}.wav`),aWav:join(dest,`a${id}.wav`),aPcm:join(dest,`a${id}.pcm`),qSec,aSec});
}
await writeFile(join(dest,'prepared.json'),JSON.stringify(audio));
console.log(JSON.stringify({cacheKey,count:audio.length,dest}));
