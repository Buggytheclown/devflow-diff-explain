import { z } from 'zod';
import { generationSchema } from './preparation.js';

import { agentNoteIdSchema, agentNoteSchema, chatExplanationSchema, chatAnchorSchema, chatExchangeIdSchema, chatExchangeSchema } from './chat.js';
import { distributionVersionSchema } from './distribution.js';
import { draftBufferEntrySchema } from './draft-buffer.js';
import { localeSchema, localeSettingSchema } from './locale.js';
import { prKeySchema } from './manifest.js';
import { workerStatusSchema } from './messages.js';
import {
    commentDraftSchema,
    commentSchema,
    fileContentSchema,
    hostIdSchema,
    iterationSchema,
    lensSchema,
    prDiffSchema,
    prMetaSchema,
    publishResultSchema,
    threadSchema,
    verdictSchema,
} from './review.js';
import { routeProvenanceSchema, routeSnapshotSchema } from './route.js';
import { priorityClassSchema, taskIdSchema, taskTypeSchema } from './task.js';
import { semverSchema } from './version.js';

/**
 * Контракт UI↔сервер (`docs/protocol.md §2`): REST для действий, SSE для реактивности.
 * UI не потребляет ничего, что не прошло эти схемы, — fail-closed с обеих сторон.
 */

/** Жизненный цикл задачи (`docs/protocol.md §5`). Закрытые статусы (`done`/`failed`/`cancelled`) необратимы. */
export const taskStatusSchema = z.enum(['queued', 'leased', 'done', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Задача глазами UI: контрактные поля плюс жизненный цикл.
 * Серверные внутренности (пути контекстных файлов, workerId аренды) наружу не выходят.
 */
export const uiTaskSchema = z.object({
    id: taskIdSchema,
    type: taskTypeSchema,
    priority: priorityClassSchema,
    status: taskStatusSchema,
    /**
     * Воркер держит задачу: `leased`, либо `cancelled` — но воркер об отмене ещё не узнал
     * (узнает при следующем вызове CLI, `docs/protocol.md §5`). Пока true, агент занят этой задачей,
     * даже если её результат никому не нужен — UI не выдаёт сессию за свободную.
     */
    heldByWorker: z.boolean(),
    attempt: z.number().int().min(1),
    /** Промпт задачи — UI показывает его как «что попросили». */
    instructions: z.string(),
    progressText: z.string().nullable(),
    result: z.string().nullable(),
    failReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});
export type UiTask = z.infer<typeof uiTaskSchema>;

/**
 * Доступность канала фидбека. Зависит только от токена Трекера
 * в окружении ревьюера — ни ревью-хост, ни живой воркер не нужны. Едет
 * в снапшоте, чтобы форма объясняла деградацию до отправки (`docs/spec.md`).
 */
export const uiFeedbackAvailabilitySchema = z.object({
    available: z.boolean(),
    /** При `available: false` — почему и куда написать руками; иначе null. */
    reason: z.string().nullable(),
});
export type UiFeedbackAvailability = z.infer<typeof uiFeedbackAvailabilitySchema>;

/**
 * Откуда установлен дистрибутив — от этого зависит, какую команду
 * обновления показать. `arc-checkout` — каталог бандла лежит в чекауте Аркадии
 * (`…/junk/alice/sherpa/skill`), `command` — `arc pull` в корне маунта; `copy` — дистрибутив
 * скопирован куда-то ещё, команды нет: тост просит скопировать каталог заново.
 */
export const uiUpdateInstallSchema = z.object({
    kind: z.enum(['arc-checkout', 'copy']),
    /** Realpath каталога дистрибутива, как его передал CLI (`--install-dir`). */
    dir: z.string().min(1),
    command: z.string().nullable(),
});
export type UiUpdateInstall = z.infer<typeof uiUpdateInstallSchema>;

/**
 * «Доступна новая версия»: результат проверки `version.json` в trunk против зашитой
 * версии сервера. Появляется в снапшоте только когда `latest > current` и версия не отклонена
 * (`settings.updates.dismissedVersion`); «Позже» живёт в памяти вкладки и снапшот не меняет.
 */
export const uiUpdateSchema = z.object({
    current: semverSchema,
    latest: semverSchema,
    releasedAt: distributionVersionSchema.shape.releasedAt,
    whatsNew: distributionVersionSchema.shape.whatsNew,
    install: uiUpdateInstallSchema,
});
export type UiUpdate = z.infer<typeof uiUpdateSchema>;

/**
 * Кап генерации (`docs/spec.md`): бюджет payload урезал контекст скелета. Считает сервер
 * при постановке `route.skeleton` (`payload-budget.ts`); UI пишет в шапке маршрута «план
 * покрывает N файлов из M, K машинных — одной остановкой» и поднимает баннер, если под
 * обрезку попали не-машинные файлы.
 */
export const uiGenerationCapSchema = z.object({
    /** Файлов, чей дифф модель увидела целиком. */
    filesCovered: z.number().int().min(0),
    filesTotal: z.number().int().min(0),
    /** Generated-файлы, отданные модели одной строкой списка, а не диффом. */
    machineFiles: z.number().int().min(0),
    /** Обрезка задела не-машинные файлы — план строился по неполному диффу. */
    truncated: z.boolean(),
});
export type UiGenerationCap = z.infer<typeof uiGenerationCapSchema>;

/**
 * Снапшот состояния PR для UI. Его отдаёт `GET state`, и его же целиком шлёт SSE-канал
 * на каждое изменение: очередь мала, гранулярные события не окупаются.
 */
export const uiStateSchema = z.object({
    prKey: prKeySchema,
    worker: workerStatusSchema,
    tasks: z.array(uiTaskSchema),
    /**
     * Имя хост-адаптера этого PR (`arcanum`, `fixture`); null — prKey ни на один хост
     * не отображается, ревью-ручки недоступны: у такого сервера есть только очередь.
     */
    reviewHost: z.string().nullable(),
    /**
     * Мета PR из `ReviewHost.getPr()`. В отличие от диффа и тредов она мала —
     * едет в каждом снапшоте: брендкрамб и шапки вью питаются из одного источника.
     * null — хоста нет или мета ещё не загрузилась (сервер наполняет кеш вне сборки
     * снапшота и обновляет его после публикации вердикта — статус доедет по SSE).
     */
    pr: prMetaSchema.nullable(),
    /** Доступность канала фидбека: зависит только от токена Трекера в окружении. */
    feedback: uiFeedbackAvailabilitySchema,
    /**
     * Итерации PR: список хоста, дополненный `gone` из локального хранилища, в порядке
     * появления. Пустой — хоста нет или список ещё не загружен. Новый пуш приезжает этим же
     * снапшотом по SSE `state`: отдельного события нет.
     */
    iterations: z.array(iterationSchema),
    /**
     * Новая версия дистрибутива; null — проверка не делалась (dev-сборка `0.0.0`,
     * фикстурный хост), провалилась, версия свежая или отклонена ревьюером.
     */
    update: uiUpdateSchema.nullable(),
    /** Кап генерации текущего снапшота маршрута; null — снапшота нет или урезания не было. */
    generationCap: uiGenerationCapSchema.nullable(),
});
export type UiState = z.infer<typeof uiStateSchema>;

/**
 * Постановка задачи из UI. Только `echo` (dev-демо петли): генеративные задачи
 * (`route.*`) ставит сам сервер — им нужен материализованный контекст и схема
 * результата, у ручки с голым текстом их нет.
 */
export const uiEnqueueRequestSchema = z.object({
    type: z.literal('echo'),
    text: z.string().min(1).max(4000),
    /** По умолчанию `interactive` — ревьюер ждёт у экрана. */
    priority: priorityClassSchema.optional(),
});
export type UiEnqueueRequest = z.infer<typeof uiEnqueueRequestSchema>;

export const uiEnqueueResponseSchema = z.object({ task: uiTaskSchema });
export type UiEnqueueResponse = z.infer<typeof uiEnqueueResponseSchema>;

/** Отмена задачи из UI (`docs/protocol.md §5`): задача в аренде отменяется формально, воркер узнаёт при следующем вызове. */
export const uiCancelRequestSchema = z.object({ taskId: taskIdSchema });
export type UiCancelRequest = z.infer<typeof uiCancelRequestSchema>;

export const uiCancelResponseSchema = z.object({ outcome: z.enum(['cancelled', 'noop']) });
export type UiCancelResponse = z.infer<typeof uiCancelResponseSchema>;

/**
 * Ревью-данные PR. Ходят отдельными ручками, а не в `uiState`: дифф и треды
 * весят мегабайты (у Арканума комментарии без пагинации), слать их в каждом SSE-снапшоте
 * нельзя. Об изменениях сообщает событие `UI_REVIEW_EVENT`, UI перечитывает нужную ручку.
 * Мета PR — исключение: она мала и живёт в `uiStateSchema.pr`.
 */
/**
 * Выбор диффа. Без параметров — активная итерация хоста; `diffId` — сохранённая
 * итерация (и `gone` тоже: патч лежит локально, `docs/spec.md`); `base`+`head` — срез между
 * двумя итерациями («что нового» в читалке). Какую итерацию смотрит вкладка, знает
 * только UI (выбор в URL-фрагменте): сервер про «текущий вид» не спрашивают.
 */
export const uiReviewDiffRequestSchema = z
    .object({
        diffId: hostIdSchema.optional(),
        base: hostIdSchema.optional(),
        head: hostIdSchema.optional(),
    })
    .refine(
        (query) => (query.base === undefined) === (query.head === undefined),
        'base и head задаются вместе',
    )
    .refine(
        (query) => query.diffId === undefined || query.base === undefined,
        'diffId и срез base/head взаимоисключающи',
    );
export type UiReviewDiffRequest = z.infer<typeof uiReviewDiffRequestSchema>;

export const uiReviewDiffResponseSchema = z.object({ diff: prDiffSchema });
export type UiReviewDiffResponse = z.infer<typeof uiReviewDiffResponseSchema>;

export const uiReviewThreadsResponseSchema = z.object({ threads: z.array(threadSchema) });
export type UiReviewThreadsResponse = z.infer<typeof uiReviewThreadsResponseSchema>;

/**
 * Содержимое файла для «Expand context». UI зовёт ручку только при
 * `capabilities.fileContent`; `content: null` — содержимого нет у этого файла.
 */
export const uiReviewFileContentRequestSchema = z.object({ fileId: hostIdSchema, diffId: hostIdSchema.optional() });
export type UiReviewFileContentRequest = z.infer<typeof uiReviewFileContentRequestSchema>;

export const uiReviewFileContentResponseSchema = z.object({ content: fileContentSchema.nullable() });
export type UiReviewFileContentResponse = z.infer<typeof uiReviewFileContentResponseSchema>;

/**
 * Байты картинки по `ImageSide.blobId` (`FileDiff.image`). UI зовёт ручку только при
 * `capabilities.blobs`. Ответ — не JSON: тело — сырые байты, `Content-Type` по магическим
 * байтам (`image/*`, иначе `application/octet-stream`), `Cache-Control: private, immutable`
 * с годовым `max-age` — id адресует содержимое. 404 (`not_found`) — хост блоба не знает
 * или сторона больше `IMAGE_BLOB_MAX_BYTES`.
 */
export const uiReviewBlobRequestSchema = z.object({ blobId: hostIdSchema });
export type UiReviewBlobRequest = z.infer<typeof uiReviewBlobRequestSchema>;

/**
 * Линзы фильтра файлов: ownership («мои») отдельно от дополнительных (PCI DSS).
 * `ownershipSource` — `ReviewHost.ownershipSource`; у ownership-линзы он есть всегда.
 */
export const uiReviewLensesResponseSchema = z
    .object({
        ownership: lensSchema.nullable(),
        extra: z.array(lensSchema),
        ownershipSource: z.string().min(1).nullable(),
    })
    .refine((lenses) => lenses.ownership === null || lenses.ownershipSource !== null, {
        message: 'ownership-линза без имени источника зон',
    });
export type UiReviewLensesResponse = z.infer<typeof uiReviewLensesResponseSchema>;

/**
 * Состояние маршрута для UI. Фазы: `none` — генерация не запускалась и не нужна
 * (нет снапшота; вместе с `smallPr` различает «приглашение запустить скилл» и «малый PR —
 * маршрут не нужен»); `reading` — скелет в работе (`docs/spec.md`, фаза A); `filling` —
 * план принят, секции достраиваются (§7–8); `ready`; `failed` — скелет не прошёл
 * валидацию/попытки исчерпаны (§12). Провал отдельной секции — не фаза, а
 * `status: 'failed'` её стопа. «Агент умер посреди генерации» отдельной фазой не является:
 * UI сочетает `filling` со статусом воркера (`docs/spec.md`).
 */
export const uiRoutePhaseSchema = z.enum(['none', 'reading', 'filling', 'ready', 'failed']);
export type UiRoutePhase = z.infer<typeof uiRoutePhaseSchema>;

export const uiRouteFailureSchema = z.object({
    /** Причина в одно предложение (ревьюер-читаемое, русский). */
    message: z.string(),
    /** Последний сырой вывод модели — для «Open raw output»; null, если модель ничего не вернула. */
    rawOutput: z.string().nullable(),
});
export type UiRouteFailure = z.infer<typeof uiRouteFailureSchema>;

/**
 * «Маршрут устарел» (`docs/spec.md`, `docs/spec.md`): активная итерация хоста ушла вперёд от итерации
 * текущего снапшота. UI остаётся на итерации снапшота (якоря не дрейфуют), stale-баннер
 * предлагает перестроить маршрут или открыть новый дифф без него; авторегенерации нет.
 */
export const uiRouteStaleSchema = z.object({
    /** Коммит и итерация снапшота против активной итерации хоста. */
    routeCommit: z.string().min(1),
    prCommit: z.string().min(1),
    prDiffId: hostIdSchema,
    /** Сколько итераций появилось после итерации снапшота (force-push считается за одну). */
    newIterations: z.number().int().min(1),
    /** Стопы текущего снапшота, чьи якоря затронуты интердиффом («затронуты остановки 02, 03 и 07»). */
    affectedStopIds: z.array(z.string().min(1)),
});
export type UiRouteStale = z.infer<typeof uiRouteStaleSchema>;

export const uiRouteStateSchema = z.object({
    generation: generationSchema.optional(),
    phase: uiRoutePhaseSchema,
    /** PR ниже порога маршрута (`docs/architecture.md`): генерация не ставится, UI открывается на полном диффе с пометкой. */
    smallPr: z.boolean(),
    /**
     * Текущий снапшот; есть с момента принятого скелета, в `filling` — частичный
     * (см. `stops[].status`). При перегенерации из `ready` старый снапшот живёт
     * до приёмки нового скелета: `reading` при ненулевом снапшоте значит «строю новый,
     * старый читаем», подмена — атомарно в момент приёмки. Прошлые снапшоты —
     * ручкой `reviewRoute?snapshot=`, список — `reviewSnapshots`.
     */
    snapshot: routeSnapshotSchema.nullable(),
    /** Только в фазе `failed`. Провал перегенерации сочетается со старым снапшотом — он остаётся читаем. */
    failure: uiRouteFailureSchema.nullable(),
    /** null — снапшота нет или он построен на активной итерации. */
    stale: uiRouteStaleSchema.nullable(),
});
export type UiRouteState = z.infer<typeof uiRouteStateSchema>;
export const uiRouteRetryDiagramRequestSchema = z.object({ snapshotId: z.string().min(1) }).strict();
export const uiRouteCancelGenerationRequestSchema = z.object({ generationId: z.string().min(1) }).strict();

/** Без `snapshot` — текущее состояние маршрута; с ним — прошлый снапшот в `snapshot`, фаза как у него была. */
export const uiReviewRouteRequestSchema = z.object({ snapshot: z.string().min(1).optional() });
export type UiReviewRouteRequest = z.infer<typeof uiReviewRouteRequestSchema>;

export const uiReviewRouteResponseSchema = z.object({
    route: uiRouteStateSchema,
    routeRevision: z.number().int().min(0),
});
export type UiReviewRouteResponse = z.infer<typeof uiReviewRouteResponseSchema>;

/**
 * Список снапшотов PR (пикер снапшотов в индикаторе, карточка «Snapshots» на Обзоре, `docs/spec.md`).
 * `current` — текущий (ровно один, если снапшоты есть); `stale` — прошлый, его итерация
 * ещё в PR; `gone` — итерация снапшота ушла из PR (force-push), снапшот читаем по
 * локально сохранённому диффу. Прошлые снапшоты — только чтение.
 */
export const uiSnapshotStatusSchema = z.enum(['current', 'stale', 'gone']);
export type UiSnapshotStatus = z.infer<typeof uiSnapshotStatusSchema>;

export const uiSnapshotSummarySchema = z.object({
    snapshotId: z.string().min(1),
    diffId: hostIdSchema,
    commit: z.string().min(1),
    baseCommit: z.string().min(1),
    createdAt: z.iso.datetime(),
    provenance: routeProvenanceSchema,
    previousSnapshotId: z.string().nullable(),
    status: uiSnapshotStatusSchema,
});
export type UiSnapshotSummary = z.infer<typeof uiSnapshotSummarySchema>;

/** В порядке появления, текущий — последний. */
export const uiReviewSnapshotsResponseSchema = z.object({ snapshots: z.array(uiSnapshotSummarySchema) });
export type UiReviewSnapshotsResponse = z.infer<typeof uiReviewSnapshotsResponseSchema>;

/**
 * Запуск/перезапуск генерации маршрута (Retry из Generation failed, «regenerate»
 * из палитры; и перегенерация из `ready`, старый снапшот при этом
 * живёт до приёмки нового скелета). Ставит `route.skeleton` даже без живого
 * воркера — задача ждёт в очереди, деградацию показывает индикатор агента.
 * `already_running` — только про `reading`/`filling` (генерация уже идёт).
 * `small_pr` — отказ: порог ручкой не обходится (`docs/architecture.md`).
 */
export const uiRouteGenerateRequestSchema = z.object({
    /**
     * Язык генерации — эффективная локаль UI по лестнице «настройка → `--lang` агента → браузер»
     * Без него (старый клиент, автозапуск сервером) сервер разрешает
     * сам: `settings.locale` ≠ `auto` → `worker.lang` → `ru`.
     */
    locale: localeSchema.optional(),
});
export type UiRouteGenerateRequest = z.infer<typeof uiRouteGenerateRequestSchema>;

export const uiRouteGenerateResponseSchema = z.object({
    outcome: z.enum(['started', 'already_running', 'small_pr']),
});
export type UiRouteGenerateResponse = z.infer<typeof uiRouteGenerateResponseSchema>;

/**
 * Точечное дозаполнение одного незаполненного стопа: кнопка у слота
 * «не заполнена — агент остановился раньше» (`docs/spec.md`). Стоп уходит в `queued`,
 * фаза — в `filling`, дальше работает штатная сверка; полная перегенерация на это
 * время отвечает `already_running`. `snapshotId` — против гонки со сменой снапшота:
 * id стопов между снапшотами не устойчивы. `stale_snapshot` — снапшот сменился;
 * `not_unfilled` — стоп не в `failed` (уже заполнен или уже в работе);
 * `already_running` — фаза не `ready`.
 */
export const uiRouteFillStopRequestSchema = z.object({
    snapshotId: z.string().min(1),
    planIndex: z.number().int().positive(),
});
export type UiRouteFillStopRequest = z.infer<typeof uiRouteFillStopRequestSchema>;

export const uiRouteFillStopResponseSchema = z.object({
    outcome: z.enum(['started', 'already_running', 'stale_snapshot', 'not_unfilled']),
});
export type UiRouteFillStopResponse = z.infer<typeof uiRouteFillStopResponseSchema>;

/**
 * Чат с агентом и заметки (доменные схемы — `chat.ts`). История ходит отдельной
 * ручкой, не в `uiState` (растёт без ограничений); об изменениях сообщает SSE-событие
 * `UI_CHAT_EVENT` с ревизией. `ask` возвращает созданный обмен (прецедент `saveDraft`:
 * id нужен UI сразу — для cancel и отметки in-flight у поповера); статусы дальше
 * едут по SSE. Постановку задачи `chat` делает только сервер — ей нужен
 * материализованный контекст (прецедент сужения `enqueue` до `echo`).
 */
export const uiChatResponseSchema = z.object({
    exchanges: z.array(chatExchangeSchema),
    notes: z.array(agentNoteSchema),
    chatRevision: z.number().int().min(0),
});
export type UiChatResponse = z.infer<typeof uiChatResponseSchema>;

/** Якорь вопроса из UI: без `diffId` сервер берёт активную итерацию. */
export const uiChatAskAnchorSchema = chatAnchorSchema.extend({ diffId: hostIdSchema.optional() });
export type UiChatAskAnchor = z.infer<typeof uiChatAskAnchorSchema>;

export const uiChatAskRequestSchema = z.object({
    explanation: chatExplanationSchema.optional(),
    text: z.string().min(1).max(4000),
    /** Отсутствует — вопрос ко всему PR (Ask AI). */
    anchor: uiChatAskAnchorSchema.optional(),
    /** Язык ответа — та же лестница и тот же запасной путь, что у `uiRouteGenerateRequestSchema.locale`. */
    locale: localeSchema.optional(),
});
export type UiChatAskRequest = z.infer<typeof uiChatAskRequestSchema>;

export const uiChatAskResponseSchema = z.object({ exchange: chatExchangeSchema });
export type UiChatAskResponse = z.infer<typeof uiChatAskResponseSchema>;

/**
 * Остановка обмена («Stop», `docs/spec.md`). `cancelled` — и для ждущего в очереди,
 * и для взятого в аренду: формальная отмена, воркер узнаёт при следующем вызове CLI
 * (`docs/protocol.md §5`). `noop` — обмен уже терминален.
 */
export const uiChatCancelRequestSchema = z.object({ exchangeId: chatExchangeIdSchema });
export type UiChatCancelRequest = z.infer<typeof uiChatCancelRequestSchema>;

export const uiChatCancelResponseSchema = z.object({ outcome: z.enum(['cancelled', 'noop']) });
export type UiChatCancelResponse = z.infer<typeof uiChatCancelResponseSchema>;

/**
 * Повтор вопроса из `failed` или `cancelled` (`docs/spec.md`: вопрос сохранён): тот же
 * обмен возвращается в `queued`, ставится новая задача с тем же текстом и якорем.
 * `noop` — обмен не в терминальном провальном состоянии (`done` не повторяется).
 */
export const uiChatRetryRequestSchema = z.object({ exchangeId: chatExchangeIdSchema });
export type UiChatRetryRequest = z.infer<typeof uiChatRetryRequestSchema>;

export const uiChatRetryResponseSchema = z.object({ outcome: z.enum(['retried', 'noop']) });
export type UiChatRetryResponse = z.infer<typeof uiChatRetryResponseSchema>;

/** Удаление заметки (`docs/spec.md`). Историю чата не трогает; повторное удаление — no-op, тоже ack. */
export const uiChatNoteDeleteRequestSchema = z.object({ noteId: agentNoteIdSchema });
export type UiChatNoteDeleteRequest = z.infer<typeof uiChatNoteDeleteRequestSchema>;

/**
 * Отправка фидбека: кнопка Feedback в топ-баре → тикет в Яндекс Трекере.
 * UI-часть автоконтекста — вью и фаза маршрута (серверу они неизвестны); остальное
 * (версии, prKey, статус воркера, логин) сервер добавляет в тикет сам. Нет токена
 * Трекера — `outcome: 'unavailable'` с текстом, куда написать руками: это деградация,
 * не ошибка ручки. Ошибка самого Трекера — обычная RPC-ошибка, введённый текст
 * остаётся у формы для повтора.
 */
export const uiFeedbackContextSchema = z.object({
    view: z.string().min(1),
    routePhase: uiRoutePhaseSchema,
    /** Версия UI-бандла — может отличаться от серверной, в тикете обе. */
    uiVersion: z.string().min(1),
});
export type UiFeedbackContext = z.infer<typeof uiFeedbackContextSchema>;

export const uiFeedbackRequestSchema = z.object({
    text: z.string().min(1).max(20000),
    /** Чекбокс «приложить контекст»; при false `context` игнорируется. */
    includeContext: z.boolean(),
    context: uiFeedbackContextSchema.nullable(),
});
export type UiFeedbackRequest = z.infer<typeof uiFeedbackRequestSchema>;

export const uiFeedbackResponseSchema = z.object({
    outcome: z.enum(['created', 'unavailable']),
    /** Ключ и ссылка созданного тикета при `created`; иначе null. */
    issueKey: z.string().nullable(),
    issueUrl: z.string().nullable(),
    /** При `unavailable` — куда написать руками; при `created` null. */
    message: z.string().nullable(),
});
export type UiFeedbackResponse = z.infer<typeof uiFeedbackResponseSchema>;

/**
 * Принудительная проверка обновления (команда палитры «Проверить обновления»): кэш
 * `~/.sherpa/update-check.json` игнорируется, ответ — то же, что уедет в `uiState.update`.
 * `update: null` при свежей версии, отклонённой версии и при провале проверки — различать
 * их UI незачем, причина провала — строкой в stderr сервера.
 */
export const uiUpdateCheckResponseSchema = z.object({ update: uiUpdateSchema.nullable() });
export type UiUpdateCheckResponse = z.infer<typeof uiUpdateCheckResponseSchema>;

/** Дев-ручка: фикстурный сервер «узнаёт» о новой версии — для галереи и e2e тоста. */
export const uiDevUpdateAvailableRequestSchema = z.object({
    version: semverSchema,
    releasedAt: distributionVersionSchema.shape.releasedAt,
    whatsNew: distributionVersionSchema.shape.whatsNew,
});
export type UiDevUpdateAvailableRequest = z.infer<typeof uiDevUpdateAvailableRequestSchema>;

/**
 * Глобальные настройки UI: один пользователь — одни настройки на все PR
 * (`docs/spec.md`, `docs/spec.md` «Diff mode is global»).
 * Живут на сервере в `~/.sherpa/settings.json`, не в браузере:
 * сервер каждого PR слушает случайный порт, origin новый — `localStorage` пуст.
 * Дефолты на каждом поле: отсутствующий или битый файл деградирует в дефолты, не в ошибку.
 * Per-PR состояние (свёрнутые каталоги, недавние команды палитры) сюда не входит.
 */
const uiSettingsFields = {
    diffMode: z.enum(['unified', 'split']),
    /** Режим сплит-кнопки Ship, выбранный в её меню; `comment` — публикация без вердикта. */
    shipMode: z.enum(['ship', 'sticky_ship', 'comment']),
    composerLayout: z.enum(['visual', 'markdown']),
    /** Язык UI. */
    locale: localeSettingSchema,
    /** Тема UI; выбор общий для всех PR. `auto` следует за темой системы, явный выбор — нет. */
    theme: z.enum(['auto', 'dark', 'light']),
    /** Оформление Arcanum независимо от светлой, тёмной или системной темы. */
    arcanum: z.boolean(),
    /** Размер текста интерфейса: `l` — та же шкала крупнее (`docs/design/theme.md`). */
    textSize: z.enum(['m', 'l']),
    /**
     * Тур первого захода: `completedAt` — пройден или пропущен
     * (пропуск = навсегда); `step` — где остановился незавершённый тур, продолжается с него
     * на любом PR и после перезапуска сервера. Replay из палитры сбрасывает оба.
     */
    onboarding: z.object({
        completedAt: z.iso.datetime().nullable(),
        step: z.number().int().min(0),
    }),
    /** «Не напоминать про X» тоста обновления: отклонена ровно эта версия, следующая покажется. */
    updates: z.object({
        dismissedVersion: semverSchema.nullable(),
    }),
};

export const uiSettingsSchema = z.object({
    diffMode: uiSettingsFields.diffMode.default('unified'),
    shipMode: uiSettingsFields.shipMode.default('ship'),
    composerLayout: uiSettingsFields.composerLayout.default('visual'),
    locale: uiSettingsFields.locale.default('auto'),
    theme: uiSettingsFields.theme.default('auto'),
    arcanum: uiSettingsFields.arcanum.default(false),
    textSize: uiSettingsFields.textSize.default('m'),
    onboarding: uiSettingsFields.onboarding.default({ completedAt: null, step: 0 }),
    updates: uiSettingsFields.updates.default({ dismissedVersion: null }),
});
export type UiSettings = z.infer<typeof uiSettingsSchema>;

export const uiSettingsResponseSchema = z.object({ settings: uiSettingsSchema });
export type UiSettingsResponse = z.infer<typeof uiSettingsResponseSchema>;

/**
 * Частичное обновление: сервер читает файл заново, сливает названные поля и отдаёт результат
 * целиком. Собирается из полей без дефолтов: `.partial()` поверх `.default()` подставил бы
 * дефолт вместо отсутствующего ключа, и «не трогай поле» стало бы неотличимо от «сбрось».
 * Вложенные объекты (`onboarding`, `updates`) заменяются целиком, по ключам не сливаются.
 */
export const uiSettingsPatchSchema = z.object(uiSettingsFields).partial();
export type UiSettingsPatch = z.infer<typeof uiSettingsPatchSchema>;

/**
 * Состояние UI одного PR: свёрнутые ревьюером каталоги дерева и карточки диффа, недавние
 * команды палитры. Живёт в per-PR SQLite сервера по той же причине, что и глобальные настройки:
 * origin вкладки меняется с портом, и `localStorage` не переживает перезапуск. Карты хранят только
 * явный выбор ревьюера — отсутствие ключа значит «по умолчанию», а не `false`. Порядок
 * `paletteRecent` — от свежего к старому, лимит показа держит UI; сервер только хранит.
 */
const uiPrStateFields = {
    treeCollapsed: z.record(z.string(), z.boolean()),
    diffCollapsed: z.record(z.string(), z.boolean()),
    paletteRecent: z.array(z.string()).max(64),
};

export const uiPrStateSchema = z.object({
    treeCollapsed: uiPrStateFields.treeCollapsed.default({}),
    diffCollapsed: uiPrStateFields.diffCollapsed.default({}),
    paletteRecent: uiPrStateFields.paletteRecent.default([]),
});
export type UiPrState = z.infer<typeof uiPrStateSchema>;

export const uiPrStateResponseSchema = z.object({ prState: uiPrStateSchema });
export type UiPrStateResponse = z.infer<typeof uiPrStateResponseSchema>;

/** Частичное обновление: названное поле заменяется целиком (не сливается по ключам), остальные не трогаются. */
export const uiPrStatePatchSchema = z.object(uiPrStateFields).partial();
export type UiPrStatePatch = z.infer<typeof uiPrStatePatchSchema>;

/**
 * Прогресс чтения (`docs/architecture.md`): только ручные отметки, никакого трекинга
 * вьюпорта. `viewed` трёхзначен: `true` — ручная отметка, пинит `read`
 * навсегда; `false` — явное снятие (un-pin generated-дефолта или отмена своей
 * отметки); `null` — решения ревьюера нет, запись существует только ради
 * seen-диапазонов — UI трактует умолчания как при отсутствии записи
 * (generated → `read`). Файл без записи — состояние по умолчанию.
 *
 * Seen-диапазоны — диапазоны строк, покрытые вручную отмеченными остановками и карточками
 * файлов в них (их пишут `reviewStopViewed` и `reviewStopFileViewed`); tri-state (`unread`/`partial`/`read`) и тултипы
 * «N of M lines seen» UI считает сам от этих данных и своей модели диффа —
 * сервер патчи не интерпретирует.
 */
export const uiSeenRangeSchema = z.object({
    /** Сторона нумерации: added-строки живут в `new`, removed — в `old`. */
    side: z.enum(['old', 'new']),
    start: z.number().int().positive(),
    /** Включительно; `end >= start`. */
    end: z.number().int().positive(),
});
export type UiSeenRange = z.infer<typeof uiSeenRangeSchema>;

export const uiFileProgressSchema = z.object({
    fileId: hostIdSchema,
    viewed: z.boolean().nullable(),
    seenRanges: z.array(uiSeenRangeSchema),
});
export type UiFileProgress = z.infer<typeof uiFileProgressSchema>;

/** Отметка «просмотрено» остановки маршрута — персистится per PR (docs/spec.md §State model). */
export const uiStopProgressSchema = z.object({
    stopId: z.string().min(1),
    viewed: z.boolean(),
});
export type UiStopProgress = z.infer<typeof uiStopProgressSchema>;

/**
 * Прогресс какой итерации читать: без `diffId` — активной; с ним — сохранённой итерации
 * (явная активная отвечает как запрос без параметра). Write-ручки пишут под итерацией, чьи
 * `fileId` прислал UI: активной или итерации текущего снапшота, пока маршрут не перестроен.
 */
export const uiReviewProgressRequestSchema = z.object({ diffId: hostIdSchema.optional() });
export type UiReviewProgressRequest = z.infer<typeof uiReviewProgressRequestSchema>;

export const uiReviewProgressResponseSchema = z.object({
    /**
     * Итерация, из которой ответ прочитан: `fileId` в нём адресуют её файлы. UI сверяет его
     * с итерацией, которую рисует, и ответ про чужую не применяет — иначе отметки просмотра
     * гаснут на диффе, который остался на экране.
     */
    diffId: hostIdSchema,
    files: z.array(uiFileProgressSchema),
    stops: z.array(uiStopProgressSchema),
    progressRevision: z.number().int().min(0),
});
export type UiReviewProgressResponse = z.infer<typeof uiReviewProgressResponseSchema>;

/**
 * Отметка «просмотрено» файла. Сервер пишет в SQLite (истина для UI) и, если хост
 * умеет (`capabilities.fileViewedSync`), зеркалит отметку в хост best-effort:
 * провал зеркала не откатывает локальную запись и не является ошибкой ручки.
 */
export const uiSetFileViewedRequestSchema = z.object({
    fileId: hostIdSchema,
    viewed: z.boolean(),
});
export type UiSetFileViewedRequest = z.infer<typeof uiSetFileViewedRequestSchema>;

export const uiSetFileViewedResponseSchema = z.object({
    progressRevision: z.number().int().min(0),
});
export type UiSetFileViewedResponse = z.infer<typeof uiSetFileViewedResponseSchema>;

/**
 * Отметка «просмотрено» остановки маршрута (`docs/architecture.md`). Пишет отметку стопа
 * и seen-диапазоны его файлов одной транзакцией. Диапазоны считает UI от своей модели
 * диффа (якоря, обрезанные до реального диффа; для «Прочего» — непокрытые строки,
 * серверу без модели диффа их не вычислить) — сервер хранит их, привязав к стопу,
 * и не интерпретирует. Снятие отметки удаляет диапазоны только этого стопа и не
 * трогает ни диапазоны других стопов, ни ручные отметки файлов (`docs/spec.md`).
 * Запрос несёт `snapshotId`: опоздавшая запись прежнего маршрута не должна попасть
 * в новый стоп с тем же детерминированным id. Поле опционально для старых UI-бандлов.
 * Сама запись стопа в хост не зеркалится — переходы файлов в «прочитано» от покрытия
 * диапазонами UI сообщает отдельной ручкой `reviewViewedMirror`.
 */
export const uiStopSeenRangeSchema = uiSeenRangeSchema.extend({ fileId: hostIdSchema });
export type UiStopSeenRange = z.infer<typeof uiStopSeenRangeSchema>;

export const uiSetStopViewedRequestSchema = z.object({
    stopId: z.string().min(1),
    viewed: z.boolean(),
    /** Снапшот, который видел UI: запрос от прежнего маршрута сервер молча отбрасывает. */
    snapshotId: z.string().min(1).optional(),
    /** При `viewed: false` игнорируются: снятие удаляет сохранённые диапазоны стопа. */
    ranges: z.array(uiStopSeenRangeSchema),
});
export type UiSetStopViewedRequest = z.infer<typeof uiSetStopViewedRequestSchema>;

export const uiSetStopViewedResponseSchema = z.object({
    progressRevision: z.number().int().min(0),
});
export type UiSetStopViewedResponse = z.infer<typeof uiSetStopViewedResponseSchema>;

/**
 * Отметка «просмотрено» файла внутри остановки (`docs/spec.md`): пишет
 * seen-диапазоны карточки с привязкой к стопу и файлу, пин файлу не ставит и отметку стопа не
 * трогает — стоп отмечает UI, когда покрыты все его карточки. Снятие удаляет диапазоны этого
 * стопа по этому файлу и снимает отметку стопа: он больше не покрыт. Снапшот и зеркало в хост —
 * как у `reviewStopViewed`.
 */
export const uiSetStopFileViewedRequestSchema = z.object({
    stopId: z.string().min(1),
    fileId: hostIdSchema,
    viewed: z.boolean(),
    snapshotId: z.string().min(1).optional(),
    /** При `viewed: false` игнорируются. */
    ranges: z.array(uiSeenRangeSchema),
});
export type UiSetStopFileViewedRequest = z.infer<typeof uiSetStopFileViewedRequestSchema>;

export const uiSetStopFileViewedResponseSchema = z.object({
    progressRevision: z.number().int().min(0),
});
export type UiSetStopFileViewedResponse = z.infer<typeof uiSetStopFileViewedResponseSchema>;

/**
 * Зеркалирование «просмотрено» в хост без локальной записи. UI извещает
 * о переходах файла в `read` и обратно, случившихся из-за покрытия диапазонами
 * (отметка или снятие остановки, серверная симметрия снятия файла): явной файловой
 * отметки при этом не было, и зеркало ручки `reviewFileViewed` о переходе не знает.
 * Момент перехода знает только UI — у сервера нет модели диффа, чтобы посчитать
 * «все строки файла покрыты». Сервер шлёт хосту best-effort через ту же очередь
 * зеркала; без `capabilities.fileViewedSync` — тихий no-op, не ошибка. Частично
 * прочитанный файл сюда не попадает: у хоста статус бинарный.
 */
export const uiViewedMirrorRequestSchema = z.object({
    entries: z
        .array(z.object({ fileId: hostIdSchema, viewed: z.boolean() }))
        .min(1),
});
export type UiViewedMirrorRequest = z.infer<typeof uiViewedMirrorRequestSchema>;

/**
 * Запись комментариев (двухступенчатая модель, `docs/spec.md`, принцип 6): черновик
 * сохраняется в хост немедленно, публикация пакетом — вердиктом. Успешная запись бампает
 * `threadsRevision` — истина приезжает перечитыванием ручки тредов по SSE-событию
 * `review`; до неё UI живёт оптимистичным состоянием. `saveDraft` возвращает
 * созданный комментарий: его id нужен композеру для `updateDraft`/`deleteDraft`.
 */
export const uiSaveDraftRequestSchema = z.object({
    draft: commentDraftSchema,
    /**
     * Ключ записи буфера: UUID композера, один на логическую запись до её успеха.
     * Повтор с тем же ключом апсёртит ту же запись и уходит в хост с тем же ключом
     * идемпотентности — дубля не будет, даже если ответ на прошлую попытку потерялся.
     */
    clientKey: z.string().min(1),
});
export type UiSaveDraftRequest = z.infer<typeof uiSaveDraftRequestSchema>;

/**
 * Итог записи черновика: `saved` — хост принял, `buffered` — хост не ответил или
 * отказал, текст лежит в буфере сервера и будет повторён (`docs/spec.md`
 * «сохраним, когда
 * связь вернётся»). Сетевые и валидационные ошибки самой ручки — по-прежнему HTTP-ошибки:
 * буферизуется только провал шага «сервер → хост».
 */
export const uiSaveDraftResponseSchema = z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('saved'), comment: commentSchema }),
    z.object({ outcome: z.literal('buffered'), entry: draftBufferEntrySchema }),
]);
export type UiSaveDraftResponse = z.infer<typeof uiSaveDraftResponseSchema>;

export const uiUpdateDraftRequestSchema = z.object({
    commentId: hostIdSchema,
    body: z.string().min(1),
    /** Смена issue-статуса черновика; undefined — не менять. */
    issue: z.boolean().optional(),
    /** См. `uiSaveDraftRequestSchema.clientKey`. */
    clientKey: z.string().min(1),
});
export type UiUpdateDraftRequest = z.infer<typeof uiUpdateDraftRequestSchema>;

export const uiUpdateDraftResponseSchema = z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('saved') }),
    z.object({ outcome: z.literal('buffered'), entry: draftBufferEntrySchema }),
]);
export type UiUpdateDraftResponse = z.infer<typeof uiUpdateDraftResponseSchema>;

/**
 * Буфер черновиков этого PR. Меняется от save/update, повторов сервера, `retry`
 * и `discard`; каждое изменение бампает `threadsRevision` — UI перечитывает буфер вместе
 * с тредами по SSE-событию `review`.
 */
export const uiDraftBufferResponseSchema = z.object({ entries: z.array(draftBufferEntrySchema) });
export type UiDraftBufferResponse = z.infer<typeof uiDraftBufferResponseSchema>;

/** Повтор записи в хост прямо сейчас (кнопка «повторить») или отказ от записи («удалить»). */
export const uiDraftBufferEntryRequestSchema = z.object({ id: z.string().min(1) });
export type UiDraftBufferEntryRequest = z.infer<typeof uiDraftBufferEntryRequestSchema>;

export const uiDeleteDraftRequestSchema = z.object({ commentId: hostIdSchema });
export type UiDeleteDraftRequest = z.infer<typeof uiDeleteDraftRequestSchema>;

export const uiSetThreadResolvedRequestSchema = z.object({
    threadId: hostIdSchema,
    resolved: z.boolean(),
});
export type UiSetThreadResolvedRequest = z.infer<typeof uiSetThreadResolvedRequestSchema>;

/** Resolve отдельного комментария с issue (`ReviewHost.setCommentResolved`, только при `capabilities.commentResolve`). */
export const uiSetCommentResolvedRequestSchema = z.object({
    commentId: hostIdSchema,
    resolved: z.boolean(),
});
export type UiSetCommentResolvedRequest = z.infer<typeof uiSetCommentResolvedRequestSchema>;

/**
 * Правка и удаление своего опубликованного комментария (`ReviewHost.updateComment`/`deleteComment`,
 * только при `capabilities.editPublished`). Буфер черновиков не участвует: провал — HTTP-ошибка,
 * UI показывает её у комментария и предлагает повтор.
 */
export const uiUpdateCommentRequestSchema = z.object({
    commentId: hostIdSchema,
    body: z.string().min(1),
    /** Смена issue-статуса; undefined — не менять. */
    issue: z.boolean().optional(),
});
export type UiUpdateCommentRequest = z.infer<typeof uiUpdateCommentRequestSchema>;

export const uiDeleteCommentRequestSchema = z.object({ commentId: hostIdSchema });
export type UiDeleteCommentRequest = z.infer<typeof uiDeleteCommentRequestSchema>;

/**
 * Публикация накопленного пакета в одном из режимов `capabilities.publishVerdicts`: один вызов
 * `publishBatch` хоста. Ответ — итог как есть: `verdictApplied: false` при любом провале
 * (`docs/spec.md` — ревью НЕ считается завершённым, UI показывает
 * несдавшиеся из `failed`). Ретрай — новый вызов той же ручки: адаптер сам не хоронит
 * уже опубликованное (`publishedSilently`). Успех бампает `threadsRevision`
 * (черновики стали опубликованными) — истина приезжает ручкой тредов;
 * мету PR после вердикта сервер перечитывает сам и рассылает снапшотом.
 */
export const uiPublishRequestSchema = z.object({ verdict: verdictSchema });
export type UiPublishRequest = z.infer<typeof uiPublishRequestSchema>;

export const uiPublishResponseSchema = z.object({ result: publishResultSchema });
export type UiPublishResponse = z.infer<typeof uiPublishResponseSchema>;

/** Общий ответ write-ручек тредов: подтверждение без данных — истина приедет ручкой тредов. */
export const uiReviewWriteAckSchema = z.object({ acknowledged: z.literal(true) });
export type UiReviewWriteAck = z.infer<typeof uiReviewWriteAckSchema>;

/**
 * Событие «треды изменились». Ревизия — монотонный счётчик от старта сервера:
 * выросла против последней виденной → перечитать `reviewThreads`. Снапшот тредов
 * в событии не едет — см. комментарий к ревью-ручкам.
 */
export const uiReviewEventSchema = z.object({
    threadsRevision: z.number().int().min(0),
});
export type UiReviewEvent = z.infer<typeof uiReviewEventSchema>;

/**
 * Событие «прогресс чтения изменился» — для сходимости нескольких вкладок.
 * Семантика ревизии — как у `uiReviewEventSchema`.
 */
export const uiProgressEventSchema = z.object({
    progressRevision: z.number().int().min(0),
});
export type UiProgressEvent = z.infer<typeof uiProgressEventSchema>;

/**
 * Событие «маршрут изменился» (фаза, готовность стопа, провал) — UI перечитывает
 * ручку `reviewRoute`. Семантика ревизии — как у `uiReviewEventSchema`.
 */
export const uiRouteEventSchema = z.object({
    routeRevision: z.number().int().min(0),
});
export type UiRouteEvent = z.infer<typeof uiRouteEventSchema>;

/**
 * Событие «чат/заметки изменились» (статус обмена, ответ, заметка) — UI перечитывает
 * ручку `reviewChat`. Семантика ревизии — как у `uiReviewEventSchema`.
 */
export const uiChatEventSchema = z.object({
    chatRevision: z.number().int().min(0),
});
export type UiChatEvent = z.infer<typeof uiChatEventSchema>;

/**
 * Ручки UI-канала. Все под bearer-токеном; исключение — `events`: EventSource не умеет
 * заголовки, поэтому SSE-ручка принимает токен query-параметром `?token=` (localhost, свои логи).
 * Ревью-ручки при `reviewHost: null` отвечают ошибкой `no_review_host`.
 */
export const UI_ENDPOINTS = {
    /** GET → `uiStateSchema`. */
    state: '/api/ui/state',
    /** POST `uiEnqueueRequestSchema` → `uiEnqueueResponseSchema`. */
    enqueue: '/api/ui/tasks',
    /** POST `uiCancelRequestSchema` → `uiCancelResponseSchema`. */
    cancel: '/api/ui/tasks/cancel',
    /** GET, SSE: события `state` (`uiStateSchema`), `review`, `progress`, `route`, `chat` (ревизии). */
    events: '/api/ui/events',
    /** GET `?diffId=` | `?base=&head=` (`uiReviewDiffRequestSchema`) → `uiReviewDiffResponseSchema`; без параметров — активная итерация. */
    reviewDiff: '/api/ui/review/diff',
    /** GET → `uiReviewThreadsResponseSchema`. */
    reviewThreads: '/api/ui/review/threads',
    /** GET → `uiReviewLensesResponseSchema`. */
    reviewLenses: '/api/ui/review/lenses',
    /** GET `?fileId=` (`uiReviewFileContentRequestSchema`) → `uiReviewFileContentResponseSchema`. */
    reviewFileContent: '/api/ui/review/file-content',
    /** GET `?blobId=` (`uiReviewBlobRequestSchema`) → сырые байты (см. схему запроса). */
    reviewBlob: '/api/ui/review/blob',
    /** GET `?diffId=` (`uiReviewProgressRequestSchema`) → `uiReviewProgressResponseSchema`. Доступна и без ревью-хоста: прогресс локальный. */
    reviewProgress: '/api/ui/review/progress',
    /** POST `uiSetFileViewedRequestSchema` → `uiSetFileViewedResponseSchema`. */
    reviewFileViewed: '/api/ui/review/file-viewed',
    /** POST `uiSetStopViewedRequestSchema` → `uiSetStopViewedResponseSchema`. Доступна и без ревью-хоста. */
    reviewStopViewed: '/api/ui/review/stop-viewed',
    /** POST `uiSetStopFileViewedRequestSchema` → `uiSetStopFileViewedResponseSchema`. Доступна и без ревью-хоста. */
    reviewStopFileViewed: '/api/ui/review/stop-file-viewed',
    /** POST `uiViewedMirrorRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewViewedMirror: '/api/ui/review/viewed-mirror',
    /** POST `uiSaveDraftRequestSchema` → `uiSaveDraftResponseSchema`. */
    reviewSaveDraft: '/api/ui/review/draft',
    /** POST `uiUpdateDraftRequestSchema` → `uiUpdateDraftResponseSchema`. */
    reviewUpdateDraft: '/api/ui/review/draft/update',
    /** GET → `uiDraftBufferResponseSchema`. */
    reviewDraftBuffer: '/api/ui/review/draft-buffer',
    /** POST `uiDraftBufferEntryRequestSchema` → `uiDraftBufferResponseSchema` (буфер после попытки). */
    reviewDraftBufferRetry: '/api/ui/review/draft-buffer/retry',
    /** POST `uiDraftBufferEntryRequestSchema` → `uiDraftBufferResponseSchema`. */
    reviewDraftBufferDiscard: '/api/ui/review/draft-buffer/discard',
    /** POST `uiDeleteDraftRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewDeleteDraft: '/api/ui/review/draft/delete',
    /** POST `uiSetThreadResolvedRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewThreadResolved: '/api/ui/review/thread-resolved',
    /** POST `uiSetCommentResolvedRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewCommentResolved: '/api/ui/review/comment-resolved',
    /** POST `uiUpdateCommentRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewUpdateComment: '/api/ui/review/comment/update',
    /** POST `uiDeleteCommentRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewDeleteComment: '/api/ui/review/comment/delete',
    /** POST `uiPublishRequestSchema` → `uiPublishResponseSchema`. */
    reviewPublish: '/api/ui/review/publish',
    /** GET `?snapshot=` (`uiReviewRouteRequestSchema`) → `uiReviewRouteResponseSchema`. */
    reviewRoute: '/api/ui/review/route',
    /** GET → `uiReviewSnapshotsResponseSchema`. */
    reviewSnapshots: '/api/ui/review/snapshots',
    /** POST `uiRouteGenerateRequestSchema` (тело может быть пустым) → `uiRouteGenerateResponseSchema`. */
    reviewRouteGenerate: '/api/ui/review/route/generate',
    /** POST `uiRouteFillStopRequestSchema` → `uiRouteFillStopResponseSchema`. */
    reviewRouteFillStop: '/api/ui/review/route/fill-stop',
    /** POST `uiRouteRetryDiagramRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewRouteRetryDiagram: '/api/ui/review/route/retry-diagram',
    /** POST `uiRouteCancelGenerationRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewRouteCancelGeneration: '/api/ui/review/route/cancel-generation',
    /** GET → `uiChatResponseSchema`. */
    reviewChat: '/api/ui/review/chat',
    /** POST `uiChatAskRequestSchema` → `uiChatAskResponseSchema`. */
    reviewChatAsk: '/api/ui/review/chat/ask',
    /** POST `uiChatCancelRequestSchema` → `uiChatCancelResponseSchema`. */
    reviewChatCancel: '/api/ui/review/chat/cancel',
    /** POST `uiChatRetryRequestSchema` → `uiChatRetryResponseSchema`. */
    reviewChatRetry: '/api/ui/review/chat/retry',
    /** POST `uiChatNoteDeleteRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewChatNoteDelete: '/api/ui/review/chat/note-delete',
    /** POST `uiFeedbackRequestSchema` → `uiFeedbackResponseSchema`. Доступна и без ревью-хоста. */
    feedback: '/api/ui/feedback',
    /** POST без тела → `uiUpdateCheckResponseSchema`. Доступна и без ревью-хоста. */
    updateCheck: '/api/ui/update-check',
    /** GET → `uiSettingsResponseSchema`; PATCH `uiSettingsPatchSchema` → `uiSettingsResponseSchema`. Доступна и без ревью-хоста. */
    settings: '/api/ui/settings',
    /** GET → `uiPrStateResponseSchema`; PATCH `uiPrStatePatchSchema` → `uiPrStateResponseSchema`. Доступна и без ревью-хоста. */
    prState: '/api/ui/pr-state',
} as const;

/**
 * Дев-ручки сервера: существуют только у PR на фикстурном хосте (prKey `fixture-*`),
 * у остальных маршрута нет. Тот же bearer-токен, что у UI-ручек.
 */
export const UI_DEV_ENDPOINTS = {
    /** POST без тела → `uiReviewWriteAckSchema`: фикстура «получает пуш» — следующая объявленная итерация становится активной. */
    fixtureAdvanceIteration: '/api/dev/fixture/advance-iteration',
    /** POST `uiDevFixtureFailDraftWritesRequestSchema` → `uiReviewWriteAckSchema`: фикстура отказывается принимать черновики (буфер). */
    fixtureFailDraftWrites: '/api/dev/fixture/fail-draft-writes',
    /** POST `uiDevUpdateAvailableRequestSchema` → `uiUpdateCheckResponseSchema`: подставить «новую версию» в `uiState.update`. */
    updateAvailable: '/api/dev/update-available',
} as const;

/** Тело дев-ручки отказа записи черновиков: `fail: false` возвращает фикстуру в рабочее состояние. */
export const uiDevFixtureFailDraftWritesRequestSchema = z.object({ fail: z.boolean() });
export type UiDevFixtureFailDraftWritesRequest = z.infer<typeof uiDevFixtureFailDraftWritesRequestSchema>;

/** Имя SSE-события со снапшотом состояния. */
export const UI_STATE_EVENT = 'state';

/** Имя SSE-события об изменении ревью-данных (`uiReviewEventSchema`). */
export const UI_REVIEW_EVENT = 'review';

/** Имя SSE-события об изменении прогресса чтения (`uiProgressEventSchema`). */
export const UI_PROGRESS_EVENT = 'progress';

/** Имя SSE-события об изменении маршрута (`uiRouteEventSchema`). */
export const UI_ROUTE_EVENT = 'route';

/** Имя SSE-события об изменении чата и заметок (`uiChatEventSchema`). */
export const UI_CHAT_EVENT = 'chat';
