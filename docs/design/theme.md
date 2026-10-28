# Темы и токены интерфейса

Оформление поддерживает обычное окно компьютера. Поведение экранов задаёт [продуктовая спецификация](../spec.md); значения — `packages/ui/src/styles/tokens.css`, компонентная раскладка — `packages/ui/src/story/story.css`.

## Оформление рабочего UI

Рабочий интерфейс всегда на русском, в палитре `arcanum-dark`. Выбора языка, темы и стиля на экране нет. Сервер отдаёт это оформление с первого кадра; старые настройки и системная светлая тема его не меняют. Оформление Arcanum не добавляет глобальное меню его сервисов.

Остальные палитры сохраняются в CSS и галерее как технические варианты компонентов. На `<html>` рабочего приложения устанавливается `data-theme="arcanum-dark"` с соответствующим `color-scheme`. Фон страницы совпадает с `--surface-app`, чтобы при загрузке не было вспышки другого цвета.

Mermaid показывает поток сверху вниз и вписывает SVG в ширину области чтения. Переключатель направления сохраняет выбранный узел и связи с блоками. Цвета узлов, текста, стрелок и групп задаёт приложение: правила `classDef`, `style` и `linkStyle` из сгенерированного графа не должны снижать контраст. Текст имеет контраст не ниже 4.5:1 к фону узла; статус PR различим также по легенде и рамкам.

Имена токенов семантические. Компоненты берут цвета, размеры текста и состояния из токенов; условий по имени темы и второго набора цветов в компонентных стилях нет. Полная таблица включает токены общих компонентов: наличие токена не добавляет экран или действие в продукт.

## Геометрия и движение

Каркас состоит из верхней навигации, общей панели готовности, содержания, области чтения и явно открываемого чата. Готовая подготовка занимает компактную строку с раскрываемыми подробностями; ошибки и незавершённость показываются полностью. Чат имеет одну шапку «Чат», без центральной инструкции, постоянной памятки клавиш и повторяющихся подписей ролей. Явное вложение файла или строк находится возле поля ввода; сведения об агенте и версии раскрываются по запросу. Ответы не сворачиваются. В обзоре маршрут расположен справа. Разбор файла показывает пояснение перед полным диффом и локальные заметки рядом с важными строками.

Точная геометрия компонентов задаётся CSS. Окно компьютера может сужаться: файлы и чат остаются доступны, целевой код не закрывается полностью, страница не получает горизонтального переполнения. Отдельной телефонной раскладки нет.

Непрерывная анимация допустима для активного ожидания. Отключение агента и остановка подготовки останавливают её. Уменьшенное движение учитывается. Смена компоновки схемы и ширины окна сохраняет адрес чтения и выделение.

## Состояния контролов

Наведение меняет поверхность, нажатие — следующую ступень поверхности; текст и рамка не должны произвольно менять контраст. Ссылки используют лестницу акцента. Фокус, выбор, disabled, загрузка и ошибка различимы без одного лишь цвета. Общие варианты живут в `packages/ui/src/styles/controls.css`, матрица состояний — в галерее «Контролы».

## Типографика

Размеры текста заданы в rem от базы `html`: браузерная база обычно 16px; масштаб L использует 18px. Поэтому системное изменение размера шрифта масштабирует интерфейс целиком. Основная нижняя граница шкалы — `0.6875rem` (11px при базе 16px); компактные метки и глифы имеют отдельные исключения в таблице.

Базовое оформление использует IBM Plex Sans и IBM Plex Mono; Arcanum — YS Text при доступности шрифта и системные резервные семейства. Пути, стеки и межстрочные интервалы заданы в CSS. Отдельные роли кода, метаданных и заголовков сохраняются при смене оформления.

Таблица шрифтовой шкалы сверяется с CSS. Пиксельные колонки — производные от rem, а не отдельные значения.

| Токен | rem | px при M | px при L | Роль |
|---|---|---|---|---|
| `--font-size-pr-title-overview` | `1.5rem` | 24 | 27 | Заголовок обзора |
| `--font-size-pr-title` | `1.375rem` | 22 | 24.8 | Заголовок PR |
| `--font-size-screen-title` | `1.1875rem` | 19 | 21.4 | заголовки экранов |
| `--font-size-close-glyph` | `1.125rem` | 18 | 20.3 | крестик закрытия панели (глиф) |
| `--font-size-stop-title-high` | `1.0625rem` | 17 | 19.1 | Заголовок блока |
| `--font-size-stop-title` | `0.9688rem` | 15.5 | 17.4 | Заголовок блока |
| `--font-size-section-title` | `0.9688rem` | 15.5 | 17.4 | заголовки секций |
| `--font-size-input` | `0.875rem` | 14 | 15.8 | Поля ввода |
| `--font-size-body` | `0.8438rem` | 13.5 | 15.2 | Пояснения |
| `--font-size-ui` | `0.8125rem` | 13 | 14.6 | Текст интерфейса |
| `--font-size-secondary` | `0.7813rem` | 12.5 | 14.1 | вторичный UI-текст |
| `--font-size-control` | `0.75rem` | 12 | 13.5 | контролы, имена файлов, моно-подписи кнопок |
| `--font-size-code` | `0.75rem` | 12 | 13.5 | код в дифе и вставках |
| `--font-size-meta` | `0.7188rem` | 11.5 | 12.9 | моно-мета и счётчики |
| `--font-size-gutter` | `0.6875rem` | 11 | 12.4 | гаттеры, пути, моно-подписи |
| `--font-size-badge` | `0.6875rem` | 11 | 12.4 | Бейджи и счётчики |
| `--font-size-scope` | `0.6875rem` | 11 | 12.4 | кикеры и метки области |
| `--font-size-tag` | `0.6875rem` | 11 | 12.4 | тег области в дереве и шапке карточки |
| `--font-size-stop-mark` | `0.625rem` | 10 | 11.3 | Компактная метка; исключение для глифа |
| `--font-size-avatar-glyph` | `0.5625rem` | 9 | 10.1 | инициалы в аватаре (глиф) |

## Типографика Arcanum

Обе палитры Arcanum используют эту шкалу. Код и гаттер при базе 16px имеют высоту строки 17px; текст интерфейса — 14px. Геометрия задаётся токенами CSS.

| Токен | rem | px при M | px при L | Роль |
|---|---|---|---|---|
| `--font-size-pr-title-overview` | `1.5rem` | 24 | 27 | Заголовок обзора |
| `--font-size-pr-title` | `1.375rem` | 22 | 24.8 | Заголовок PR |
| `--font-size-screen-title` | `1.1875rem` | 19 | 21.4 | заголовки экранов |
| `--font-size-close-glyph` | `1.125rem` | 18 | 20.3 | крестик закрытия панели (глиф) |
| `--font-size-stop-title-high` | `1.0625rem` | 17 | 19.1 | Заголовок блока |
| `--font-size-stop-title` | `0.9688rem` | 15.5 | 17.4 | Заголовок блока |
| `--font-size-section-title` | `0.9688rem` | 15.5 | 17.4 | заголовки секций |
| `--font-size-input` | `0.875rem` | 14 | 15.8 | Поля ввода |
| `--font-size-body` | `0.875rem` | 14 | 15.8 | Пояснения |
| `--font-size-ui` | `0.875rem` | 14 | 15.8 | Текст интерфейса |
| `--font-size-secondary` | `0.8125rem` | 13 | 14.6 | вторичный UI-текст |
| `--font-size-control` | `0.8125rem` | 13 | 14.6 | контролы, имена файлов, моно-подписи кнопок |
| `--font-size-code` | `0.75rem` | 12 | 13.5 | код в дифе и вставках |
| `--font-size-meta` | `0.8125rem` | 13 | 14.6 | моно-мета и счётчики |
| `--font-size-gutter` | `0.75rem` | 12 | 13.5 | гаттеры, пути, моно-подписи |
| `--font-size-badge` | `0.6875rem` | 11 | 12.4 | Бейджи и счётчики |
| `--font-size-scope` | `0.6875rem` | 11 | 12.4 | кикеры и метки области |
| `--font-size-tag` | `0.6875rem` | 11 | 12.4 | тег области в дереве и шапке карточки |
| `--font-size-stop-mark` | `0.625rem` | 10 | 11.3 | Компактная метка; исключение для глифа |
| `--font-size-avatar-glyph` | `0.5625rem` | 9 | 10.1 | инициалы в аватаре (глиф) |

## Цветовые токены

Таблица — действующие значения четырёх палитр. Тест проверяет полный состав и значения; при изменении CSS обновляется эта таблица.

| Токен | Dark | Light | Arcanum dark | Arcanum light |
|---|---|---|---|---|
| `--surface-app` | `#0d0e10` | `#f6f7f9` | `#2d2c33` | `#ffffff` |
| `--surface-panel` | `#121315` | `#ffffff` | `#2d2c33` | `#ffffff` |
| `--surface-panel-deep` | `#16171b` | `#fdfdfd` | `#35343b` | `#fafafa` |
| `--surface-diff-card` | `#111214` | `#ffffff` | `#2d2c33` | `#ffffff` |
| `--surface-card-header` | `#1a1b1e` | `#f2f3f6` | `#424248` | `#f2f2f2` |
| `--surface-input` | `#1b1e24` | `#f3f4f8` | `#2d2c33` | `#ffffff` |
| `--surface-chip` | `#18191d` | `#fafbfc` | `#35343b` | `#fafafa` |
| `--surface-control` | `#1d2020` | `#e8eaef` | `#424248` | `#f2f2f2` |
| `--surface-raised` | `#212429` | `#ffffff` | `#35343b` | `#ffffff` |
| `--surface-popover` | `#262b34` | `#e2e5ea` | `#424248` | `#ffffff` |
| `--surface-selected` | `#2d323b` | `#e2e5ea` | `#57565c` | `#f2f2f2` |
| `--surface-offline-banner` | `#1b1c20` | `#f3f4f8` | `#35343b` | `#fafafa` |
| `--surface-command` | `#0f1012` | `#f0f1f5` | `#2d2c33` | `#ffffff` |
| `--ownership-mine-surface` | `#182e20` | `#e4f6ea` | `rgba(91, 181, 87, 0.15)` | `rgba(59, 201, 53, 0.15)` |
| `--surface-digest-footer` | `#1b171b` | `#feefec` | `#402f35` | `#ffe6e6` |
| `--overlay-dialog` | `rgba(7, 8, 9, 0.66)` | `rgba(236, 238, 242, 0.7)` | `rgba(7, 8, 9, 0.66)` | `rgba(0, 0, 0, 0.4)` |
| `--surface-toolbar` | `rgba(13, 14, 16, 0.92)` | `rgba(246, 247, 249, 0.92)` | `rgba(45, 44, 51, 0.96)` | `rgba(255, 255, 255, 0.96)` |
| `--pr-comments-overlay` | `rgba(8, 9, 10, 0.55)` | `rgba(236, 238, 242, 0.6)` | `rgba(8, 9, 10, 0.55)` | `rgba(0, 0, 0, 0.4)` |
| `--pr-comments-draft-surface` | `#181510` | `#fffaec` | `rgba(255, 203, 0, 0.1)` | `rgba(255, 219, 77, 0.1)` |
| `--comment-edit-surface` | `#161926` | `#f0f1ff` | `var(--accent-surface)` | `var(--accent-surface)` |
| `--pr-comments-published-chip-surface` | `#23252f` | `#e8eaef` | `#23252f` | `#f2f2f2` |
| `--comment-edit-chip-surface` | `#262e4a` | `#dfe2fa` | `var(--accent-surface-alt)` | `var(--accent-surface-alt)` |
| `--pr-comments-delete-surface` | `#1f100e` | `#feecea` | `var(--error-surface)` | `var(--error-surface)` |
| `--surface-hover` | `#262b34` | `#e2e5ea` | `#424248` | `#f2f2f2` |
| `--surface-pressed` | `#333741` | `#dadee4` | `#57565c` | `#e5e5e5` |
| `--surface-pressed-deep` | `#434954` | `#c8cdd5` | `#68676d` | `#d9d9d9` |
| `--surface-button` | `#333741` | `#ffffff` | `#424248` | `#ffffff` |
| `--surface-button-hover` | `#434954` | `#eef0f4` | `#505056` | `#f2f2f2` |
| `--surface-button-pressed` | `#4a515c` | `#e2e5ea` | `#57565c` | `#e5e5e5` |
| `--surface-danger-button` | `#3a1f1e` | `#f8d9d7` | `#3a1f1e` | `#ffe6e6` |
| `--surface-danger-button-hover` | `#4a2725` | `#f2c9c6` | `#4a2725` | `#ffd9d9` |
| `--surface-danger-button-pressed` | `#5c3230` | `#e0a39f` | `#5c3230` | `#ffcdcc` |
| `--surface-code-inset` | `#090a0c` | `#f3f4f6` | `#35343b` | `#fafafa` |
| `--surface-code-inline` | `#23272d` | `#e8eaee` | `#424248` | `#f2f2f2` |
| `--border-hairline` | `#24292f` | `#e4e6eb` | `#45444b` | `#e5e5e5` |
| `--border-hairline-strong` | `#2c3038` | `#e0e2e7` | `#505056` | `#d9d9d9` |
| `--border-hairline-soft` | `#23272d` | `#e8eaee` | `#45444b` | `#e5e5e5` |
| `--border-standard` | `#333741` | `#dadee4` | `#57565c` | `#d9d9d9` |
| `--border-control` | `#363b44` | `#d2d5dd` | `#57565c` | `#cccccc` |
| `--border-chip` | `#3a404a` | `#c9ced6` | `#57565c` | `#cccccc` |
| `--border-divider` | `#3a3f48` | `#cdd3da` | `#57565c` | `#d9d9d9` |
| `--border-strong` | `#434954` | `#c8cdd5` | `#68676d` | `#cccccc` |
| `--border-strong-lifted` | `#4a515c` | `#bbc2cb` | `#77767c` | `#b3b3b3` |
| `--ownership-mine-border` | `#24422f` | `#cde9d8` | `rgba(91, 181, 87, 0.3)` | `rgba(59, 201, 53, 0.3)` |
| `--border-raised-bar` | `#4c5466` | `#b7bec8` | `#57565c` | `#cccccc` |
| `--border-raised-dialog` | `#4e5666` | `#bfc6cf` | `#57565c` | `#cccccc` |
| `--border-raised-popover` | `#515a6a` | `#b0b7c1` | `#68676d` | `#b3b3b3` |
| `--pr-comments-draft-border` | `#33301f` | `#ecdfc4` | `rgba(255, 203, 0, 0.2)` | `rgba(255, 219, 77, 0.3)` |
| `--comment-edit-border` | `#3c4560` | `#c3c7e6` | `var(--accent-border)` | `var(--accent-border)` |
| `--pr-comments-delete-border` | `#4a2f2d` | `#f0d2d0` | `var(--error-border)` | `var(--error-border)` |
| `--border-danger-button` | `#5c3230` | `#e0a39f` | `#5c3230` | `#ffb4b3` |
| `--border-button` | `#4a515c` | `#8b94a3` | `#68676d` | `#b3b3b3` |
| `--border-switch-track` | `#343941` | `#c8cdd5` | `#57565c` | `#cccccc` |
| `--pr-comments-editor-border` | `#535b68` | `#b1b8c2` | `#535b68` | `#b3b3b3` |
| `--text-primary` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` |
| `--text-primary-soft` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` |
| `--text-secondary` | `#ffffff` | `#000000` | `#c0bfc2` | `#595959` |
| `--text-secondary-dim` | `#ffffff` | `#00000a` | `#c0bfc2` | `#595959` |
| `--text-body` | `#ffffff` | `#00000a` | `#e0e0e1` | `#262626` |
| `--text-muted` | `#ffffff` | `#000813` | `#b1b0b4` | `#666666` |
| `--text-muted-dim` | `#ffffff` | `#0c1420` | `#b1b0b4` | `#666666` |
| `--text-link-muted` | `#b6bcc6` | `#3c424c` | `#b1b0b4` | `#666666` |
| `--text-dim` | `#e7f1ff` | `#19212d` | `#b1b0b4` | `#666666` |
| `--text-dim-strong` | `#dae4f3` | `#28303b` | `#c0bfc2` | `#595959` |
| `--text-gutter` | `#6e7580` | `#9198a2` | `#e0e0e1` | `#595959` |
| `--pr-comments-published-chip-text` | `#eef8ff` | `#0c1420` | `#eef8ff` | `#262626` |
| `--comment-edit-chip-text` | `#9ea8ff` | `#4c5ae0` | `var(--accent-text)` | `var(--accent-text)` |
| `--pr-comments-body-text` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` |
| `--chat-body-text` | `#ffffff` | `#000000` | `#e0e0e1` | `#262626` |
| `--text-danger-button` | `#f2c4c0` | `#7a2622` | `#f2c4c0` | `#6c2024` |
| `--text-button` | `#ffffff` | `#0c1420` | `#ffffff` | `#262626` |
| `--pr-comments-note-icon` | `#9c8760` | `#7f6c3e` | `#b3a17e` | `#6c603b` |
| `--accent` | `#7f8cff` | `#5a68e8` | `#5282ff` | `#4768c2` |
| `--accent-hover` | `#8f9bff` | `#4c5ae0` | `#7098ff` | `#3f5799` |
| `--accent-hover-strong` | `#b3bcff` | `#3a47bd` | `#8eadff` | `#384670` |
| `--accent-pressed` | `#6b78e6` | `#4353cf` | `#4778ef` | `#3c4f85` |
| `--accent-ink` | `#101223` | `#ffffff` | `#0b1020` | `#ffffff` |
| `--accent-text` | `#aeb6ff` | `#4350cc` | `#82a5ff` | `#3f5799` |
| `--accent-text-soft` | `#c9cdf0` | `#3a4390` | `#a3bbff` | `#3f5799` |
| `--accent-text-bright` | `#dfe2ff` | `#262f8a` | `#cfddff` | `#384670` |
| `--accent-text-queued` | `#7d83ad` | `#6b719f` | `#a3abc2` | `#595959` |
| `--accent-surface` | `#131424` | `#f0f1fc` | `#303850` | `#eef3ff` |
| `--accent-surface-alt` | `#1a1b2d` | `#f0f1ff` | `#303850` | `#e5ecff` |
| `--accent-border` | `#262a45` | `#dfe2fa` | `#465d90` | `#cbdaff` |
| `--accent-selection` | `rgba(127, 140, 255, 0.13)` | `rgba(90, 104, 232, 0.12)` | `rgba(82, 130, 255, 0.15)` | `rgba(82, 130, 255, 0.15)` |
| `--accent-text-selection` | `rgba(127, 140, 255, 0.28)` | `rgba(90, 104, 232, 0.22)` | `rgba(82, 130, 255, 0.3)` | `rgba(82, 130, 255, 0.3)` |
| `--surface-thread-line` | `rgba(127, 140, 255, 0.07)` | `rgba(90, 104, 232, 0.08)` | `rgba(82, 130, 255, 0.07)` | `rgba(82, 130, 255, 0.1)` |
| `--attention` | `#e2954c` | `#d8791c` | `#ffcb00` | `#ffdb4d` |
| `--attention-text` | `#e2b878` | `#9d6410` | `#ffdb4c` | `#6c603b` |
| `--attention-text-dim` | `#c9a464` | `#7f5612` | `#ffd01a` | `#6c603b` |
| `--attention-text-soft` | `#e6d7bd` | `#3f3014` | `#e0e0e1` | `#262626` |
| `--attention-surface` | `#241f14` | `#fbf3df` | `rgba(255, 203, 0, 0.15)` | `rgba(255, 219, 77, 0.2)` |
| `--attention-surface-alt` | `#231e14` | `#fffaec` | `rgba(255, 203, 0, 0.1)` | `rgba(255, 219, 77, 0.1)` |
| `--attention-border` | `#4a4230` | `#d9c9a4` | `rgba(255, 203, 0, 0.3)` | `rgba(255, 219, 77, 0.5)` |
| `--attention-border-alt` | `#3d3524` | `#ecdfc4` | `rgba(255, 203, 0, 0.2)` | `rgba(255, 219, 77, 0.3)` |
| `--attention-border-strong` | `#6b5b39` | `#bba777` | `rgba(255, 203, 0, 0.5)` | `#c0a645` |
| `--attention-button` | `#e2954c` | `#b8641c` | `#ffcb00` | `#ffdb4d` |
| `--attention-button-ink` | `#1b1508` | `#ffffff` | `#2d2c33` | `#262626` |
| `--attention-button-hover` | `#eaa15c` | `#c56d1f` | `#ffd01a` | `#ffdf5f` |
| `--attention-button-pressed` | `#d1873f` | `#a85a14` | `#e9ba04` | `#eac94a` |
| `--attention-label` | `#9c8760` | `#7f6c3e` | `#ffdb4c` | `#6c603b` |
| `--attention-body` | `#d8c9ad` | `#5a4a24` | `#e0e0e1` | `#262626` |
| `--draft-field-surface` | `#1a1510` | `#fffaec` | `rgba(255, 203, 0, 0.1)` | `rgba(255, 219, 77, 0.1)` |
| `--draft-saved` | `#5e8a6d` | `#268f52` | `#8bbe9d` | `#347b34` |
| `--tag-pci-border` | `#3d3a2c` | `#e9dfc3` | `rgba(255, 203, 0, 0.3)` | `rgba(255, 219, 77, 0.5)` |
| `--surface-tour-card` | `#1f242b` | `#ffffff` | `#35343b` | `#ffffff` |
| `--tour-skip-underline` | `#5e6673` | `#a1a7b3` | `#5e6673` | `#999999` |
| `--diff-add-bg` | `rgba(66, 160, 110, 0.11)` | `rgba(38, 143, 82, 0.10)` | `rgba(151, 234, 151, 0.1)` | `rgba(151, 234, 151, 0.3)` |
| `--diff-add-text` | `#6cc38f` | `#268f52` | `#50c987` | `#347b34` |
| `--diff-add-text-strong` | `#86d9a8` | `#1e7f47` | `#68d99b` | `#336b34` |
| `--diff-add-gutter` | `#5f9478` | `#3a835d` | `#e0e0e1` | `#595959` |
| `--diff-del-bg` | `rgba(224, 108, 102, 0.10)` | `rgba(207, 70, 64, 0.09)` | `rgba(251, 175, 175, 0.1)` | `rgba(251, 175, 175, 0.3)` |
| `--diff-del-text` | `#dd8a84` | `#c94842` | `#ff6969` | `#c0100f` |
| `--diff-del-text-strong` | `#e8a29c` | `#c33f39` | `#ff9494` | `#961819` |
| `--diff-del-gutter` | `#a0736e` | `#a45a54` | `#e0e0e1` | `#595959` |
| `--diff-add-gutter-bg` | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | `#425247` | `#cbf5cb` |
| `--diff-del-gutter-bg` | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | `#56464c` | `#fdd7d7` |
| `--read-fill` | `#3a8f66` | `#2f8557` | `#3a8f66` | `#347b34` |
| `--viewed-surface` | `#1d3022` | `#e8f7ec` | `rgba(91, 181, 87, 0.15)` | `rgba(59, 201, 53, 0.15)` |
| `--viewed-border` | `#25422f` | `#cde9d8` | `rgba(91, 181, 87, 0.3)` | `rgba(59, 201, 53, 0.3)` |
| `--viewed-hover-surface` | `#25422f` | `#cde9d8` | `rgba(91, 181, 87, 0.2)` | `rgba(59, 201, 53, 0.2)` |
| `--viewed-hover-border` | `#3a8f66` | `#2f8557` | `#5bb557` | `#347b34` |
| `--success-surface` | `#1f3d2c` | `#bfe4cd` | `rgba(91, 181, 87, 0.2)` | `rgba(59, 201, 53, 0.2)` |
| `--success-text` | `#86d9a8` | `#1e7f47` | `#8ccb89` | `#336b34` |
| `--read-fill-hover` | `rgba(58, 143, 102, 0.25)` | `rgba(47, 133, 87, 0.25)` | `rgba(58, 143, 102, 0.25)` | `rgba(59, 201, 53, 0.25)` |
| `--read-border` | `#3f7a5a` | `#46a672` | `#3f7a5a` | `#347b34` |
| `--error` | `#e0736c` | `#cf4640` | `#ef7f7d` | `#c0100f` |
| `--error-text` | `#d99a95` | `#b5423c` | `#f3a4a2` | `#961819` |
| `--error-surface` | `#1f1719` | `#feecea` | `#493036` | `#ffe6e6` |
| `--error-border` | `#3d2a2c` | `#f0d2d0` | `#653539` | `#ffb4b3` |
| `--code-text` | `#ffffff` | `#000000` | `#e0e0e1` | `#000000` |
| `--code-text-del` | `#d5c0be` | `#87332e` | `#e0e0e1` | `#000000` |
| `--surface-diff-empty` | `#0b0c0e` | `#f3f4f6` | `#2d2c33` | `#ffffff` |
| `--surface-diff-gap` | `#1a1b1e` | `#f2f3f6` | `#35343b` | `#f1f8ff` |
| `--diff-add-word` | `rgba(66, 160, 110, 0.22)` | `rgba(38, 143, 82, 0.22)` | `rgba(151, 234, 151, 0.1)` | `rgba(151, 234, 151, 0.6)` |
| `--diff-del-word` | `rgba(224, 108, 102, 0.22)` | `rgba(207, 70, 64, 0.22)` | `rgba(251, 175, 175, 0.1)` | `rgba(251, 175, 175, 0.6)` |
| `--diff-trailing-space` | `rgba(224, 108, 102, 0.25)` | `rgba(207, 70, 64, 0.25)` | `rgba(224, 108, 102, 0.25)` | `rgba(255, 4, 0, 0.2)` |
| `--row-hover` | `rgba(255, 255, 255, 0.04)` | `rgba(20, 24, 32, 0.04)` | `rgba(255, 255, 255, 0.04)` | `rgba(0, 0, 0, 0.05)` |
| `--checkbox-border` | `#5e6673` | `#a1a7b3` | `#5e6673` | `#999999` |
| `--read-box-border` | `#515a65` | `#afb5c0` | `#515a65` | `#b3b3b3` |
| `--stop-mark-text` | `#7b8390` | `#828894` | `#a3a2a7` | `#595959` |
| `--stop-mark-border` | `#2c3038` | `#e0e2e7` | `#2c3038` | `#e5e5e5` |
| `--tree-read-color` | `#848b97` | `#70767f` | `#9e9da3` | `#767676` |
| `--border-button-outline` | `#7b8390` | `#828894` | `#7b8390` | `#999999` |
| `--border-button-outline-hover` | `#dae4f3` | `#28303b` | `#dae4f3` | `#404040` |
| `--syntax-keyword` | `#9aa6ff` | `#5462e3` | `#c586c0` | `#af00db` |
| `--syntax-string` | `#d3b183` | `#8a5f1c` | `#ce9178` | `#a31515` |
| `--syntax-comment` | `#8a919c` | `#646b76` | `#8a9b83` | `#008000` |
| `--syntax-decorator` | `#d99a5c` | `#b46a1f` | `#4ec9b0` | `#267f99` |
| `--syntax-property` | `#d3b183` | `#8a5f1c` | `#569cd6` | `#0451a5` |
| `--syntax-number` | `#d3b183` | `#8a5f1c` | `#b5cea8` | `#098658` |
| `--syntax-variable` | `currentColor` | `currentColor` | `#4ec9b0` | `#001080` |
| `--syntax-type` | `#9aa6ff` | `#5462e3` | `#4ec9b0` | `#267f99` |
| `--syntax-function` | `currentColor` | `currentColor` | `#dcdcaa` | `#795e26` |
| `--tier-medium` | `#7b87a0` | `#7b8390` | `#7b87a0` | `#737373` |
| `--tier-low` | `#434954` | `#c8cdd5` | `#434954` | `#cccccc` |
| `--tier-unfilled` | `#2a2e4a` | `#dde0f8` | `#2a2e4a` | `#e5e5e5` |
| `--hatch` | `repeating-linear-gradient(115deg, #515863 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #b1b8c2 0 3px, #e9ecef 3px 6px)` | `repeating-linear-gradient(115deg, #515863 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #b3b3b3 0 3px, #f2f2f2 3px 6px)` |
| `--hatch-sidebar` | `repeating-linear-gradient(115deg, #414851 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #c5cad2 0 3px, #e9ecef 3px 6px)` | `repeating-linear-gradient(115deg, #414851 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #cccccc 0 3px, #f2f2f2 3px 6px)` |
| `--hatch-footer` | `repeating-linear-gradient(115deg, #23272d 0 3px, #1a1b1e 3px 6px)` | `repeating-linear-gradient(115deg, #e8eaee 0 3px, #f2f3f6 3px 6px)` | `repeating-linear-gradient(115deg, #23272d 0 3px, #1a1b1e 3px 6px)` | `repeating-linear-gradient(115deg, #e5e5e5 0 3px, #fafafa 3px 6px)` |
| `--hover-selected` | `#3e444f` | `#dadee4` | `#68676d` | `#e5e5e5` |
| `--surface-segment-active` | `#434954` | `#ffffff` | `#57565c` | `#ffffff` |
| `--text-on-segment-active` | `#ffffff` | `#000000` | `#ffffff` | `#262626` |
| `--shadow-segment-active` | `none` | `0 1px 2px rgba(20, 24, 32, 0.18), 0 0 0 1px rgba(20, 24, 32, 0.08)` | `none` | `0 1px 2px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05)` |
| `--shadow-button` | `none` | `0 1px 2px rgba(20, 24, 32, 0.12)` | `none` | `0 1px 2px rgba(0, 0, 0, 0.1)` |
| `--surface-chip-active` | `#1e2240` | `#e8eaff` | `#303e62` | `#e5ecff` |
| `--border-chip-active` | `#3f4880` | `#b9c0f4` | `#465d90` | `#cbdaff` |
| `--text-chip-active` | `#c3caff` | `#2b3690` | `#cad8ff` | `#3f5799` |
| `--surface-chip-active-hover` | `#262c52` | `#dfe2fb` | `#394c75` | `#dce6ff` |
| `--surface-chip-active-pressed` | `#2e3566` | `#d3d8f8` | `#425a88` | `#cbdaff` |
| `--focus-ring-color` | `#7f8cff` | `#5a68e8` | `#5282ff` | `#5282ff` |
| `--text-on-selected` | `#ffffff` | `#000000` | `#ffffff` | `#262626` |
| `--text-separator` | `#7b8390` | `#828894` | `#b1b0b4` | `#666666` |
| `--shadow-line-comment` | `0 1px 4px rgba(0, 0, 0, 0.45)` | `0 1px 4px rgba(20, 24, 32, 0.1)` | `0 1px 4px rgba(0, 0, 0, 0.45)` | `0 1px 4px rgba(0, 0, 0, 0.1)` |
| `--shadow-popover` | `0 8px 24px rgba(0, 0, 0, 0.5)` | `0 8px 24px rgba(20, 24, 32, 0.12)` | `0 8px 24px rgba(0, 0, 0, 0.5)` | `0 8px 24px rgba(0, 0, 0, 0.15)` |
| `--shadow-menu` | `0 16px 40px rgba(0, 0, 0, 0.6)` | `0 16px 40px rgba(20, 24, 32, 0.16)` | `0 16px 40px rgba(0, 0, 0, 0.6)` | `0 16px 40px rgba(0, 0, 0, 0.15)` |
| `--shadow-floating` | `0 16px 44px rgba(0, 0, 0, 0.6)` | `0 16px 44px rgba(20, 24, 32, 0.16)` | `0 16px 44px rgba(0, 0, 0, 0.6)` | `0 16px 44px rgba(0, 0, 0, 0.15)` |
| `--shadow-dialog` | `0 24px 64px rgba(0, 0, 0, 0.65)` | `0 24px 64px rgba(20, 24, 32, 0.18)` | `0 24px 64px rgba(0, 0, 0, 0.65)` | `0 24px 64px rgba(0, 0, 0, 0.2)` |
| `--shadow-pr-comments` | `0 18px 50px rgba(0, 0, 0, 0.55)` | `0 18px 50px rgba(20, 24, 32, 0.14)` | `0 18px 50px rgba(0, 0, 0, 0.55)` | `0 18px 50px rgba(0, 0, 0, 0.15)` |
| `--shadow-tour-card` | `0 20px 52px rgba(0, 0, 0, 0.62)` | `0 20px 52px rgba(20, 24, 32, 0.18)` | `0 20px 52px rgba(0, 0, 0, 0.62)` | `0 20px 52px rgba(0, 0, 0, 0.2)` |
| `--shadow-tour-ring` | `0 0 0 3px rgba(127, 140, 255, 0.13), 0 0 26px rgba(127, 140, 255, 0.16)` | `0 0 0 3px rgba(90, 104, 232, 0.12), 0 0 26px rgba(90, 104, 232, 0.16)` | `0 0 0 3px rgba(127, 140, 255, 0.13), 0 0 26px rgba(127, 140, 255, 0.16)` | `0 0 0 3px rgba(82, 130, 255, 0.15), 0 0 26px rgba(82, 130, 255, 0.2)` |
| `--pr-comments-list-fade` | `linear-gradient(180deg, rgba(17, 18, 20, 0) 0%, #111214 92%)` | `linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #ffffff 92%)` | `linear-gradient(180deg, rgba(45, 44, 51, 0) 0%, #2d2c33 92%)` | `linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #ffffff 92%)` |

## Контраст

Матрица в `packages/ui/src/styles/tokens.test.ts` проверяет текст на соответствующих поверхностях с учётом прозрачных заливок. Для Arcanum основной порог — 4.5:1. В тёмной Arcanum разрешены два исключения для красного маркера удаления `#ff6969`: 3.96:1 на строке удаления и 3.55:1 в шапке файла. Это знаки и счётчики; текст удалённого кода использует отдельный `--code-text-del` и проходит 4.5:1.

Исключения базовых dark/light перечислены в матрице теста и не распространяются на Arcanum. Добавление темы или роли требует полного набора токенов и проверки контраста; общий порог не снижается ради отдельного цвета.
