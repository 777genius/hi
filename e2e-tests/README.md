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
