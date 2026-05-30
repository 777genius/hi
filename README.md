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

### Запуск с новой Memory Platform

Основной локальный сценарий для persistent memory:

```bash
# Один раз: клонировать Memory Platform рядом с HackInterview.
# Нужен доступ к приватному repo 777genius/memory-platform.
cd ..
git clone https://github.com/777genius/memory-platform.git memory-platform

cd memory-platform
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev,qdrant,openai,graphiti]'

cd ../HackInterview
pnpm memory-platform:up
pnpm memory-platform:server
```

В другом терминале:

```bash
pnpm copy-helper:brave:restart-cdp
pnpm tauri:dev:memory-platform
```

В этом режиме STT остаётся на production backend, а память идёт в Memory Platform по `/v1/episodes` и `/v1/context`.

Если Memory Platform лежит не рядом с `HackInterview`, передай путь явно:

```bash
MEMORY_PLATFORM_DIR=/absolute/path/to/memory-platform pnpm memory-platform:up
MEMORY_PLATFORM_DIR=/absolute/path/to/memory-platform pnpm memory-platform:server
```

Если memory server уже запущен на другой машине или в Docker, локальный репозиторий `memory-platform` не нужен. Достаточно указать HTTP endpoint:

```bash
INTERVIEW_MEMORY_API_VARIANT=platform \
INTERVIEW_MEMORY_API_URL=http://127.0.0.1:7788 \
INTERVIEW_MEMORY_AUTH_TOKEN=local-dev-token \
pnpm tauri:dev:memory-platform
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
