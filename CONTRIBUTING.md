# Разработка Devflow Diff Explain

Node ≥ 22.13, pnpm версии из `packageManager` в корневом `package.json`. Внутренние имена пакетов `@sherpa/*` сохранены.

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Эти проверки обязательны перед коммитом. `pnpm test:all` — совместимое имя того же полного набора. После изменений сервера и UI-потоков — `pnpm test:e2e`. Тесты используют фикстуры; реальный PR не нужен. Подробнее — [матрица проверок](docs/testing.md).

## Сборка и установка

```sh
pnpm install:local
```

Команда собирает UI и standalone-скилл: `SKILL.md`, `agents/openai.yaml`, `version.json`, CLI и сервер с зашитой статикой. Артефакты живут в `packages/skill/dist`, не коммитятся; установщик проверяет копирование и сохраняет резервную копию предыдущего скилла. Для временной установки используй `node scripts/install-local.mjs --target <path>`; `--no-build` берёт готовые артефакты.

Исходники версионируются Git, идентификатор сборки записывается в `version.json`. Установка выполняется из этого репозитория, автоматической проверки внешних обновлений нет.

## Пакеты

- `protocol` — схемы и межпроцессные контракты.
- `server` — HTTP/SSE, SQLite, очередь, импорт снимков, генерация объяснения и чат.
- `ui` — интерфейс объяснения для компьютера.
- `cli` — standalone-команда `devflow-diff-explain` и работа воркера.
- `skill` — инструкция агенту и сборка устанавливаемого дистрибутива.
- `fixtures` — детерминированные PR и данные для тестов и галереи.
- `e2e` — браузерные сценарии поверх собранного приложения.

## Дев-режим и галерея

```sh
pnpm --filter @sherpa/server dev --pr fixture-medium
pnpm --filter @sherpa/ui dev
```

Dev-запуск fixture-ключа экспортирует синтетические байты и использует обычный importer; в production-бандле фикстурного провайдера нет. Сервер печатает порт и ссылку с токеном. Vite проксирует `/api` на `SHERPA_SERVER` или сервер из манифеста в `~/.sherpa/servers`. Открывай `http://localhost:5173/#t=<token>`. Галерея без сервера: `http://localhost:5173/gallery.html`.

Для фоновых браузерных тестов установи Chromium Headless Shell: `pnpm --filter @sherpa/e2e exec playwright install chromium --only-shell`. Обычно `SHERPA_E2E_EXECUTABLE_PATH` не нужен; на macOS свой бинарник должен быть `chrome-headless-shell`, а не браузер из `.app`, который мелькает в Dock даже с `--headless`. Если задан `PLAYWRIGHT_BROWSERS_PATH`, используй его и при установке, и при запуске. Для отладки с окном установи полный Chromium (`pnpm --filter @sherpa/e2e exec playwright install chromium`) и добавь `--headed` без `SHERPA_E2E_EXECUTABLE_PATH`. E2E самостоятельно собирают UI/CLI и поднимают серверы во временных каталогах.

Контракты, язык, дизайн и обновление документации описаны в [AGENTS.md](AGENTS.md). Требования к продукту — в [единственной спецификации](docs/spec.md).
