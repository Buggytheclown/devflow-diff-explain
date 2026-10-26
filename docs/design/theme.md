# Темы интерфейса

Настройка «Тема» выбирает `auto`, `dark` или `light`. Отдельный переключатель «Стиль Arcanum»
включает его палитру, шрифты и плотность для выбранной светлоты. При `auto` обе версии
следуют за системой: без переключателя это dark/light, с ним — arcanum-dark/arcanum-light.
По умолчанию `theme: auto`, `arcanum: false`; источники Arcanum описаны в `arcanum.md`.

Все различия палитр, типографики и геометрии объявлены в `packages/ui/src/styles/tokens.css`.
Тёмная Devflow Diff Explain задаётся базовым блоком `:root, [data-theme]`; светлая Devflow Diff Explain и обе Arcanum
содержат тот же полный набор токенов в собственных блоках. Каждая граница `data-theme`
сбрасывает значения, включая ссылки между токенами: вложенная карточка галереи получает
свою тему целиком. В стилях компонентов нет условий по имени темы.
Геометрия, радиусы, отступы и движение описаны в `README.md`, раздел «Design tokens»;
источники оформления Arcanum — в `arcanum.md`. Таблицы сверяются с CSS тестом
`packages/ui/src/styles/tokens.test.ts` — списки обязаны совпадать по ключам и значениям.

Атрибут `data-theme` стоит на `<html>`, вместе с ним переключается `color-scheme` — от него
зависят нативные скроллбары, поля ввода и выпадающие списки. Атрибут содержит одну из четырёх
разрешённых палитр; `auto` остаётся только в настройках. Фон `html`/`body` равен `--surface-app`, чтобы при загрузке не было
вспышки чужого цвета. Селектор светлой палитры цепляется и к любому другому элементу с этим
атрибутом: галерея состояний так показывает карточку в светлой теме, не перекрашивая стенд
вокруг неё. В продукте вложенных тем нет.

Имена токенов семантические: переменная называется по роли, а не по оттенку. Исходные dark/light
сохраняют прежнюю палитру и геометрию. Для них значения взяты
из `SPEC-theming-2026-09-12.md`: столбец «источник» называет строку её таблицы §2 (`--c-<hex>`
для непрозрачных, `--a-<цифры>` для альф) или пару из §1, откуда пришли оба значения. Тёмная
палитра там пересобрана: нейтрали растянуты от фона страницы на +80 %, поэтому серая иерархия
стала плоской — приглушённые подписи почти белые. Это осознанный выбор дизайна по жалобам
на контраст, а не ошибка миграции.

Одна ступень возвращена точечно — так, как предусмотрено §3 той же спеки («вернуть 2–3 ступени,
не снижая общий уровень»): `--text-link-muted`, тон тихих ссылок-действий («Редактировать ·
Удалить»). Без него строка действий под комментарием была ровно того же цвета, что и тело.
Значение выбрано не по макету (`8a8f98`, это 5.3:1), а на уровне прохода 09-12: ≈9:1 на
поверхности карточки против ≈17:1 у тела — отношение ступеней то же, что в прототипе.

Токены, чьего прод-цвета в таблице §2 нет (экраны из `SPEC-additions-2026-08-26.md`, состояния
контролов), помечены «выведено»: тёмное значение получено формулой §3 —
`new = bg + (old − bg) × 1.8` покомпонентно от `#0d0e10` с клампом, акцентные оттенки не
тронуты, — светлое взято у ближайшего соседа той же роли. Штриховки, тени и полупрозрачные
заливки собраны из мигрированных составляющих.

## Правила исходной светлой темы, которые из таблицы не выводятся

- Активный сегмент (табы вью, пресеты маршрута, переключатели режимов) — приподнятая белая
  «таблетка» с тенью `--shadow-segment-active` на сером треке. Серый на сером в светлой
  читается как disabled.
- Включённый чип (People / Bots / Resolved, фильтр файлов) — индиговая заливка, обводка
  и текст (`--surface-chip-active`, `--border-chip-active`, `--text-chip-active`) в обеих темах.
- Янтарная primary-кнопка баннеров — `--attention-button` с белым текстом: оранжевый
  с чёрным текстом на кремовом фоне читался грязно. Заливка темнее общего `--attention`,
  поэтому у кнопки своя пара.
- Просмотренная остановка и прочитанный чип файла не приглушаются прозрачностью: первую
  показывают приглушённые токены заголовка и абзаца, вторую — только зелёная галочка.

## Состояния контролов

Источник — `SPEC-changes-2026-09-20.md` §5: ховер меняет только поверхность, нажатие сдвигает
её на вторую ступень, текст и рамка не меняются. Лестница серых поверхностей — `--surface-hover`
→ `--surface-pressed` → `--surface-pressed-deep`; у залитых кнопок три тона своего цвета
(`--surface-button-*`, `--surface-danger-button-*`, `--accent-hover` / `--accent-pressed`,
`--attention-button-hover` / `--attention-button-pressed`, `--surface-chip-active-*`).
Исключения из правила — ссылки (цвет идёт по лестнице акцента) и корзина (иконка краснеет
вместе с фоном). Сами варианты живут в `packages/ui/src/styles/controls.css`, компонентные
стили держат только раскладку; матрица состояний в обеих темах — карточка «Контролы» галереи.

## Типографика исходных тем

Размеры текста заданы в rem от базы `html` — `SPEC-theming-2026-09-12.md` §5. База `100%`,
то есть браузерная (обычно 16px): системная или браузерная настройка размера шрифта
масштабирует интерфейс целиком. Размер текста L — `data-textsize='l'` на `<html>`, база
`112.5%` (18px); других размеров нет, S спека отклонила (§9).

Пол шкалы — 11px (`0.6875rem`): всё, что в проде было 9–10.5px, поднято до него, поэтому
четыре мелких токена совпали по величине. Из шкалы выведены декоративные глифы, у которых
нет своего текста, — крестик закрытия (18px) и инициалы в аватаре; под полом остаются
инициалы (крупнее 9px они не помещаются в кружок 18×18) и один текстовый токен —
`--font-size-stop-mark`. Это единственное осознанное исключение из пола
(`SPEC-theming-2026-09-12.md` §5 и §6a): номер остановки живёт в метке 17×13 у левого края
строки дерева, второстепенный маркер рядом с именем файла, и 11px в такую метку не влезают.
`--line-height-code` намеренно остался в px: плотность строк кода не зависит от размера текста.

Колонки «px при M» и «px при L» — производные (`rem × 16` и `rem × 18`, округление до десятых);
тест пересчитывает их, чтобы таблица не разъехалась с CSS.

| Токен | rem | px при M | px при L | Где |
|---|---|---|---|---|
| `--font-size-pr-title-overview` | `1.5rem` | 24 | 27 | заголовок PR на Обзоре |
| `--font-size-pr-title` | `1.375rem` | 22 | 24.8 | заголовок PR на Маршруте и Полном диффе |
| `--font-size-screen-title` | `1.1875rem` | 19 | 21.4 | заголовки экранов |
| `--font-size-close-glyph` | `1.125rem` | 18 | 20.3 | крестик закрытия панели (глиф) |
| `--font-size-stop-title-high` | `1.0625rem` | 17 | 19.1 | заголовок остановки высокого тира |
| `--font-size-stop-title` | `0.9688rem` | 15.5 | 17.4 | заголовок остановки |
| `--font-size-section-title` | `0.9688rem` | 15.5 | 17.4 | заголовки секций |
| `--font-size-input` | `0.875rem` | 14 | 15.8 | поля ввода, заголовок карточки тура |
| `--font-size-body` | `0.8438rem` | 13.5 | 15.2 | абзацы остановок, бренд в шапке |
| `--font-size-ui` | `0.8125rem` | 13 | 14.6 | база `body`, основной UI-текст, тело карточки тура |
| `--font-size-secondary` | `0.7813rem` | 12.5 | 14.1 | вторичный UI-текст |
| `--font-size-control` | `0.75rem` | 12 | 13.5 | контролы, имена файлов, моно-подписи кнопок |
| `--font-size-code` | `0.75rem` | 12 | 13.5 | код в дифе и вставках |
| `--font-size-meta` | `0.7188rem` | 11.5 | 12.9 | моно-мета и счётчики |
| `--font-size-gutter` | `0.6875rem` | 11 | 12.4 | гаттеры, пути, моно-подписи |
| `--font-size-badge` | `0.6875rem` | 11 | 12.4 | бейджи, счётчики, ⌘K |
| `--font-size-scope` | `0.6875rem` | 11 | 12.4 | кикеры и метки области |
| `--font-size-tag` | `0.6875rem` | 11 | 12.4 | тег области в дереве и шапке карточки |
| `--font-size-stop-mark` | `0.625rem` | 10 | 11.3 | метка остановки в строке дерева (исключение из пола) |
| `--font-size-avatar-glyph` | `0.5625rem` | 9 | 10.1 | инициалы в аватаре (глиф) |

## Типографика Arcanum

Обе палитры Arcanum используют `YS Text` с резервными `Helvetica Neue`, `Arial`, `Helvetica`,
`sans-serif`. Имена, пути и счётчики в шапках файлов также используют `YS Text`.
Код и моноширинные метаданные используют стек Gravity: `Menlo`, `Monaco`,
`Consolas`, `Liberation Mono`, `Ubuntu Mono`, `DejaVu Sans Mono`, `Courier New`, `Courier`,
`monospace`. Исходные dark/light продолжают использовать IBM Plex Sans и IBM Plex Mono.
При M код и гаттер — 12px с высотой строки 17px; основной UI и абзацы — 14px,
контролы и метаданные — 13px. Механизм M/L и пол 11px сохранены.

| Токен | rem | px при M | px при L | Где |
|---|---|---|---|---|
| `--font-size-pr-title-overview` | `1.5rem` | 24 | 27 | заголовок PR на Обзоре |
| `--font-size-pr-title` | `1.375rem` | 22 | 24.8 | заголовок PR на Маршруте и Полном диффе |
| `--font-size-screen-title` | `1.1875rem` | 19 | 21.4 | заголовки экранов |
| `--font-size-close-glyph` | `1.125rem` | 18 | 20.3 | крестик закрытия панели (глиф) |
| `--font-size-stop-title-high` | `1.0625rem` | 17 | 19.1 | заголовок остановки высокого тира |
| `--font-size-stop-title` | `0.9688rem` | 15.5 | 17.4 | заголовок остановки |
| `--font-size-section-title` | `0.9688rem` | 15.5 | 17.4 | заголовки секций |
| `--font-size-input` | `0.875rem` | 14 | 15.8 | поля ввода, заголовок карточки тура |
| `--font-size-body` | `0.875rem` | 14 | 15.8 | абзацы остановок, бренд в шапке |
| `--font-size-ui` | `0.875rem` | 14 | 15.8 | база `body`, основной UI-текст, тело карточки тура |
| `--font-size-secondary` | `0.8125rem` | 13 | 14.6 | вторичный UI-текст |
| `--font-size-control` | `0.8125rem` | 13 | 14.6 | контролы, имена файлов, моно-подписи кнопок |
| `--font-size-code` | `0.75rem` | 12 | 13.5 | код в дифе и вставках |
| `--font-size-meta` | `0.8125rem` | 13 | 14.6 | моно-мета и счётчики |
| `--font-size-gutter` | `0.75rem` | 12 | 13.5 | гаттеры, пути, моно-подписи |
| `--font-size-badge` | `0.6875rem` | 11 | 12.4 | бейджи, счётчики, ⌘K |
| `--font-size-scope` | `0.6875rem` | 11 | 12.4 | кикеры и метки области |
| `--font-size-tag` | `0.6875rem` | 11 | 12.4 | тег области в дереве и шапке карточки |
| `--font-size-stop-mark` | `0.625rem` | 10 | 11.3 | метка остановки в строке дерева (исключение из пола) |
| `--font-size-avatar-glyph` | `0.5625rem` | 9 | 10.1 | инициалы в аватаре (глиф) |

## Цветовые токены

| Токен | Тёмная | Светлая | Тёмная Arcanum | Светлая Arcanum | Источник |
|---|---|---|---|---|---|
| `--surface-app` | `#0d0e10` | `#f6f7f9` | `#2d2c33` | `#ffffff` | `--c-0d0e10`; Arcanum: `arcanum.md` |
| `--surface-panel` | `#121315` | `#ffffff` | `#2d2c33` | `#ffffff` | `--c-101113`; Arcanum: `arcanum.md` |
| `--surface-panel-deep` | `#16171b` | `#fdfdfd` | `#35343b` | `#fafafa` | `--c-121316`; Arcanum: `arcanum.md` |
| `--surface-diff-card` | `#111214` | `#ffffff` | `#2d2c33` | `#ffffff` | `--c-0f1012`; Arcanum: `arcanum.md` |
| `--surface-card-header` | `#1a1b1e` | `#f2f3f6` | `#424248` | `#f2f2f2` | `--c-141518`; Arcanum: `arcanum.md` |
| `--surface-input` | `#1b1e24` | `#f3f4f8` | `#2d2c33` | `#ffffff` | `--c-15171b`; Arcanum: `arcanum.md` |
| `--surface-chip` | `#18191d` | `#fafbfc` | `#35343b` | `#fafafa` | `--c-131417`; Arcanum: `arcanum.md` |
| `--surface-control` | `#1d2020` | `#e8eaef` | `#424248` | `#f2f2f2` | `--c-161819`; Arcanum: `arcanum.md` |
| `--surface-raised` | `#212429` | `#ffffff` | `#35343b` | `#ffffff` | `--c-181a1e`; Arcanum: `arcanum.md` |
| `--surface-popover` | `#262b34` | `#e2e5ea` | `#424248` | `#ffffff` | `--c-1b1e24`; Arcanum: `arcanum.md` |
| `--surface-selected` | `#2d323b` | `#e2e5ea` | `#57565c` | `#f2f2f2` | `--c-1f2228`; Arcanum: `arcanum.md` |
| `--surface-offline-banner` | `#1b1c20` | `#f3f4f8` | `#35343b` | `#fafafa` | `--c-151619`; Arcanum: `arcanum.md` |
| `--surface-command` | `#0f1012` | `#f0f1f5` | `#2d2c33` | `#ffffff` | `--c-0e0f11`; Arcanum: `arcanum.md` |
| `--ownership-mine-surface` | `#182e20` | `#e4f6ea` | `rgba(91, 181, 87, 0.15)` | `rgba(59, 201, 53, 0.15)` | `--c-132019`; Arcanum: `arcanum.md` |
| `--surface-digest-footer` | `#1b171b` | `#feefec` | `#402f35` | `#ffe6e6` | `--c-151316`; Arcanum: `arcanum.md` |
| `--overlay-dialog` | `rgba(7, 8, 9, 0.66)` | `rgba(236, 238, 242, 0.7)` | `rgba(7, 8, 9, 0.66)` | `rgba(0, 0, 0, 0.4)` | `--a-78966`; Arcanum: `arcanum.md` |
| `--surface-toolbar` | `rgba(13, 14, 16, 0.92)` | `rgba(246, 247, 249, 0.92)` | `rgba(45, 44, 51, 0.96)` | `rgba(255, 255, 255, 0.96)` | `--a-13141692`; Arcanum: `arcanum.md` |
| `--pr-comments-overlay` | `rgba(8, 9, 10, 0.55)` | `rgba(236, 238, 242, 0.6)` | `rgba(8, 9, 10, 0.55)` | `rgba(0, 0, 0, 0.4)` | выведено: скрим, сосед `--a-78966`; Arcanum: `arcanum.md` |
| `--pr-comments-draft-surface` | `#181510` | `#fffaec` | `rgba(255, 203, 0, 0.1)` | `rgba(255, 219, 77, 0.1)` | выведено: §3 + сосед `--c-191712`; Arcanum: `arcanum.md` |
| `--comment-edit-surface` | `#161926` | `#f0f1ff` | `var(--accent-surface)` | `var(--accent-surface)` | выведено: §3 + сосед `--c-141520`; Arcanum: `arcanum.md` |
| `--pr-comments-published-chip-surface` | `#23252f` | `#e8eaef` | `#23252f` | `#f2f2f2` | выведено: §3 + сосед `--c-161819`; Arcanum: `arcanum.md` |
| `--comment-edit-chip-surface` | `#262e4a` | `#dfe2fa` | `var(--accent-surface-alt)` | `var(--accent-surface-alt)` | выведено: §3 + сосед `--c-262a45`; Arcanum: `arcanum.md` |
| `--pr-comments-delete-surface` | `#1f100e` | `#feecea` | `var(--error-surface)` | `var(--error-surface)` | выведено: §3 + сосед `--c-171315`; Arcanum: `arcanum.md` |
| `--surface-hover` | `#262b34` | `#e2e5ea` | `#424248` | `#f2f2f2` | §5 ступень 1, `--c-1b1e24`; Arcanum: `arcanum.md` |
| `--surface-pressed` | `#333741` | `#dadee4` | `#57565c` | `#e5e5e5` | §5 ступень 2, `--c-22252b`; Arcanum: `arcanum.md` |
| `--surface-pressed-deep` | `#434954` | `#c8cdd5` | `#68676d` | `#d9d9d9` | §5 ступень 3, `--c-2b2f36`; Arcanum: `arcanum.md` |
| `--surface-button` | `#333741` | `#ffffff` | `#424248` | `#ffffff` | §4b `--btn-bg`; Arcanum: `arcanum.md` |
| `--surface-button-hover` | `#434954` | `#eef0f4` | `#505056` | `#f2f2f2` | §4b `--btn-bg-hover`; Arcanum: `arcanum.md` |
| `--surface-button-pressed` | `#4a515c` | `#e2e5ea` | `#57565c` | `#e5e5e5` | §5 `--btn-bg-active`; Arcanum: `arcanum.md` |
| `--surface-danger-button` | `#3a1f1e` | `#f8d9d7` | `#3a1f1e` | `#ffe6e6` | §5 `--c-3a1f1e`; Arcanum: `arcanum.md` |
| `--surface-danger-button-hover` | `#4a2725` | `#f2c9c6` | `#4a2725` | `#ffd9d9` | §5 `--c-4a2725`; Arcanum: `arcanum.md` |
| `--surface-danger-button-pressed` | `#5c3230` | `#e0a39f` | `#5c3230` | `#ffcdcc` | §5 `--c-5c3230`; Arcanum: `arcanum.md` |
| `--surface-code-inset` | `#090a0c` | `#f3f4f6` | `#35343b` | `#fafafa` | выведено: §3 + сосед `--c-0c0d0f`; Arcanum: `arcanum.md` |
| `--surface-code-inline` | `#23272d` | `#e8eaee` | `#424248` | `#f2f2f2` | `--c-191c20`; Arcanum: `arcanum.md` |
| `--border-hairline` | `#24292f` | `#e4e6eb` | `#45444b` | `#e5e5e5` | `--c-1a1d21`; Arcanum: `arcanum.md` |
| `--border-hairline-strong` | `#2c3038` | `#e0e2e7` | `#505056` | `#d9d9d9` | `--c-1e2126`; Arcanum: `arcanum.md` |
| `--border-hairline-soft` | `#23272d` | `#e8eaee` | `#45444b` | `#e5e5e5` | `--c-191c20`; Arcanum: `arcanum.md` |
| `--border-standard` | `#333741` | `#dadee4` | `#57565c` | `#d9d9d9` | `--c-22252b`; Arcanum: `arcanum.md` |
| `--border-control` | `#363b44` | `#d2d5dd` | `#57565c` | `#cccccc` | `--c-24272d`; Arcanum: `arcanum.md` |
| `--border-chip` | `#3a404a` | `#c9ced6` | `#57565c` | `#cccccc` | `--c-262a30`; Arcanum: `arcanum.md` |
| `--border-divider` | `#3a3f48` | `#cdd3da` | `#57565c` | `#d9d9d9` | `--c-26292f`; Arcanum: `arcanum.md` |
| `--border-strong` | `#434954` | `#c8cdd5` | `#68676d` | `#cccccc` | `--c-2b2f36`; Arcanum: `arcanum.md` |
| `--border-strong-lifted` | `#4a515c` | `#bbc2cb` | `#77767c` | `#b3b3b3` | `--c-2f333a`; Arcanum: `arcanum.md` |
| `--ownership-mine-border` | `#24422f` | `#cde9d8` | `rgba(91, 181, 87, 0.3)` | `rgba(59, 201, 53, 0.3)` | `--c-24422f`; Arcanum: `arcanum.md` |
| `--border-raised-bar` | `#4c5466` | `#b7bec8` | `#57565c` | `#cccccc` | `--c-303540`; Arcanum: `arcanum.md` |
| `--border-raised-dialog` | `#4e5666` | `#bfc6cf` | `#57565c` | `#cccccc` | `--c-313640`; Arcanum: `arcanum.md` |
| `--border-raised-popover` | `#515a6a` | `#b0b7c1` | `#68676d` | `#b3b3b3` | `--c-333842`; Arcanum: `arcanum.md` |
| `--pr-comments-draft-border` | `#33301f` | `#ecdfc4` | `rgba(255, 203, 0, 0.2)` | `rgba(255, 219, 77, 0.3)` | выведено: акцент не тронут, сосед `--c-3d3524`; Arcanum: `arcanum.md` |
| `--comment-edit-border` | `#3c4560` | `#c3c7e6` | `var(--accent-border)` | `var(--accent-border)` | выведено: акцент не тронут, сосед `--c-3a3f60`; Arcanum: `arcanum.md` |
| `--pr-comments-delete-border` | `#4a2f2d` | `#f0d2d0` | `var(--error-border)` | `var(--error-border)` | выведено: акцент не тронут, сосед `--c-3d2a2c`; Arcanum: `arcanum.md` |
| `--border-danger-button` | `#5c3230` | `#e0a39f` | `#5c3230` | `#ffb4b3` | §5 `--c-5c3230`; Arcanum: `arcanum.md` |
| `--border-button` | `#4a515c` | `#8b94a3` | `#68676d` | `#b3b3b3` | §4b `--btn-bd`; Arcanum: `arcanum.md` |
| `--border-switch-track` | `#343941` | `#c8cdd5` | `#57565c` | `#cccccc` | §5 `--c-343941`; Arcanum: `arcanum.md` |
| `--pr-comments-editor-border` | `#535b68` | `#b1b8c2` | `#535b68` | `#b3b3b3` | выведено: §3 + сосед `--c-33373e`; Arcanum: `arcanum.md` |
| `--text-primary` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` | `--c-f0f1f4`; Arcanum: `arcanum.md` |
| `--text-primary-soft` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` | `--c-e9eaee`; Arcanum: `arcanum.md` |
| `--text-secondary` | `#ffffff` | `#000000` | `#c0bfc2` | `#595959` | `--c-c7cad1`; Arcanum: `arcanum.md` |
| `--text-secondary-dim` | `#ffffff` | `#00000a` | `#c0bfc2` | `#595959` | `--c-b9bec7`; Arcanum: `arcanum.md` |
| `--text-body` | `#ffffff` | `#00000a` | `#e0e0e1` | `#262626` | `--c-a9aeb7`; Arcanum: `arcanum.md` |
| `--text-muted` | `#ffffff` | `#000813` | `#b1b0b4` | `#666666` | `--c-9ba1ab`; Arcanum: `arcanum.md` |
| `--text-muted-dim` | `#ffffff` | `#0c1420` | `#b1b0b4` | `#666666` | `--c-8a8f98`; Arcanum: `arcanum.md` |
| `--text-link-muted` | `#b6bcc6` | `#3c424c` | `#b1b0b4` | `#666666` | `SPEC-changes-2026-09-20.md §5` (`8a8f98`), ступень возвращена по §3; Arcanum: `arcanum.md` |
| `--text-dim` | `#e7f1ff` | `#19212d` | `#b1b0b4` | `#666666` | `--c-6b7078`; Arcanum: `arcanum.md` |
| `--text-dim-strong` | `#dae4f3` | `#28303b` | `#c0bfc2` | `#595959` | `--c-5e636b`; Arcanum: `arcanum.md` |
| `--text-gutter` | `#6e7580` | `#9198a2` | `#e0e0e1` | `#595959` | `--c-43474e`; Arcanum: `arcanum.md` |
| `--pr-comments-published-chip-text` | `#eef8ff` | `#0c1420` | `#eef8ff` | `#262626` | выведено: §3 + сосед `--c-8a8f98`; Arcanum: `arcanum.md` |
| `--comment-edit-chip-text` | `#9ea8ff` | `#4c5ae0` | `var(--accent-text)` | `var(--accent-text)` | выведено: акцент не тронут, сосед `--c-9aa6ff`; Arcanum: `arcanum.md` |
| `--pr-comments-body-text` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` | выведено: §3 + сосед `--c-c2c7d0`; Arcanum: `arcanum.md` |
| `--chat-body-text` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` | `--c-c2c7d0`; Arcanum: `arcanum.md` |
| `--text-danger-button` | `#f2c4c0` | `#7a2622` | `#f2c4c0` | `#6c2024` | §5 `--c-f2c4c0`; Arcanum: `arcanum.md` |
| `--text-button` | `#ffffff` | `#0c1420` | `#ffffff` | `#262626` | §4b `--btn-fg`; Arcanum: `arcanum.md` |
| `--pr-comments-note-icon` | `#9c8760` | `#7f6c3e` | `#b3a17e` | `#6c603b` | `--c-8a7550`; Arcanum: `arcanum.md` |
| `--accent` | `#7f8cff` | `#5a68e8` | `#5282ff` | `#4768c2` | `--c-7f8cff`; Arcanum: `arcanum.md` |
| `--accent-hover` | `#8f9bff` | `#4c5ae0` | `#7098ff` | `#3f5799` | `--c-8f9bff`; Arcanum: `arcanum.md` |
| `--accent-hover-strong` | `#b3bcff` | `#3a47bd` | `#8eadff` | `#384670` | `--c-b3bcff`; Arcanum: `arcanum.md` |
| `--accent-pressed` | `#6b78e6` | `#4353cf` | `#4778ef` | `#3c4f85` | §5 `--c-6b78e6`; Arcanum: `arcanum.md` |
| `--accent-ink` | `#101223` | `#ffffff` | `#0b1020` | `#ffffff` | `--c-101223`; Arcanum: `arcanum.md` |
| `--accent-text` | `#aeb6ff` | `#4350cc` | `#82a5ff` | `#3f5799` | `--c-aeb6ff`; Arcanum: `arcanum.md` |
| `--accent-text-soft` | `#c9cdf0` | `#3a4390` | `#a3bbff` | `#3f5799` | `--c-c9cdf0`; Arcanum: `arcanum.md` |
| `--accent-text-bright` | `#dfe2ff` | `#262f8a` | `#cfddff` | `#384670` | `--c-dfe2ff`; Arcanum: `arcanum.md` |
| `--accent-text-queued` | `#7d83ad` | `#6b719f` | `#a3abc2` | `#595959` | `--c-5c6288`; Arcanum: `arcanum.md` |
| `--accent-surface` | `#131424` | `#f0f1fc` | `#303850` | `#eef3ff` | `--c-131424`; Arcanum: `arcanum.md` |
| `--accent-surface-alt` | `#1a1b2d` | `#f0f1ff` | `#303850` | `#e5ecff` | `--c-141520`; Arcanum: `arcanum.md` |
| `--accent-border` | `#262a45` | `#dfe2fa` | `#465d90` | `#cbdaff` | `--c-262a45`; Arcanum: `arcanum.md` |
| `--accent-selection` | `rgba(127, 140, 255, 0.13)` | `rgba(90, 104, 232, 0.12)` | `rgba(82, 130, 255, 0.15)` | `rgba(82, 130, 255, 0.15)` | `--a-12714025513`; Arcanum: `arcanum.md` |
| `--accent-text-selection` | `rgba(127, 140, 255, 0.28)` | `rgba(90, 104, 232, 0.22)` | `rgba(82, 130, 255, 0.3)` | `rgba(82, 130, 255, 0.3)` | `--a-12714025528`; Arcanum: `arcanum.md` |
| `--surface-thread-line` | `rgba(127, 140, 255, 0.07)` | `rgba(90, 104, 232, 0.08)` | `rgba(82, 130, 255, 0.07)` | `rgba(82, 130, 255, 0.1)` | `SPEC-changes-2026-09-20.md §3`; Arcanum: `arcanum.md` |
| `--attention` | `#e2954c` | `#d8791c` | `#ffcb00` | `#ffdb4d` | `--c-e2954c`; Arcanum: `arcanum.md` |
| `--attention-text` | `#e2b878` | `#9d6410` | `#ffdb4c` | `#6c603b` | `--c-e2b878`; Arcanum: `arcanum.md` |
| `--attention-text-dim` | `#c9a464` | `#7f5612` | `#ffd01a` | `#6c603b` | `--c-c9a464`; Arcanum: `arcanum.md` |
| `--attention-text-soft` | `#e6d7bd` | `#3f3014` | `#e0e0e1` | `#262626` | `--c-e6d7bd`; Arcanum: `arcanum.md` |
| `--attention-surface` | `#241f14` | `#fbf3df` | `rgba(255, 203, 0, 0.15)` | `rgba(255, 219, 77, 0.2)` | `--c-241f14`; Arcanum: `arcanum.md` |
| `--attention-surface-alt` | `#231e14` | `#fffaec` | `rgba(255, 203, 0, 0.1)` | `rgba(255, 219, 77, 0.1)` | `--c-191712`; Arcanum: `arcanum.md` |
| `--attention-border` | `#4a4230` | `#d9c9a4` | `rgba(255, 203, 0, 0.3)` | `rgba(255, 219, 77, 0.5)` | `--c-4a4230`; Arcanum: `arcanum.md` |
| `--attention-border-alt` | `#3d3524` | `#ecdfc4` | `rgba(255, 203, 0, 0.2)` | `rgba(255, 219, 77, 0.3)` | `--c-3d3524`; Arcanum: `arcanum.md` |
| `--attention-border-strong` | `#6b5b39` | `#bba777` | `rgba(255, 203, 0, 0.5)` | `#c0a645` | `--c-6b5b39`; Arcanum: `arcanum.md` |
| `--attention-button` | `#e2954c` | `#b8641c` | `#ffcb00` | `#ffdb4d` | §1 `--amber-btn`; Arcanum: `arcanum.md` |
| `--attention-button-ink` | `#1b1508` | `#ffffff` | `#2d2c33` | `#262626` | §1 `--amber-btn-fg`; Arcanum: `arcanum.md` |
| `--attention-button-hover` | `#eaa15c` | `#c56d1f` | `#ffd01a` | `#ffdf5f` | §5 `--amber-btn-hover`; Arcanum: `arcanum.md` |
| `--attention-button-pressed` | `#d1873f` | `#a85a14` | `#e9ba04` | `#eac94a` | §5 `--amber-btn-active`; Arcanum: `arcanum.md` |
| `--attention-label` | `#9c8760` | `#7f6c3e` | `#ffdb4c` | `#6c603b` | `--c-8a7550`; Arcanum: `arcanum.md` |
| `--attention-body` | `#d8c9ad` | `#5a4a24` | `#e0e0e1` | `#262626` | `--c-d8c9ad`; Arcanum: `arcanum.md` |
| `--draft-field-surface` | `#1a1510` | `#fffaec` | `rgba(255, 203, 0, 0.1)` | `rgba(255, 219, 77, 0.1)` | выведено: §3 + сосед `--c-191712`; Arcanum: `arcanum.md` |
| `--draft-saved` | `#5e8a6d` | `#268f52` | `#8bbe9d` | `#347b34` | выведено: акцент не тронут, сосед `--c-6cc38f`; Arcanum: `arcanum.md` |
| `--tag-pci-border` | `#3d3a2c` | `#e9dfc3` | `rgba(255, 203, 0, 0.3)` | `rgba(255, 219, 77, 0.5)` | `--c-3d3a2c`; Arcanum: `arcanum.md` |
| `--surface-tour-card` | `#1f242b` | `#ffffff` | `#35343b` | `#ffffff` | `--c-171a1f`; Arcanum: `arcanum.md` |
| `--tour-skip-underline` | `#5e6673` | `#a1a7b3` | `#5e6673` | `#999999` | `--c-3a3f47`; Arcanum: `arcanum.md` |
| `--diff-add-bg` | `rgba(66, 160, 110, 0.11)` | `rgba(38, 143, 82, 0.10)` | `rgba(151, 234, 151, 0.1)` | `rgba(151, 234, 151, 0.3)` | `--a-6616011011`; Arcanum: `arcanum.md` |
| `--diff-add-text` | `#6cc38f` | `#268f52` | `#50c987` | `#347b34` | `--c-6cc38f`; Arcanum: `arcanum.md` |
| `--diff-add-text-strong` | `#86d9a8` | `#1e7f47` | `#68d99b` | `#336b34` | `--c-86d9a8`; Arcanum: `arcanum.md` |
| `--diff-add-gutter` | `#5f9478` | `#3a835d` | `#e0e0e1` | `#595959` | `--c-4f7f66`; Arcanum: `arcanum.md` |
| `--diff-del-bg` | `rgba(224, 108, 102, 0.10)` | `rgba(207, 70, 64, 0.09)` | `rgba(251, 175, 175, 0.1)` | `rgba(251, 175, 175, 0.3)` | `--a-22410810210`; Arcanum: `arcanum.md` |
| `--diff-del-text` | `#dd8a84` | `#c94842` | `#ff6969` | `#c0100f` | `--c-dd8a84`; Arcanum: `arcanum.md` |
| `--diff-del-text-strong` | `#e8a29c` | `#c33f39` | `#ff9494` | `#961819` | `--c-e8a29c`; Arcanum: `arcanum.md` |
| `--diff-del-gutter` | `#a0736e` | `#a45a54` | `#e0e0e1` | `#595959` | `--c-7f5a56`; Arcanum: `arcanum.md` |
| `--diff-add-gutter-bg` | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | `#425247` | `#cbf5cb` | исходные темы: прозрачный фон; Arcanum: `arcanum.md` |
| `--diff-del-gutter-bg` | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | `#56464c` | `#fdd7d7` | исходные темы: прозрачный фон; Arcanum: `arcanum.md` |
| `--read-fill` | `#3a8f66` | `#2f8557` | `#3a8f66` | `#347b34` | `--c-2b7a55`; Arcanum: `arcanum.md` |
| `--viewed-surface` | `#1d3022` | `#e8f7ec` | `rgba(91, 181, 87, 0.15)` | `rgba(59, 201, 53, 0.15)` | `--c-16211a`; Arcanum: `arcanum.md` |
| `--viewed-border` | `#25422f` | `#cde9d8` | `rgba(91, 181, 87, 0.3)` | `rgba(59, 201, 53, 0.3)` | `--c-25422f`; Arcanum: `arcanum.md` |
| `--viewed-hover-surface` | `#25422f` | `#cde9d8` | `rgba(91, 181, 87, 0.2)` | `rgba(59, 201, 53, 0.2)` | `--c-25422f`; Arcanum: `arcanum.md` |
| `--viewed-hover-border` | `#3a8f66` | `#2f8557` | `#5bb557` | `#347b34` | `--c-2b7a55`; Arcanum: `arcanum.md` |
| `--success-surface` | `#1f3d2c` | `#bfe4cd` | `rgba(91, 181, 87, 0.2)` | `rgba(59, 201, 53, 0.2)` | `--c-1f3d2c`; Arcanum: `arcanum.md` |
| `--success-text` | `#86d9a8` | `#1e7f47` | `#8ccb89` | `#336b34` | текст зелёных меток; Arcanum: `arcanum.md` |
| `--read-fill-hover` | `rgba(58, 143, 102, 0.25)` | `rgba(47, 133, 87, 0.25)` | `rgba(58, 143, 102, 0.25)` | `rgba(59, 201, 53, 0.25)` | выведено из `--c-2b7a55`; Arcanum: `arcanum.md` |
| `--read-border` | `#3f7a5a` | `#46a672` | `#3f7a5a` | `#347b34` | `--c-3f7a5a`; Arcanum: `arcanum.md` |
| `--error` | `#e0736c` | `#cf4640` | `#ef7f7d` | `#c0100f` | `--c-e0736c`; Arcanum: `arcanum.md` |
| `--error-text` | `#d99a95` | `#b5423c` | `#f3a4a2` | `#961819` | `--c-d99a95`; Arcanum: `arcanum.md` |
| `--error-surface` | `#1f1719` | `#feecea` | `#493036` | `#ffe6e6` | `--c-171315`; Arcanum: `arcanum.md` |
| `--error-border` | `#3d2a2c` | `#f0d2d0` | `#653539` | `#ffb4b3` | `--c-3d2a2c`; Arcanum: `arcanum.md` |
| `--code-text` | `#ffffff` | `#000000` | `#e0e0e1` | `#000000` | `--c-cfd3da`; Arcanum: `arcanum.md` |
| `--code-text-del` | `#d5c0be` | `#87332e` | `#e0e0e1` | `#000000` | `--c-d5c0be`; Arcanum: `arcanum.md` |
| `--surface-diff-empty` | `#0b0c0e` | `#f3f4f6` | `#2d2c33` | `#ffffff` | `--c-0c0d0f`; Arcanum: `arcanum.md` |
| `--surface-diff-gap` | `#1a1b1e` | `#f2f3f6` | `#35343b` | `#f1f8ff` | `--c-111214`; оба значения — отступление: по §2 (`#141517` / `#ffffff`) строка сливается с карточкой, взяты значения соседа `--c-141518` — шапки карточки (`docs/decisions.md`, 2026-09-12); Arcanum: `arcanum.md` |
| `--diff-add-word` | `rgba(66, 160, 110, 0.22)` | `rgba(38, 143, 82, 0.22)` | `rgba(151, 234, 151, 0.1)` | `rgba(151, 234, 151, 0.6)` | выведено из `--a-6616011011`; Arcanum: `arcanum.md` |
| `--diff-del-word` | `rgba(224, 108, 102, 0.22)` | `rgba(207, 70, 64, 0.22)` | `rgba(251, 175, 175, 0.1)` | `rgba(251, 175, 175, 0.6)` | выведено из `--a-22410810210`; Arcanum: `arcanum.md` |
| `--diff-trailing-space` | `rgba(224, 108, 102, 0.25)` | `rgba(207, 70, 64, 0.25)` | `rgba(224, 108, 102, 0.25)` | `rgba(255, 4, 0, 0.2)` | выведено из `--a-22410810210`; Arcanum: `arcanum.md` |
| `--row-hover` | `rgba(255, 255, 255, 0.04)` | `rgba(20, 24, 32, 0.04)` | `rgba(255, 255, 255, 0.04)` | `rgba(0, 0, 0, 0.05)` | выведено: нейтральная альфа, сосед `--a-0005`; Arcanum: `arcanum.md` |
| `--checkbox-border` | `#5e6673` | `#a1a7b3` | `#5e6673` | `#999999` | `--c-3a3f47`; Arcanum: `arcanum.md` |
| `--read-box-border` | `#515a65` | `#afb5c0` | `#515a65` | `#b3b3b3` | `--c-33383f`; Arcanum: `arcanum.md` |
| `--stop-mark-text` | `#7b8390` | `#828894` | `#a3a2a7` | `#595959` | `--c-4a4f57` (§6a); Arcanum: `arcanum.md` |
| `--stop-mark-border` | `#2c3038` | `#e0e2e7` | `#2c3038` | `#e5e5e5` | `--c-1e2126` (§6a); Arcanum: `arcanum.md` |
| `--tree-read-color` | `#848b97` | `#70767f` | `#9e9da3` | `#767676` | подпись прочитанного в дереве; самый тихий серый, который держит 4.5:1 и на панели, и на ховере строки (`--surface-raised`): ступени `--text-*` оказались слишком близки к обычной подписи, и прочитанное плохо отличалось от непрочитанного. В Arcanum не `--g-color-text-secondary` просмотренного элемента из референса (`DiffListTreeItem.scss`, `Level.scss`): тот совпадает с оттенком generated и ярче foreign |
| `--border-button-outline` | `#7b8390` | `#828894` | `#7b8390` | `#999999` | `--c-4a4f57`; Arcanum: `arcanum.md` |
| `--border-button-outline-hover` | `#dae4f3` | `#28303b` | `#dae4f3` | `#404040` | `--c-5e636b`; Arcanum: `arcanum.md` |
| `--syntax-keyword` | `#9aa6ff` | `#5462e3` | `#c586c0` | `#af00db` | `--c-9aa6ff`; Arcanum: `arcanum.md` |
| `--syntax-string` | `#d3b183` | `#8a5f1c` | `#ce9178` | `#a31515` | `--c-d3b183`; Arcanum: `arcanum.md` |
| `--syntax-comment` | `#8a919c` | `#646b76` | `#8a9b83` | `#008000` | `--c-5f646d`; оба значения — отступление: по §2 (`#dae4f3` / `#28303b`) комментарий почти не отличался от кода (`docs/decisions.md`, 2026-09-12); Arcanum: `arcanum.md` |
| `--syntax-decorator` | `#d99a5c` | `#b46a1f` | `#4ec9b0` | `#267f99` | `--c-d99a5c`; Arcanum: `arcanum.md` |
| `--syntax-property` | `#d3b183` | `#8a5f1c` | `#569cd6` | `#0451a5` | Devflow Diff Explain: роль `string`; Arcanum: `arcanum.md` |
| `--syntax-number` | `#d3b183` | `#8a5f1c` | `#b5cea8` | `#098658` | Devflow Diff Explain: роль `string`; Arcanum: `arcanum.md` |
| `--syntax-variable` | `currentColor` | `currentColor` | `#4ec9b0` | `#001080` | Devflow Diff Explain: цвет строки кода; Arcanum: `arcanum.md` |
| `--syntax-type` | `#9aa6ff` | `#5462e3` | `#4ec9b0` | `#267f99` | Devflow Diff Explain: роль `keyword`; Arcanum: `arcanum.md` |
| `--syntax-function` | `currentColor` | `currentColor` | `#dcdcaa` | `#795e26` | Devflow Diff Explain: цвет строки кода; Arcanum: `arcanum.md` |
| `--tier-medium` | `#7b87a0` | `#7b8390` | `#7b87a0` | `#737373` | `--c-4a5160`; Arcanum: `arcanum.md` |
| `--tier-low` | `#434954` | `#c8cdd5` | `#434954` | `#cccccc` | `--c-2b2f36`; Arcanum: `arcanum.md` |
| `--tier-unfilled` | `#2a2e4a` | `#dde0f8` | `#2a2e4a` | `#e5e5e5` | `--c-2a2e4a`; Arcanum: `arcanum.md` |
| `--hatch` | `repeating-linear-gradient(115deg, #515863 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #b1b8c2 0 3px, #e9ecef 3px 6px)` | `repeating-linear-gradient(115deg, #515863 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #b3b3b3 0 3px, #f2f2f2 3px 6px)` | `--c-33373e`, `--c-1b1e22`; Arcanum: `arcanum.md` |
| `--hatch-sidebar` | `repeating-linear-gradient(115deg, #414851 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #c5cad2 0 3px, #e9ecef 3px 6px)` | `repeating-linear-gradient(115deg, #414851 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #cccccc 0 3px, #f2f2f2 3px 6px)` | `--c-2a2e34`, `--c-1b1e22`; Arcanum: `arcanum.md` |
| `--hatch-footer` | `repeating-linear-gradient(115deg, #23272d 0 3px, #1a1b1e 3px 6px)` | `repeating-linear-gradient(115deg, #e8eaee 0 3px, #f2f3f6 3px 6px)` | `repeating-linear-gradient(115deg, #23272d 0 3px, #1a1b1e 3px 6px)` | `repeating-linear-gradient(115deg, #e5e5e5 0 3px, #fafafa 3px 6px)` | `--c-191c20`, `--c-141518`; Arcanum: `arcanum.md` |
| `--hover-selected` | `#3e444f` | `#dadee4` | `#68676d` | `#e5e5e5` | выведено: §3 + сосед `--c-22252b`; Arcanum: `arcanum.md` |
| `--surface-segment-active` | `#434954` | `#ffffff` | `#57565c` | `#ffffff` | §1 `--seg-bg`; Arcanum: `arcanum.md` |
| `--text-on-segment-active` | `#ffffff` | `#000000` | `#ffffff` | `#262626` | §1 `--seg-fg`; Arcanum: `arcanum.md` |
| `--shadow-segment-active` | `none` | `0 1px 2px rgba(20, 24, 32, 0.18), 0 0 0 1px rgba(20, 24, 32, 0.08)` | `none` | `0 1px 2px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05)` | §1 `--seg-shadow`; Arcanum: `arcanum.md` |
| `--shadow-button` | `none` | `0 1px 2px rgba(20, 24, 32, 0.12)` | `none` | `0 1px 2px rgba(0, 0, 0, 0.1)` | §4b `--btn-shadow`; Arcanum: `arcanum.md` |
| `--surface-chip-active` | `#1e2240` | `#e8eaff` | `#303e62` | `#e5ecff` | §1 `--chip-bg`; Arcanum: `arcanum.md` |
| `--border-chip-active` | `#3f4880` | `#b9c0f4` | `#465d90` | `#cbdaff` | §1 `--chip-bd`; Arcanum: `arcanum.md` |
| `--text-chip-active` | `#c3caff` | `#2b3690` | `#cad8ff` | `#3f5799` | §1 `--chip-fg`; Arcanum: `arcanum.md` |
| `--surface-chip-active-hover` | `#262c52` | `#dfe2fb` | `#394c75` | `#dce6ff` | §5 `--chip-bg-hover`; Arcanum: `arcanum.md` |
| `--surface-chip-active-pressed` | `#2e3566` | `#d3d8f8` | `#425a88` | `#cbdaff` | §5 `--chip-bg-active`; Arcanum: `arcanum.md` |
| `--focus-ring-color` | `#7f8cff` | `#5a68e8` | `#5282ff` | `#5282ff` | §5 `--focus`; Arcanum: `arcanum.md` |
| `--text-on-selected` | `#ffffff` | `#000000` | `#ffffff` | `#262626` | `--c-e0e2e7`; Arcanum: `arcanum.md` |
| `--text-separator` | `#7b8390` | `#828894` | `#b1b0b4` | `#666666` | `--c-4a4f57`; Arcanum: `arcanum.md` |
| `--shadow-line-comment` | `0 1px 4px rgba(0, 0, 0, 0.45)` | `0 1px 4px rgba(20, 24, 32, 0.1)` | `0 1px 4px rgba(0, 0, 0, 0.45)` | `0 1px 4px rgba(0, 0, 0, 0.1)` | выведено: сосед `--a-0005`; Arcanum: `arcanum.md` |
| `--shadow-popover` | `0 8px 24px rgba(0, 0, 0, 0.5)` | `0 8px 24px rgba(20, 24, 32, 0.12)` | `0 8px 24px rgba(0, 0, 0, 0.5)` | `0 8px 24px rgba(0, 0, 0, 0.15)` | `--a-0005`; Arcanum: `arcanum.md` |
| `--shadow-menu` | `0 16px 40px rgba(0, 0, 0, 0.6)` | `0 16px 40px rgba(20, 24, 32, 0.16)` | `0 16px 40px rgba(0, 0, 0, 0.6)` | `0 16px 40px rgba(0, 0, 0, 0.15)` | `--a-0006`; Arcanum: `arcanum.md` |
| `--shadow-floating` | `0 16px 44px rgba(0, 0, 0, 0.6)` | `0 16px 44px rgba(20, 24, 32, 0.16)` | `0 16px 44px rgba(0, 0, 0, 0.6)` | `0 16px 44px rgba(0, 0, 0, 0.15)` | `--a-0006`; Arcanum: `arcanum.md` |
| `--shadow-dialog` | `0 24px 64px rgba(0, 0, 0, 0.65)` | `0 24px 64px rgba(20, 24, 32, 0.18)` | `0 24px 64px rgba(0, 0, 0, 0.65)` | `0 24px 64px rgba(0, 0, 0, 0.2)` | `--a-00065`; Arcanum: `arcanum.md` |
| `--shadow-pr-comments` | `0 18px 50px rgba(0, 0, 0, 0.55)` | `0 18px 50px rgba(20, 24, 32, 0.14)` | `0 18px 50px rgba(0, 0, 0, 0.55)` | `0 18px 50px rgba(0, 0, 0, 0.15)` | `--a-00055`; Arcanum: `arcanum.md` |
| `--shadow-tour-card` | `0 20px 52px rgba(0, 0, 0, 0.62)` | `0 20px 52px rgba(20, 24, 32, 0.18)` | `0 20px 52px rgba(0, 0, 0, 0.62)` | `0 20px 52px rgba(0, 0, 0, 0.2)` | `--a-00062`; Arcanum: `arcanum.md` |
| `--shadow-tour-ring` | `0 0 0 3px rgba(127, 140, 255, 0.13), 0 0 26px rgba(127, 140, 255, 0.16)` | `0 0 0 3px rgba(90, 104, 232, 0.12), 0 0 26px rgba(90, 104, 232, 0.16)` | `0 0 0 3px rgba(127, 140, 255, 0.13), 0 0 26px rgba(127, 140, 255, 0.16)` | `0 0 0 3px rgba(82, 130, 255, 0.15), 0 0 26px rgba(82, 130, 255, 0.2)` | `--a-12714025513`, `--a-12714025516`; Arcanum: `arcanum.md` |
| `--pr-comments-list-fade` | `linear-gradient(180deg, rgba(17, 18, 20, 0) 0%, #111214 92%)` | `linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #ffffff 92%)` | `linear-gradient(180deg, rgba(45, 44, 51, 0) 0%, #2d2c33 92%)` | `linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #ffffff 92%)` | выведено из `--c-0f1012`; Arcanum: `arcanum.md` |
