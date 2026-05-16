# E2E (Tauri) tests

Эти тесты запускают **реальное Tauri приложение** и управляют окнами через WebDriver.

## Companion audio smoke на macOS

Для проверки реального companion/STT без WebDriver есть отдельный smoke-тест через локальный companion HTTP API:

```bash
pnpm e2e:companion-audio
```

Что делает тест:

- не чистит историю companion, а запоминает текущий `seq` и проверяет только новые сообщения;
- сам берёт companion token из `COMPANION_TOKEN`, `COMPANION_URL` или bridge-файла приложения;
- по умолчанию генерирует детерминированные русские interview-вопросы через macOS `say`;
- стартует запись через `/api/record/start`;
- в system-фазе временно выключает app microphone transcript и проигрывает голосовые fixture-файлы через `afplay`;
- в mic-фазе включает app microphone transcript и повторяет проигрывание, чтобы проверить реальный mic-path;
- после stop проверяет, что запись вернулась в `Idle` и `activeSessionId` сброшен в `0`;
- после прогона восстанавливает исходное app mute-состояние микрофона;
- сохраняет диагностический JSON в `.e2e-artifacts/companion-dual-audio/`.

Стресс-прогон нескольких start/stop циклов:

```bash
pnpm e2e:companion-audio -- --cycles 3 --allow-mic-miss
```

Полезный запуск против уже поднятого dev-приложения:

```bash
COMPANION_URL="http://127.0.0.1:43821/companion.html?token=<token>" pnpm e2e:companion-audio
```

Для проверки сохранёнными голосовыми fixture-файлами используй `--real-fixtures`; тогда берутся:

```text
/Users/belief/Documents/2026-05-14 23.56.41.ogg
/Users/belief/Documents/2026-05-14 23.57.41.ogg
/Users/belief/Documents/2026-05-14 23.57.56.ogg
```

Важно про mic-фазу: без виртуального loopback input вроде BlackHole/Loopback/Soundflower скрипт может только акустически проиграть звук в обычный output и ждать, что реальный микрофон его услышит. Если output идёт в наушники, это честно покажет проблему окружения, а не баг STT. Для диагностического прогона без падения на mic-фазе:

```bash
pnpm e2e:companion-audio -- --allow-mic-miss
```

Для детерминированной mic-проверки без акустики установи `SwitchAudioSource` и BlackHole:

```bash
brew install switchaudio-osx blackhole-2ch
```

`blackhole-2ch` ставится как системный audio driver и может потребовать пароль администратора и reboot. После появления устройства `BlackHole 2ch` тест можно запускать так:

```bash
pnpm e2e:companion-audio -- --skip-system --mic-route blackhole --require-mic
```

В `blackhole` route тест временно переключает только macOS input на `BlackHole 2ch`, проигрывает синтетический голос прямо в BlackHole через `ffmpeg` AudioToolbox output и затем восстанавливает прежний input. Обычный system output не переключается, поэтому звук компьютера для пользователя не должен пропадать. Если нужно другое имя устройства, передай `--blackhole-device "<name>"` или `COMPANION_BLACKHOLE_DEVICE`.

Для проверки обоих каналов за один прогон:

```bash
pnpm e2e:companion-audio -- --cycles 2 --system-runs 2 --mic-runs 2 --mic-route blackhole --require-mic
```

Это проверяет system path и mic path последовательно. Полностью одновременная проверка разного текста в OS audio и mic audio требует отдельного mixer/test audio adapter, иначе один и тот же BlackHole stream может попасть сразу в несколько capture paths.

## Companion synthetic interview + AI context

Для проверки, что длинный companion-контекст реально попадает в AI prompt и AI отвечает как помощник на интервью-вопросы собеседника:

```bash
pnpm e2e:companion-context
```

Для полной проверки новой interview memory path запускай desktop app с production backend. Desktop bridge по умолчанию работает в `ActiveContext`:

```bash
pnpm copy-helper:brave:restart-cdp
VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
```

`INTERVIEW_MEMORY_MODE=active_context` and `INTERVIEW_MEMORY_ENABLED=1` are explicit equivalents of the default. Lower modes are available for canaries: `shadow_ingest` stores chunks without prompt impact, `shadow_retrieve` enables retrieval checks without prompt impact, and `INTERVIEW_MEMORY_FORCE_DISABLED=true` is the emergency kill switch. `INTERVIEW_MEMORY_MODE=disabled`, `INTERVIEW_MEMORY_ENABLED=false` or `INTERVIEW_MEMORY_ACTIVE_CONTEXT=false` disable the default. The Settings switch writes `AppConfig.interview_memory_enabled=false`, which also resolves the desktop bridge to `disabled` at runtime without restart. `INTERVIEW_MEMORY_FORCE_LOCAL_ONLY=true` avoids backend memory calls and keeps only the minimal local prompt fallback.

Для local memory backend canary, когда STT остаётся на production websocket, а `/api/v1/interview-memory/*` идёт в локальный backend:

```bash
INTERVIEW_MEMORY_AUTH_TOKEN="<local-user-jwt>" INTERVIEW_MEMORY_API_URL=http://127.0.0.1:8080 VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
```

`INTERVIEW_MEMORY_AUTH_TOKEN` намеренно имеет приоритет только для memory bridge. Это позволяет гонять local backend memory E2E без замены основного app auth/provider flow.

Для полного local canary, где auth, STT websocket и memory routes идут в локальный backend, сначала залогинь desktop app в local backend или положи валидную native-сессию в `~/Library/Application Support/HackInterview/auth_store.json`, затем запускай:

```bash
cd /Users/belief/dev/projects/VoicetextAI/backend
set -a; source .env >/dev/null 2>&1 || true; set +a
AUTH__EMAIL__PROVIDER=console INTERVIEW_MEMORY__ENABLED=true APP_ENV=local AUTH__JWT__ACCESS_TTL_SECS=3600 cargo run

cd /Users/belief/dev/projects/HackInterview
pnpm e2e:prepare-local-memory-auth -- --api-url http://127.0.0.1:8080
VITE_API_URL=http://127.0.0.1:8080 VOICE_TO_TEXT_API_URL=http://127.0.0.1:8080 VOICE_TO_TEXT_BACKEND_URL=ws://127.0.0.1:8080 INTERVIEW_MEMORY_API_URL=http://127.0.0.1:8080 FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
```

`e2e:prepare-local-memory-auth` логинится в local backend через `/api/v1/auth/login`, пишет Tauri-native `auth_store.json` с `*_expires_at_ms` и кладёт raw access token в `/tmp/hackinterview-memory-e2e-token.txt` для `--verify-memory`.

После local canary очисти тестовую native auth-сессию:

```bash
pnpm e2e:prepare-local-memory-auth -- --clear
```

Backend, против которого идёт проверка, должен иметь включённые memory routes:

```bash
INTERVIEW_MEMORY__ENABLED=true
```

Backend HTTP gate для памяти находится в `/Users/belief/dev/projects/VoicetextAI/backend`:

```bash
set -a; source .env >/dev/null 2>&1 || true; set +a
cargo run -p migration -- up
cargo test --test interview_memory_e2e -- --nocapture --test-threads=1
```

Production/staging canary для уже задеплоенного backend memory API:

```bash
pnpm e2e:memory-canary -- --api-url https://api.voicetext.site
```

Canary берёт JWT из `INTERVIEW_MEMORY_AUTH_TOKEN`, `--auth-token-file` или native `~/Library/Application Support/HackInterview/auth_store.json`, создаёт отдельную synthetic session, проверяет ingest/context/duplicate/delete/status и пишет production-safe artifact в `.e2e-artifacts/interview-memory-canary/`. Raw transcript/code/prompt text в artifact не сохраняется, а скрипт падает, если видит утечку контрольных raw-фрагментов.

Что делает тест:

- добавляет ранний кодовый anchor через `/api/focus-copy/ingest`;
- генерирует русские голосовые вопросы интервью через macOS `say` voice `Milena`;
- проигрывает их через `afplay`, чтобы companion/STT создал реальные system-audio сообщения;
- добавляет длинный filler-контекст, чтобы проверить context trimming;
- добавляет поздний anchor с инструкцией отвечать как кандидат;
- отправляет реальный `/api/prompt/send` и проверяет, что AI ответил по голосовым interview-вопросам про `debounceSearch`, очередь вместо стека и линейную сложность.

Полезные флаги:

```bash
pnpm e2e:companion-context -- --filler-chars 80000
pnpm e2e:companion-context -- --skip-voice
pnpm e2e:companion-context -- --skip-ai
pnpm e2e:companion-context -- --allow-ai-miss
pnpm e2e:companion-context -- --production-safe-artifact
```

`--skip-voice` intentionally narrows AI/memory expectations to deterministic focus-copy and prompt facts only. It does not require voice-only facts like "таймер" or "последний аргумент", because those facts are introduced by the synthetic voice phase.

When the desktop bridge is in `ActiveContext` and the memory API is intentionally unavailable, it falls back to a compact current-session tail. That fallback should prove the chat still answers and the question flow does not break; it is not expected to preserve old long-interview recall without the backend memory context.

The companion `/api/state` snapshot includes a production-safe `memory` block with the resolved mode, backend/local capabilities and memory session id. It intentionally does not include raw retrieved text or prompt artifacts. `pnpm e2e:companion-context` fails early if that block is missing.

For staging/canary evidence, pass `--production-safe-artifact` or set `COMPANION_PRODUCTION_SAFE_ARTIFACT=1`. This keeps the artifact useful for release review while redacting raw transcript/code/prompt/AI text and nested candidate/attachment text payloads.

Проверка, что backend memory не только получил ingest, но и реально достаёт нужный контекст после длинной истории:

```bash
INTERVIEW_MEMORY_AUTH_TOKEN="$(cat /tmp/hackinterview-memory-e2e-token.txt)" \
pnpm e2e:companion-context -- --filler-chars 52000 --verify-memory --memory-api-url http://127.0.0.1:8080
```

`--verify-memory` по умолчанию берёт `session_id` из production-safe companion `/api/state` memory snapshot, вызывает `/api/v1/interview-memory/context` и проверяет, что retrieved memory содержит ранний code marker, поздний marker, голосовой вопрос про проект, `debounce`, таймер/аргумент, очередь/стек и линейную сложность. Если нужно проверить старый/внешний session вручную, передай `--memory-session-id <uuid>` или `INTERVIEW_MEMORY_DB_URL=...` для fallback discovery через `psql`.

Если desktop app не залогинен, voice/recording phase ожидаемо вернёт `authRequired`. Для проверки long context/focus-copy/memory split без записи:

```bash
pnpm e2e:companion-context -- --skip-voice --skip-ai --filler-chars 52000
```

## Важно про macOS

По текущей документации Tauri v2 WebDriver **не поддерживается на macOS** (нет WKWebView driver).
Поэтому локально на macOS эти тесты не запускаются — их нужно гонять в CI на Linux/Windows.

## Как запустить (Linux)

1) Установить системный драйвер WebKit:

Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y webkit2gtk-driver
```

2) Установить tauri-driver:

```bash
cargo install tauri-driver --locked
```

3) Запустить тесты:

```bash
cd frontend
pnpm e2e:tauri
```
