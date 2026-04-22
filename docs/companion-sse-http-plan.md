# Companion Plan - Safe SSE + HTTP Rollout

## Статус документа

Это не "идея", а технический план с жёсткими ограничениями, которые нужны, чтобы не создать тихих расхождений между:

- hidden desktop window
- phone companion
- текущим `Tauri + Vue` UI
- реальным Rust backend

Главная цель этого плана - **не сделать быстро, а сделать так, чтобы потом не ловить плавающие баги состояния**.

---

## Короткий вывод

`SSE + HTTP` для companion - правильное направление.  
Но старый план был слишком оптимистичным в трёх местах:

1. он недооценивал, сколько текущей логики живёт только во frontend
2. он переоценивал надёжность fire-and-forget sync в скрытом `WebView`
3. он оставлял слишком много семантически важных действий в локальном TS state

Если делать аккуратно, безопасный путь такой:

1. сделать backend snapshot + безопасный HTTP/SSE сервер
2. завести **общий Rust SoT** для companion timeline и companion controls
3. подключить **revision-based reconcile** для desktop окна
4. только после этого добавлять shared actions вроде `clear context`, `clear history`
5. `AI request` с телефона включать **не сразу**, а только после выноса общего reducer/context builder

## Финальные решения, в которых теперь есть чёткая уверенность

Это не просто рекомендации, а решения, которые закрывают самые тонкие места в текущем коде.

- production companion server делается **новым runtime поверх `hyper`**, а не как "доработка" текущего `presentation/companion.rs`
- все mutating actions проходят через **один serialized backend write path**, а не напрямую через текущие Tauri commands
- mutating `POST` должны возвращать **свежий snapshot из того же critical section**, а не надеяться только на будущий `SSE`
- `phone AI request` нельзя включать, пока prompt/context semantics не станут backend-owned
- desktop окно при show/hide больше не должно решать судьбу shared timeline - только `refresh()` и apply snapshot

---

## Что я перепроверил перед обновлением плана

### 1. Текущий стек уже имеет рабочий state-sync паттерн

В проекте уже есть нормальная модель:

- Rust snapshot command
- monotonic `revision`
- invalidation event `state-sync:invalidation`
- frontend `refresh()` при show/focus-like lifecycle

Это уже используется для:

- `app-config`
- `stt-config`
- `auth-state`
- `auth-session`
- `ui-preferences`

Вывод:

⚠️ Для companion нельзя делать "кастомные разовые desktop events и надеяться, что hidden window их не пропустит".  
Нужно использовать **тот же revision/snapshot pattern**, который уже есть в проекте.

### 2. Текущий desktop чат - не Rust SoT

Сейчас логика чата живёт в `src/stores/chat.ts` и `src/stores/transcription.ts`, и там есть важная семантика:

- merge финальных utterances по gap
- dedup system vs mic
- live partial buffers
- local `haiku` lifecycle
- local `clear context`
- local `clear history`
- local `edit/delete/select`

Вывод:

⚠️ Нельзя просто "отдать Rust raw events на телефон" и считать, что это тот же самый контент, что сейчас видит desktop UI.

### 3. Текущая отмена `haiku` - локальная, не backend cancel

Сейчас cancel в основном фронтовый:

- UI просто перестаёт принимать события по `request_id`
- backend stream реально не останавливается

Вывод:

⚠️ В `v1` нельзя обещать честный shared `AI cancel`.  
Либо делаем настоящий backend cancellation token, либо **вообще не включаем cancel в phone companion**.

### 4. Latest `axum` не подходит под текущий MSRV проекта

В проекте `src-tauri/Cargo.toml` сейчас:

```toml
rust-version = "1.77.2"
```

Актуальные официальные источники показывают:

- current `axum` `0.8.9` требует MSRV `1.80`
- `EventSource` в браузере не умеет custom headers, только `withCredentials`
- официальный путь для `hyper` сервера - `hyper 1 + hyper-util 0.1 + http-body-util 0.1`

Вывод:

⚠️ Нельзя бездумно взять latest `axum` и воткнуть его в проект.  
Это либо поднимет toolchain requirement, либо даст скрытый инфраструктурный долг.

### 5. В текущем desktop UI уже есть destructive clear paths

Сейчас в `RecordingPopover.vue` есть два места, которые чистят локальный UI:

- на `EVENT_RECORDING_WINDOW_SHOWN`, если backend idle, вызываются:
  - `store.clearText()`
  - `chatStore.clearChatOutgoing()`
- на `recording:start-requested` перед стартом тоже вызываются:
  - `store.clearText()`
  - `chatStore.clearChatOutgoing()`

Вывод:

⚠️ Пока эти paths живут как local-first логика, desktop окно может само стереть shared companion state или разойтись с backend snapshot.  
Это не "мелкая деталь", а полноценный migration blocker.

### 6. Текущий `start_recording` нельзя считать companion-safe write path

В `commands.rs` сейчас есть важная деталь:

- `start_recording` сначала делает `transcription_session_seq.fetch_add(...)`
- сразу после этого пишет `active_transcription_session_id`
- и только потом вызывает `transcription_service.start_recording(...)`

А сам `TranscriptionService::start_recording(...)` уже внутри может вернуть:

- `Already recording or starting`
- ошибку инициализации провайдера
- ошибку старта стрима/захвата

Вывод:

⚠️ Повторный или конкурентный вызов `start_recording` может **сжечь новый `session_id` даже без реального старта записи**.  
Значит текущий Tauri command нельзя просто переиспользовать как HTTP route handler для телефона.

Что из этого следует:

- companion write path должен сначала сериализовать действие
- затем проверить текущее состояние
- и только при реальном переходе `Idle -> Starting` выделять новый `session_id`

### 7. Текущий test companion server нельзя развивать в production "по месту"

В текущем коде `presentation/companion.rs`:

- listener поднимается сразу при старте приложения
- bind идёт на `0.0.0.0`
- `start_test_server()` уходит в бесконечный `accept` loop
- порт хранится в `OnceLock<u16>`
- сервер читает один раз в буфер `8192` и не парсит request body / streaming корректно

А в `lib.rs` это ещё и запускается fire-and-forget через `tauri::async_runtime::spawn(...)`.

Вывод:

⚠️ Этот сервер хорош как reachability probe для телефона, но он **структурно не подходит** как база для:

- `enable/disable companion mode`
- token rotation
- graceful shutdown
- predictable tests lifecycle
- настоящий `SSE` и mutating `POST`

---

## Решения, в которых была наименьшая уверенность

Ниже - места, которые были самыми тонкими, и как они теперь решены.

### 1. Чем поднимать HTTP/SSE сервер

#### Вариант 1 - продолжать на handwritten TCP/HTTP parser
🎯 5   🛡️ 4   🧠 3  
Примерно `250-450` строк.

Плюсы:

- быстро
- без новых зависимостей

Минусы:

- высокий риск багов на `Content-Length`, partial reads, keep-alive, SSE flushing
- тяжело тестировать корректно
- слишком хрупко для real server, нормален только как тестовая заглушка

#### Вариант 2 - `hyper 1 + hyper-util 0.1 + http-body-util 0.1`
🎯 9   🛡️ 9   🧠 6  
Примерно `450-800` строк.

Плюсы:

- официальный low-level stack
- не упирается в MSRV `1.77.2` как latest `axum`
- убирает риск самописного HTTP parser
- достаточно гибок для `GET`, `POST`, `SSE`

Минусы:

- чуть больше кода, чем в `axum`
- чуть ниже ergonomics

#### Вариант 3 - `axum`
🎯 6   🛡️ 8   🧠 4  
Примерно `350-650` строк, если бы toolchain уже подходил.

Плюсы:

- удобнее router
- проще handlers

Минусы:

- current latest `axum` branch требует более высокий MSRV, чем текущий проект
- значит это уже не "маленькое безопасное изменение", а решение уровня toolchain

### Решение

Для этого проекта safest path:

- тестовый сервер можно оставить как есть до миграции
- production companion server делать на `hyper` stack, а не на handwritten parser
- `axum` не использовать, пока сознательно не поднимем `rust-version`

---

### 2. Как синхронизировать desktop окно

#### Вариант 1 - слать кастомные Tauri events
🎯 5   🛡️ 4   🧠 2  
Примерно `80-140` строк.

Плюсы:

- быстро

Минусы:

- hidden `NSPanel/WebView` уже сейчас может пропускать события при hide/show
- нет deterministic rehydrate
- late-join окно не догоняет реальное состояние

#### Вариант 2 - revision + snapshot + invalidation
🎯 10   🛡️ 10   🧠 5  
Примерно `180-320` строк.

Плюсы:

- уже соответствует архитектуре репозитория
- late-join и missed invalidation закрываются через `refresh()`
- можно звать `refresh()` на `EVENT_RECORDING_WINDOW_SHOWN`

Минусы:

- нужно сделать snapshot contract и store adapter

#### Вариант 3 - вообще не синкать desktop, считать phone отдельным UI
🎯 3   🛡️ 3   🧠 1  
Примерно `0-50` строк.

Плюсы:

- быстро

Минусы:

- окно на Mac потом открывается в невалидном состоянии
- пользователь видит другой timeline

### Решение

Для companion нужен **тот же state-sync контракт**, что уже используется в проекте.

---

### 3. Давать ли сразу AI кнопку на телефон

#### Вариант 1 - включить сразу на raw backend timeline
🎯 4   🛡️ 4   🧠 3  
Примерно `120-220` строк.

Плюсы:

- быстро получаем кнопку

Минусы:

- prompt получится не тем же, что на desktop
- сейчас dedup, merge и часть chat semantics живут в TS
- при clear/history/cancel легко получить stale deltas

#### Вариант 2 - отложить AI до shared reducer
🎯 10   🛡️ 9   🧠 6  
Примерно `250-500` строк на отдельный этап.

Плюсы:

- поведение становится предсказуемым
- можно тестами сравнить desktop semantics и backend semantics

Минусы:

- AI кнопка появится не в самый первый шаг

#### Вариант 3 - сразу выносить весь chat.ts в backend SoT
🎯 7   🛡️ 10   🧠 9  
Примерно `1200-2500+` строк.

Плюсы:

- самый чистый long-term путь

Минусы:

- слишком большой рефактор для первого companion rollout

### Решение

⚠️ Safe rollout: **не включать phone AI в самом первом этапе**.  
Сначала - live view + record/mic + snapshot/rehydrate.  
AI - только после shared reducer/context builder.

---

### 4. Можно ли прямо вызывать существующие Tauri commands из companion server

#### Вариант 1 - вызывать commands напрямую, где сигнатура подходит
🎯 8   🛡️ 8   🧠 2  
Примерно `40-120` строк.

Плюсы:

- быстро
- меньше дублирования

Минусы:

- годится только для команд без `Window`
- легко случайно затащить UI-specific побочные эффекты

#### Вариант 2 - сделать explicit internal companion-safe helpers
🎯 10   🛡️ 10   🧠 5  
Примерно `120-260` строк.

Плюсы:

- чётко отделяет UI commands от backend-safe write path
- легче тестировать без Tauri window assumptions
- меньше шансов потом случайно вызвать не тот path

Минусы:

- чуть больше кода

### Решение

Для надёжного rollout нужно явно разделить:

- **companion-safe backend actions**
- **UI-only Tauri commands**

#### Safe to call from companion route

- `get_recording_status(state)`
- `ensure_recording_started(state, app_handle)`
- `ensure_recording_stopped(state, app_handle)`
- `ensure_microphone_muted(state, app_handle, muted)` или другой explicit internal helper
- `get_microphone_mute_state()`
- позже `ensure_ai_request_started(...)`, но только после backend context builder

#### Not safe / not appropriate for companion route

- `toggle_recording_with_window(...)`
- `toggle_window(...)`
- `show_recording_window(...)`
- любые команды, которым нужен `Window`
- любые локальные TS actions без Rust SoT

Практический вывод:

⚠️ Companion не должен управлять visibility/focus окна.  
Он должен управлять только backend state.

### Recommended extraction pattern

Чтобы не зависеть от `State<'_, AppState>` внутри route handlers, лучше вынести внутренние helpers:

```rust
pub struct CompanionActionResult {
    pub action_result: &'static str, // started | stopped | muted | unmuted | noop
    pub snapshot: CompanionSnapshotEnvelope,
}

pub async fn ensure_recording_started(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResult, String> { ... }

pub async fn ensure_recording_stopped(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResult, String> { ... }

pub async fn ensure_microphone_muted(
    state: &AppState,
    app_handle: &AppHandle,
    muted: bool,
) -> Result<CompanionActionResult, String> { ... }
```

Тогда:

- Tauri command wrapper остаётся тонким
- companion HTTP route вызывает тот же internal helper
- меньше риска divergence между write paths
- семантика `noop`/`started`/`stopped` становится явной и тестируемой

---

## Главные инварианты

Если хоть один из них нарушается, companion будет хрупким.

### Invariant 1 - источник правды только Rust

Никакое действие, влияющее на общий companion state, не должно жить только во frontend.

Это относится к:

- record state
- mic mute state
- context clear
- history clear
- AI request lifecycle

### Invariant 2 - toggle не должен быть серверным контрактом

`toggle` слишком хрупок при двух клиентах и stale state.

Нужны только idempotent действия:

- `record/start`
- `record/stop`
- `microphone/mute`
- `microphone/unmute`
- `context/clear`
- `history/clear`

UI-кнопка может быть одна, но API должен быть явным.

### Invariant 3 - hidden window должно уметь догонять состояние

Если desktop окно было скрыто и что-то пропустило, оно обязано восстановиться через snapshot pull.

### Invariant 4 - общие действия идут через один write path

Если `broom` и `trash` меняют shared semantics, desktop и phone должны вызывать **один backend command path**, а не каждый свою локальную логику.

### Invariant 5 - companion snapshot не содержит секретов

В snapshot нельзя отдавать:

- access token
- refresh token
- provider API keys
- backend URLs/секреты

### Invariant 6 - локальный LAN companion не должен быть полностью открыт всем в сети

Нужен random session token + ограниченный API surface.

### Invariant 7 - старые session/request события не должны оживлять новый UI

Это относится к:

- поздним `transcription:*` от старой recording session
- поздним `haiku:*` после clear/cancel/new generation

### Invariant 8 - companion не должен зависеть от window lifecycle hacks

Если shared semantics уже вынесена в Rust, то:

- `window_shown` не должен быть местом, где "решается судьба" timeline
- `window_shown` может только делать `refresh()`, но не придумывать новое состояние

### Invariant 9 - server lifecycle должен быть явным и обратимым

Companion server не должен жить как неуправляемая background-задача "навсегда".

Нужно уметь:

- запустить listener
- остановить listener
- ротировать token
- освободить порт

Это нужно и для безопасности, и для предсказуемых тестов.

### Invariant 10 - mutating actions должны быть сериализованы

Для shared companion состояния запрещено допускать несколько параллельных write decisions.

Под write decisions попадают:

- `record/start`
- `record/stop`
- `microphone/mute`
- `microphone/unmute`
- `context/clear`
- `history/clear`
- `enable/disable companion mode`

Если два клиента одновременно делают write без serialization, то баги будут не только UI-level, но и state-level.

---

## Что именно сейчас мешает "просто подключить телефон"

Это ключевой раздел. Здесь список конкретных локальных TS-only семантик, которые старый план недоучёл.

### 1. `transcription.ts` делает свой session gating

Сейчас frontend защищается от поздних событий через:

- `sessionId`
- `closedSessionIdFloor`
- `lastSeenSessionId`
- `awaitingSessionStart`

Вывод:

⚠️ Companion backend reducer должен иметь свой session gate.  
Иначе поздние события от старой recording session будут загрязнять phone snapshot.

### 2. `transcription.ts` сам объединяет final utterances

Сейчас desktop UI использует merge gap:

```ts
const UTTERANCE_MERGE_GAP_MS = 2500;
```

Вывод:

⚠️ Если backend timeline будет просто append raw finals, phone timeline и desktop timeline будут chunked по-разному.

### 3. `chat.ts` делает dedup system vs mic

Сейчас есть:

- `isSystemTextDuplicateOfMic`
- `isMicTextDuplicateOfSystem`
- `isNearDuplicateText`
- mic dominance gating

Вывод:

⚠️ Phone AI нельзя строить на raw timeline без переноса этих правил или явного отказа от parity.

### 4. `clear context` и `clear history` сейчас frontend-local

Сейчас:

- `clearLlmContext()` живёт только в `chat.ts`
- `clearAllHistory()` живёт только в `chat.ts` + `transcription.ts`

Вывод:

⚠️ Пока эти действия не вынесены в backend SoT, phone companion не должен претендовать на shared semantic context.

### Additional blocker - `systemPrompt` сейчас localStorage-only

Сейчас `chat.ts` читает и пишет `systemPrompt` через `localStorage`.

Вывод:

⚠️ Даже если backend научится собирать timeline, `phone AI` всё равно не будет честно совпадать с desktop AI, пока prompt живёт только в frontend storage.

Безопасные варианты тут только два:

#### Вариант 1 - до `Phase 6` не давать phone запускать AI
🎯 10   🛡️ 10   🧠 2  
Примерно `0-40` строк.

#### Вариант 2 - переносить prompt в backend-owned snapshot/config
🎯 9   🛡️ 10   🧠 6  
Примерно `120-260` строк.

### Additional blocker - текущий Rust `history` не равен desktop chat timeline

Сейчас `AppState.history` пополняется из `start_recording()` только системными финальными транскриптами.

Туда не попадают:

- микрофонные сообщения
- prompt messages
- `haiku` ответы
- selection
- context/history floors

Вывод:

⚠️ Нельзя брать текущий `AppState.history` и считать, что это уже готовая база для phone timeline или AI context.

### Additional blocker - текущий `clear context` использует смешанные cutoff semantics

Сейчас `chat.ts` режет контекст не единым способом:

- `stt` сообщения фильтруются через `contextFloorSttIndex`
- `mic` / `prompt` / `haiku` фильтруются через `contextClearedAtMs`

Вывод:

⚠️ Это значит, что текущая semantics clear зависит и от индекса, и от времени одновременно.  
Если переносить её в backend "на глаз", почти гарантированно получится drift.

Что из этого следует:

- backend должен использовать **одну unified model** для cutoffs
- safest path - unified `seq`
- migration должна явно описать, как старая mixed semantics схлопывается в новую

### Additional blocker - AI anchoring сейчас зависит от local UI mechanics

Сейчас в `chat.ts` есть специфическая логика:

- `haiku` может временно якориться на `LIVE_STT_MESSAGE_ID`
- после появления финального STT ответ переякоривается на последний final STT
- `insertAfterId` зависит от selection / live state / prompt origin

Вывод:

⚠️ Даже если backend уже умеет стримить `haiku` текст, этого недостаточно для parity.  
Нужна явная backend model для:

- anchor resolution
- live-to-final re-anchor
- prompt-attached vs selection-attached AI response placement

### 5. edit/delete/select/reply/prompt composer сейчас local-only

Это значит:

- desktop может изменить смысл timeline локально
- backend companion об этом не узнает
- phone AI увидит другой контекст

Вывод:

⚠️ Эти функции не должны входить в companion `v1`.  
Если хотим избежать тихих багов, их надо либо:

- явно не поддерживать в companion mode
- либо позже переносить в backend write path

### 6. Новая запись сейчас семантически чистит старый локальный timeline

Это уже видно в desktop коде:

- `startRecordingOnce()` очищает transcription state
- hotkey `recording:start-requested` очищает и transcription, и chat outgoing state

Вывод:

⚠️ Companion rollout должен **явно выбрать продуктовую семантику**:

1. либо timeline по-прежнему session-local и новая запись сбрасывает shared timeline
2. либо вы меняете продуктовую модель и делаете persistent history между сессиями

Без этого решения backend reducer получится внутренне противоречивым.

### Recommended decision

Для безопасного первого rollout:

- сохранить текущую продуктовую семантику
- считать timeline **session-local**
- новая запись поднимает новую session/generation и сбрасывает session timeline в backend SoT

Это сильно уменьшает риск скрытых расхождений с тем, как приложение уже работает сегодня.

### 7. Current hotkey/window lifecycle assume local-first reset

Сейчас часть UX строится на идее:

- hotkey стартует новую запись
- локальный UI заранее чистится
- затем идут новые события

Вывод:

⚠️ При переходе на backend SoT нельзя просто удалить эти clears без замены.  
Нужен явный migration path:

1. сначала backend умеет возвращать новый session snapshot
2. потом `window_shown`/`start_requested` переключаются с local clear на `refresh()`
3. только после этого старые destructive clear paths удаляются

### 8. Companion write path должен быть отдельным от текущих Tauri command wrappers

Наиболее тонкий момент здесь такой:

- некоторые существующие команды уже нормальны как read-only reuse
- но некоторые write-команды несут UI-ориентированные или race-sensitive побочные эффекты

Особенно важно это для `start_recording`.

Поэтому companion routes не должны делать "тонкий proxy" вида:

```rust
// ПЛОХО: прямой reuse Tauri command
start_recording(state_wrapper, app_handle).await?;
```

Вместо этого нужен слой internal actions:

```rust
pub async fn ensure_recording_started(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResult, String> { ... }

pub async fn ensure_recording_stopped(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResult, String> { ... }
```

И уже:

- Tauri UI
- global hotkey path
- HTTP companion routes

должны идти через один и тот же internal слой.

---

## Правильная целевая архитектура

### Слой 1 - Companion Core в Rust

Нужен один backend runtime, который живёт независимо от окон.

Рекомендуемая структура:

```rust
pub struct CompanionRuntime {
    pub snapshot: Arc<RwLock<CompanionSnapshot>>,
    pub sse_tx: tokio::sync::watch::Sender<CompanionSnapshotEnvelope>,
    pub security_token: Arc<RwLock<String>>,
}
```

`CompanionRuntime` лучше хранить в `AppState`, а не в глобальном static, чтобы:

- его было проще тестировать
- не плодить неявный global mutable state
- использовать уже существующие revision counters рядом

### Почему здесь `watch`, а не `broadcast`

Для companion лучше подходит именно `tokio::sync::watch`:

- snapshot у нас full-state, а не event log
- клиенту нужен **последний консистентный state**, а не каждая промежуточная мутация
- lagging subscriber должен догоняться latest snapshot, а не получать overflow/error как в event-stream queue

Практический вывод:

- `watch` подходит для `latest-wins`
- replay buffer для `SSE` в `v1/v2` не нужен
- correctness обеспечивается через `revision + full snapshot + GET /api/state`

### Recommended `AppState` additions

```rust
pub struct AppState {
    // ...
    pub companion_revision: Arc<RwLock<u64>>,
    pub companion_runtime: Arc<RwLock<CompanionRuntime>>,
    pub companion_server_task: Arc<RwLock<Option<tauri::async_runtime::JoinHandle<()>>>>,
    pub companion_action_lock: Arc<tokio::sync::Mutex<()>>,
}
```

Это даст тот же lifecycle control, который уже используется в проекте для других фоновых задач.

### Single-writer policy

Это один из самых важных новых выводов.

Hotkey, desktop clicks и phone `POST` не должны менять shared state параллельно.  
Иначе можно получить:

- double start
- start/stop crossing
- clear во время `Starting`
- token rotation одновременно с активным `POST`

Поэтому нужен один backend lock:

```rust
pub companion_action_lock: Arc<tokio::sync::Mutex<()>>;
```

Правило простое:

- каждый mutating companion action берёт этот lock
- внутри lock принимает решение по текущему состоянию
- делает mutation
- собирает новый snapshot
- bump revision / publish invalidation / SSE уже после согласованной мутации

Это важнее "красоты API".  
Без этого часть гонок будет плавающей и плохо воспроизводимой.

### Lock ordering и bounded busy policy

Здесь легко сделать скрытый deadlock или повисший `POST`, поэтому порядок должен быть жёстким.

#### Порядок lock'ов

1. сначала `companion_action_lock`
2. потом короткоживущие `snapshot/config/runtime` lock'и
3. release внутренних lock'ов до network write / `emit` / `SSE publish`

#### Запрещено

- держать `snapshot.write()` во время внешнего I/O
- держать `companion_runtime` lock во время `serve_connection`
- строить HTTP response body, пока удерживается write lock на snapshot

#### Busy policy

`start_recording` может реально висеть на handshake/инициализации секунды.  
Поэтому mutating `POST` не должны бесконечно ждать action lock.

Безопасный контракт:

- route пытается взять `companion_action_lock`
- если lock занят дольше короткого бюджета, вернуть `409 busy_transition` + текущий snapshot

Пример:

```json
{
  "ok": false,
  "actionResult": "busy_transition",
  "snapshot": { "revision": "18", "data": { "...": "..." } }
}
```

Это лучше, чем:

- вешать HTTP request на долгий handshake
- скрыто ставить команды в очередь без явной семантики
- допускать двойной старт/стоп ради "быстрого ответа"

### Слой 2 - Companion Snapshot

Не просто "какой-то JSON", а формальный контракт.

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshotEnvelope {
    pub revision: String,
    pub data: CompanionSnapshot,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshot {
    pub auth_required: bool,
    pub recording: CompanionRecordingState,
    pub microphone: CompanionMicrophoneState,
    pub controls: CompanionControlState,
    pub live: CompanionLiveState,
    pub timeline: Vec<CompanionMessage>,
}
```

Ключевой момент:

- `revision` обязателен
- phone HTTP и desktop Tauri command должны отдавать **один и тот же contract**

### Слой 3 - Companion Timeline reducer

Нужен reducer, который обновляет snapshot строго через backend payloads.

Пример сообщения:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMessage {
    pub id: String,
    pub seq: u64,
    pub kind: String,      // stt | mic | haiku
    pub role: String,      // incoming | outgoing
    pub status: String,    // final | streaming | error
    pub text: String,
    pub created_at_ms: i64,
    pub session_id: Option<u64>,
    pub request_id: Option<String>,
    pub generation: Option<u64>,
}
```

### Слой 4 - HTTP/SSE surface

Phone UI работает только с этим слоем.

### Слой 5 - Desktop rehydrate bridge

Desktop окно не должно пытаться "догадываться", что произошло, если оно спало.  
Оно должно уметь `refresh()` snapshot from Rust.

---

## Почему snapshot должен быть один и для phone, и для desktop

Это критично.

Если сделать отдельно:

- HTTP snapshot для телефона
- другой IPC snapshot для desktop

то появится два разных контракта и drift.

Нужно:

- один `CompanionSnapshotEnvelope`
- один backend reducer
- два транспорта:
  - Tauri `invoke('get_companion_snapshot')`
  - HTTP `GET /api/state`

---

## Companion state model

Здесь - самое важное изменение по сравнению со старым планом.

### Нельзя использовать timestamps как главный semantic floor

Старый план опирался на:

- `context_cleared_at_ms`
- `history_cleared_at_ms`

Это лучше, чем local index, но всё ещё не идеально.

Надёжнее:

- держать монотонный backend `seq`
- все semantic cutoffs выражать через `seq`

Пример:

```rust
pub struct CompanionControlState {
    pub history_floor_seq: u64,
    pub context_floor_seq: u64,
    pub conversation_generation: u64,
}
```

### Почему `seq` лучше, чем время

- не зависит от clock skew
- не ломается при одинаковых timestamps
- deterministic для desktop/phone/backend

### Как работают floor values

- `history_floor_seq`
  - сообщения `<= history_floor_seq` не входят в visible history и AI context
- `context_floor_seq`
  - сообщения `<= context_floor_seq` видны в UI, но не входят в AI context

Это важное различие:

- `history clear` режет и UI, и AI context
- `context clear` режет только AI context

---

## Session gating для transcription events

Companion reducer должен повторить принцип frontend gate, но уже в Rust.

Минимально нужны:

```rust
pub struct CompanionRecordingState {
    pub status: String,
    pub active_session_id: u64,
    pub closed_session_floor: u64,
    pub last_seen_session_id: u64,
    pub connection_quality: String,
}
```

### Правила

#### На `RecordingStatus::Starting(session = s)`

- если `s > closed_session_floor`
- сделать `active_session_id = s`
- очистить live partial buffers
- status = `Starting`

#### На partial/final payload с `session_id < active_session_id`

- игнорировать

#### На `Idle/Error(session = s)`

- если `s == active_session_id`
- `closed_session_floor = max(closed_session_floor, s)`
- очистить live partials

### Почему это обязательно

Без этого старые callback closures из прошлой recording session смогут загрязнить новый snapshot.

---

## AI request lifecycle model

Старый план недооценивал stale `haiku` events.

Нужен generation-based guard.

```rust
pub struct CompanionAiState {
    pub current_generation: u64,
    pub active_requests: std::collections::HashMap<String, CompanionAiRequestMeta>,
}

pub struct CompanionAiRequestMeta {
    pub generation: u64,
    pub message_id: String,
}
```

### Правила

#### При старте нового AI request

- request получает `generation = current_generation`
- создаётся streaming message

#### При `clear context` или `clear history`

- `current_generation += 1`
- все старые `active_requests` логически инвалидируются

#### На `haiku:delta/done/error`

- если request привязан к generation < current_generation
- событие игнорируется

### Что это решает

- старые AI deltas не оживляют очищенный timeline
- clear не приводит к "призракам" старого ответа

---

## Security model для local companion

Это было пропущено в старом плане. Для LAN control это must-have.

### Угроза

Companion server слушает `0.0.0.0`, значит любой девайс в той же сети потенциально видит порт.

### Требование

У companion должен быть random session token.

### Почему нельзя просто ставить header на SSE

Потому что нативный `EventSource` не умеет custom headers.  
У него в constructor есть только `withCredentials`.

### Безопасная схема

#### Для страницы и SSE

Использовать token в URL:

```text
http://<mac-ip>:<port>/c/<token>
http://<mac-ip>:<port>/events?token=<token>
```

#### Для POST

Использовать header:

```text
X-Companion-Token: <token>
```

### Дополнительные правила

- production companion server не должен слушать `0.0.0.0` всегда по умолчанию
- bind на LAN включается только когда companion mode явно активирован
- не отдавать `Access-Control-Allow-Origin`
- reject `OPTIONS`
- reject POST без `Content-Type: application/json`
- token ротировать при каждом старте приложения
- token ротировать при logout/disable companion mode
- не логировать полный URL запроса, чтобы не утекал token
- позже можно добавить кнопку `Regenerate link`
- phone page должна быть self-contained, без внешних шрифтов/скриптов/картинок
- для HTML ответа лучше выставлять `Referrer-Policy: no-referrer`

### Практический вывод

⚠️ QR/link на телефон должен содержать token, а не просто `http://ip:port`.

### Listener lifecycle

Рекомендуемое поведение:

1. при старте приложения `CompanionRuntime` создаётся, но LAN listener не поднимается
2. при `enable_companion_mode`:
   - генерируется новый token
   - поднимается listener task
   - сохраняется `JoinHandle`
3. при `disable_companion_mode` или logout:
   - listener task abort
   - token invalidated
   - порт освобождён

Это лучше, чем всегда слушать порт в фоне.

---

## Почему `toggle` нельзя использовать как API

Старый план включал `POST /api/record/toggle`. Это плохой контракт.

### Проблема

Если:

- телефон видит stale snapshot
- desktop одновременно меняет состояние

то `toggle` может сделать противоположное ожидаемому действие.

### Правильный API

```text
POST /api/record/start
POST /api/record/stop
POST /api/microphone/mute
POST /api/microphone/unmute
POST /api/context/clear
POST /api/history/clear
```

### Поведение должно быть идемпотентным

#### `record/start`

- если уже `Recording` или `Starting` - вернуть `200/202` и не падать

#### `record/stop`

- если уже `Idle` или `Processing` - вернуть `200/202`

То же для `mute/unmute`.

---

## Shared actions и desktop кнопки

### Важная коррекция

Desktop `broom` и `trash` нельзя оставлять как local-only actions, если phone companion тоже будет ими управлять.

### Правильная схема

Desktop кнопки должны вызвать backend command, например:

```ts
await invoke('companion_clear_context');
await invoke('companion_clear_history');
```

А локальное очищение desktop store должно происходить не напрямую из click handler, а из companion snapshot apply path.

### Почему это важно

Если desktop оставит локальную write path, а phone будет писать в backend SoT, получится два разных semantic state.

### Migration blocker

До перевода `broom` и `trash` на backend write path:

- нельзя считать их shared controls
- нельзя обещать parity между phone и desktop

---

## Companion не должен сразу поддерживать весь текущий desktop feature set

Это самая важная scope correction.

### В `v1` safe to share

- live transcript view
- record start/stop
- mic mute/unmute
- live AI output display, если AI был запущен с desktop и backend уже стримит результат

### В `v1` не надо шарить

- selection
- lasso
- inline edit
- delete message
- reply-to-message
- prompt composer
- image attachments
- real AI cancel

### Почему

Почти всё из этого сейчас local-only в TS.

### Что делать с desktop функциями, которые меняют timeline локально

Есть 2 безопасных пути.

#### Вариант 1 - временно disable these features in companion mode
🎯 9   🛡️ 9   🧠 3  
Примерно `60-140` строк.

#### Вариант 2 - переносить их на backend write path
🎯 8   🛡️ 10   🧠 8  
Примерно `500-1200+` строк.

### Решение

Для первого production companion safest path - **disable local-only timeline mutations while companion mode is active**.

---

## Desktop rehydrate path

Это место, где старый план был недостаточно строгим.

### Цель

Если запись шла, пока desktop окно было скрыто, то при показе окна оно должно уметь догнать:

- live partial text
- timeline
- mic state
- control floors

### Как делать правильно

Нужно добавить:

- новый Tauri topic `companion-ui`
- команду `get_companion_snapshot`
- frontend sync handle, как в других store

Пример topic:

```ts
export const TOPIC_COMPANION_UI = 'companion-ui';
export const CMD_GET_COMPANION_SNAPSHOT = 'get_companion_snapshot';
```

### На Rust стороне

При любом meaningful companion state update:

```rust
let revision = AppState::bump_revision(&state.companion_revision).await;
AppState::emit_invalidation(
    &app_handle,
    "companion-ui",
    revision,
    source_id,
).await;
```

### На frontend стороне

Либо отдельный `companionStore`, либо manual sync handle.

На `EVENT_RECORDING_WINDOW_SHOWN`:

```ts
await companionSyncHandle?.refresh();
```

### Почему это must-have

Потому что hidden `NSPanel` уже сейчас может пропускать invalidation events.

### Что считать `meaningful companion state update`

⚠️ Не надо эмитить Tauri invalidation на каждый partial token и каждый live delta.

В `Phase 4` invalidation должна идти только на coarse transitions:

- recording start
- recording stop
- microphone mute state changed
- auth required changed
- context/history clear
- companion mode enabled/disabled

А latest live state desktop догоняет через:

- свой обычный event layer, если окно активно
- `refresh()` при `window_shown`, если окно спало

Это защищает от event storm и лишней нагрузки на скрытый WebView.

### Важная коррекция к rollout

⚠️ Desktop нельзя сразу переводить на full timeline rehydrate из companion snapshot, пока backend reducer ещё не повторяет chat semantics.

Поэтому нужен двухшаговый путь:

#### Step A - coarse rehydrate

Через `companion-ui` синхронизируем только:

- recording status
- microphone state
- control floors
- auth_required

Но не делаем snapshot авторитетным для полного timeline desktop UI.

#### Step B - full timeline rehydrate

Только после того как backend reducer покрывает:

- session gating
- utterance merge
- нужный dedup
- clear semantics

можно убирать старый local-first timeline path и восстанавливать десктопный чат из companion snapshot.

### Практический вывод

⚠️ Если попытаться сделать full desktop rehydrate слишком рано, то мы не уберём баги, а просто перенесём их в другое место.

## Ownership matrix по фазам

Это нужен не для красоты, а чтобы не допустить split-brain, когда одно и то же поле
одновременно обновляется из двух разных источников.

### До `Phase 4`

- desktop recording status - текущие Rust events + existing TS stores
- desktop timeline - existing TS stores
- phone timeline - backend companion snapshot
- phone controls - нет shared writes

### `Phase 4`

- desktop coarse state (`recording`, `microphone`, `auth_required`, control floors) - companion snapshot
- desktop timeline text/messages - всё ещё existing TS stores
- phone timeline - backend companion snapshot

### `Phase 5`

- desktop `clear context/history` semantics - backend write path + snapshot apply
- desktop timeline rendering - ещё не полностью backend-owned
- phone timeline - backend companion snapshot

### `Phase 6`

- AI context builder - backend-owned
- shared AI lifecycle - backend-owned
- full timeline parity можно постепенно переводить на backend snapshot

### Жёсткое правило

⚠️ В рамках одной фазы один и тот же semantic field должен иметь ровно один authoritative source.

Нельзя, например:

- писать desktop `recording status` и из raw events, и из companion snapshot
- применять `clear context` локально в TS и одновременно из backend snapshot
- строить AI context частично из backend, частично из local-only edited timeline

---

## HTTP/SSE surface

### Recommended routes

```text
GET  /c/<token>                 -> phone page
GET  /api/state?token=<token>   -> current snapshot envelope
GET  /events?token=<token>      -> SSE snapshots
POST /api/record/start
POST /api/record/stop
POST /api/microphone/mute
POST /api/microphone/unmute
POST /api/context/clear
POST /api/history/clear
```

### Что важно

- `GET /api/state` должен возвращать тот же envelope, что Tauri command
- `GET /events` должен посылать **полный snapshot envelope**, а не patch
- heartbeat comment каждые `15s` полезен для mobile browsers
- mutating `POST` должны возвращать результат **из того же serialized write path**
- в `v1/v2` не нужен полноценный replay protocol по `Last-Event-ID`

### Response contract для mutating `POST`

Безопаснее всего не отвечать пустым `204`, а вернуть подтверждение + актуальный snapshot:

```json
{
  "ok": true,
  "actionResult": "started",
  "snapshot": {
    "revision": "17",
    "data": { "...": "..." }
  }
}
```

Почему это важно:

- phone UI не зависит только от того, придёт ли `SSE` мгновенно
- после reconnect UI быстрее приходит в согласованное состояние
- проще дебажить idempotent `noop` и `rejected` cases
- можно честно обработать `busy_transition`, не теряя текущее состояние

Пример SSE frame:

```text
id: 17
event: snapshot
retry: 1500
data: {"revision":"17","data":{...}}

```

### Почему full snapshot, а не patch

Потому что в первом стабильном rollout correctness важнее, чем экономия байтов.

### Почему пока без replay buffer

Хотя `EventSource` поддерживает `id`, для этого rollout safer path такой:

- `id` можно равнять `revision`
- но сервер **не обязан** хранить историю снапшотов и досылать пропущенные диффы
- reconnect correctness достигается через `GET /api/state` + latest snapshot stream

Это существенно проще и надёжнее, чем пытаться сразу реализовать event replay.

### Publish policy

Полный snapshot по `SSE` не должен публиковаться "на каждый чих" без коалесинга.

Рекомендуемый policy:

- state mutate - сразу
- `SSE publish` - coalesced, latest-wins
- soft throttle примерно `50-100ms`
- durable transitions публикуются сразу

Пример durable transitions:

- recording start/stop
- mic mute/unmute
- clear context/history
- auth required changed

Пример coalesced transitions:

- live partial text updates
- haiku token deltas

Это снижает риск перегруза phone UI и бессмысленного full-snapshot spam.

### Command execution policy

Mutating `POST` не должны делать optimistic local patching на телефоне.  
Порядок должен быть таким:

1. route получает token и проходит auth
2. route берёт `companion_action_lock`
3. route выполняет internal action
4. route собирает итоговый snapshot
5. route отвечает `snapshot` в HTTP
6. потом публикует/коалесит `SSE`

Так phone UI получает deterministic result даже если `SSE` в этот момент переподключается.

### Explicit action result vocabulary

Чтобы не плодить двусмысленность, mutating actions должны возвращать ограниченный набор результатов:

- `started`
- `stopped`
- `muted`
- `unmuted`
- `cleared_context`
- `cleared_history`
- `noop`
- `busy_transition`
- `rejected_auth`

Так проще писать phone UI и тесты, чем разбирать произвольные строки ошибок.

### Reconnect policy

Phone page должна делать:

- initial `GET /api/state`
- потом `EventSource('/events?...')`
- на `error` не паниковать, а ждать native reconnect
- на `visibilitychange -> visible` делать дополнительный `GET /api/state`
- если `POST` вернул более новый snapshot, применить его сразу, не дожидаясь `SSE`

Это нужно, потому что mobile browser backgrounding часто рвёт long-lived connections неочевидно.

---

## Hyper-based server skeleton

Если делать production surface, safer path выглядит так:

```rust
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

loop {
    let (stream, _) = listener.accept().await?;
    let io = TokioIo::new(stream);
    let app = app_handle.clone();

    tokio::spawn(async move {
        let service = service_fn(move |req| route_request(app.clone(), req));
        let _ = http1::Builder::new().serve_connection(io, service).await;
    });
}
```

### Почему это лучше handwritten parser

- нормальный HTTP parsing
- predictable request lifecycle
- легче писать тесты на handlers

---

## Что должно жить в snapshot, а что нет

### Safe to expose

- `auth_required`
- recording status
- connection quality
- microphone mute state
- live partial texts
- timeline messages
- control floor seq values
- revision

### Must not expose

- access token
- refresh token
- provider API keys
- backend auth token
- private config internals

### Auth gating

Если пользователь не авторизован:

- snapshot должен вернуть `auth_required: true`
- phone page должна показать locked/read-only состояние
- mutating POST endpoints должны отвечать `401`

Это важно, потому что текущий desktop hotkey path уже проверяет auth state, а companion тоже должен соблюдать тот же продуктовый инвариант.

---

## Этапы rollout

Здесь уже не "хотелки", а правильный порядок, если цель - без скрытых регрессий.

### Phase 0 - prep fixes

Сделать до companion rollout:

1. зафиксировать local `haiku` lifecycle bug around clear/cancel
2. решить, что делать с local-only edit/delete/reply while companion mode active
3. добавить feature flag или явный режим `companion_mode_enabled`
4. убрать или жёстко загейтить destructive clear в `window_shown`/`start_requested`
5. вынести companion-safe internal helpers из UI-oriented Tauri commands
6. завести `companion_action_lock` и зафиксировать single-writer policy для shared writes

Почему это Phase 0:

пока локальная timeline mutation semantics не ограничена, shared companion semantics будет хрупкой.

### Phase 1 - backend snapshot + secure server

Сделать:

- `CompanionRuntime` в Rust
- snapshot envelope
- explicit `companion_mode_enabled`
- `GET /api/state`
- `GET /events`
- secure tokened page
- `hyper` server вместо production handwritten parser
- explicit server task lifecycle (`start/stop/rotate token`)

Пока без shared action buttons.

### Phase 2 - read-only phone UI

Сделать:

- phone page с render snapshot
- reconnect logic
- `visibilitychange -> refresh()`

Проверить:

- hidden desktop
- reconnect после suspend/resume
- no stale data after reconnect

Это ещё **preview-only**, не ship-ready shared UX.

### Phase 3 - idempotent record/mic actions

Сделать:

- `record/start`
- `record/stop`
- `microphone/mute`
- `microphone/unmute`
- `POST -> snapshot` response contract
- explicit `busy_transition` handling
- action result vocabulary без произвольных строк

Проверить:

- rapid repeated taps
- desktop hotkey одновременно с phone action
- no double flip
- duplicate start не двигает `session_id`, если реального старта не было

### Важная продуктовая фиксация для mic control

Shared phone control должен означать именно **OS microphone mute/unmute**, а не абстрактное
`microphone_transcription_enabled`.

Почему:

- текущая desktop кнопка уже фактически работает через `set_microphone_muted`
- `microphoneEnabled` в TS - это производное UI-состояние
- backend сам синхронизирует mute state и `set_microphone_transcription_enabled`

Если перепутать эти два уровня, phone и desktop начнут по-разному понимать одну и ту же кнопку.

### Phase 4 - companion-ui revision sync for desktop

Сделать:

- `companion-ui` topic
- `get_companion_snapshot`
- desktop `refresh()` on window shown
- coarse rehydrate only, без авторитетного timeline restore

Проверить:

- окно было скрыто
- companion работал
- окно показали
- coarse state корректно догнал snapshot
- нет invalidation storm на partial updates

### Phase 5 - backend-owned clear context/history

Сделать:

- `history_floor_seq`
- `context_floor_seq`
- backend commands
- desktop broom/trash переводим на backend path

Проверить:

- clear с телефона
- clear с desktop
- hidden window catch-up
- no stale AI deltas after clear

### Phase 6 - shared reducer for AI context parity

Сделать:

- backend context builder
- backend merge/dedup semantics enough to match desktop
- generation gating for AI requests

Только после этого можно включать:

- phone AI request button

---

## Release gates

Это новый обязательный раздел. Без него слишком легко перепутать "технически работает" и "можно отдавать пользователю".

### Dev Preview Gate

Можно включать только себе, если готовы:

- `Phase 1`
- `Phase 2`

Что разрешено:

- открыть phone page
- смотреть live state

Что нельзя обещать:

- shared timeline parity с desktop
- shared clear semantics
- shared AI semantics

### Beta Gate

Можно давать ограниченно, если готовы:

- `Phase 3`
- `Phase 4`

Что разрешено:

- shared record/mic controls
- coarse desktop catch-up

Что нельзя обещать:

- полный parity desktop chat после sleep/hide
- shared AI request
- shared local edits/deletes

### Stable Gate

Можно считать полноценным feature только если готовы:

- `Phase 5`

И только тогда допустимо обещать:

- shared semantic controls
- desktop/phone convergence
- отсутствие destructive clear drift

Что всё ещё нельзя обещать:

- safe AI requests from phone

### Stable AI Gate

Можно включать phone AI только если готовы:

- `Phase 6`

И только тогда допустимо обещать:

- safe AI requests from phone

---

## Что должно быть протестировано unit tests, а не только руками

### 1. Session race tests

Сценарии:

- session 1 partial -> session 2 starts -> late session 1 final ignored
- session 2 idle -> late session 2 partial ignored
- duplicate `record/start` during `Starting` не должен сжечь ещё один live session

### 2. AI generation tests

Сценарии:

- request A started
- `history clear`
- `haiku:delta` for request A arrives later
- delta ignored
- live-anchored AI response после финального STT переякоривается детерминированно

### 3. Security tests

Сценарии:

- missing token -> `401/403`
- wrong token -> `401/403`
- POST without required header -> reject
- `OPTIONS` -> reject
- HTML page не тянет внешние ресурсы и не утекает token через referer

### 4. Snapshot tests

Сценарии:

- snapshot revision monotonic
- same mutation order gives deterministic timeline order
- mutating `POST` возвращает snapshot не старее текущего `revision`

### 5. Desktop rehydrate tests

Сценарии:

- window misses invalidation
- later `refresh()` pulls newer revision
- old revision does not overwrite new state

### 6. Publish coalescing tests

Сценарии:

- 20 partial updates подряд
- наружу ушло не 20 независимых publish bursts, а coalesced latest-wins поток

### 7. Listener lifecycle tests

Сценарии:

- enable companion -> listener started
- disable companion -> listener aborted
- re-enable companion -> token changed, old token rejected

### 8. Single-writer tests

Сценарии:

- phone `record/start` и hotkey `record/start` одновременно
- phone `history/clear` и desktop `trash` одновременно
- `disable companion mode` во время открытого `SSE`
- второй mutating `POST` во время долгого `start_recording` получает `busy_transition`, а не висит бесконечно

Ожидаемо:

- итоговый snapshot согласован
- `revision` монотонен
- нет двойного `session_id` burn

---

## Что обязательно проверить руками

### Scenario A - hidden desktop full loop

Prerequisite:

- `Stable Gate` минимум

1. Скрыть desktop окно
2. Открыть phone page
3. Начать запись с телефона
4. Поговорить
5. Остановить запись
6. Показать desktop окно

Ожидаемо:

- desktop видит актуальный timeline
- нет пустого/старого состояния

### Scenario B - concurrent controls

1. Начать запись hotkey на Mac
2. Пока идёт `Starting`, нажать stop/start на телефоне

Ожидаемо:

- никаких flip-flop
- состояние консистентное

### Scenario C - clear during active AI

Prerequisite:

- `Stable AI Gate`

1. Запустить AI
2. Пока stream идёт, нажать `clear history`

Ожидаемо:

- старые AI deltas больше не оживляют timeline

### Scenario D - mobile suspend/resume

1. Открыть phone page
2. Свернуть браузер на телефоне
3. Подождать
4. Вернуть страницу

Ожидаемо:

- state refresh проходит
- UI не остаётся со stale snapshot

### Scenario E - window shown does not destroy shared state

Prerequisite:

- `Beta Gate` минимум

1. Держать companion активным на телефоне
2. На Mac скрыть окно
3. Дать timeline накопиться
4. Показать desktop окно

Ожидаемо:

- окно не вызывает destructive local clear
- оно делает `refresh()` и догоняет backend

### Scenario F - companion disable/enable rotation

1. Включить companion mode
2. Открыть phone page
3. Выключить companion mode
4. Попробовать использовать старый URL
5. Включить снова

Ожидаемо:

- старый token больше не работает
- новый token отличается
- порт/сервер lifecycle предсказуем

---

## Что я считаю безопасным scope для первого реального companion релиза

### Recommended v1
🎯 10   🛡️ 9   🧠 5  
Примерно `700-1300` строк.

Соответствует `Beta Gate`, но ещё не `Stable Gate`.

Включает:

- secure tokened local page
- live transcript/AI display
- record start/stop
- mic mute/unmute
- coarse desktop rehydrate

Не включает:

- phone AI request
- clear context/history
- edit/delete/select/reply

### Recommended v2
🎯 9   🛡️ 9   🧠 7  
Примерно ещё `400-900` строк.

Соответствует `Stable Gate`, но ещё не `Stable AI Gate`.

Добавляет:

- backend-owned clear context/history
- desktop broom/trash через backend
- companion-ui revision sync for control floors

### Recommended v3
🎯 8   🛡️ 9   🧠 8  
Примерно ещё `500-1200` строк.

Соответствует `Stable AI Gate`.

Добавляет:

- shared AI context reducer
- phone AI button
- generation-safe AI lifecycle

---

## Что точно не надо делать

### 1. Не надо строить production companion поверх текущего handwritten HTTP parser

Для тестовой страницы ок. Для настоящего режима - нет.

И особенно не надо тащить в production:

- `OnceLock` для активного порта
- бесконечный task без shutdown handle
- unconditionally-started LAN listener

### 2. Не надо использовать custom desktop events как основной sync

Они хороши как дополнительный сигнал, но не как SoT sync.

### 3. Не надо делать `toggle` API

Слишком хрупко при двух клиентах.

### 4. Не надо обещать phone AI parity до shared reducer

Иначе prompt semantics разъедется.

### 5. Не надо тащить весь `RecordingPopover.vue` на телефон

Нужно переиспользовать визуальные идеи, а не Tauri-specific logic.

### 6. Не надо вызывать текущий `start_recording` напрямую из HTTP route

Пока он сам выделяет `session_id` до подтверждённого старта, это не безопасный public write path для companion.

---

## Итоговое решение

Самый уверенный путь такой:

1. production companion server - `hyper` stack, не handwritten parser, не latest `axum`
2. один Rust `CompanionSnapshotEnvelope` для HTTP и Tauri
3. один Rust reducer для companion timeline/control state
4. `companion-ui` revision topic для desktop rehydrate
5. idempotent explicit commands, не `toggle`
6. tokened local companion link, потому что `EventSource` не умеет custom headers
7. AI button и shared semantic actions только после выноса нужной логики из local TS state

Если идти именно так, то получится companion, который не зависит от того, бодрствует ли desktop WebView, и не разваливается на скрытых race conditions.

---

## Ссылки, которые повлияли на решения

- `axum` repo: latest `0.8.9`, MSRV `1.80` - [GitHub](https://github.com/tokio-rs/axum)
- `hyper` official guide for server stack - [hyper.rs](https://hyper.rs/guides/1/server/hello-world/)
- `hyper` MSRV policy - [hyper.rs MSRV](https://hyper.rs/contrib/msrv/)
- `EventSource()` options - only `withCredentials` is supported, no custom headers - [MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource)
