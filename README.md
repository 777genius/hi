# HackInterviewAI

Программа для прохождения интервью с помощью ИИ: непрерывная транскрипция разговора (системный звук и микрофон) и мгновенные подсказки от ИИ по наведению.

- **Непрерывная транскрипция** — голос из динамиков (то, что вы слышите) и с микрофона в реальном времени превращается в текст в виде чата.
- **ИИ по наведению** — при наведении на кнопку в шапке текущий текст отправляется в ИИ (Anthropic Haiku), ответ приходит потоком и сразу отображается в чате.
- **Чат-интерфейс** — входящие сообщения: распознанный голос; исходящие: ваши реплики с микрофона и ответы ИИ. Окно можно растягивать.
- **Два источника звука** — системный звук (динамики) и микрофон; архитектура рассчитана на оба режима параллельно.

Бэкенд для распознавания речи (STT) берётся из окружения (HackInterviewAI), вызовы к ИИ выполняются с фронтенда (в перспективе — через свой бэкенд). Архитектура: Clean Architecture, SOLID, без жёсткой привязки к провайдеру ИИ.

## Возможности

- Транскрипция в реальном времени (WebSocket, тот же контракт, что у HackInterviewAI).
- Захват звука с динамиков (то, что слышит пользователь).
- Поддержка микрофона (ваш голос в чате как исходящие сообщения).
- Кнопка в шапке: наведение отправляет текущий текст в ИИ и показывает стриминговый ответ; во время запроса кнопка превращается в индикатор загрузки.
- Крупное изменяемое по размеру окно, всё в формате чата.
- Текст из голоса не копируется в буфер обмена.

## Стек и структура

- **Фронтенд:** Vue 3, TypeScript, Vite, Pinia; UI — Vuetify 3.
- **Десктоп:** Tauri 2 (при необходимости).
- **STT:** те же env и эндпоинты, что у HackInterviewAI.
- **ИИ:** Anthropic API (Haiku), стриминг; в коде — абстракция, чтобы позже заменить на свой бэкенд.

Код организован по слоям (domain, application, infrastructure, presentation), без жёсткой зависимости от конкретного провайдера ИИ.

## Запуск

```bash
pnpm install
pnpm tauri:dev
```

### Запуск с новой Memory Platform и Anthropic

`HackInterview` не хранит Memory Platform внутри этого репозитория. Для локального запуска с новой памятью нужно клонировать второй приватный репозиторий:

```bash
mkdir -p ~/dev/projects/ai
cd ~/dev/projects/ai
git clone https://github.com/777genius/memory-platform.git memory-platform
cd ~/dev/projects/HackInterview
```

Нужен доступ к приватному GitHub repo [777genius/memory-platform](https://github.com/777genius/memory-platform).

Первичная установка:

```bash
cd ~/dev/projects/ai/memory-platform

python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev,qdrant,openai,graphiti]'

cd ~/dev/projects/HackInterview
pnpm install
```

Самый простой запуск Memory Platform в Docker, без внешних provider adapters:

```bash
# Из корня HackInterview:
pnpm memory-platform:stack
pnpm memory-platform:smoke
pnpm memory-platform:mcp-smoke
```

Wrapper `pnpm memory-platform:*` сам выставляет `MEMORY_DEFAULT_SPACE_SLUG=hackinterview`
и `MEMORY_LEGACY_HACKINTERVIEW_ENABLED=true` для локального memory server. В самом
репозитории Memory Platform дефолтный space остаётся generic `default`, а legacy
compatibility routes выключены по умолчанию.

Полный режим с Qdrant, Graphiti и OpenAI embeddings:

```bash
# Из корня HackInterview:
read -s OPENAI_API_KEY
export OPENAI_API_KEY
export MEMORY_OPENAI_API_KEY="$OPENAI_API_KEY"
pnpm memory-platform:full-stack
pnpm memory-platform:clean-full-smoke
```

`OPENAI_API_KEY` нужен Graphiti, `MEMORY_OPENAI_API_KEY` нужен embeddings adapter. Не записывай ключ в README, package scripts или `.env`, который может попасть в git.

В другом терминале запусти desktop app с Anthropic Haiku, production STT backend и локальной Memory Platform:

```bash
cd /path/to/HackInterview

pnpm copy-helper:brave:restart-cdp

LLM_PROVIDER=anthropic \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
ANTHROPIC_MODEL=claude-haiku-4-5-20251001 \
INTERVIEW_MEMORY_API_VARIANT=platform \
INTERVIEW_MEMORY_API_URL=http://127.0.0.1:7788 \
INTERVIEW_MEMORY_AUTH_TOKEN=local-dev-token \
VITE_API_URL=https://api.voicetext.site \
VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site \
FOCUS_COPY_ENABLE_BROWSER_CDP=1 \
pnpm tauri dev
```

В этом режиме:

- STT остаётся на production backend `api.voicetext.site`;
- ответы ИИ идут через Anthropic Haiku;
- память идёт в локальную Memory Platform по `/v1/episodes` и `/v1/context`;
- токен `local-dev-token` используется только для локального memory server.

Если Memory Platform лежит не рядом с `HackInterview`, передай путь явно:

```bash
MEMORY_PLATFORM_DIR=/absolute/path/to/memory-platform pnpm memory-platform:stack
MEMORY_PLATFORM_DIR=/absolute/path/to/memory-platform pnpm memory-platform:full-stack
```

Если memory server уже запущен на другой машине или в Docker, локальный репозиторий `memory-platform` для запуска desktop app не нужен. Достаточно указать HTTP endpoint:

```bash
LLM_PROVIDER=anthropic \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
ANTHROPIC_MODEL=claude-haiku-4-5-20251001 \
INTERVIEW_MEMORY_API_VARIANT=platform \
INTERVIEW_MEMORY_API_URL=http://127.0.0.1:7788 \
INTERVIEW_MEMORY_AUTH_TOKEN=local-dev-token \
pnpm tauri:dev:memory-platform
```

Старый ручной локальный режим всё ещё доступен, если нужно запускать server не в Docker:

```bash
cd ../memory-platform

MEMORY_AUTO_CREATE_SCHEMA=true \
MEMORY_SERVICE_TOKEN=local-dev-token \
MEMORY_DEFAULT_SPACE_SLUG=hackinterview \
MEMORY_LEGACY_HACKINTERVIEW_ENABLED=true \
MEMORY_QDRANT_ENABLED=true \
MEMORY_EMBEDDINGS_ENABLED=true \
MEMORY_EMBEDDINGS_PROVIDER=openai \
MEMORY_OPENAI_API_KEY="$OPENAI_API_KEY" \
OPENAI_API_KEY="$OPENAI_API_KEY" \
MEMORY_GRAPHITI_ENABLED=true \
MEMORY_GRAPHITI_NEO4J_PASSWORD=memorygraph \
.venv/bin/python -m memory_server.main
```

### Запуск с продовым backend на Render и Brave CDP

Для проверки desktop frontend на продовом backend с включённым real Brave/CDP focus-copy:

```bash
pnpm copy-helper:brave:restart-cdp
VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
```

Продовый backend задеплоен через Render. Для проверки деплоя, логов и состояния продового backend можно использовать Render MCP.

Для локального тестирования backend VoicetextAI:

```text
/Users/belief/dev/projects/VoicetextAI/backend
```

Либо только фронтенд (если бэкенд уже поднят):

```bash
pnpm install
pnpm dev
```

Переменные окружения — в `.env` (URL бэкенда STT, ключ Anthropic и т.д.).

## Лицензия

Apache License 2.0 — см. [LICENSE](LICENSE).
