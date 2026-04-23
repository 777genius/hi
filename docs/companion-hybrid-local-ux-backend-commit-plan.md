# Hybrid Plan - Desktop Local UX, Backend Commit Actions

## Статус документа

Это не "идея направления", а жёсткая implementation spec для варианта:

- desktop UX остаётся локальным
- все действия, которые меняют shared timeline или запускают shared AI, идут через backend
- phone companion остаётся projection от backend snapshot

Цель документа:

- вернуть в desktop companion mode весь привычный UX
- не создать split-brain между desktop, phone и Rust reducer
- сделать это быстрее, чем полный перенос вообще всего UI-state в backend

---

## Почему выбираем именно этот вариант

### Вариант 1 - Гибрид: desktop UX локальный, но все commit-действия идут через backend
🎯 10   🛡️ 9   🧠 6  
Примерно `700-1500` строк изменений.

Плюсы:

- вернёт пользователю почти весь прежний desktop UX
- phone будет видеть корректный итог действий через snapshot/SSE
- не нужно тянуть в backend hover, lasso, selection-rect, inline draft caret state
- заметно безопаснее и быстрее, чем full backend SoT вообще для всего UI

Минусы:

- нужно очень чётко отделить local-only state от shared state
- нельзя делать optimistic shared mutations в TS
- понадобится несколько новых backend actions и тестов на race

### Вариант 2 - Полный backend SoT вообще для всего, включая selection state
🎯 8   🛡️ 10   🧠 9  
Примерно `1200-2500+` строк изменений.

Плюсы:

- архитектурно максимально чисто
- desktop и phone потенциально смогут когда-нибудь делить даже selection semantics

Минусы:

- долго
- риск сломать текущий UX заметно выше
- для твоей цели это избыточно

### Вариант 3 - Просто снова включить все локальные desktop actions
🎯 10   🛡️ 3   🧠 2  
Примерно `30-120` строк изменений.

Плюсы:

- очень быстро

Минусы:

- часть AI пойдёт по local context, часть по backend context
- phone будет показывать не ту историю, из которой desktop уже строит ответы
- delete/edit/reply/prompt/images снова создадут drift

### Финальный выбор

Берём **Вариант 1**.

Ключевая идея:

- selection, lasso, hover, inline draft, ask draft, pasted images до отправки - остаются локальными
- edit, delete, make-question, reply, prompt send, shared AI request, cancel AI - переходят на backend commit path

---

## Что уже есть в коде и на что можно опереться

Ниже не абстракция, а то, что уже реально существует в проекте.

### 1. Shared companion backend уже есть

В проекте уже работают:

- snapshot + revision для `companion-ui`
- `SSE + HTTP` companion server
- backend-owned `companion_timeline`
- `companion_action_lock`
- backend AI request path
- shared phone page

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion.rs`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion_actions.rs`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion_timeline.rs`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/commands.rs`

### 2. Shared renderer списка сообщений уже тоже есть

Один и тот же feed-рендер уже переиспользуется для desktop и phone:

- `/Users/belief/dev/projects/HackInterview/src/presentation/components/ConversationFeed.vue`
- `/Users/belief/dev/projects/HackInterview/src/presentation/companionFeed.ts`

Это очень важно: не надо второй раз изобретать message list. Нужно только дать этому feed правильный shared snapshot.

### 3. Самый большой remaining drift всё ещё живёт в desktop local actions

Сейчас локально в TS ещё живут:

- `editMessageText()`
- `deleteMessage()`
- `replyToMessageWithAi()`
- `sendPromptToLlm()`
- selection-based `requestHaikuFromAnchor()`
- local `cancelActiveHaikuStreams()`

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`
- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

### 4. В companion mode часть UX просто blanket-отключена

Сейчас это завязано на:

```ts
const localTimelineMutationsDisabled = computed(() => chatStore.companionModeEnabled);
```

Из-за этого в companion mode отключаются не только опасные commit-операции, но и безопасный local UX, например:

- selection click
- lasso
- selection badge
- hover shell
- ask composer UI
- code selection button

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

### 5. Есть важный blocker, который нельзя пропустить

Сейчас при `hydrateFromCompanionSnapshot()` chat store в companion mode делает:

```ts
if (companionModeEnabled.value) {
  clearSelection();
}
```

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`

⚠️ Если просто вернуть selection UI, но оставить это поведение, любой snapshot будет мгновенно убивать выделение. Это один из самых тонких багов в этом рефакторе.

### 6. Code explain по выделенному фрагменту не shared и не должен им становиться

Кнопка по выделенному коду/тексту сейчас запускает отдельный local dialog через:

- `start_code_explain_stream`
- отдельный `codeExplainDialogOpen`
- отдельный `codeExplainRequestId`

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/commands.rs`

Это не shared timeline mutation. Значит его можно вернуть в companion mode как local-only UX без backend timeline refactor.

### 7. `companionModeEnabled` в desktop сейчас равен факту работы companion server

В текущем snapshot:

- `snapshot.controls.companionModeEnabled` строится из `runtime.enabled`
- это не отдельный продуктовый флаг, а фактически `server enabled`

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion.rs`
- `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`

Вывод:

⚠️ hybrid plan должен ключеваться по текущему `chatStore.companionModeEnabled`, но помнить, что выключение companion mode означает не "убрать часть UI", а буквально "server disabled / token rotated / snapshot перестаёт быть shared source".

### 8. Компонент прямо сейчас сам уничтожает часть UX при включении companion mode

В `RecordingPopover.vue` есть watch, который на `enabled = true` делает:

- `askComposerOpen = false`
- `editingMessageId = null`
- `chatStore.clearSelection()`
- `hideCodeSelectionUi()`

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

⚠️ Это migration blocker. Даже если вернуть UI-кнопки, этот watch всё равно будет закрывать composer, edit и selection.

### 9. `filterSelectableIds()` уже есть, но в текущем виде оно слишком слабое

Сейчас helper проверяет только "id существует в `messages`".

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`

Для hybrid этого недостаточно, потому что:

- deleted messages не должны считаться selectable
- `haiku` не должны становиться selectable
- synthetic live ids не должны становиться selectable для shared commit paths
- одного `filterSelectableIds()` недостаточно, потому что текущие `selectOnly()` и `toggleSelection()` обходят его вообще
- `ConversationFeed.onMessageClick()` сейчас блокирует только `haiku`, а deleted bubble всё ещё кликабелен как selection target

Значит план должен не создавать второй helper рядом, а:

- **усилить существующий** `filterSelectableIds()`
- ввести один общий predicate `isMessageSelectable(...)`
- использовать этот predicate в:
  - `filterSelectableIds()`
  - `selectOnly()`
  - `toggleSelection()`
  - desktop row click path
  - lasso result reconciliation

⚠️ Иначе получится ложное чувство безопасности: hydrate и lasso будут "как будто правильные", но одиночный клик по deleted/live row всё равно сможет положить невалидный id в selection.

### 10. `state.history` и `state.final_transcription` не равны companion SoT

По текущему коду:

- `state.history` пополняется при системных final STT
- `state.final_transcription` обновляется как агрегат для legacy UI path
- companion AI context строится из `companion_timeline`
- desktop companion hydrate тоже строится из `snapshot.timeline`
- phone feed тоже строится из `snapshot.timeline`

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/commands.rs`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion_timeline.rs`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion.rs`

Вывод:

⚠️ Не надо в этом rollout пытаться делать `state.history` новым shared source of truth.

Но есть nuance:

- `snapshot.live.finalText` всё ещё берётся из `state.final_transcription`

Самый безопасный путь в этом rollout:

- **не трогать `state.history`**
- **best-effort пересчитывать `state.final_transcription`** после backend edit/delete `stt`, чтобы shared contract не становился внутренне противоречивым

### 11. Existing AI pipeline уже умеет почти всё, что нужно hybrid send/reply

Сейчас `start_haiku_chat_stream(...)` уже умеет:

- append prompt message
- пробросить attachments
- выставить `prompt_message_id`
- создать haiku placeholder

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/commands.rs`

Вывод:

⚠️ Для `companion_send_prompt` не нужно писать новый prompt/image pipeline. Безопаснее обернуть существующий `start_haiku_chat_stream(...)`.

### 12. HTTP surface для phone почти не нужно расширять, кроме одного shared prompt path

Сейчас phone server уже имеет routes только для:

- record start/stop
- mic mute/unmute
- clear context/history
- AI request

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion.rs`

Вывод:

⚠️ В этом rollout не надо добавлять phone HTTP routes для `edit/delete/reply/cancel`.

Но здесь нужен один deliberate exception:

- `prompt send with images` для phone companion
- тот же backend commit path, что и у desktop `companion_send_prompt`
- camera/gallery на телефоне должны использовать именно его, а не отдельный image-specific pipeline

Причина:

- задача сейчас про возврат desktop UX
- phone для фото-вопросов не может опираться только на projection, ему нужен mutating path
- reuse одного shared prompt route заметно безопаснее, чем придумывать вторую camera-specific semantics
- все остальные новые routes всё ещё только расширят surface area и объём тестов

### 13. Desktop hydrate path сейчас ломает parity для deleted messages, особенно для `stt`

В `chat.ts` текущий `hydrateFromCompanionSnapshot()` делает:

```ts
const timeline = [...(snapshot.timeline ?? [])]
  .filter((message) => !message.deleted)
  .sort((a, b) => a.seq - b.seq);
```

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`
- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`
- `/Users/belief/dev/projects/HackInterview/src/presentation/companionFeed.ts`

⚠️ Это уже противоречит shared renderer:

- phone feed сохраняет deleted messages
- desktop hydrate их сейчас выкидывает

Значит hybrid plan обязан:

- убрать blanket `.filter((message) => !message.deleted)` из desktop hydrate
- сохранить `deleted` flag в chat store projection
- только selection/filter logic должна исключать deleted ids из selectable, но не сам feed

Но этого **недостаточно само по себе**.

Сейчас второй projection-слой тоже режет deleted `stt`:

```ts
finalUtterances.value = snapshot.timeline
  .filter((message) => message.kind === 'stt' && message.status === 'final' && !message.deleted)
  .sort((a, b) => a.seq - b.seq)
  .map(...)
```

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src/stores/transcription.ts`

⚠️ Значит даже если убрать filter в `chat.ts`, desktop всё равно не восстановит deleted tombstone для системных реплик, потому что `transcription.ts` уже потерял эти записи раньше.

Обязательное решение:

- расширить hydrated `FinalUtterance` полями `deleted`, `seq`, `sttIndex`
- в companion hydrate path не выкидывать deleted `stt`
- в `chatStore.sttMessages` строить projection из этих сохранённых полей, а не заново "из индекса"

Важное уточнение:

- local non-companion delete path всё ещё может оставаться hard-remove
- companion hydrate path обязан уметь показывать tombstones, потому что backend snapshot уже содержит их как shared truth

### 14. Desktop projection сейчас теряет backend `seq` для `stt`

Сейчас цепочка такая:

- `transcription.hydrateFromCompanionSnapshot()` сохраняет `id/sessionId/text/timestamp`
- `chatStore.sttMessages` потом заново синтезирует `seq` как `idx`

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src/stores/transcription.ts`
- `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`

⚠️ Это значит:

- backend absolute ordering для `stt` не сохраняется в desktop projection
- при одинаковых `createdAtMs` можно словить reorder относительно `mic/prompt`

Самый безопасный путь:

- расширить desktop `FinalUtterance` optional-полями `seq` и `sttIndex`
- при hydrate сохранить backend `seq/sttIndex`
- в `chatStore.sttMessages` использовать preserved `seq`, а не array index

### 15. Synthetic live ids нельзя считать обычными backend message ids

Сейчас desktop feed и selection могут работать с synthetic ids:

- `stt:live`
- `mic:live`

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`
- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

⚠️ Это не реальные durable ids в backend timeline.

Значит hybrid v1 должен зафиксировать решение:

- edit/delete/reply работают только по durable ids
- selection для backend commit path фильтрует synthetic live ids
- synthetic live rows остаются purely visual/live, но не целями shared commit action

Это deliberate safety cut. Иначе придётся изобретать отдельную semantics для `LIVE_MIC_MESSAGE_ID`, которой сейчас в backend нет.

### 16. Current AI start path уже сейчас делает лишний `snapshot publish`

В `companion_actions::request_ai()` сейчас:

- `start_haiku_stream/start_haiku_chat_stream` уже сами вызывают `publish_snapshot(...)`
- после этого `success(..., "started_ai")` снова делает `publish_snapshot(...)`

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion_actions.rs`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/commands.rs`

⚠️ Это не catastrophic bug, но это:

- лишний revision bump
- лишний invalidation noise
- больше шансов на ложный resync churn в desktop/phone

Значит для новых hybrid AI actions в плане нужен принцип:

- **один user action - один immediate snapshot publish**
- последующие revision bumps только от real streaming deltas/done/error

### 17. Local component refs сейчас не reconcile'ятся по target validity

В `RecordingPopover.vue` локально живут:

- `editingMessageId`
- `askComposerOpen`
- `askDraftText`
- `askDraftImages`
- `codeSelectionUi`

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

⚠️ Сейчас это почти не связано со snapshot reconcile:

- если target message удалили с phone/backend, `editingMessageId` может остаться висеть на уже несуществующем id
- `codeSelectionUi` тоже может пережить удаление/очистку target сообщения
- `askDraftText/Images` наоборот не должны случайно исчезать из-за чужого remote action

Значит hybrid plan должен различать два класса local state:

- **target-bound local state**
  - `editingMessageId`
  - `codeSelectionUi.messageId`
- **free local draft state**
  - `askComposerOpen`
  - `askDraftText`
  - `askDraftImages`

Их нельзя reconcile'ить одинаково.

Правило:

- target-bound local state trim'ится, если его target больше не существует или стал deleted после snapshot
- free local drafts не трогаются remote snapshot actions и переживают чужие commits

### 18. Desktop AI button уже живёт на hover-start / click-cancel semantics

Сейчас main AI button в desktop UI работает так:

- `pointerenter` стартует `requestHaikuFromAnchor()` или companion AI path
- `click` отменяет только уже активный stream
- в companion mode сейчас кнопка ещё и disabled во время backend streaming

Опорное место:

- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

⚠️ Это значит, что hybrid rollout может легко случайно сломать desktop parity двумя способами:

- незаметно превратить кнопку в click-start вместо hover-start
- или вернуть backend cancel, но оставить streaming-state permanently disabled, и cancel снова окажется недоступен

Решение в плане должно быть явным:

- не менять desktop trigger-model в этом rollout
- companion mode сохраняет hover-start / click-cancel semantics
- меняем только commit path и disabled-логику, а не сам UX-контракт кнопки

### 19. `snapshot.controls.lastAction` сейчас выглядит sticky, а не edge-triggered

Сейчас backend кладёт `companion_last_action` в snapshot, но не видно общего механизма "consume and clear" после publish.

Опорные места:

- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion_actions.rs`
- `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion.rs`
- `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

⚠️ Это значит, что `lastAction` нельзя считать одноразовым событием.

Риск:

- snapshot с уже устаревшим `lastAction = cleared_context`
- потом приходит unrelated snapshot с новым `generation`
- desktop ошибочно снова воспроизводит старый local side-effect, если логика привязана к `lastAction`

Правильное правило для hybrid spec:

- desktop side-effects не должны опираться на `lastAction` как на edge-trigger
- direct desktop action cleanup идёт по `response.actionResult + response.ok`
- remote side-effects выводятся из monotonic deltas:
  - `sessionAdvanced`
  - `historyFloorSeq`
  - `contextFloorSeq`
  - `conversationGeneration`

`lastAction` можно оставить только как informational/debug field, но не как driver для local cleanup semantics

---

## Что должно получиться в конце

### На desktop в companion mode должны работать все привычные вещи

- selection click
- multi-select
- lasso
- selection badge
- hover action buttons
- inline edit
- make question
- reply with AI
- ask composer
- paste/attach images
- ask by selected messages
- code/text selection explain button
- cancel AI

### На phone не нужно показывать local desktop UX

Phone не обязан знать про:

- hover
- selection рамку
- lasso rectangle
- caret position при inline edit
- ask draft до отправки
- code explain dialog

Phone обязан видеть только **результат committed actions**:

- edited message
- deleted message
- new prompt message
- attached images
- new AI answer
- cancelled AI result

### В обычном desktop режиме вне companion mode ничего не должно сломаться

Это не рефактор "всего чата". Это рефактор поведения **только когда `companionModeEnabled === true`**.

---

## Жёсткие инварианты, без которых этот план нельзя реализовывать

### I1. Shared timeline не меняется из TS в companion mode

В companion mode запрещено вызывать локальные shared mutations:

- `chatStore.editMessageText()`
- `chatStore.deleteMessage()`
- `chatStore.replyToMessageWithAi()`
- `chatStore.sendPromptToLlm()`
- `chatStore.requestHaikuFromAnchor()`
- `chatStore.cancelActiveHaikuStreams()`

в качестве финального commit path.

Локальный TS может:

- открыть composer
- хранить draft
- показывать selection
- открыть inline edit
- собрать payload

Но commit идёт только через backend command.

### I2. Local desktop UX не попадает в snapshot

Никогда не синкаем в backend и phone:

- выделенные сообщения
- lasso rectangle
- hover state
- inline edit open/closed
- ask composer open/closed
- local image draft до отправки
- code explain dialog

### I3. Каждый mutating backend action должен возвращать свежий snapshot

Не полагаемся только на `SSE`.

Каждый mutating command должен вернуть:

```ts
type CompanionActionResponse = {
  ok: boolean;
  actionResult: string;
  snapshot: TauriSnapshotEnvelope<CompanionSnapshotData>;
};
```

Это уже существующий контракт и его нужно сохранить.

### I4. В companion mode не делаем optimistic shared mutation

Можно optimistically:

- крутить спиннер
- дизейблить кнопку
- держать inline draft
- держать ask draft

Нельзя optimistically:

- править текст сообщения
- удалять сообщение из local feed
- добавлять prompt message в feed
- добавлять/убирать haiku message

### I5. Все shared commit actions проходят через один serialized backend path

Под тем же `companion_action_lock`, что уже есть для:

- record start/stop
- mic mute/unmute
- clear context/history
- request AI

Нельзя делать отдельный "быстрый" path для edit/delete/prompt/reply.

### I6. `selection` должна переживать snapshot refresh, если её id ещё валидны

Нельзя больше blanket-очищать выделение на каждый `hydrateFromCompanionSnapshot()`.

Нужно:

- фильтровать selection по актуальным visible/selectable ids
- очищать selection только если action это требует явно

И ещё:

- `filterSelectableIds()`, `selectOnly()`, `toggleSelection()`, row click и lasso не имеют права жить на разных правилах selectable/non-selectable
- у selection должен быть один canonical predicate, иначе клик и drag начнут расходиться по поведению

### I7. Delete и cancel не должны допускать late resurrect

После delete/cancel нельзя позволить:

- позднему `delta`
- позднему `done`
- позднему `error`

оживить сообщение или изменить его после удаления.

### I8. AI cancel должен быть настоящим backend cancel

Не "игнорируем события во frontend", а:

- abort backend task
- удалить task handle
- удалить request generation binding
- привести timeline в финальное согласованное состояние

### I9. Message ids, seq и insertAfterId остаются backend-owned

Desktop не придумывает shared seq и не переупорядочивает shared timeline локально.

### I10. Любой action в companion mode должен быть safe при hidden desktop window

Desktop может быть скрыт, frozen, backgrounded.

Значит:

- action применим даже если UI спит
- phone всегда видит истину через snapshot/SSE
- desktop после rehydrate просто догоняет backend

### I11. Любой backend error в companion mode оставляет local draft в живом состоянии

Если backend rejectнул:

- inline edit остаётся открыт
- ask composer остаётся открыт
- draft text/images не теряются
- selection не пропадает сама по себе

Это особенно важно на телефоне и при hidden/reconnect сценариях, но и desktop UX от этого становится заметно надёжнее.

Дополнение:

- local draft/edit/composer закрываются только в handler'е того desktop action, который сам инициировал commit и получил `ok`
- `snapshot.data.controls.lastAction` не должен быть blanket-триггером для закрытия local drafts
- phone-originated edit/delete/prompt/cancel snapshot не должен случайно закрыть desktop inline edit или ask composer на другом сообщении

### I12. Phone HTTP surface расширяем только одним shared prompt-with-images route

Desktop получает новые backend commit actions через Tauri commands.

Phone в этом rollout:

- не получает `edit/delete/reply/cancel` routes
- получает только `send prompt with images` route
- продолжает жить на текущем `HTTP + SSE` surface
- видит результат через snapshot

Это deliberate scope cut, а не "потом просто доделаем".

Почему это допустимо:

- phone camera/gallery без mutating prompt path не решают продуктовую задачу
- `send prompt with images` уже естественно маппится на существующий backend `companion_send_prompt`
- все остальные actions по-прежнему безопаснее оставить desktop-only в этом rollout

### I13. `companion_action_lock` удерживается только на фазе commit/start-scheduling

Под lock нельзя держать:

- всю жизнь AI stream
- network streaming loop
- долгую пост-обработку изображений после старта stream

Под lock можно держать только:

- validation
- target lookup
- timeline mutation
- start scheduling
- snapshot publish

Иначе `COMPANION_ACTION_LOCK_TIMEOUT_MS = 200` начнёт давать ложные `busy_transition`.

### I14. Synthetic live ids не участвуют в shared commit actions

`stt:live` и `mic:live`:

- не редактируются
- не удаляются
- не участвуют в backend selection commit
- не становятся target для reply

Они остаются purely visual/live rows.

### I15. Desktop companion projection должен сохранять backend `seq` для `stt`

Нельзя в companion mode снова пересобирать `stt.seq` из array index, потому что это уже другой порядок, а не backend order.

### I16. Один user action не должен делать два immediate revision bump

Для AI-start действий:

- либо publish делает inner command
- либо publish делает outer action layer

Но не оба сразу.

### I17. Local ephemeral state reconcile должен быть target-aware

Не весь local state нужно чистить одинаково.

Нужно различать:

- target-bound local state
  - `editingMessageId`
  - `codeSelectionUi.messageId`
- free local draft state
  - `askComposerOpen`
  - `askDraftText`
  - `askDraftImages`

Правило:

- target-bound local state trim'ится, если его target больше не существует, deleted, или исчез после history/session reset
- free local drafts живут до explicit local close или successful local send

### I18. Main AI button в companion mode сохраняет desktop interaction contract

В этом rollout не меняем desktop semantics:

- hover-start остаётся hover-start
- click-cancel остаётся click-cancel

Меняем:

- backend commit/cancel path
- disabled-логику во время active backend stream

### I19. Snapshot apply не использует `lastAction` как edge-trigger для local cleanup

Desktop reconcile должен быть устроен так:

- direct local cleanup после собственного action идёт по `CompanionActionResponse`
- remote reconcile идёт по monotonic state deltas

Нельзя:

- делать generic side-effect из `snapshot.data.controls.lastAction`
- предполагать, что `lastAction` будет автоматически очищен после одного publish

---

## Разделение ответственности: что локально, а что shared

## Local-only desktop state

Это остаётся в TS и не требует sync:

- `selectedMessageIds`
- lasso state
- code selection popup position
- `editingMessageId`
- inline edited text до save
- `askDraftText`
- `askDraftImages`
- `askComposerOpen`
- `promptMenuOpen`
- code explain dialog state

Но это не означает, что всё из списка живёт одинаково:

- `editingMessageId` и `codeSelectionUi` - target-bound local state
- `askDraftText/Images` и `askComposerOpen` - free local draft state

Это distinction обязано пройти через reconcile-логику.

## Shared backend state

Это меняется только через Rust:

- existence сообщения в timeline
- текст `stt/mic/prompt/haiku`
- `deleted`
- `status`
- `insertAfterId`
- prompt attachments
- AI request lifecycle
- AI cancel lifecycle
- history/context floors
- generation
- `lastAction`

---

## Полный inventory действий и их целевая модель

| Действие | Сейчас | Целевое состояние | Shared? |
|---|---|---|---|
| Selection click | отключено в companion mode | вернуть как local-only | Нет |
| Lasso | отключено | вернуть как local-only | Нет |
| Selection badge | отключён | вернуть как local-only | Нет |
| Hover shell | отключён | вернуть как local-only | Нет |
| Inline edit open | отключён | вернуть как local-only draft | Нет |
| Inline edit save | local mutation | backend commit | Да |
| Make question | local mutation | local transform + backend edit commit | Да |
| Delete message | local mutation | backend commit | Да |
| Reply with AI | local AI path | backend AI path | Да |
| Main AI by selection/current context | backend only для tail, selection disabled | backend AI path с selection payload | Да |
| Ask composer open | отключён | вернуть как local-only | Нет |
| Paste/attach images | hidden because composer hidden | вернуть как local-only draft | Нет |
| Send prompt | local prompt + local AI path | backend commit | Да |
| Code explain dialog | hidden by blanket guard | вернуть local-only | Нет |
| Cancel AI | disabled in companion mode | backend cancel | Да |

---

## Ключевой architectural split

### Что остаётся локальным

Desktop остаётся местом, где удобно пользоваться UI:

- выделять сообщения
- таскать lasso
- печатать в composer
- вставлять картинки
- править текст в inline edit
- выделять код и открывать explain dialog

### Что коммитится в backend

Backend становится единственным местом, где фиксируется результат:

- отредактированный текст
- удаление
- новый prompt message
- новый AI request
- отмена AI

Это и есть heart гибридного решения.

---

## Самые тонкие места и как именно их закрывать

## 1. Selection нельзя терять на каждом snapshot

### Проблема

Сейчас `hydrateFromCompanionSnapshot()` в `chat.ts` очищает selection в companion mode.

### Решение

Меняем логику на reconcile.

⚠️ Важно: не писать новый helper "рядом". Нужно усилить уже существующий `filterSelectableIds()` и перестать обходить его через прямые `selectOnly()/toggleSelection()`.

```ts
function isMessageSelectable(msg: Pick<ChatMessage, 'id' | 'kind' | 'deleted'>): boolean {
  if (msg.deleted) return false;
  if (msg.kind === 'haiku') return false;
  if (msg.id === LIVE_STT_MESSAGE_ID || msg.id === LIVE_MIC_MESSAGE_ID) return false;
  return true;
}

function filterSelectableIds(ids: string[]): string[] {
  const next = uniqStable(ids);
  const allowed = new Set(
    messages.value
      .filter((msg) => isMessageSelectable(msg))
      .map((msg) => msg.id)
  );
  return next.filter((id) => allowed.has(id));
}

function selectOnly(id: string): void {
  selectedMessageIds.value = filterSelectableIds([id]);
}

function toggleSelection(id: string): void {
  const next = selectedMessageIds.value.includes(id)
    ? selectedMessageIds.value.filter((x) => x !== id)
    : [...selectedMessageIds.value, id];
  selectedMessageIds.value = filterSelectableIds(next);
}
```

Применение:

- `hydrateFromCompanionSnapshot()` должен делать `selectedMessageIds.value = filterSelectableIds(selectedMessageIds.value)`
- без blanket `clearSelection()`
- `ConversationFeed`/desktop click path не должны эмитить или принимать selection action для non-selectable message
- lasso path может продолжать собирать raw ids из DOM, но финальный commit selection обязан идти через тот же `filterSelectableIds()`

Selection очищаем только в случаях:

- пользователь явно нажал clear selection
- action успешно завершился и по UX должен сбросить selection
- selected ids больше не существуют после snapshot
- selected ids были synthetic live ids и отфильтрованы как non-durable

### Обязательные тесты

- selection survives benign snapshot refresh
- selection trims ids that disappeared after delete
- selection does not include deleted messages after snapshot
- selection survives unrelated AI delta snapshots
- click on deleted row does not create selection
- click on synthetic live row does not create selection
- `toggleSelection/selectOnly` sanitize ids через тот же predicate, что и hydrate/lasso

### Отдельное решение по UX после action

После успешного action selection ведёт себя так:

- `edit` - сохраняем selection, если id ещё существует
- `makeQuestion` - сохраняем selection
- `replyWithAi` - сохраняем selection
- `request_ai_for_selection` - сохраняем selection
- `delete` - trim selection по surviving ids
- `clear_history` - selection очищается, потому что target ids гарантированно устаревают

### Важное уточнение

В hybrid v1 selection для shared commit paths работает только по durable ids.

То есть:

- `stt:live`
- `mic:live`

не должны доходить до backend action layer как valid targets.

---

## 2. Blanket flag `localTimelineMutationsDisabled` нужно разрезать

### Проблема

Сейчас один флаг сразу:

- скрывает UI
- блокирует selection
- блокирует code explain
- блокирует composer
- блокирует commit actions

Это слишком грубо.

### Решение

Заменить на capability split.

Пример:

```ts
const requiresBackendCommit = computed(() => chatStore.companionModeEnabled);
const selectionUxEnabled = computed(() => true);
const codeExplainUxEnabled = computed(() => true);
const askComposerUxEnabled = computed(() => true);
const inlineEditUxEnabled = computed(() => true);
```

И уже отдельно:

```ts
const canCommitEditLocally = computed(() => !chatStore.companionModeEnabled);
const canCommitDeleteLocally = computed(() => !chatStore.companionModeEnabled);
```

⚠️ Это важнее, чем кажется. Если оставить старый blanket flag и просто частично снять `v-if`, получится полурабочий UI с рандомно заблокированными путями.

### Отдельный blocker

Нужно также переписать watch на `chatStore.companionModeEnabled`, который сейчас принудительно делает:

- `askComposerOpen = false`
- `editingMessageId = null`
- `clearSelection()`
- `hideCodeSelectionUi()`

В hybrid rollout правильнее так:

- при `enabled = true` не убивать drafts blanket-ом
- `hideCodeSelectionUi()` оставить можно
- `editingMessageId` можно сохранить
- `selection` сохранить через reconcile
- `askComposerOpen` сохранить

Исключение:

- если companion mode включился посреди hard session reset, тогда cleanup должен идти от session reset, а не от самого факта `enabled = true`

### Ещё один blocker

Нужно перестать считать synthetic live rows "обычными selectable messages".

Иначе получится странный UX:

- пользователь выделил `stt:live`
- desktop показал selection badge
- backend commit path такой id не знает

Это тот тип полубагов, который выглядит "то работает, то нет".

---

## 3. Delete semantics нельзя менять на глаз

### Что сейчас делает desktop local path

В `chat.ts`:

- `stt/mic/prompt` удаляются hard-remove
- все `haiku`, которые были привязаны к удалённому base message, re-anchor на предыдущий base message
- `haiku` delete даёт tombstone `"Сообщение удалено"`

### Целевое backend поведение

#### Для `stt/mic/prompt`

- hard-remove из `companion_timeline`
- пересчитать descendants `haiku.insertAfterId`
- selection после snapshot trim'ится автоматически на desktop
- если удалили `stt`, best-effort пересчитать `state.final_transcription`
- если удалили `stt`, desktop projection не должен потерять relative order из-за ресинтеза `seq`

#### Для `haiku`

- soft-delete
- `deleted = true`
- `status = final`
- `text = "Сообщение удалено"`
- если это active streaming request, сначала снять request binding и abort task

### Почему так

- base message hard-remove сохраняет текущий UX
- haiku tombstone сохраняет порядок ответа и соответствует текущему desktop поведению
- phone просто получает уже готовый consistent timeline

### Backend helper

```rust
pub enum DeleteMessageOutcome {
    Noop,
    DeletedBase,
    DeletedHaiku,
    Missing,
    Unsupported,
}

pub async fn delete_message(state: &AppState, message_id: &str) -> DeleteMessageOutcome {
    // 1. найти сообщение
    // 2. если base - вычислить prev visible base id
    // 3. hard-remove base
    // 4. re-anchor haiku descendants
    // 5. если haiku - soft-delete + abort active task если есть
}
```

### Дополнительный helper

```rust
async fn recompute_final_transcription_from_timeline(state: &AppState) {
    let final_text = state
        .companion_timeline
        .read()
        .await
        .iter()
        .filter(|message| {
            message.kind == "stt" && message.status == "final" && !message.deleted
        })
        .map(|message| message.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    *state.final_transcription.write().await =
        (!final_text.trim().is_empty()).then_some(final_text);
}
```

⚠️ Это не делает `final_transcription` новым SoT. Это просто legacy aggregate repair, чтобы shared contract не становился внутренне противоречивым.

### Обязательные тесты

- deleting `stt` reanchors dependent haiku to previous base
- deleting first base message leaves `insertAfterId = None`
- deleting `prompt` preserves attachments on surviving messages
- deleting streaming `haiku` does not allow late delta to resurrect it

---

## 4. Edit semantics должны быть backend-owned, но draft остаётся локальным

### Проблема

Сейчас `saveInlineEdit()` сразу делает local mutation.

### Решение

`startInlineEdit()` и caret management остаются локальными.  
`saveInlineEdit()` в companion mode идёт в backend.

Пример TS:

```ts
async function saveInlineEdit(): Promise<void> {
  const id = editingMessageId.value;
  if (!id) return;

  const el = getEditingEl(id);
  const text = getEditableText(el);
  if (!text) return;

  if (!chatStore.companionModeEnabled) {
    chatStore.editMessageText(id, text);
    cancelInlineEdit();
    return;
  }

  const response = await invoke<CompanionActionResponse>(
    CMD_COMPANION_EDIT_MESSAGE,
    { messageId: id, nextText: text },
  );

  applyCompanionSnapshot(response.snapshot);
  if (response.ok) {
    cancelInlineEdit();
  }
}
```

### Backend constraints

- редактировать можно только `stt`, `mic`, `prompt`
- `haiku` не редактируем
- `deleted` нельзя редактировать
- пустой trimmed текст reject как `invalid_input`
- `seq`, `id`, `created_at_ms`, `attachments` не меняются
- после edit `stt` нужен best-effort `recompute_final_transcription_from_timeline(state)`

### Обязательные тесты

- edit `prompt` preserves image attachments
- edit `stt` preserves `sttIndex`
- edit deleted message returns `missing_or_deleted`
- save inline edit does not close composer on failed backend response

---

## 5. `makeQuestion` не нужен как отдельный backend command

### Почему

Это чистое deterministic преобразование текста. Безопаснее не плодить новый backend action, а:

- локально вычислить `updated`
- отправить в `companion_edit_message`

Пример:

```ts
function makeQuestionText(source: string): string {
  const trimmed = source.trimEnd();
  return trimmed.endsWith('.') ? `${trimmed.slice(0, -1)}?` : `${trimmed}?`;
}

async function makeQuestion(msg: { id: string; text: string }) {
  const nextText = makeQuestionText(msg.text);
  await saveEditedMessage(msg.id, nextText);
}
```

### Почему это надёжно

- нет второй mutation-семантики
- вся shared фиксация всё равно идёт через backend edit path

---

## 6. Reply with AI нельзя оставлять local-only

### Проблема

Сейчас `replyToMessageWithAi()` строит контекст локально.

### Целевое поведение

В companion mode reply идёт через backend action:

- backend валидирует target message
- backend строит context text из current shared timeline
- backend запускает `start_haiku_chat_stream(...)`
- backend сам создаёт streaming haiku placeholder в timeline

### Важное уточнение

Для `replyWithAi` safest path:

- reuse `start_haiku_chat_stream(...)`
- `question_text = target_message.text`
- `images = []`
- `companion_meta.insert_after_id = Some(message_id)`

То есть не писать новый отдельный stream reducer.

### Важное решение по семантике

В companion mode `reply` должен уважать текущие shared floors:

- history floor
- context floor
- generation

То есть не допускаем ситуацию, когда уже очищенная shared история внезапно влияет на новый ответ только потому, что desktop сохранил старую local копию.

### Proposed command

```rust
#[tauri::command]
pub async fn companion_reply_with_ai(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    message_id: String,
) -> Result<CompanionActionResponse, String> { ... }
```

### Backend helper

```rust
pub async fn build_context_text_before_message(
    state: &AppState,
    message_id: &str,
) -> Result<String, ActionError> { ... }
```

### Return semantics

- `missing_message`
- `message_deleted`
- `unsupported_message_kind`
- `busy_transition`
- `rejected_auth`
- `started_reply_ai`

### Обязательные тесты

- reply on deleted message is rejected
- reply respects context/history floors
- reply inserts haiku after target message
- reply survives concurrent snapshot refresh on desktop

---

## 7. Main AI button в companion mode должен снова уметь работать с selection

### Проблема

Сейчас backend `companion_request_ai` умеет строить AI context без desktop selection.

### Целевое поведение

Если на desktop есть selection:

- selection остаётся local-only
- desktop отправляет backend только `selectedIds`
- backend строит context text на своей timeline-копии
- backend вычисляет `insertAfterId` как последний выбранный visible id

И semantics здесь должны совпадать с текущим desktop `buildHaikuContextText()`:

- explicit selection является override относительно `contextFloor/historyFloor`
- выбранные durable сообщения можно использовать даже если они out-of-context для tail режима
- deleted ids, synthetic live ids и non-final `haiku` всё равно не участвуют

Если selection нет:

- используем существующий current-context path

### Важное уточнение

Selection AI должен reuse существующий `start_haiku_stream(...)`, а не `chat_stream`, потому что:

- это тот же semantic class, что и текущий main AI button
- там нет prompt attachments
- текущий UX ожидает именно "ответ по контексту", а не новый `prompt` message

И ещё:

- selection builder должен отбрасывать synthetic live ids до того, как начнётся backend validation

### Proposed command

```rust
#[tauri::command]
pub async fn companion_request_ai_for_selection(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    selected_ids: Vec<String>,
) -> Result<CompanionActionResponse, String> { ... }
```

### Backend helper

```rust
pub struct SelectionContext {
    pub context_text: String,
    pub insert_after_id: Option<String>,
}

pub async fn build_context_text_for_selection(
    state: &AppState,
    selected_ids: &[String],
) -> Result<SelectionContext, ActionError> { ... }
```

### Validation rules

- selected ids dedup
- missing ids drop out
- deleted ids ignored
- `haiku` со `streaming/error/deleted` не участвуют
- если после фильтрации ничего не осталось, вернуть `empty_selection`

### Desktop UX

- selection UI не прячется
- clear selection badge работает
- AI button в companion mode вызывает selection-aware backend path

### Обязательные тесты

- selection order follows timeline order, не порядок массива из TS
- insertAfterId equals last selected surviving message
- stale selected ids produce `empty_selection` and refresh snapshot

---

## 8. Ask composer и картинки должны вернуться, но draft не должен стать shared

### Local-only часть

Остаются локальными:

- `askComposerOpen`
- `askDraftText`
- `askDraftImages`
- paste handling
- preview image chips

И важное правило:

- remote snapshot actions не имеют права очищать этот draft
- draft очищается только:
  - после `response.ok` на локально инициированный `sendAsk()`
  - при явном local close/reset от пользователя

### Shared commit часть

При `sendAsk()` в companion mode:

- идём в backend
- backend валидирует input
- backend append'ит prompt message
- backend запускает AI request
- response возвращает snapshot
- только после `response.ok` desktop очищает composer draft

Для phone companion это тот же самый shared commit path:

- phone держит local draft text/images
- при send не делает optimistic append в feed
- отправляет `text + images` в backend
- backend создаёт committed `prompt` message и AI request
- phone просто получает итог через snapshot/SSE

### Proposed command

```rust
#[tauri::command]
pub async fn companion_send_prompt(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    text: String,
    images: Vec<LlmImageInput>,
) -> Result<CompanionActionResponse, String> { ... }
```

### Почему отдельный command, а не reuse `sendPromptToLlm()`

`sendPromptToLlm()` сейчас:

- локально пушит prompt message
- локально стартует AI path
- локально пишет error haiku

Для companion mode это unsafe.

### Почему при этом не нужен новый backend image pipeline

В текущем коде safest path такой:

- `companion_send_prompt(...)` валидирует input
- генерирует `prompt_message_id`
- вызывает существующий `start_haiku_chat_stream(...)`
- использует уже существующий `LlmImageInput` shape

То есть reuse уже существующего Rust path уменьшает write surface и риск багов.

### Input limits

Обязательные guardrails:

- максимум `8 MB` на изображение оставить как сейчас
- добавить backend cap на суммарный payload, например `16 MB`
- reject пустой `text + images == []`
- для phone перед upload делать client-side resize/compress, чтобы сырое фото с камеры не раздувало payload

### Phone companion camera/gallery path

Самый безопасный вариант для mobile web:

- скрытый `<input type=\"file\" accept=\"image/*\" capture=\"environment\">`
- reuse того же local draft model, что и для desktop attachments
- reuse того же backend `companion_send_prompt`

Почему именно так:

- браузер сам открывает камеру или gallery самым совместимым способом
- не нужен отдельный `getUserMedia` lifecycle
- не появляется второй camera-specific upload pipeline
- на iPhone/Android fallback обычно просто уходит в gallery picker, что тоже приемлемо

Обязательные правила:

- если `capture=\"environment\"` проигнорирован браузером, это не ошибка, а допустимый fallback
- preview фото остаётся local-only до successful send
- очищать phone draft/preview только после `response.ok`
- не создавать отдельный backend route "upload photo only"
- не делать camera-specific prompt semantics без `text`; backend всё равно принимает общий `text + images`

### Обязательные тесты

- prompt with images creates prompt message and keeps attachments
- failed backend start does not create partial prompt message
- desktop draft is preserved when backend rejects input
- phone camera/gallery draft survives failed backend response
- phone image send produces the same committed prompt shape, что и desktop image send

---

## 9. Code explain button нужно вернуть сразу и не тащить в shared timeline

### Важное решение

Это **не commit action**.

Значит:

- кнопку по выделенному коду/тексту можно вернуть в companion mode сразу
- она остаётся local-only
- phone не обязан ничего про неё знать

### Что делаем

- убираем blanket guard, который скрывает `codeSelectionUi`
- сохраняем локальный `start_code_explain_stream`
- не трогаем `companion_timeline`
- прячем `codeSelectionUi`, если после snapshot его `messageId` больше не существует или стал deleted

### Почему это безопасно

- код explain не мутирует shared history
- не создаёт drift в phone
- не зависит от message deletion semantics

---

## 10. AI cancel - самый тонкий кусок во всём плане

### Текущее состояние

Сейчас по-настоящему backend cancel нет.

`start_haiku_stream()` и `start_haiku_chat_stream()`:

- создают `request_id`
- спавнят background task
- пишут deltas в timeline и в Tauri events

Но task handle для request сейчас не хранится как canonical cancel handle.

### Что нужно добавить

В `AppState`:

```rust
pub companion_ai_tasks:
    Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
```

### Почему одного `abort(handle)` здесь достаточно

В текущем коде network stream живёт внутри outer async task.

Когда `JoinHandle` abort'ится:

- outer task падает
- reqwest future drop'ается
- дальнейшие network reads прекращаются

Но есть нюанс:

- callback на `delta` уже спавнит маленькие inner task'и для append/publish

Именно поэтому cancel обязан делать **сначала**:

- remove from `companion_request_generations`
- mark/delete timeline message

И только потом:

- abort outer handle

Тогда даже если 1-2 inner task успели стартовать, они упрутся в generation/deleted guard и ничего не испортят.

### Правильный lifecycle

#### На start

- создать `request_id`
- создать placeholder в timeline
- заспавнить task
- сохранить handle в `companion_ai_tasks`

#### На done/error

- finalize/fail timeline
- удалить handle из `companion_ai_tasks`
- удалить `request_id` из `companion_request_generations`

#### На cancel

Под `companion_action_lock`:

1. забрать handle из `companion_ai_tasks`
2. удалить `request_id` из `companion_request_generations`
3. перевести timeline в финальное cancelled состояние
4. abort handle
5. publish snapshot

### Какой именно timeline state после cancel

Самый безопасный вариант:

- для отменяемого `haiku` поставить:
  - `deleted = true`
  - `status = final`
  - `text = "Сообщение удалено"`

Почему не hard-remove:

- соответствует текущему delete UX для `haiku`
- не ломает ordering посреди чтения
- проще для feed consistency

### Критичный guardrail

Нужно изменить reducer так, чтобы late delta больше не трогал deleted/cancelled message.

Сейчас `append_haiku_delta()` не проверяет `deleted` и не проверяет membership в `companion_request_generations`.

Нужно:

```rust
pub async fn append_haiku_delta(state: &AppState, request_id: &str, delta: &str) {
    if request_id.trim().is_empty() || delta.is_empty() {
        return;
    }

    let current_generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);

    if state
        .companion_request_generations
        .read()
        .await
        .get(request_id)
        .copied()
        != Some(current_generation)
    {
        return;
    }

    let mut timeline = state.companion_timeline.write().await;
    if let Some(message) = timeline.iter_mut().find(|item| item.id == request_id) {
        if message.deleted || message.generation != Some(current_generation) {
            return;
        }
        message.status = "streaming".to_string();
        message.text.push_str(delta);
    }
}
```

### Proposed command

```rust
#[tauri::command]
pub async fn companion_cancel_ai(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    request_id: String,
) -> Result<CompanionActionResponse, String> { ... }
```

### Desktop UX

В companion mode click по AI cancel больше не игнорируется.

### Обязательные тесты

- cancel aborts running task
- cancel removes task handle
- late delta after cancel does not mutate snapshot
- phone sees cancelled state consistently

---

## 11. Desktop wiring должен идти через отдельный action-layer, а не россыпью по компоненту

### Почему

Если начать прямо в `RecordingPopover.vue` размножать:

- `if companionModeEnabled then invoke(...) else local`

во всех местах отдельно, компонент очень быстро станет хрупким.

### Recommended structure

Новый модуль:

- `/Users/belief/dev/projects/HackInterview/src/presentation/companionDesktopActions.ts`

Он отвечает за:

- вызов companion Tauri commands
- единый error mapping
- единое применение `CompanionActionResponse`
- единые busy guards

Пример:

```ts
export type CompanionSnapshotApplier = (
  snapshot: TauriSnapshotEnvelope<CompanionSnapshotData>
) => void;

export function createCompanionDesktopActions(
  applySnapshot: CompanionSnapshotApplier,
) {
  async function editMessage(messageId: string, nextText: string) { ... }
  async function deleteMessage(messageId: string) { ... }
  async function replyWithAi(messageId: string) { ... }
  async function sendPrompt(
    text: string,
    images: Array<{ mediaType: string; dataBase64: string }>
  ) { ... }
  async function requestAiForSelection(selectedIds: string[]) { ... }
  async function cancelAi(requestId: string) { ... }

  return { editMessage, deleteMessage, replyWithAi, sendPrompt, requestAiForSelection, cancelAi };
}
```

### Почему это safer

- меньше дублирования
- проще централизованно обрабатывать `busy_transition`
- проще тестировать отдельно от огромного `RecordingPopover.vue`

---

## 12. State-sync contracts нужно расширять без дублирования shape

В `/Users/belief/dev/projects/HackInterview/src/windowing/stateSync/contracts.ts` нужно добавить новые команды:

```ts
export const CMD_COMPANION_EDIT_MESSAGE = 'companion_edit_message';
export const CMD_COMPANION_DELETE_MESSAGE = 'companion_delete_message';
export const CMD_COMPANION_REPLY_WITH_AI = 'companion_reply_with_ai';
export const CMD_COMPANION_SEND_PROMPT = 'companion_send_prompt';
export const CMD_COMPANION_REQUEST_AI_FOR_SELECTION = 'companion_request_ai_for_selection';
export const CMD_COMPANION_CANCEL_AI = 'companion_cancel_ai';
```

И типы input payload.

⚠️ Не надо плодить второй `ActionResponse`. Используем уже существующий `CompanionActionResponse`.

---

## File-by-file execution plan

## Phase 0 - Preparatory split and anti-regression scaffolding
🎯 10   🛡️ 10   🧠 4  
Примерно `120-220` строк.

### Цель

Подготовить код так, чтобы дальше не ломаться на каждом шаге.

### Шаги

1. Создать новый doc-level checklist и feature flag в коде не нужен, если rollout идёт в одной ветке.
2. Разрезать blanket capability logic в `RecordingPopover.vue`.
3. Убрать blanket selection wipe в `chat.ts`.
4. Убрать watch, который принудительно закрывает composer/edit/selection при `companionModeEnabled = true`.
5. Вернуть local-only code explain UI в companion mode.
6. Добавить маленький kill switch для hybrid path, чтобы rollback был дешёвым.

### Результат

Пока shared mutations ещё не переведены, но безопасный pure-local UX уже вернулся.

### Риски

- accidental local commit path still reachable

### Guardrail

Пока backend actions не готовы, commit buttons можно возвращать только там, где вызов уже будет заменён.

### Recommended kill switch

В `RecordingPopover.vue` на время rollout добавить один central switch:

```ts
const hybridBackendCommitsEnabled = computed(() => chatStore.companionModeEnabled);
```

И уже от него вести весь новый commit path.

Если что-то пошло не так, rollback будет дешёвым:

- local UX можно временно оставить
- конкретный backend-commit branch можно быстро отключить
- phone companion от этого не ломается

---

## Phase 1 - Backend mutation primitives for timeline
🎯 9   🛡️ 10   🧠 6  
Примерно `180-320` строк.

### Цель

Добавить в `companion_timeline.rs` backend-owned helpers:

- `edit_message_text`
- `delete_message`
- `build_context_text_for_selection`
- `build_context_text_before_message`

### Шаги

1. Добавить error/result enum'ы.
2. Реализовать поиск message по id.
3. Реализовать hard-remove для `stt/mic/prompt`.
4. Реализовать soft-delete для `haiku`.
5. Реализовать re-anchor descendants.
6. Реализовать selection context builder.
7. Добавить unit tests.

### Риски

- сломать `insertAfterId`
- потерять attachments у `prompt`

### Guardrail

Все helper'ы покрываются unit tests до wiring во frontend.

---

## Phase 2 - Backend action layer
🎯 9   🛡️ 10   🧠 6  
Примерно `220-420` строк.

### Цель

Добавить в `companion_actions.rs` новые serialized actions:

- `edit_message`
- `delete_message`
- `reply_with_ai`
- `send_prompt`
- `request_ai_for_selection`
- `cancel_ai`

### Шаги

1. Вынести общий helper `run_serialized_companion_action(...)`.
2. Подключить auth check.
3. Подключить snapshot return из critical section.
4. Для AI actions reuse existing `start_haiku_stream/start_haiku_chat_stream`.
5. Для prompt action не делать новый image pipeline, reuse existing `LlmImageInput + start_haiku_chat_stream`.
6. Подготовить один shared route для phone `prompt send with images`, но не открывать остальные mutating phone routes.

### Пример helper

```rust
async fn run_serialized_action<F, Fut>(
    state: &AppState,
    app_handle: &AppHandle,
    action_name: &str,
    f: F,
) -> Result<CompanionActionResponse, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<&'static str, String>>,
{
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let result = f().await?;
    success(state, app_handle, result).await
}
```

---

## Phase 3 - AI task registry and real cancel
🎯 8   🛡️ 9   🧠 7  
Примерно `140-260` строк.

### Цель

Сделать настоящий backend cancel.

### Шаги

1. Добавить `companion_ai_tasks` в `AppState`.
2. В `start_haiku_stream/start_haiku_chat_stream` сохранять handle по `request_id`.
3. На `done/error` удалять handle.
4. Убрать двойной immediate publish для AI start path.
5. Реализовать `companion_cancel_ai`.
6. Усилить reducer против late delta.
7. Явно держать `companion_action_lock` только вокруг state transition, не вокруг stream lifetime.

### Особый риск

`delta` сейчас сам спавнит внутренние task'и.

### Guardrail

- gate по `companion_request_generations`
- gate по `message.deleted`
- remove request binding до abort
- не делать двойной immediate `publish_snapshot` на старте AI action

---

## Phase 4 - Desktop action adapter
🎯 10   🛡️ 9   🧠 5  
Примерно `150-260` строк.

### Цель

Добавить `companionDesktopActions.ts`.

### Шаги

1. Описать invoke wrappers.
2. Единообразно применять `response.snapshot`.
3. Централизованно обрабатывать `busy_transition`.
4. Возвращать structured result для UI.

### Почему отдельно

Это позволит не размазывать логику по `RecordingPopover.vue`.

---

## Phase 5 - Desktop wiring in RecordingPopover.vue
🎯 9   🛡️ 8   🧠 7  
Примерно `180-320` строк.

### Цель

Вернуть весь UX в companion mode, но commit path направить в backend.

### Шаги

1. Вернуть selection click/lasso/badge.
2. Вернуть hover actions.
3. Вернуть ask composer и paste/images.
4. Вернуть code explain button.
5. Inline save переключить на backend.
6. Delete переключить на backend.
7. Reply переключить на backend.
8. Main AI button переключить на selection-aware backend path.
9. Cancel AI переключить на backend path.
10. Вернуть streaming-button semantics: в companion mode при активном backend request кнопка не disabled навсегда, а вызывает backend cancel.
11. Убедиться, что failed backend response не теряет draft/edit state.
12. Success-cleanup делать только из desktop action response handler, а не из общего snapshot `lastAction`.
13. Оставить hover-start / click-cancel contract без продуктового изменения.
14. Перестроить `applyCompanionSnapshot()` на monotonic deltas, а не на sticky `lastAction`.

### Важный принцип

Branching делаем так:

```ts
if (!chatStore.companionModeEnabled) {
  // текущий local path
} else {
  // new backend commit path
}
```

Это самый низкорисковый rollout. Не надо в этой задаче переписывать ещё и non-companion mode.

---

## Phase 6 - Chat store reconciliation and snapshot discipline
🎯 9   🛡️ 10   🧠 6  
Примерно `100-180` строк.

### Цель

Сделать так, чтобы `chat.ts` и `transcription.ts` были хорошими projection stores в companion mode.

### Шаги

1. Убрать blanket `clearSelection()` на snapshot hydrate.
2. Ввести canonical `isMessageSelectable(...)` и пропустить через него `filterSelectableIds`, `selectOnly`, `toggleSelection`, click и lasso reconcile.
3. Проверить, что `activeHaikuRequests` восстанавливается из snapshot.
4. Убрать `.filter((message) => !message.deleted)` из desktop hydrate.
5. Расширить `transcription.FinalUtterance` metadata и сохранить `deleted/seq/sttIndex`.
6. Убедиться, что `deleted` корректно сохраняется для feed projection, но не считается selectable.
7. Убрать generic draft cleanup из snapshot apply path - закрывать composer/edit только после success инициировавшего desktop action.
8. Trim target-bound local state после hydrate:
  - закрыть inline edit, если `editingMessageId` больше не существует или стал deleted
  - скрыть `codeSelectionUi`, если его `messageId` исчез
  - не трогать `askDraftText/Images`
9. Убрать side-effect branching по `lastAction`; оставлять только monotonic checks по session/floor/generation.

### Особая проверка

После delete/edit/prompt/reply desktop должен менять только local ephemeral state:

- закрыть inline edit
- очистить draft при success
- trim selection

Но не мутировать shared messages вручную.

---

## Phase 7 - HTTP/phone verification
🎯 10   🛡️ 9   🧠 5  
Примерно `120-220` строк.

### Цель

Убедиться, что phone companion:

- продолжает быть projection для почти всех действий
- но умеет делать `prompt send with images` через один shared backend path

⚠️ Важно: это intentional. В этой фазе мы **не** добавляем phone routes для `edit/delete/reply/cancel`.

### Что проверить

- edit с desktop виден на phone
- delete с desktop виден на phone
- prompt с картинкой виден на phone
- phone camera/gallery image send создаёт тот же committed prompt shape
- reply с desktop виден на phone
- cancel с desktop виден на phone
- phone draft очищается только после `response.ok`
- fallback browser path без реальной камеры всё равно позволяет выбрать фото из gallery/files

### Ожидаемый результат

Phone code меняется только вокруг local draft + hidden file input + shared send route, а feed и итоговая синхронизация остаются на текущем snapshot/SSE path.

---

## Concrete command inventory

### Новые Tauri commands

```rust
companion_edit_message(messageId, nextText)
companion_delete_message(messageId)
companion_reply_with_ai(messageId)
companion_send_prompt(text, images)
companion_request_ai_for_selection(selectedIds)
companion_cancel_ai(requestId)
```

### Existing commands, которые переиспользуем

```rust
get_companion_snapshot()
companion_request_ai(questionText)
companion_clear_context()
companion_clear_history()
set_companion_system_prompt(prompt)
start_haiku_stream(...)
start_haiku_chat_stream(...)
start_code_explain_stream(...)
```

### Новые TS constants

```ts
CMD_COMPANION_EDIT_MESSAGE
CMD_COMPANION_DELETE_MESSAGE
CMD_COMPANION_REPLY_WITH_AI
CMD_COMPANION_SEND_PROMPT
CMD_COMPANION_REQUEST_AI_FOR_SELECTION
CMD_COMPANION_CANCEL_AI
```

### Новые HTTP routes

В этом rollout:

```text
POST /api/prompt/send
```

Важно:

- route reuse'ит тот же backend `companion_send_prompt(text, images)`
- отдельного `camera upload` route не добавляем
- других новых mutating phone routes в этом rollout нет

---

## Exact behavior contract per action

## Edit message

Input:

```json
{ "messageId": "stt:12:45:3", "nextText": "Исправленный текст" }
```

Success:

```json
{
  "ok": true,
  "actionResult": "edited_message",
  "snapshot": { "...": "fresh snapshot" }
}
```

Rejects:

- `invalid_input`
- `missing_message`
- `message_deleted`
- `unsupported_message_kind`
- `busy_transition`
- `rejected_auth`

## Delete message

Input:

```json
{ "messageId": "prompt:abc" }
```

Success:

- `deleted_base_message`
- `deleted_haiku_message`
- `noop`

## Reply with AI

Input:

```json
{ "messageId": "stt:..." }
```

Success:

- `started_reply_ai`

Rejects:

- `missing_message`
- `empty_context`
- `busy_transition`
- `rejected_auth`

## Send prompt

Input:

```json
{
  "text": "Сравни эти две реализации",
  "images": [
    { "mediaType": "image/png", "dataBase64": "<...>" }
  ]
}
```

Success:

- `started_prompt_ai`

Rejects:

- `empty_input`
- `payload_too_large`
- `busy_transition`
- `rejected_auth`

## Request AI for selection

Input:

```json
{ "selectedIds": ["stt:1", "mic:2", "prompt:3"] }
```

Success:

- `started_selection_ai`

Rejects:

- `empty_selection`
- `busy_transition`
- `rejected_auth`

## Cancel AI

Input:

```json
{ "requestId": "2d9b..." }
```

Success:

- `cancelled_ai`
- `noop`

Rejects:

- `busy_transition`
- `rejected_auth`

---

## Recommended file-level edits

## `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/state.rs`

Добавить:

- `companion_ai_tasks`

## `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion_timeline.rs`

Добавить:

- edit helper
- delete helper
- selection context builder
- reply context builder
- stronger delta/finalize/fail guards for deleted/cancelled request

## `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion_actions.rs`

Добавить:

- shared serialized mutation actions

## `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/commands.rs`

Добавить:

- новые Tauri commands
- registry wiring for AI tasks

## `/Users/belief/dev/projects/HackInterview/src-tauri/src/presentation/companion.rs`

Поменять минимально:

- только если понадобится snapshot-side helper для `final_transcription` aggregate repair
- HTTP routes для новых desktop actions в этом rollout **не добавлять**

## `/Users/belief/dev/projects/HackInterview/src/windowing/stateSync/contracts.ts`

Добавить:

- новые command constants
- input types

## `/Users/belief/dev/projects/HackInterview/src/windowing/stateSync/tauri.ts`

Добавить:

- re-export новых command constants для реального invoke-использования в desktop code

## `/Users/belief/dev/projects/HackInterview/src/presentation/companionDesktopActions.ts`

Новый файл:

- invoke wrappers
- busy/error mapping

## `/Users/belief/dev/projects/HackInterview/src/stores/transcription.ts`

Поменять:

- расширить `FinalUtterance` полями `deleted?: boolean`, `seq?: number`, `sttIndex?: number`
- сохранить backend `seq/sttIndex` в hydrated `FinalUtterance`
- не выкидывать deleted `stt` в companion hydrate path
- не терять absolute ordering `stt` сообщений в companion mode
- использовать `recompute_final_transcription_from_timeline` только как legacy aggregate repair, не как новый SoT

## `/Users/belief/dev/projects/HackInterview/src/stores/chat.ts`

Поменять:

- hydrate selection reconcile
- убрать blanket clear selection in companion mode
- перестать выкидывать `deleted` messages при hydrate
- строить `sttMessages` из preserved `deleted/seq/sttIndex`, а не только из `idx`
- централизовать `isMessageSelectable(...)` и прогнать через него все selection entry points
- не считать synthetic live ids selectable для shared commit actions

## `/Users/belief/dev/projects/HackInterview/src/presentation/components/RecordingPopover.vue`

Поменять:

- capability split
- desktop UX return
- commit actions route to backend in companion mode
- не закрывать inline edit / ask composer по чужому snapshot action
- main AI button в streaming companion mode больше не держать permanently disabled, когда backend cancel уже есть
- trim `editingMessageId` / `codeSelectionUi` по target validity после snapshot reconcile
- не менять hover-start / click-cancel UX-модель кнопки AI
- не использовать sticky `snapshot.controls.lastAction` как источник local side-effects

---

## Test plan

## Rust unit tests

### companion_timeline

- edit stt updates text, preserves seq/sttIndex
- edit/delete stt recomputes legacy `final_transcription` aggregate
- edit prompt preserves attachments
- delete base reanchors child haiku
- delete first base leaves child `insertAfterId = None`
- delete haiku marks deleted tombstone
- selection context builder respects timeline order
- selection context builder ignores deleted ids
- selection context builder ignores context floor for explicit durable ids
- append delta ignored for deleted request

### companion_actions

- edit returns snapshot from same critical section
- delete returns snapshot from same critical section
- reply rejects missing message
- send prompt rejects oversized payload
- cancel aborts active request and removes handle
- concurrent edit + delete returns one success and one stale/noop

### commands

- start_haiku_* registers task handle
- done/error removes task handle
- cancel removes task handle even if task already finished
- AI start path does not do double immediate revision bump

## TS unit tests

- selection survives benign snapshot
- selection trims removed ids after delete
- desktop hydrate keeps deleted tombstones in feed projection
- desktop hydrate preserves backend `stt` ordering metadata
- synthetic live ids are filtered out of shared selection commit targets
- `companionDesktopActions` maps `busy_transition` correctly
- ask draft stays open on rejected prompt
- inline edit stays open on rejected save
- phone-originated snapshot action does not close unrelated desktop inline edit
- phone-originated snapshot action does not close unrelated desktop ask composer
- inline edit closes if target message disappeared after remote delete/history clear
- code selection popup hides if target message disappeared after remote delete/history clear
- ask draft survives remote clear_history / clear_context
- repeated snapshot with stale `lastAction` does not replay old local cleanup
- selection survives unrelated delta snapshot
- delete trims selection but does not clear unrelated selected ids
- `makeQuestion` keeps inline UX stable on backend error
- deleted `stt` tombstone survives `transcription -> chat` hydrate path
- selection-aware AI ignores context floor for explicit durable selection
- row click on deleted/live/haiku never leaves invalid id in `selectedMessageIds`
- phone camera/gallery draft survives failed backend response
- phone image send reuses shared `companion_send_prompt` contract

## Integration smoke

- desktop companion mode on
- select 2 messages -> ask AI -> phone sees answer
- select synthetic live row -> backend commit path ignores it safely
- phone deletes message while desktop inline edit on another row stays open
- phone deletes the exact edited message -> desktop inline edit closes itself cleanly
- phone clears history -> ask draft still there, but code selection popup disappears
- unrelated snapshot after old `cleared_context` does not re-run local clear side-effect
- edit message on desktop -> phone updates
- delete prompt with child haiku -> phone order remains stable
- send prompt with image -> phone sees image
- phone opens camera/gallery -> sends image -> desktop and phone both see the same committed prompt + answer
- hover AI start and click cancel still work in desktop companion mode
- cancel streaming AI -> phone does not get resurrected delta
- backend reject prompt -> desktop draft and images remain
- backend reject phone image prompt -> phone draft and preview remain
- backend reject edit -> inline editor remains open with typed text

---

## Rollout order I would actually follow

### PR 1

- capability split
- selection reconcile fix
- code explain return

### PR 2

- backend timeline edit/delete helpers
- unit tests

### PR 3

- backend action layer
- Tauri commands

### PR 4

- AI task registry
- real cancel
- tests on late delta

### PR 5

- desktop wiring for edit/delete/reply/prompt/selection AI/cancel

### PR 6

- phone local draft + camera/gallery button + shared `POST /api/prompt/send`
- phone and desktop smoke verification
- cleanup and docs

Это медленнее, чем "одним коммитом всё", но заметно безопаснее.

---

## Non-goals

В этот план специально не входят:

- sync hover state на phone
- sync selection rectangle на phone
- phone UI для inline edit/delete/reply
- custom `getUserMedia` camera preview/stream lifecycle в mobile web
- полный backend SoT для code explain dialog
- превращение `state.history` в новый shared source of truth
- переписывание desktop companion rendering напрямую от raw snapshot вместо store projection
- переписывание обычного desktop mode вне companion

---

## Rollback strategy

Если по ходу реализации всплывает неприятный баг, rollback делаем не "откатить всё", а точечно.

### Самый дешёвый rollback

- оставить local UX return
- временно вернуть disable только для проблемного commit action

Например:

- edit уже стабилен, оставить
- delete ещё flaky, временно скрыть только delete branch в companion mode

### Что нельзя откатывать частично

- нельзя вернуть local shared mutation для одного action, если уже включён backend variant для соседних actions этого же класса без явной причины

Пример плохого состояния:

- `replyWithAi` через backend
- `sendPromptToLlm` обратно local-only

Это снова создаст mixed context semantics.

---

## Главные anti-bug правила во время реализации

1. Не менять shared timeline локально в TS, если `companionModeEnabled`.
2. Не очищать selection blanket'ом на каждый snapshot.
3. Не разрешать late delta менять deleted/cancelled haiku.
4. Не чистить composer draft до успешного backend response.
5. Не закрывать inline edit до успешного backend response.
6. Не плодить generic "one command for all actions", если это ухудшает валидацию и тестируемость.
7. Не тащить local-only UX state в snapshot.
8. Не расширять phone HTTP surface в этой задаче.
9. Не менять normal desktop mode в этой задаче.
10. Не смешивать target-bound local state и free local draft state в одном cleanup path.
11. Не менять hover-start / click-cancel semantics кнопки AI под видом backend refactor.
12. Не использовать `snapshot.controls.lastAction` как одноразовый event без явного nonce/consume-mechanism.

---

## Короткий итог

Самый безопасный быстрый путь такой:

- вернуть локальный desktop UX как UX
- shared commits увести в backend
- phone оставить projection от backend snapshot

Самые важные реальные blocker'ы, которые нельзя забыть:

- ⚠️ `clearSelection()` внутри `hydrateFromCompanionSnapshot()`
- ⚠️ blanket `localTimelineMutationsDisabled`
- ⚠️ отсутствие настоящего backend cancel с task registry
- ⚠️ late delta после cancel/delete

Если делать именно по этому документу, то в companion mode вернётся весь нужный desktop UX, а mobile не начнёт жить в другой истории.
