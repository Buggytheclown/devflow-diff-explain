# @sherpa/skill

Сборка самостоятельного скилла Devflow Diff Explain. Результат в `dist/` состоит из шести файлов: `SKILL.md`, `agents/openai.yaml`, `version.json`, `bin/devflow-diff-explain.mjs`, `bin/devflow-diff-explain-server.mjs` и `bin/devflow-diff-explain-arc.mjs`. Установленная копия не обращается к исходникам репозитория и не запускает pnpm.

В списке скиллов комплект называется «Дифф — объяснить». `agents/openai.yaml` запрещает неявный запуск; этот файл сохраняется при сборке и установке.

`SKILL.md` задаёт одну стартовую команду для Arcanum PR, нативный экспорт для других источников, импорт снимка и pull-петлю воркера. Внешний Arc producer использует установленный `arc` и `ya tool gena-arcanum-cli`, а его единственный бандл лежит рядом с CLI. Команды из вывода CLI запускаются через `node` и абсолютный путь к установленному `.mjs`; алиас в `PATH` не нужен. Контракт — в [протоколе](../../docs/protocol.md).

## Сборка и установка

Из корня репозитория:

```sh
pnpm install:local
```

Команда собирает UI и скилл, проверяет шесть файлов и устанавливает самостоятельную копию в `~/.agents/skills/devflow-diff-explain`. Предыдущая установка сохраняется вне каталога скиллов. Симлинки не используются.

Для другого каталога: `node scripts/install-local.mjs --target <path>`; `--no-build` использует уже собранный `dist/`. Отдельная сборка без установки:

```sh
pnpm --filter @sherpa/ui build
pnpm --filter @sherpa/skill build
```

Версия берётся из корневого `package.json`, Git-ревизия — из рабочего дерева. `dist/` не хранится в Git. Проверки и требования к изменениям — в [CONTRIBUTING](../../CONTRIBUTING.md) и [AGENTS](../../AGENTS.md).
