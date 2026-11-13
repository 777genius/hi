#!/usr/bin/env node
import process from 'node:process';
import {
  DEFAULT_AUTH_STORE_PATH,
  DEFAULT_MEMORY_API_URL,
  importDocumentText,
  loadDocumentFile,
  normalizeBaseUrl,
  normalizeApiVariant,
  readAuthToken,
  resolveCompanionState,
  splitTextForMemory,
} from './helpers/interviewMemoryDocument.mjs';

function parseArgs(argv) {
  const options = {
    apiUrl: process.env.INTERVIEW_MEMORY_E2E_API_URL || process.env.INTERVIEW_MEMORY_API_URL || DEFAULT_MEMORY_API_URL,
    apiVariant: process.env.INTERVIEW_MEMORY_API_VARIANT || 'legacy',
    spaceSlug: process.env.INTERVIEW_MEMORY_SPACE_SLUG || 'hackinterview',
    profileExternalRef:
      process.env.INTERVIEW_MEMORY_PROFILE_EXTERNAL_REF ||
      process.env.INTERVIEW_MEMORY_PROFILE_REF ||
      'default',
    platformImportMode:
      process.env.INTERVIEW_MEMO_STACK_IMPORT_MODE ||
      process.env.INTERVIEW_MEMORY_PLATFORM_IMPORT_MODE ||
      'documents',
    authToken: process.env.INTERVIEW_MEMORY_AUTH_TOKEN || '',
    authTokenFile: process.env.INTERVIEW_MEMORY_AUTH_TOKEN_FILE || '',
    authStorePath: DEFAULT_AUTH_STORE_PATH,
    file: '',
    sessionId: process.env.INTERVIEW_MEMORY_SESSION_ID || '',
    useCompanionSession: process.env.INTERVIEW_MEMORY_USE_COMPANION_SESSION === '1',
    newSession: false,
    companionBaseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || 'http://127.0.0.1:43821',
    companionToken: process.env.COMPANION_TOKEN || '',
    source: 'manual_prompt',
    kindHint: 'requirement',
    language: 'ru',
    maxCharsPerEvent: Number(process.env.INTERVIEW_MEMORY_IMPORT_CHUNK_CHARS || 12_000),
    overlapChars: Number(process.env.INTERVIEW_MEMORY_IMPORT_OVERLAP_CHARS || 400),
    pinned: true,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;

    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === '--api-url') options.apiUrl = next();
    else if (arg === '--api-variant') options.apiVariant = next();
    else if (arg === '--space-slug') options.spaceSlug = next();
    else if (arg === '--profile-ref') options.profileExternalRef = next();
    else if (arg === '--platform-import-mode') options.platformImportMode = next();
    else if (arg === '--auth-token') options.authToken = next();
    else if (arg === '--auth-token-file') options.authTokenFile = next();
    else if (arg === '--auth-store-path') options.authStorePath = next();
    else if (arg === '--file') options.file = next();
    else if (arg === '--session-id') options.sessionId = next();
    else if (arg === '--use-companion-session') options.useCompanionSession = true;
    else if (arg === '--new-session') options.newSession = true;
    else if (arg === '--companion-base-url') options.companionBaseUrl = next();
    else if (arg === '--companion-token') options.companionToken = next();
    else if (arg === '--source') options.source = next();
    else if (arg === '--kind-hint') options.kindHint = next();
    else if (arg === '--language') options.language = next();
    else if (arg === '--max-chars-per-event') options.maxCharsPerEvent = Number(next());
    else if (arg === '--overlap-chars') options.overlapChars = Number(next());
    else if (arg === '--no-pinned') options.pinned = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.file) throw new Error('Missing --file <path>');
  options.apiUrl = normalizeBaseUrl(options.apiUrl);
  options.apiVariant = normalizeApiVariant(options.apiVariant);
  if (!['documents', 'episodes'].includes(options.platformImportMode)) {
    throw new Error('--platform-import-mode must be documents or episodes');
  }
  options.maxCharsPerEvent = Math.max(1_000, Math.floor(options.maxCharsPerEvent || 12_000));
  options.overlapChars = Math.max(0, Math.floor(options.overlapChars || 0));
  return options;
}

function printHelp() {
  console.log(`Import a large text document into interview memory

Usage:
  pnpm memory:import-document -- --file ./profile.txt --use-companion-session

Session selection:
  --use-companion-session     Import into the currently running desktop companion memory session.
  --session-id <uuid>         Import into a known memory session id.
  --new-session               Create an isolated new session and print its id.

Auth:
  --api-url <url>             Backend URL, default INTERVIEW_MEMORY_API_URL/VITE_API_URL/prod.
  --api-variant <name>        legacy or platform, default INTERVIEW_MEMORY_API_VARIANT/legacy.
  --space-slug <slug>         Memo Stack space slug, default hackinterview.
  --profile-ref <ref>         Memo Stack profile external ref, default default.
  --platform-import-mode <m>  documents or episodes for platform mode, default documents.
  --auth-token <token>        Raw bearer token.
  --auth-token-file <path>    Raw token or auth_store.json.
  --auth-store-path <path>    Native auth store, default ~/Library/Application Support/HackInterview/auth_store.json.

Chunking:
  --max-chars-per-event <n>   Default 12000, stays below backend event split limit.
  --overlap-chars <n>         Default 400.
  --no-pinned                 Do not mark imported chunks as pinned memory.
  --dry-run                   Only print chunking/session plan, do not call backend.
`);
}

async function resolveSessionId(options) {
  if (options.sessionId.trim()) return { sessionId: options.sessionId.trim(), source: 'explicit' };
  if (options.useCompanionSession) {
    const companion = await resolveCompanionState(options);
    if (!companion.memorySessionId) throw new Error('Companion state has no memory.sessionId.');
    return {
      sessionId: companion.memorySessionId,
      source: companion.bridgePath ? `companion:${companion.bridgePath}` : 'companion',
    };
  }
  if (options.newSession) return { sessionId: '', source: 'new' };

  throw new Error('Choose a session: pass --use-companion-session, --session-id <uuid>, or --new-session.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = await loadDocumentFile(options.file);
  const chunks = splitTextForMemory(document.text, options);
  const session = await resolveSessionId(options);

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          apiUrl: options.apiUrl,
          apiVariant: options.apiVariant,
          file: options.file,
          session,
          inputChars: document.text.length,
          chunkCount: chunks.length,
          firstChunkChars: chunks[0]?.text.length || 0,
          lastChunkChars: chunks.at(-1)?.text.length || 0,
          pinned: options.pinned,
        },
        null,
        2,
      ),
    );
    return;
  }

  const token = await readAuthToken(options);
  if (!token) {
    throw new Error('Auth token is required. Pass --auth-token, --auth-token-file or use a valid auth_store.json.');
  }

  const result = await importDocumentText(options, token, {
    label: document.label,
    text: document.text,
    sessionId: session.sessionId || undefined,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        apiUrl: options.apiUrl,
        apiVariant: options.apiVariant,
        file: options.file,
        sessionId: result.sessionId,
        sessionSource: session.source,
        documentId: result.documentId,
        inputChars: result.inputChars,
        chunkCount: result.chunkCount,
        storedChunks: result.storedChunks,
        duplicateChunks: result.duplicateChunks,
        pinned: options.pinned,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`[memory-import-document] ${error.stack || error.message || error}`);
  process.exit(1);
});
