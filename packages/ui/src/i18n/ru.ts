import { formatCount, formatDecimal, plural } from './format.js';

export const overviewRu = { sourcesHint: 'Источники подтверждают описание. Все изменённые файлы — в маршруте и разделе «Все изменения».', diagramLimited: 'Часть схемы не подтверждена доступным кодом. Ограничения указаны в основаниях схемы.', legacyDetails: 'Готовность прежнего формата не измерялась. Сохранённые материалы доступны; обновление запускается вручную.', revision: 'Версия кода' };

export const preparationRu = { title: 'Подготовка разбора', planning: 'Читаю изменения, готовлю описание, архитектуру и блоки', preparing: 'Готовлю пояснения', ready: 'Разбор готов', partial: 'Разбор подготовлен частично', failed: 'Подготовка не завершена', cancelled: 'Подготовка остановлена', idle: 'Разбор ещё не подготовлен', legacy: 'Сохранённый разбор · общий прогресс недоступен', previous: 'Предыдущий разбор', latest: 'Открыть новый разбор', offline: 'Агент отключён. Готовые материалы доступны, подготовка продолжится после подключения.', blocks: 'Блоки', files: 'Файлы', diagram: 'Схема', description: 'Описание', pending: 'ожидает', unavailable: 'недоступна', not_applicable: 'не требуется', done: 'готово', cancel: 'Остановить', stage: 'Сначала описание, архитектура и блоки, затем пояснения к файлам', missing: 'Осталось подготовить', units: 'частей', overviewTitle: 'Описание ПРа', overviewPending: 'Готовлю описание проблемы и решения', diagramTitle: 'Архитектура и место ПРа', diagramPending: 'Схема появится вместе с описанием и блоками', routeTitle: 'Маршрут по изменениям', routePending: 'Определяю смысловые блоки и порядок файлов', diagramNotNeeded: 'Схема не требуется: ', retryDiagram: 'Повторить схему', connectToRetry: 'Подключите агента, чтобы повторить подготовку схемы.', overviewSources: 'Источники описания', fileCount: 'файлов' };

/**
 * Русский словарь — источник истины по составу ключей: тип `Dictionary` выводится из него,
 * и английский словарь обязан совпасть с ним ключ в ключ и сигнатура в сигнатуру.
 *
 * Ключ — плоская строка с точечным префиксом по области экрана (`app.`, `topbar.`, `palette.`…).
 * Значение — строка либо функция от параметров: порядок слов и словоформы у языков разные,
 * склеивать перевод из кусочков на стороне компонента нельзя.
 */

const num = (value: number): string => formatCount(value, 'ru');
/** Дробное число: килобайты и мегабайты размера картинки. */
const dec = (value: number): string => formatDecimal(value, 'ru');
/** Русские словоформы: `other` совпадает с `many` — «5 файлов». */
const form = (value: number, one: string, few: string, many: string): string =>
    plural(value, { one, few, many, other: many }, 'ru');

export const ru = {
    'app.name': 'Devflow Diff Explain',
    'app.noToken.text': 'Открой UI ссылкой из запуска скилла Devflow Diff Explain или сервера — в ней токен доступа.',
    'app.noToken.hint': 'http://127.0.0.1:<порт>/#t=<токен>',
    'app.closeChat': 'Закрыть чат',

    'command.hint': 'Запусти в любом харнесе — сессия станет воркером.',
    'command.copy': 'Скопировать',
    'command.copied': 'Скопировано',
    'command.copied.status': 'Команда скопирована',
    'command.manual': 'Команда выделена — скопируй вручную',
    'command.aria': 'Команда запуска Шерпы',

    'chat.aria': 'Чат с агентом',
    'chat.notes': (notes: number) => `Заметки ${num(notes)}`,
    'chat.history.loading': 'Загружаю историю чата…',
    'chat.history.failed': (error: string) => `Не удалось загрузить историю чата: ${error}. Повторяю запрос…`,
    'chat.disconnected': 'Агент отключён. Новые вопросы недоступны.',
    'chat.anchor.remove': 'Убрать диапазон из контекста',
    'chat.selection.before': 'До',
    'chat.selection.after': 'После',
    'chat.selection.code': 'Выделенный код',
    'chat.selection.unavailable': 'Выбранные строки недоступны. Раскройте код и выделите их снова.',
    'chat.composer.aria': 'Вопрос агенту',
    'chat.composer.placeholder': 'Спросить агента',
    'chat.composer.hint.send': 'Enter — отправить',
    'chat.composer.hint.newline': 'Shift+Enter — новая строка',
    'chat.composer.send': 'Отправить',
    'chat.queue.route': 'Генерирую маршрут · ваш вопрос следующий',
    'chat.queue.busy': 'Агент занят · ваш вопрос следующий',
    'chat.queue.feedback': 'Правит по замечаниям · ваш вопрос следующий',
    'chat.note.pinned': (anchor: string) => `◆ Закреплено заметкой у ${anchor}`,
    'chat.note.lostAnchor': (anchor: string) => `якорь потерян после пуша · ${anchor}`,
    'chat.answering': 'Отвечаю',
    'chat.answering.long': 'Всё ещё работаю',
    'chat.stop': 'Остановить',
    'chat.retry': 'Повторить',
    'chat.answer.missing': 'Ответ не получен.',
    'chat.answer.cancelled': 'Вопрос отменён.',
    'chat.cancelledLease': 'Агент ещё занят отменённой задачей — узнает об отмене при следующем обращении',
    'chat.empty': 'Спросите о PR или выделите строки и спросите о них',
    'chat.worker.never': 'не подключён',

    'chat.ask.placeRanges':
        'Разложи по остановкам маршрута диапазоны, которые модель не разместила. Для каждого — к какой остановке он относится и почему, или что это отдельная тема.',
    'chat.ask.placeRanges.listed': (list: string) =>
        `Разложи по остановкам маршрута диапазоны, которые модель не разместила: ${list}. Для каждого — к какой остановке он относится и почему, или что это отдельная тема.`,
    'chat.ask.rangesRest': (listed: string, rest: number) => `${listed} и ещё ${num(rest)}`,
    'chat.ask.placeRange.line': (numbers: string, path: string) =>
        `К какой остановке маршрута относится строка ${numbers} в ${path}? Модель её не разместила.`,
    'chat.ask.placeRange.lineRemoved': (numbers: string, path: string) =>
        `К какой остановке маршрута относится удалённая строка ${numbers} в ${path}? Модель её не разместила.`,
    'chat.ask.placeRange.lines': (numbers: string, path: string) =>
        `К какой остановке маршрута относятся строки ${numbers} в ${path}? Модель их не разместила.`,
    'chat.ask.placeRange.linesRemoved': (numbers: string, path: string) =>
        `К какой остановке маршрута относятся удалённые строки ${numbers} в ${path}? Модель их не разместила.`,
    'chat.ask.rangeRemoved': (numbers: string) => `${numbers} (удалённые)`,
    'chat.example.risky': 'Какие изменения здесь самые рискованные?',
    'chat.example.manual': 'Что проверить вручную перед шипом?',
    'chat.example.edgeCases': 'Есть ли в диффе пропущенные крайние случаи?',
    'chat.ask.selectionDisabled': 'Переподключите агента, чтобы спросить о выделении',
    'chat.ask.rangesDisabled': 'Переподключите агента, чтобы спросить об этих строках',
    'chat.ask.answerInChat': 'ответ придёт в чат, маршрут не изменится',
    'thread.note.lostDraft': 'якорь потерян — комментарий не к чему привязать',
    'thread.note.lostAnchor': 'якорь потерян — в коде этой итерации заметки нет',
    'diff.worker.closed': 'дифф-воркер закрыт',
    'diff.worker.crashed': 'дифф-воркер упал',
    'diff.worker.cloneFailed': 'ответ дифф-воркера не поддался structured clone',
    'diff.elsewhere': (changed: number) =>
        `${num(changed)} ${form(changed, 'изменённая строка', 'изменённые строки', 'изменённых строк')} — в других остановках`,
    'diff.oneSided': (kind: string) => `во всю ширину — в этом файле только ${kind}`,
    'diff.oneSided.additions': 'добавления',
    'diff.oneSided.deletions': 'удаления',
    'diff.gap.toEndOfFile': 'неизменённое до конца файла',
    'diff.gap.unchanged': (hidden: number) =>
        `${num(hidden)} ${form(hidden, 'неизменённая строка', 'неизменённые строки', 'неизменённых строк')}`,
    'diff.gap.both': (unchanged: string, elsewhere: string) => `${unchanged} и ${elsewhere}`,
    'diff.gap.expandFailed': 'не удалось догрузить · повторить',
    'diff.gap.loading': 'догружаю…',
    'diff.gap.expandUp': (step: number, base: string) => `+${num(step)} ${form(step, 'строка', 'строки', 'строк')} вверх · ${base}`,
    'diff.gap.expandDown': (step: number, base: string) => `+${num(step)} ${form(step, 'строка', 'строки', 'строк')} вниз · ${base}`,
    'diff.gap.aria': 'направление раскрытия скрытого контекста',
    'diff.gap.hiddenToEnd': 'строк скрыто до конца файла',
    'diff.gap.hiddenCount': (hidden: number) => `${num(hidden)} ${form(hidden, 'строка скрыта', 'строки скрыты', 'строк скрыто')}`,
    'diff.gap.loadAll': (amount: number, hidden: string) => `догрузить ${num(amount)} ${form(amount, 'строку', 'строки', 'строк')}, ${hidden}`,
    'diff.gap.loadUp': (amount: number, hidden: string) => `догрузить ${num(amount)} ${form(amount, 'строку', 'строки', 'строк')} вверх, ${hidden}`,
    'diff.gap.loadDown': (amount: number, hidden: string) => `догрузить ${num(amount)} ${form(amount, 'строку', 'строки', 'строк')} вниз, ${hidden}`,
    'diff.row.tabs': 'табы показаны четырьмя пробелами',
    'diff.row.noNewline': ' ⏎ нет перевода строки в конце файла',

    'image.mode.aria': 'Как показывать картинку',
    'image.mode.twoUp': '2-up',
    'image.mode.swipe': 'Swipe',
    'image.mode.onion': 'Onion Skin',
    'image.mode.diff': 'Diff',
    'image.mode.text': 'Текст',
    'image.mode.needBothSides': 'нужны обе стороны',
    'image.mode.noSize': 'нет размера картинки',
    'image.fit.toActual': '1:1',
    'image.fit.toFit': 'Вписать',
    'image.fit.toActualTitle': 'показать в масштабе 1:1',
    'image.fit.toFitTitle': 'вписать в ширину колонки',
    'image.side.before': 'Было',
    'image.side.after': 'Стало',
    'image.side.empty': 'нет',
    'image.download': 'Скачать',
    'image.dimensions': (width: number, height: number) => `${num(width)} × ${num(height)}`,
    'image.size.bytes': (value: number) => `${num(value)} Б`,
    'image.size.kilobytes': (value: number) => `${dec(value)} КБ`,
    'image.size.megabytes': (value: number) => `${dec(value)} МБ`,
    'image.loading': 'загружается…',
    'image.missing': 'картинка недоступна',
    'image.failed': (reason: string) => `не загрузилось: ${reason}`,
    'image.retry': 'Повторить',
    'image.tooLarge': (size: string) => `слишком большая: ${size}`,
    'image.openAtHost': 'Открыть в Аркануме',
    'image.alt.before': (path: string) => `${path} — было`,
    'image.alt.after': (path: string) => `${path} — стало`,
    'image.swipe.aria': 'Разделитель сравнения',
    'image.onion.label': 'Непрозрачность',
    'image.onion.value': (percent: number) => `${num(percent)} %`,
    'image.diff.alt': (path: string) => `${path} — попиксельная разница`,
    'image.diff.busy': 'считаем разницу…',
    'image.diff.noCanvas': 'браузер не дал холст для растеризации',
    'image.diff.failed': (reason: string) => `не удалось посчитать разницу: ${reason}`,
    'image.diff.summary': (percent: number, changed: number, total: number) =>
        `изменено ${dec(percent)} % пикселей (${num(changed)} из ${num(total)})`,
    'image.diff.sizeMismatch': (
        beforeWidth: number,
        beforeHeight: number,
        afterWidth: number,
        afterHeight: number,
    ) =>
        `размеры различаются: ${num(beforeWidth)} × ${num(beforeHeight)} → ${num(afterWidth)} × ${num(afterHeight)}`,

    'error.serverDown': 'Сервер Шерпы не отвечает. Проверь, что он ещё запущен, и повтори.',
    'error.contract': 'Ответ сервера не прошёл проверку контракта — обнови Шерпу.',
    'error.unknown': 'Сервер вернул ошибку без понятного описания. Посмотри его вывод в терминале.',
    'error.invalidState':
        'Сервер прислал состояние, которого этот UI не понимает. Обнови Шерпу — скилл, сервер и UI ставятся одной поставкой.',

    'time.justNow': 'только что',
};

/**
 * Форма словаря: строки остаются строками, функции сохраняют сигнатуру. Английский словарь
 * объявляется этим типом — компилятор ловит пропущенный ключ, лишний ключ и другой набор
 * параметров.
 */
export type Dictionary = {
    [K in keyof typeof ru]: (typeof ru)[K] extends (...args: infer A) => string ? (...args: A) => string : string;
};

export type MessageKey = keyof typeof ru;

export const storyRu = {
        showChange: 'Показать изменение', hideChange: 'Скрыть изменение', fragments: 'Фрагменты кода', hideFragments: 'Скрыть фрагменты',
        before: 'До', after: 'После', retrySource: 'Повторить загрузку', loadingSource: 'Загружаю источник…', binary: 'Бинарный файл',
        returnTo: 'К рассказу', newDiff: 'Открыть новый дифф', legacy: 'Этот рассказ создан без связей тезисов с источниками. Можно обновить его вручную.',
        changeTypes: { add: 'Добавлен', modify: 'Изменён', delete: 'Удалён', move: 'Переименован', copy: 'Скопирован', conflict: 'Конфликт' },
        files: 'Файлы', closeFiles: 'Закрыть файлы', introduction: 'Введение', unavailable: 'Указанные строки недоступны в этой версии файла.',
        story: 'Рассказ', diff: 'Дифф', chat: 'Спросить в чате', contents: 'Содержание',
        loading: 'Загружаю ПР…', planning: 'Готовлю короткое объяснение…', writing: 'Дописываю рассказ. Введение уже можно читать.',
        empty: 'Рассказ ещё не построен.', generate: 'Построить рассказ', retry: 'Повторить построение',
        stale: 'В ПР появились новые изменения. Этот рассказ относится к предыдущей версии.',
        refresh: 'Обновить рассказ', open: 'Открыть в диффе', askSection: 'Вопрос об этом',
        fileSearch: 'Найти файл', noPatch: 'Текстового патча нет.',
        noFiles: 'В этом ПР нет изменённых файлов.', noMatch: 'Подходящих файлов нет.',
        offline: 'Агент не подключён. Сохранённый рассказ и дифф доступны для чтения.',
        pinned: 'Вопрос о показанной версии', refreshContext: 'Обновить контекст', clear: 'Весь рассказ', reconnect: 'Запусти скилл sherpa для этого ПР.',
        theme: 'Тема', language: 'Язык', expand: 'Раскрыть контекст файла', cancel: 'Остановить',
        incomplete: 'Часть диффа не поместилась в контекст агента. Объяснение может быть неполным.',
        unknown: 'Не удалось загрузить данные.', selected: 'Выбраны строки',
} as const;
export const guidedRu = { blocks: 'Разбор по блокам', allChanges: 'Все изменения', arcanum: 'Стиль Arcanum', route: 'Маршрут по ПРу', readingOrder: 'Файлы в порядке чтения', openFile: 'Открыть полный дифф', nextStep: 'Следующий шаг', description: 'Описание ПРа', start: 'К первому блоку', next: 'Дальше', previous: 'Назад', file: 'Полный дифф файла', pending: 'Пояснение готовится. Полный дифф уже можно читать.', failed: 'Пояснение не готово. Полный дифф доступен.', related: 'Связанные файлы', ask: 'Вопрос об этом', block: 'К блоку', retry: 'Повторить пояснение', older: 'Прежний формат рассказа. Обновите, чтобы пройти по файлам.' };

export const flowRu = { orientation: 'Направление схемы', vertical: 'Вертикально', horizontal: 'Горизонтально', continued: 'Продолжение', title: 'Как проходит поток', pending: 'Готовлю схему потока… Рассказ уже можно читать.', sources: 'На чём основана схема', exampleSources: 'Основание примера', example: 'Например', illustrative: 'Иллюстрация, не результат запуска', data: 'данные', control: 'управление', existing: 'Без изменений', added: 'Добавлено', modified: 'Изменено', unknown: 'Не подтверждено', affected: 'Влияет на поведение', renderError: 'Не удалось отобразить архитектурную схему. Описание и дифф доступны. ', retry: 'Повторить схему' };
