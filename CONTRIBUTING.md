# Разработка Шерпы

Собрать, погонять и прислать PR. Правила для агентов и канон контрактов — `AGENTS.md`, устройство системы — `docs/architecture.md`, тесты и бюджеты — `docs/testing.md`.

## Чекаут и установка

```
pnpm install --frozen-lockfile
```

Node ≥ 22.13 (`engines` в корневом `package.json`), pnpm ровно той версии, что записана в `packageManager` — `pnpm@11.10.0`; `corepack` ставит её сам. Реестр внутренний, `https://npm.yandex-team.ru/` (`.npmrc`): из внешней сети установка не пройдёт.

Виртуальный стор pnpm лежит вне чекаута, в `~/.sherpa-dev/pnpm-virtual-store` (`virtualStoreDir` в `pnpm-workspace.yaml`): FUSE-маунт arc отдаёт `realpath` файла с повторяющимся содержимым как хеш, и `tsc` на таком пути падает. В `node_modules` остаются симлинки.

## Проверки

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

Зелёные перед любым коммитом. E2E в обязательные проверки не входит: у `packages/e2e` нет скрипта `test` осознанно — браузерный прогон долгий, его запускают явно.

## Пакеты

`packages/protocol` — схемы zod и типы всего, что пересекает границу процессов: задачи и сообщения воркера, снапшот UI, маршрут, чат, манифест сервера, интерфейс `ReviewHost`, версия протокола. Зависимостей, кроме `zod`, нет; от него зависят все остальные.

`packages/server` — сервер одного PR: HTTP и SSE, база на `node:sqlite`, очередь задач, реестр воркеров, оркестраторы маршрута и чата, адаптеры хостов (`src/hosts/`), проверка обновления. esbuild собирает его в один модуль `devflow-diff-explain-server.mjs` с зашитой статикой UI; сервер поднимает экспорт `runServer`, его зовёт CLI в `devflow-diff-explain server`.

`packages/ui` — React-приложение ревьюера: дифф, маршрут, обсуждения, чат, настройки, дизайн-токены в `src/styles/`, дев-страницы в `src/dev/`. Сборка — vite.

`packages/cli` — тонкий CLI `sherpa` (`up`, `worker next` и прочее): петля воркера дёргает его на каждый вызов, поэтому старт быстрый и рантайм-зависимостей нет. Один бандл `devflow-diff-explain.mjs`.

`packages/skill` — дистрибутив для харнеса: `SKILL.md` плюс CLI и модуль сервера в `dist/bin/`. Сам `dist/` — рабочий артефакт сборки, он не версионируется (`.arcignore` режет `packages/*/dist/`). Версионируется его копия в корневом каталоге `skill/`: релиз раскладывает её туда, и коммит этого каталога — то, чем обновление доезжает до пользователей.

`packages/fixtures` — детерминированные PR (`medium`, `small`, `large`, `edge`, `huge`, `empty`), фикстурный `ReviewHost` и конструкторы доменных объектов. Их используют дев-режим, галерея состояний и e2e.

`packages/e2e` — Playwright-спеки поверх собранных артефактов.

## Дев-режим

Сервер на фикстурном PR:

```
pnpm --filter @sherpa/server dev --pr fixture-medium
```

Ключ — `fixture-<small|medium|large|edge|huge|empty>` (`FIXTURE_NAMES`; выбор адаптера — `packages/server/src/hosts/select.ts`). Сервер печатает порт, путь манифеста и ссылку на UI, висит до Ctrl+C, самоостановки по простою у него нет. Собранный UI ему не нужен — его отдаёт vite.

UI:

```
pnpm --filter @sherpa/ui dev
```

Дев-прокси в `packages/ui/vite.config.ts` направляет `/api` на живой сервер: адрес он берёт из `SHERPA_SERVER`, иначе из первого манифеста в `~/.sherpa/servers/*.json` — порт эфемерный, зашить его нельзя, а сервер, поднятый после `vite dev`, требует перезапуска vite. Открывать `http://localhost:5173/#t=<токен>`, токен — из ссылки, которую напечатал сервер.

Скилл из чекаута: собрать (`pnpm --filter @sherpa/ui build && pnpm --filter @sherpa/skill build`) и слинковать дистрибутив в харнес — `~/.claude/skills/devflow-diff-explain` (Claude Code) или `~/.agents/skills/devflow-diff-explain` (Codex) → `<репо>/packages/skill/dist`. `SHERPA_SERVER_BIN` перебивает поиск модуля сервера рядом с CLI, если нужен другой.

## Галерея состояний

```
pnpm --filter @sherpa/ui dev   # http://localhost:5173/gallery.html
```

Галерея рендерит каждое состояние экрана детерминированно на фикстурах — без сервера и токена. Отсюда же идёт приёмка внешнего вида: галерея и прототип `docs/design/Devflow Diff Explain.dc.html` в одинаковом вьюпорте, до совпадения. Состояние живёт в адресе (`#state=…`), язык — `#locale=`.

Новое состояние: экспортировать список карточек из файла `*-states.tsx` в `packages/ui/src/dev/gallery/` и подключить его в реестр `GALLERY_STATES` (`packages/ui/src/dev/gallery/states.tsx`). Новый компонент или новое состояние существующего — новая карточка, иначе его нечем принимать.

## E2E

Chromium ставим один раз, с внутреннего зеркала:

```
PLAYWRIGHT_DOWNLOAD_HOST=https://s3.mds.yandex.net/playwright-browsers \
  pnpm --filter @sherpa/e2e exec playwright install chromium
```

```
pnpm --filter @sherpa/e2e e2e
```

`globalSetup` сам собирает прод-статику UI и бандл CLI; каждый тест поднимает фикстурный сервер во временном `--sherpa-dir`. Перф-спека идёт в общем прогоне; отдельно её можно запустить так:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

Цифры печатаются строками `PERF …`. Подробности — `docs/testing.md` и `packages/e2e/README.md`.

## Контракты

Канон — `AGENTS.md`, здесь коротко:

- Всё, что читает модель или пересекает границу процессов, описано схемой в `packages/protocol` и проходит валидатор; невалидное сервер отклоняет, UI такого не потребляет.
- Хост-специфика не выходит за `ReviewHost` (`packages/protocol/src/review-host.ts`); новый метод — вместе с флагом в `HostCapabilities` и проверкой в контракт-сьюте `packages/server/src/hosts/review-host-contract.ts`.
- Версия протокола (`packages/protocol/src/version.ts`) растёт при любом ломающем изменении воркерских ручек или формата задачи.

## Внешний вид

Тест `packages/ui/src/styles/tokens.test.ts` сверяет дизайн-токены `packages/ui/src/styles/tokens.css` с таблицей в `docs/design/README.md`: правка токена без правки хендоффа (и наоборот) роняет проверки. Дальше — карточка в галерее, потом сравнение с прототипом. Прототип — референс, не источник кода.

## Релиз дистрибутива

```
pnpm release --notes "<одна фраза>"
```

`--notes` обязателен: фразу (до 140 символов) показывает тост обновления. Скрипт (`scripts/release.mjs`) собирает `@sherpa/ui` и `@sherpa/skill`, сверяет `devflow-diff-explain --version` и `version.json` с полем `version` корневого `package.json` и требует, чтобы этот номер стоял в корневом `README.md`, пересоздаёт `<target>/skill/` из `packages/skill/dist`, проставляет там `releasedAt` и `whatsNew`. Цель по умолчанию — корень самого репозитория, `--target` нужен для прогона в отдельный каталог; `--skip-build` берёт готовый `dist`. В конце печатает список выложенных файлов и готовые `arc add skill` / `arc commit` — `arc` скрипт не зовёт, коммит человек делает руками.

Тост обновления сравнивает зашитую версию с `skill/version.json` из trunk, так что версия доезжает до пользователей только этим коммитом.

## Решения

Изменил поведение, контракт или инвариант — запиши в `docs/decisions.md`: раздел по подсистеме, дата, что и почему. Старое решение при отмене помечается заменённым, а не удаляется.

## PR

Ветка от trunk, проверки зелёные, `arc pr create`. В описании — что меняется и зачем; если затронуты сервер, UI-потоки или `packages/e2e`, прогнать e2e до отправки.
