import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const token = 'companion-ui-e2e-only';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

export function message(index, prefix = 'burst') {
  return {
    id: `${prefix}:${index}`, seq: index + 1,
    kind: index % 2 ? 'mic' : 'stt', role: index % 2 ? 'outgoing' : 'incoming',
    status: 'final', text: `${prefix} ${index}: Русский / українська / 🎙️`,
    createdAtMs: 1_700_000_000_000 + index,
  };
}

export function snapshot(instanceId = 'ui-server-a', revision = 1) {
  return {
    revision: String(revision),
    data: {
      authRequired: false,
      recording: { status: 'Idle', activeSessionId: 0 },
      microphone: { appMuted: false, appEnabled: true },
      controls: { instanceId, companionModeEnabled: true, historyFloorSeq: 0, contextFloorSeq: 0, conversationGeneration: 1, desktopBlackoutEnabled: false },
      live: {}, timeline: [],
    },
  };
}

/** Built Vue page + actual HTTP/SSE. Faults are fixtures, not a fake EventSource. */
export async function startCompanionFixture({ distDirectory = dist } = {}) {
  const streams = new Set();
  const sockets = new Set();
  const activeRequests = new Set();
  const fixture = {
    state: snapshot(), stateFailures: 0, stateGets: 0,
    authorized: true, heartbeatEnabled: true, streamsOpened: 0,
    posts: [], dropResponseFor: null, heldAction: null,
    sendSnapshot(value) {
      const frame = `event: snapshot\ndata: ${JSON.stringify(value)}\n\n`;
      for (const response of streams) response.write(frame);
    },
    publish() {
      fixture.state.revision = String(Number(fixture.state.revision) + 1);
      fixture.sendSnapshot(fixture.state);
    },
    dropStreams() {
      for (const response of streams) response.destroy();
      streams.clear();
    },
    count(pathname) { return fixture.posts.filter((post) => post.path === pathname).length; },
  };
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };

  async function route(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/') || pathname === '/events') {
      const suppliedToken = request.headers['x-companion-token'] ?? url.searchParams.get('token');
      if (!fixture.authorized || suppliedToken !== token) return json(response, 403, { error: 'Forbidden' });
    }
    if (pathname === '/api/state') {
      fixture.stateGets += 1;
      if (fixture.stateFailures > 0) {
        fixture.stateFailures -= 1;
        response.destroy();
        return;
      }
      return json(response, 200, fixture.state);
    }
    if (pathname === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      fixture.streamsOpened += 1;
      streams.add(response);
      response.on('close', () => streams.delete(response));
      response.write(`event: snapshot\ndata: ${JSON.stringify(fixture.state)}\n\n`);
      return;
    }
    if (request.method === 'POST' && pathname.startsWith('/api/')) {
      let raw = '';
      for await (const part of request) {
        raw += part;
        if (raw.length > 65536) return json(response, 413, { error: 'fixture body too large' });
      }
      const body = JSON.parse(raw || '{}');
      fixture.posts.push({ path: pathname, body, requestId: request.headers['x-companion-request-id'] });
      // A controllable response barrier proves that clicks while a command is
      // pending cannot turn into another POST. No timing-dependent double click.
      if (fixture.heldAction?.path === pathname) await fixture.heldAction.promise;
      const data = fixture.state.data;
      let actionResult;
      switch (pathname) {
        case '/api/record/start': data.recording.status = 'Recording'; actionResult = 'started'; break;
        case '/api/record/stop': data.recording.status = 'Idle'; actionResult = 'stopped'; break;
        case '/api/microphone/app/mute': data.microphone.appMuted = true; actionResult = 'muted'; break;
        case '/api/microphone/app/unmute': data.microphone.appMuted = false; actionResult = 'unmuted'; break;
        case '/api/context/clear': data.controls.conversationGeneration += 1; actionResult = 'cleared_context'; break;
        case '/api/history/clear': data.timeline = []; actionResult = 'cleared_history'; break;
        case '/api/ai/request': actionResult = 'started_ai'; break;
        case '/api/prompt/send': {
          const next = message(data.timeline.length, 'prompt');
          data.timeline.push({ ...next, kind: 'prompt', role: 'outgoing', text: body.text });
          actionResult = 'started_prompt';
          break;
        }
        default: return json(response, 404, { error: 'Unexpected fixture action' });
      }
      fixture.publish();
      if (fixture.dropResponseFor === pathname) {
        fixture.dropResponseFor = null;
        response.destroy();
        return;
      }
      return json(response, 200, { ok: true, actionResult, snapshot: fixture.state });
    }
    if (pathname === '/manifest.webmanifest') {
      return json(response, 200, { name: 'Companion test', short_name: 'Companion', start_url: '/companion.html', scope: '/', display: 'standalone', icons: [{ src: '/companion-icon-512.png', sizes: '512x512', type: 'image/png' }] });
    }
    if (pathname.startsWith('/companion-icon-')) { response.writeHead(204); response.end(); return; }
    if (pathname !== '/companion.html' && !pathname.startsWith('/assets/')) {
      response.writeHead(404); response.end(); return;
    }
    const root = path.resolve(distDirectory);
    const target = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!target.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    let bytes = await readFile(target);
    if (pathname === '/companion.html') {
      // Install before Vue loads; assertion failures include render exceptions.
      const probe = `<script>window.__uiErrors=[];addEventListener('error',e=>{if(e.message)window.__uiErrors.push(e.message)});addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason)));const previousError=console.error;console.error=(...args)=>{window.__uiErrors.push(args.map(String).join(' '));previousError.apply(console,args)};</script>`;
      bytes = Buffer.from(bytes.toString().replace('<head>', '<head>' + probe));
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(bytes);
  }

  const server = createServer((request, response) => {
    const task = route(request, response).catch((error) => {
      if (!response.headersSent && !response.destroyed) json(response, 500, { error: String(error) });
      else response.destroy();
    });
    activeRequests.add(task);
    void task.then(() => activeRequests.delete(task), () => activeRequests.delete(task));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const heartbeat = setInterval(() => {
    if (fixture.heartbeatEnabled) for (const response of streams) response.write('event: heartbeat\ndata: {}\n\n');
  }, 5000);
  fixture.url = `http://127.0.0.1:${server.address().port}/companion.html?token=${token}`;
  fixture.hold = (pathname) => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    fixture.heldAction = { path: pathname, promise, release };
    return () => { release(); fixture.heldAction = null; };
  };
  fixture.stop = async () => {
    clearInterval(heartbeat);
    fixture.heldAction?.release();
    fixture.dropStreams();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.all(activeRequests);
  };
  return fixture;
}
