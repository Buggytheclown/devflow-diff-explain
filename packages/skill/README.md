# @sherpa/skill

Сборка самостоятельного скилла Devflow Diff Explain. Результат в `dist/` состоит из четырёх файлов: `SKILL.md`, `version.json`, `bin/devflow-diff-explain.mjs` и `bin/devflow-diff-explain-server.mjs`. Установленная копия не обращается к исходникам репозитория и не запускает pnpm.

`SKILL.md` задаёт выбор PR или локального diff, запуск сервера и pull-петлю воркера. Без аргумента скилл объясняет локальные изменения текущего каталога. CLI остаётся небольшим; сервер со встроенным UI загружается только при запуске серверного процесса. Контракт — в [протоколе](../../docs/protocol.md).

## Сборка и установка

Из корня репозитория:

```sh
pnpm install:local
```

Команда собирает UI и скилл, проверяет четыре файла и устанавливает самостоятельную копию в `~/.agents/skills/devflow-diff-explain`. Предыдущая установка сохраняется вне каталога скиллов. Симлинки не используются.

Для другого каталога: `node scripts/install-local.mjs --target <path>`; `--no-build` использует уже собранный `dist/`. Отдельная сборка без установки:

```sh
pnpm --filter @sherpa/ui build
pnpm --filter @sherpa/skill build
```

Версия берётся из корневого `package.json`, Git-ревизия — из рабочего дерева. `dist/` не хранится в Git. Проверки и требования к изменениям — в [CONTRIBUTING](../../CONTRIBUTING.md) и [AGENTS](../../AGENTS.md).
