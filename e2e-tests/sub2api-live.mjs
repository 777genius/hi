#!/usr/bin/env node
// Real Sub2API + desktop companion E2E. Uses synthetic images and never starts recording.
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

const envPath = process.env.HACKINTERVIEW_LLM_ENV || join(homedir(), '.local/share/hackinterview-sub2api/hackinterview-llm.env');
const bridgePath = process.env.HACKINTERVIEW_COMPANION_BRIDGE || join(homedir(), 'Library/Application Support/HackInterview/companion_bridge.json');
const companionUrl = (process.env.COMPANION_BASE_URL || 'http://127.0.0.1:43821').replace(/\/$/, '');

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) return [];
    return [[match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2')]];
  }));
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}

function solidScreenshot(rgb, marker = false) {
  const width = 320;
  const height = 180;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const offset = 1 + x * 3;
      const color = marker && x >= 258 && x < 298 && y >= 38 && y < 78
        ? [255, 225, 15]
        : y < 24 || x < 8 || x >= width - 8 ? [245, 245, 245] : rgb;
      row.set(color, offset);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function images() {
  const red = solidScreenshot([235, 35, 35]);
  const blue = solidScreenshot([30, 90, 230], true);
  const dir = await mkdtemp(join(tmpdir(), 'hackinterview-sub2api-e2e-'));
  try {
    const pngPath = join(dir, 'blue.png');
    const jpegPath = join(dir, 'blue.jpg');
    await writeFile(pngPath, blue);
    const conversion = spawnSync('sips', ['-s', 'format', 'jpeg', pngPath, '--out', jpegPath], { encoding: 'utf8' });
    if (conversion.status !== 0) throw new Error(`sips JPEG conversion failed (${conversion.status})`);
    return [
      { mediaType: 'image/png', dataBase64: red.toString('base64') },
      { mediaType: 'image/jpeg', dataBase64: (await readFile(jpegPath)).toString('base64') },
    ];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), ...options });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

function assertColorOrder(answer, label) {
  const normalized = String(answer).toLowerCase();
  const red = normalized.search(/red|красн|червон/);
  const blue = normalized.search(/blue|син|блакит|голуб/);
  if (red < 0 || blue < 0 || blue <= red) {
    throw new Error(`${label}: image order or recognition failed; answer=${JSON.stringify(answer.slice(0, 240))}`);
  }
}

async function directResponse(config, content, options = {}) {
  const base = config.OPENAI_BASE_URL.replace(/\/$/, '');
  const url = base.endsWith('/v1') ? `${base}/responses` : `${base}/v1/responses`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.SUB2API_E2E_MODEL || 'gpt-6-luna',
      instructions: 'Answer only the user question.',
      input: [{ role: 'user', content }],
      max_output_tokens: options.maxOutputTokens || 180,
      reasoning: { effort: 'low' },
      ...(options.cacheKey ? {
        prompt_cache_key: options.cacheKey,
        prompt_cache_options: { mode: 'implicit', ttl: '30m' },
      } : {}),
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Sub2API /v1/responses: HTTP ${response.status}`);
  const events = (await response.text()).split(/\r?\n\r?\n/).flatMap((block) => {
    const line = block.split(/\r?\n/).find((item) => item.startsWith('data: '));
    if (!line || line === 'data: [DONE]') return [];
    try { return [JSON.parse(line.slice(6))]; } catch { return []; }
  });
  const failure = events.find((event) => ['response.failed', 'response.incomplete', 'error'].includes(event.type));
  if (failure) throw new Error(`Sub2API stream failed: ${failure.type}`);
  if (!events.some((event) => event.type === 'response.completed')) throw new Error('Sub2API stream ended without response.completed');
  return {
    text: events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta || '').join(''),
    usage: events.find((event) => event.type === 'response.completed')?.response?.usage || {},
  };
}

async function main() {
  const config = parseEnv(await readFile(envPath, 'utf8'));
  if (!config.OPENAI_API_KEY || !config.OPENAI_BASE_URL || !config.OPENAI_RESPONSES_MODEL) throw new Error('Sub2API LLM configuration is incomplete');
  const token = JSON.parse(await readFile(bridgePath, 'utf8')).companionAccessToken;
  if (!token) throw new Error('Companion token is missing');
  const imageSet = await images();
  const textAnswer = await directResponse(config, [{ type: 'input_text', text: 'Reply with exactly SUB2API_TEXT_OK.' }]);
  if (!textAnswer.text.includes('SUB2API_TEXT_OK')) throw new Error(`Text response failed: ${textAnswer.text.slice(0, 160)}`);
  console.log('PASS Sub2API text streaming');

  const colorQuestion = 'What is the dominant color in each screenshot, in attachment order? Answer RED, BLUE.';
  const content = [
    { type: 'input_text', text: colorQuestion },
    ...imageSet.map((image) => ({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.dataBase64}` })),
  ];
  assertColorOrder((await directResponse(config, content)).text, 'Sub2API direct multimodal');
  console.log('PASS Sub2API PNG + JPEG in order');

  const cacheKey = `hackinterview-e2e-${randomUUID()}`;
  const stableContext = 'Stable reference: adapters depend on interfaces, use cases own policies, and storage is behind a port.\n'.repeat(85);
  const cachedContent = [{ type: 'input_text', text: `${stableContext}\nReply OK.` }];
  const first = await directResponse(config, cachedContent, { cacheKey, maxOutputTokens: 32 });
  const second = await directResponse(config, cachedContent, { cacheKey, maxOutputTokens: 32 });
  const cachedTokens = Number(second.usage.input_tokens_details?.cached_tokens || 0);
  if (!first.text || !second.text || cachedTokens <= 0) {
    throw new Error(`Prompt cache did not hit: input=${second.usage.input_tokens || 0}, cached=${cachedTokens}`);
  }
  console.log(`PASS Sub2API prompt cache (${cachedTokens} cached tokens)`);

  const stateUrl = `${companionUrl}/api/state?token=${encodeURIComponent(token)}`;
  const before = await jsonFetch(stateUrl);
  if (before.data?.recording?.status !== 'Idle') throw new Error('Recording is active; E2E will not interrupt audio');
  if (before.data?.authRequired) throw new Error('Desktop app requires authentication');
  const previousIds = new Set((before.data.timeline || []).map((message) => message.id));
  const response = await jsonFetch(`${companionUrl}/api/prompt/send`, {
    method: 'POST',
    headers: { 'x-companion-token': token, 'x-request-id': randomUUID(), 'content-type': 'application/json' },
    body: JSON.stringify({ text: colorQuestion, images: imageSet, openaiResponsesWebSearch: false }),
  });
  if (!response.ok || response.actionResult !== 'started_prompt') throw new Error(`App prompt rejected: ${response.actionResult}`);

  const deadline = Date.now() + 120_000;
  let firstAnswer = '';
  while (Date.now() < deadline) {
    const snapshot = await jsonFetch(stateUrl);
    if (snapshot.data?.recording?.status !== 'Idle') throw new Error('Audio recording started during E2E');
    const added = (snapshot.data.timeline || []).filter((message) => !previousIds.has(message.id));
    const prompt = added.find((message) => message.kind === 'prompt');
    const answer = added.find((message) => message.kind === 'haiku');
    if (prompt && (prompt.attachments || []).length !== 2) throw new Error('App lost an image attachment');
    if (answer?.status === 'error') throw new Error(`App LLM error: ${String(answer.text).slice(0, 240)}`);
    if (answer?.status === 'final') {
      firstAnswer = answer.text || answer.candidates?.[0]?.text || '';
      assertColorOrder(firstAnswer, 'App multimodal');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (!firstAnswer) throw new Error('App LLM response timed out');
  console.log('PASS app -> Sub2API -> streamed answer with two screenshots');

  const afterFirst = await jsonFetch(stateUrl);
  const firstTurnIds = new Set((afterFirst.data.timeline || []).map((message) => message.id));
  const followup = await jsonFetch(`${companionUrl}/api/prompt/send`, {
    method: 'POST',
    headers: { 'x-companion-token': token, 'x-request-id': randomUUID(), 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'In the second screenshot from the previous turn, what color is the small square near the upper right? Reply with that color only.',
      images: [],
      openaiResponsesWebSearch: false,
    }),
  });
  if (!followup.ok || followup.actionResult !== 'started_prompt') throw new Error(`App follow-up rejected: ${followup.actionResult}`);
  const followupDeadline = Date.now() + 120_000;
  while (Date.now() < followupDeadline) {
    const snapshot = await jsonFetch(stateUrl);
    if (snapshot.data?.recording?.status !== 'Idle') throw new Error('Audio recording started during E2E');
    const added = (snapshot.data.timeline || []).filter((message) => !firstTurnIds.has(message.id));
    const prompt = added.find((message) => message.kind === 'prompt');
    const answer = added.find((message) => message.kind === 'haiku');
    if (prompt && (prompt.attachments || []).length !== 0) throw new Error('Historical images appeared as new UI attachments');
    if (answer?.status === 'error') throw new Error(`App follow-up error: ${String(answer.text).slice(0, 240)}`);
    if (answer?.status === 'final') {
      const text = String(answer.text || answer.candidates?.[0]?.text || '').toLowerCase();
      if (!/yellow|ж[её]лт|жовт/.test(text)) throw new Error(`App lost previous image context: ${text.slice(0, 240)}`);
      console.log('PASS follow-up sees previous screenshot without reattaching it');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('App image follow-up timed out');
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
