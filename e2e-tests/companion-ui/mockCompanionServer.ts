import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type {
  CompanionMessage,
  CompanionSnapshotData,
} from '../../src/windowing/stateSync/contracts';

/**
 * Мок локального companion-сервера (src-tauri/src/presentation/companion.rs) внутри Vite dev-сервера.
 * Состояние изолировано по token из ссылки: каждый тест получает свой token и не мешает соседним.
 * Тест управляет сервером через /__companion-mock/<token>/<команда>.
 */

export const MOCK_CONTROL_PREFIX = '/__companion-mock/';
// Тот же лимит тела запроса, что у настоящего сервера (COMPANION_MAX_REQUEST_BODY_BYTES).
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;

export type MockActionOverride = {
  status?: number;
  /** Тело ответа как есть (строка) или JSON. */
  body?: unknown;
  /** Оборвать соединение без ответа (как потеря Wi-Fi посреди запроса). */
  drop?: boolean;
  /** Задержка перед ответом. */
  delayMs?: number;
  /** Сколько раз применить; по умолчанию один раз. */
  times?: number;
  /** Применить действие к состоянию перед ошибкой (ответ потерян, но команда выполнена). */
  applyAction?: boolean;
};

export type MockConfig = {
  authorized?: boolean;
  heartbeat?: boolean;
  /** Подмена ответа GET /api/state (например некорректный snapshot или 500). */
  stateOverride?: MockActionOverride | null;
  /** Подмена ответов POST по пути. */
  actionOverrides?: Record<string, MockActionOverride | null>;
};

export type MockPostRecord = {
  path: string;
  requestId: string | null;
  token: string | null;
  body: Record<string, unknown>;
  bodyBytes: number;
};

export type MockLog = {
  posts: MockPostRecord[];
  stateGets: number;
  streamsOpened: number;
  openStreams: number;
  revision: number;
};

type Session = {
  revision: number;
  data: CompanionSnapshotData;
  streams: Set<ServerResponse>;
  posts: MockPostRecord[];
  stateGets: number;
  streamsOpened: number;
  config: Required<Pick<MockConfig, 'authorized' | 'heartbeat'>> & {
    stateOverride: MockActionOverride | null;
    actionOverrides: Record<string, MockActionOverride | null>;
  };
  held: Map<string, { promise: Promise<void>; release: () => void }>;
};

export function emptyCompanionSnapshotData(instanceId = 'mock-instance-a'): CompanionSnapshotData {
  return {
    authRequired: false,
    recording: { status: 'Idle', activeSessionId: 0 },
    microphone: {
      muted: false,
      enabled: true,
      supported: true,
      source: 'mock',
      systemMuted: false,
      systemSupported: true,
      systemSource: 'mock',
      appMuted: false,
      appEnabled: true,
    },
    controls: {
      instanceId,
      historyFloorSeq: 0,
      contextFloorSeq: 0,
      conversationGeneration: 1,
      companionModeEnabled: true,
      desktopBlackoutEnabled: false,
      lastAction: null,
    },
    live: {},
    timeline: [],
  };
}

function createSession(data: CompanionSnapshotData = emptyCompanionSnapshotData()): Session {
  return {
    revision: 1,
    data,
    streams: new Set(),
    posts: [],
    stateGets: 0,
    streamsOpened: 0,
    config: { authorized: true, heartbeat: true, stateOverride: null, actionOverrides: {} },
    held: new Map(),
  };
}

function envelope(session: Session) {
  return { revision: String(session.revision), data: session.data };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

class BodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function consumeOverride(
  holder: { value: MockActionOverride | null },
): MockActionOverride | null {
  const override = holder.value;
  if (!override) return null;
  const times = override.times ?? 1;
  if (times <= 1) {
    holder.value = null;
  } else {
    holder.value = { ...override, times: times - 1 };
  }
  return override;
}

function summarizeBody(body: Record<string, unknown>): Record<string, unknown> {
  // Фото могут весить мегабайты: в журнал кладём только размер и начало base64.
  if (!Array.isArray(body.images)) return body;
  return {
    ...body,
    images: body.images.map((image: Record<string, unknown>) => ({
      mediaType: image?.mediaType,
      dataBase64Length: typeof image?.dataBase64 === 'string' ? image.dataBase64.length : -1,
      dataBase64Prefix: typeof image?.dataBase64 === 'string' ? image.dataBase64.slice(0, 16) : '',
    })),
  };
}

function nextSeq(data: CompanionSnapshotData): number {
  return data.timeline.reduce((max, message) => Math.max(max, message.seq), 0) + 1;
}

function applyDefaultAction(
  session: Session,
  path: string,
  body: Record<string, unknown>,
): string | null {
  const data = session.data;
  switch (path) {
    case '/api/record/start':
      data.recording.status = 'Recording';
      return 'started';
    case '/api/record/stop':
      data.recording.status = 'Idle';
      return 'stopped';
    case '/api/microphone/app/mute':
      data.microphone.appMuted = true;
      return 'muted';
    case '/api/microphone/app/unmute':
      data.microphone.appMuted = false;
      return 'unmuted';
    case '/api/context/clear':
      data.controls.contextFloorSeq = nextSeq(data) - 1;
      data.controls.conversationGeneration += 1;
      return 'cleared_context';
    case '/api/history/clear':
      data.controls.historyFloorSeq = nextSeq(data) - 1;
      data.timeline = [];
      return 'cleared_history';
    case '/api/ai/request':
      return 'started_ai';
    case '/api/prompt/send': {
      const seq = nextSeq(data);
      const images = Array.isArray(body.images) ? body.images as Array<Record<string, unknown>> : [];
      const message: CompanionMessage = {
        id: `prompt:${seq}`,
        seq,
        kind: 'prompt',
        role: 'outgoing',
        status: 'final',
        text: String(body.text ?? ''),
        createdAtMs: Date.now(),
        attachments: images.map((image, index) => ({
          id: `prompt:${seq}:img:${index}`,
          kind: 'image',
          mime: String(image.mediaType ?? ''),
          dataUrl: `data:${String(image.mediaType ?? '')};base64,${String(image.dataBase64 ?? '')}`,
        })),
      };
      data.timeline.push(message);
      return 'started_prompt';
    }
    default:
      return null;
  }
}

export function companionMockServer(): Plugin {
  const sessions = new Map<string, Session>();

  const sessionFor = (token: string): Session => {
    let session = sessions.get(token);
    if (!session) {
      session = createSession();
      sessions.set(token, session);
    }
    return session;
  };

  const writeFrame = (session: Session, frame: string) => {
    for (const stream of session.streams) stream.write(frame);
  };

  const publish = (session: Session) => {
    session.revision += 1;
    writeFrame(session, `event: snapshot\ndata: ${JSON.stringify(envelope(session))}\n\n`);
  };

  const dropStreams = (session: Session) => {
    for (const stream of session.streams) stream.destroy();
    session.streams.clear();
  };

  async function handleControl(
    token: string,
    command: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const raw = request.method === 'POST' ? (await readBody(request)).toString('utf8') : '';
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    switch (command) {
      case 'reset': {
        const previous = sessions.get(token);
        if (previous) {
          dropStreams(previous);
          for (const held of previous.held.values()) held.release();
        }
        const session = createSession(body.data as CompanionSnapshotData | undefined);
        if (body.config) Object.assign(session.config, body.config);
        sessions.set(token, session);
        return sendJson(response, 200, envelope(session));
      }
      case 'state':
        return sendJson(response, 200, envelope(sessionFor(token)));
      case 'publish': {
        const session = sessionFor(token);
        if (body.data) session.data = body.data as CompanionSnapshotData;
        publish(session);
        return sendJson(response, 200, envelope(session));
      }
      case 'publish-raw': {
        const session = sessionFor(token);
        writeFrame(session, String(body.frame ?? ''));
        return sendJson(response, 200, { ok: true });
      }
      case 'drop-streams':
        dropStreams(sessionFor(token));
        return sendJson(response, 200, { ok: true });
      case 'configure': {
        const session = sessionFor(token);
        const config = body as MockConfig;
        if (config.authorized !== undefined) session.config.authorized = config.authorized;
        if (config.heartbeat !== undefined) session.config.heartbeat = config.heartbeat;
        if (config.stateOverride !== undefined) session.config.stateOverride = config.stateOverride;
        if (config.actionOverrides) {
          Object.assign(session.config.actionOverrides, config.actionOverrides);
        }
        return sendJson(response, 200, { ok: true });
      }
      case 'hold': {
        const session = sessionFor(token);
        const path = String(body.path ?? '');
        let release = () => {};
        const promise = new Promise<void>((resolve) => { release = resolve; });
        session.held.set(path, { promise, release });
        return sendJson(response, 200, { ok: true });
      }
      case 'release': {
        const session = sessionFor(token);
        const path = String(body.path ?? '');
        session.held.get(path)?.release();
        session.held.delete(path);
        return sendJson(response, 200, { ok: true });
      }
      case 'log': {
        const session = sessionFor(token);
        const log: MockLog = {
          posts: session.posts,
          stateGets: session.stateGets,
          streamsOpened: session.streamsOpened,
          openStreams: session.streams.size,
          revision: session.revision,
        };
        return sendJson(response, 200, log);
      }
      default:
        return sendJson(response, 404, { error: `unknown mock command ${command}` });
    }
  }

  async function respondWithOverride(
    response: ServerResponse,
    override: MockActionOverride,
  ): Promise<void> {
    if (override.delayMs) await new Promise((resolve) => setTimeout(resolve, override.delayMs));
    if (override.drop) {
      response.destroy();
      return;
    }
    sendJson(response, override.status ?? 500, override.body ?? 'Mock failure');
  }

  async function handleApi(
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = url.pathname;
    const headerToken = request.headers['x-companion-token'];
    const token = (typeof headerToken === 'string' ? headerToken : null) ?? url.searchParams.get('token');
    if (!token) return sendJson(response, 401, 'Missing token');
    const session = sessionFor(token);

    if (pathname === '/api/state' && request.method === 'GET') {
      session.stateGets += 1;
      if (!session.config.authorized) return sendJson(response, 403, 'Forbidden');
      const holder = { value: session.config.stateOverride };
      const override = consumeOverride(holder);
      session.config.stateOverride = holder.value;
      if (override) return respondWithOverride(response, override);
      return sendJson(response, 200, envelope(session));
    }

    if (pathname === '/events' && request.method === 'GET') {
      if (!session.config.authorized) return sendJson(response, 403, 'Forbidden');
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      session.streamsOpened += 1;
      session.streams.add(response);
      response.on('close', () => session.streams.delete(response));
      response.write(`event: snapshot\ndata: ${JSON.stringify(envelope(session))}\n\n`);
      return;
    }

    if (request.method === 'POST' && pathname.startsWith('/api/')) {
      let rawBody: Buffer;
      try {
        rawBody = await readBody(request);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return sendJson(response, 413, 'Request body too large');
        }
        throw error;
      }
      let body: Record<string, unknown> = {};
      try {
        body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) as Record<string, unknown> : {};
      } catch {
        return sendJson(response, 400, 'Invalid JSON');
      }
      const requestId = request.headers['x-companion-request-id'];
      session.posts.push({
        path: pathname,
        requestId: typeof requestId === 'string' ? requestId : null,
        token: typeof headerToken === 'string' ? headerToken : null,
        body: summarizeBody(body),
        bodyBytes: rawBody.length,
      });
      if (!session.config.authorized) return sendJson(response, 403, 'Forbidden');

      const held = session.held.get(pathname);
      if (held) await held.promise;

      const holder = { value: session.config.actionOverrides[pathname] ?? null };
      const override = consumeOverride(holder);
      session.config.actionOverrides[pathname] = holder.value;
      if (override && !override.applyAction) return respondWithOverride(response, override);

      const actionResult = applyDefaultAction(session, pathname, body);
      if (!actionResult) return sendJson(response, 404, 'Not Found');
      publish(session);
      if (override) return respondWithOverride(response, override);
      return sendJson(response, 200, { ok: true, actionResult, snapshot: envelope(session) });
    }

    return sendJson(response, 404, 'Not Found');
  }

  return {
    name: 'companion-mock-server',
    configureServer(server) {
      const heartbeat = setInterval(() => {
        for (const session of sessions.values()) {
          if (session.config.heartbeat) writeFrame(session, 'event: heartbeat\ndata: {}\n\n');
        }
      }, HEARTBEAT_INTERVAL_MS);
      server.httpServer?.once('close', () => clearInterval(heartbeat));

      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        let task: Promise<void> | null = null;

        if (pathname.startsWith(MOCK_CONTROL_PREFIX)) {
          const [token, command] = pathname.slice(MOCK_CONTROL_PREFIX.length).split('/');
          task = handleControl(decodeURIComponent(token ?? ''), command ?? '', request, response);
        } else if (pathname.startsWith('/api/') || pathname === '/events') {
          task = handleApi(url, request, response);
        } else if (pathname === '/manifest.webmanifest') {
          sendJson(response, 200, {
            name: 'HackInterview Companion (mock)',
            short_name: 'Companion',
            start_url: `/c/${url.searchParams.get('token') ?? ''}`,
            scope: '/',
            display: 'standalone',
            icons: [{ src: '/companion-icon-512.png', sizes: '512x512', type: 'image/png' }],
          });
          return;
        } else if (/^\/companion-(icon-\d+|apple-touch-icon)\.png$/.test(pathname)) {
          response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          response.end();
          return;
        }

        if (!task) {
          next();
          return;
        }
        task.catch((error: unknown) => {
          if (!response.headersSent && !response.destroyed) {
            sendJson(response, 500, String(error));
          } else {
            response.destroy();
          }
        });
      });
    },
  };
}
