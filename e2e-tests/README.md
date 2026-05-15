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

Для текущих голосовых fixture-файлов по умолчанию используются:

```text
/Users/belief/Documents/2026-05-14 23.56.41.ogg
/Users/belief/Documents/2026-05-14 23.57.41.ogg
/Users/belief/Documents/2026-05-14 23.57.56.ogg
```

Важно про mic-фазу: без виртуального loopback input вроде BlackHole/Loopback/Soundflower скрипт может только акустически проиграть звук в обычный output и ждать, что реальный микрофон его услышит. Если output идёт в наушники, это честно покажет проблему окружения, а не баг STT. Для диагностического прогона без падения на mic-фазе:

```bash
pnpm e2e:companion-audio -- --allow-mic-miss
```

## Companion synthetic interview + AI context

Для проверки, что длинный companion-контекст реально попадает в AI prompt и AI отвечает как помощник на интервью-вопросы собеседника:

```bash
pnpm e2e:companion-context
```

Для полной проверки новой interview memory path запускай desktop app с production backend и включённым memory bridge:

```bash
pnpm copy-helper:brave:restart-cdp
VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site INTERVIEW_MEMORY_ENABLED=1 FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
```

Для local memory backend canary, когда STT остаётся на production websocket, а `/api/v1/interview-memory/*` идёт в локальный backend:

```bash
INTERVIEW_MEMORY_AUTH_TOKEN="<local-user-jwt>" INTERVIEW_MEMORY_API_URL=http://127.0.0.1:8080 VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site INTERVIEW_MEMORY_ENABLED=1 FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
```

`INTERVIEW_MEMORY_AUTH_TOKEN` намеренно имеет приоритет только для memory bridge. Это позволяет гонять local backend memory E2E без замены основного app auth/provider flow.

Для полного local canary, где auth, STT websocket и memory routes идут в локальный backend, сначала залогинь desktop app в local backend или положи валидную native-сессию в `~/Library/Application Support/HackInterview/auth_store.json`, затем запускай:

```bash
VITE_API_URL=http://127.0.0.1:8080 VOICE_TO_TEXT_API_URL=http://127.0.0.1:8080 VOICE_TO_TEXT_BACKEND_URL=ws://127.0.0.1:8080 INTERVIEW_MEMORY_API_URL=http://127.0.0.1:8080 INTERVIEW_MEMORY_ENABLED=1 FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
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
```

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
