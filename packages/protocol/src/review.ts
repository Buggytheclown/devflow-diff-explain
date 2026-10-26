import { z } from 'zod';

/**
 * Доменные типы ревью (`docs/architecture.md §5`, `docs/product.md §4a`): то, что пересекает границу хост-адаптера
 * и уходит в UI. Хост-специфика (стики-шип как механика, знаковые id Арканума,
 * `common_status` и т. п.) остаётся вердиктами и непрозрачными строками — в модель не протекает.
 * Формы выверены по разведке API Арканума (`docs/research/arcanum-api.md`).
 */

/**
 * Непрозрачный идентификатор хоста (PR, комментарий, файл диффа, итерация).
 * Не парсить и не конструировать: у Арканума это знаковые числа и base64-протобуфы,
 * у другого хоста будут свои форматы — контракт одинаково не обещает ничего, кроме равенства.
 */
export const hostIdSchema = z.string().min(1);
export type HostId = z.infer<typeof hostIdSchema>;

/** Автор комментария или PR. Бот-метка — приглушение и чип источника в UI (`docs/product.md §7`, сценарий F4). */
export const reviewUserSchema = z.object({
    login: z.string().min(1),
    /** Человекочитаемое имя источника — для ботов метка вида «Example AI Review (…)». */
    displayName: z.string().nullable(),
    bot: z.boolean(),
    /**
     * Фото человека, которое браузер ревьюера грузит напрямую; `null` — фото у хоста нет,
     * UI рисует инициалы. Модели не передаётся.
     */
    avatarUrl: z.url({ protocol: /^https$/ }).nullable(),
});
export type ReviewUser = z.infer<typeof reviewUserSchema>;

/**
 * Режим публикации пакета черновиков. `comment` — опубликовать черновики и ничего не применять;
 * `ship`, `sticky_ship`, `request_changes` — опубликовать и применить вердикт. Какие режимы хост
 * примет на этом PR, говорит `HostCapabilities.publishVerdicts`.
 */
export const verdictSchema = z.enum(['comment', 'ship', 'sticky_ship', 'request_changes']);
export type Verdict = z.infer<typeof verdictSchema>;

/** Что хост умеет — UI прячет недоступное (синхронизация viewed, раскрытие контекста и т. п. есть не везде). */
export const hostCapabilitiesSchema = z.object({
    /**
     * Режимы публикации, которые хост примет на этом PR: UI рисует ровно этот список, хост
     * отклоняет вердикт вне него. Считается на каждое чтение шапки — зависит от PR, а не только
     * от хоста (настройки PR у Арканума, автор PR у GitHub).
     */
    publishVerdicts: z.array(verdictSchema).superRefine((verdicts, ctx) => {
        if (new Set(verdicts).size !== verdicts.length) {
            ctx.addIssue({ code: 'custom', message: 'режимы публикации повторяются' });
        }
    }),
    fileViewedSync: z.boolean(),
    /** Хост умеет отдавать содержимое файла целиком (`getFileContent`) — без него «Expand context» недоступен. */
    fileContent: z.boolean(),
    /** Чтение произвольного исходника строго в указанной ревизии. */
    sourceAtRevision: z.boolean().optional(),
    /** Хост различает «комментарий открывает issue / не требует ответа» (`CommentDraft.issue`) — без него UI прячет контрол. */
    commentIssues: z.boolean(),
    /**
     * Хост ведёт resolved на каждом комментарии, а не на треде (`setCommentResolved`, `Comment.resolved`):
     * тогда `Thread.resolved` адаптер считает по правилу «есть хотя бы один issue и все issue закрыты».
     * Без него resolved живёт только на треде (`setThreadResolved`), а `Comment.resolved` всегда `null`.
     */
    commentResolve: z.boolean(),
    /**
     * Хост даёт править и удалять свои уже опубликованные комментарии (`updateComment`, `deleteComment`).
     * Поднимается только при известном `PrMeta.viewer`: без личности «своё» не с чем сверить.
     */
    editPublished: z.boolean(),
    /**
     * Хост перечисляет прошлые итерации и отдаёт срез между ними (`listIterations` длиннее
     * одной записи, `getDiff({base, head})`). Без этого `listIterations` содержит только
     * активную итерацию, срез отклоняется, а перенос прогресса и классификация стопов
     * после пуша серверу недоступны — UI показывает только «маршрут устарел».
     */
    iterations: z.boolean(),
    /**
     * Хост отдаёт байты файлов по содержимому (`getBlob`) — без него карточка-картинка
     * не показывается, бинарник остаётся нотисом «двоичный файл не показан».
     */
    blobs: z.boolean(),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const prStateSchema = z.enum(['open', 'merged', 'closed']);
export type PrState = z.infer<typeof prStateSchema>;

/**
 * Сводный статус проверок CI по PR; null — хост его не отдаёт (у Арканума checks —
 * отдельная неисследованная поверхность API, адаптер честно возвращает null, UI прячет).
 */
export const prChecksSchema = z.enum(['passed', 'failed', 'pending']);
export type PrChecks = z.infer<typeof prChecksSchema>;

/**
 * Текущий вердикт ревьюера по PR (`docs/design/SPEC-elements.md §4.5` «someone else ships first»): у Арканума —
 * `review.reviewers[].action` (`ship` / `sticky_ship` / `waiting_for_changes` → `request_changes`).
 * Времени вердикта хосты не отдают — UI засекает момент, когда вердикт появился в снапшоте.
 * Публикация без вердикта (`comment`) вердиктом ревьюера не считается и сюда не попадает.
 */
export const reviewerVerdictSchema = z.object({
    user: reviewUserSchema,
    verdict: z.enum(['ship', 'sticky_ship', 'request_changes']),
});
export type ReviewerVerdict = z.infer<typeof reviewerVerdictSchema>;

/**
 * Шапка PR. `statusLabel` — статус ревью словами хоста, UI показывает как есть.
 * `verdicts` — только ревьюеры с вердиктом; пустой список — вердиктов нет или хост не отдаёт.
 */
export const prMetaSchema = z.object({
    id: hostIdSchema,
    url: z.string().min(1),
    title: z.string(),
    author: reviewUserSchema,
    fromBranch: z.string(),
    toBranch: z.string(),
    state: prStateSchema,
    statusLabel: z.string(),
    checks: prChecksSchema.nullable(),
    updatedAt: z.iso.datetime(),
    capabilities: hostCapabilitiesSchema,
    verdicts: z.array(reviewerVerdictSchema),
    /** Кто смотрит PR через Шерпу; null — хост личность не знает. */
    viewer: reviewUserSchema.nullable(),
});
export type PrMeta = z.infer<typeof prMetaSchema>;

export const fileChangeTypeSchema = z.enum(['add', 'modify', 'delete', 'copy', 'move', 'conflict']);
export type FileChangeType = z.infer<typeof fileChangeTypeSchema>;

/** Типы картинок, которые UI показывает карточкой; определяются хостом по расширению пути. */
export const imageMimeSchema = z.enum([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/x-icon',
]);
export type ImageMime = z.infer<typeof imageMimeSchema>;

/** Расширение пути → тип картинки; единственный признак, по которому хост метит файл картинкой. */
const IMAGE_MIME_BY_EXTENSION = new Map<string, ImageMime>([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    ['bmp', 'image/bmp'],
    ['ico', 'image/x-icon'],
]);

/** Тип картинки по расширению пути; null — файл картинкой не считается. */
export function imageMimeOf(path: string): ImageMime | null {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return null;
    }
    return IMAGE_MIME_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/**
 * Одна сторона картинки. `blobId` адресует содержимое, а не файл: равные id — равные байты
 * (у Арканума — собственный хэш блоба arc), поэтому сервер кэширует байты по нему без срока годности.
 * `size` — байты стороны; UI по нему отказывается грузить сторону больше `IMAGE_BLOB_MAX_BYTES`.
 */
export const imageSideSchema = z.object({
    blobId: hostIdSchema,
    size: z.number().int().min(0),
});
export type ImageSide = z.infer<typeof imageSideSchema>;

/** Картинка в диффе: стороны null у add (нет before) и delete (нет after). */
export const fileImageSchema = z.object({
    mime: imageMimeSchema,
    before: imageSideSchema.nullable(),
    after: imageSideSchema.nullable(),
});
export type FileImage = z.infer<typeof fileImageSchema>;

/**
 * Один файл диффа. Контент — сырой unified diff (`patch`): парсинг в модель строк
 * делает UI в воркере (`docs/architecture.md §1`), сервер и адаптер текст не интерпретируют.
 */
export const fileDiffSchema = z.object({
    /** Непрозрачный id файла в этой итерации — якорь комментариев и viewed-отметок. */
    fileId: hostIdSchema,
    path: z.string().min(1),
    /** Прежний путь для copy/move. */
    oldPath: z.string().nullable(),
    changeType: fileChangeTypeSchema,
    binary: z.boolean(),
    /**
     * «Команда не требует ревью этого файла»: файл исключён из активных правил ревью
     * (CODEOWNERS или аналог хоста). Не эвристика — ревьюилка не спорит с политикой команды.
     */
    generated: z.boolean(),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    /** Unified diff файла; null у binary и у файлов без текстового диффа. */
    patch: z.string().nullable(),
    /** Отметка «просмотрено» на стороне хоста; null — хост не умеет (см. capabilities). */
    viewed: z.boolean().nullable(),
    /** Ссылка на blame этого файла в вебе хоста; null — хосту нечего предложить. */
    blameUrl: z.string().nullable(),
    /**
     * Ссылка на этот файл в этом PR в вебе хоста — «Скопировать ссылку на файл» ведёт к хосту,
     * не в Шерпу. null — у хоста нет веба (фикстуры) или ссылки на файл.
     */
    hostFileUrl: z.string().nullable(),
    /**
     * Файл — картинка (по расширению; хост проставляет только при `capabilities.blobs`).
     * null — не картинка. UI рисует карточку-картинку вместо нотиса binary; текстовый
     * `patch` (svg) при этом сохраняется и показывается отдельным режимом.
     * Необязателен на входе с дефолтом null: диффы, сохранённые раньше, читаются без миграции.
     */
    image: fileImageSchema.nullable().default(null),
});
export type FileDiff = z.infer<typeof fileDiffSchema>;

/**
 * Содержимое файла по обе стороны диффа — топливо «Expand context» (`docs/design/SPEC-elements.md §2.13`):
 * строки за пределами ханков UI достраивает из этого текста сам, протокол ширины
 * контекста хосту не нужен. null-сторона — файла на той стороне нет (add/delete).
 */
export const fileContentSchema = z.object({
    oldText: z.string().nullable(),
    newText: z.string().nullable(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

/**
 * Дифф PR целиком: одна итерация хоста — либо срез между двумя итерациями
 * (`getDiff({base, head})`, интердифф). У среза `diffId` — id итерации `head`,
 * `baseCommit` — ревьюируемый коммит итерации `base`; `fileId` файлов среза
 * непрозрачны так же, как у итерации, и с `fileId` самих итераций не совпадают.
 */
export const prDiffSchema = z.object({
    /** Непрозрачный id итерации — провенанс снапшотов и якорь новых комментариев. */
    diffId: hostIdSchema,
    baseCommit: z.string().min(1),
    /** Ревьюируемая сторона (у Арканума — синтетический merge-коммит, не HEAD ветки). */
    headCommit: z.string().min(1),
    files: z.array(fileDiffSchema),
});
export type PrDiff = z.infer<typeof prDiffSchema>;

/**
 * Статус итерации. `active` — та, что ревьюируется сейчас (ровно одна); `previous` —
 * хост её ещё перечисляет; `gone` — хост больше не перечисляет (например, после force-push),
 * но сервер помнит её локально сохранённый дифф (`docs/product.md §4a`). `gone` ставит только
 * сервер, сравнивая список хоста со своим хранилищем: адаптер отдаёт лишь то, что видит.
 */
export const iterationStatusSchema = z.enum(['active', 'previous', 'gone']);
export type IterationStatus = z.infer<typeof iterationStatusSchema>;

/**
 * Итерация PR — единица времени ревью (у Арканума `diff-set`): один пуш автора — одна
 * итерация. Снапшоты маршрута, прогресс чтения и якоря заметок привязаны к `diffId`.
 */
export const iterationSchema = z.object({
    diffId: hostIdSchema,
    baseCommit: z.string().min(1),
    /** Ревьюируемый коммит итерации — тот же, что `PrDiff.headCommit`. */
    headCommit: z.string().min(1),
    createdAt: z.iso.datetime(),
    status: iterationStatusSchema,
});
export type Iteration = z.infer<typeof iterationSchema>;

/** Позиция в диффе файла: сторона + строка + охват (size ≥ 1, бывает диапазон). */
export const anchorPositionSchema = z.object({
    side: z.enum(['old', 'new']),
    line: z.number().int().positive(),
    size: z.number().int().positive(),
});
export type AnchorPosition = z.infer<typeof anchorPositionSchema>;

/** Якорь треда/черновика. Без `position` — комментарий на весь файл. */
export const fileAnchorSchema = z.object({
    fileId: hostIdSchema,
    path: z.string().min(1),
    position: anchorPositionSchema.nullable(),
});
export type FileAnchor = z.infer<typeof fileAnchorSchema>;

/**
 * Комментарий с поддеревом ответов. Треды — деревья, не списки: по данным разведки API
 * Арканума глубина доходит до 14, ~7% узлов ветвятся; UI сплющивает при рендере (отступ до 4).
 * `draft` — мой неопубликованный черновик (виден только мне, чип «publishes on ship»).
 */
export interface Comment {
    id: HostId;
    author: ReviewUser;
    /** Markdown, как отдал хост. */
    body: string;
    draft: boolean;
    /**
     * Открывает ли комментарий issue — состояние того же флага, что ставит `CommentDraft.issue`.
     * `null` только у хоста без `capabilities.commentIssues`: где issue есть, «не знаю» не бывает —
     * комментарий без статуса issue не открывает, и UI показывает выключенный переключатель,
     * а не прячет его.
     */
    issue: boolean | null;
    /**
     * Закрыт ли issue этого комментария. `null` только у хоста без `capabilities.commentResolve`;
     * у комментария без issue — `false`: закрывать нечего. Кнопка Resolve в UI стоит у каждого
     * комментария с `issue`, где хост это умеет.
     */
    resolved: boolean | null;
    createdAt: string;
    editedAt: string | null;
    replies: Comment[];
}
export const commentSchema: z.ZodType<Comment> = z.object({
    id: hostIdSchema,
    author: reviewUserSchema,
    body: z.string(),
    draft: z.boolean(),
    issue: z.boolean().nullable(),
    resolved: z.boolean().nullable(),
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    get replies() {
        return z.array(commentSchema);
    },
});

/**
 * Пин треда к коммиту, на котором он написан (`docs/design/SPEC-elements.md §4.5` «pinned to 9f3c1ab»): итерация
 * исходного якоря по данным хоста (у Арканума — `original_anchor`). UI свой пин не хранит
 * и не вычисляет: `pinnedTo.diffId`, отличный от активной итерации, даёт «view at the
 * old commit», остальное — `outdated` и перепривязанный `anchor`.
 */
export const threadPinSchema = z.object({
    diffId: hostIdSchema,
    commit: z.string().min(1),
});
export type ThreadPin = z.infer<typeof threadPinSchema>;

/**
 * Тред: корневой комментарий + состояние уровня треда.
 * `resolved` у хоста с `capabilities.commentResolve` считает адаптер: тред закрыт, если в нём есть
 * хотя бы один комментарий с issue и все они закрыты; тред без issue всегда открыт. У остальных
 * хостов — статус треда как есть. Правило и инвариант проверяет контрактный набор хостов.
 * `anchor: null` — обсуждение уровня PR. `outdated` вычисляет адаптер
 * (у Арканума поля нет — разность списков итераций). `pinnedTo: null` —
 * обсуждение уровня PR или хост не знает итерацию якоря.
 */
export const threadSchema = z.object({
    id: hostIdSchema,
    anchor: fileAnchorSchema.nullable(),
    resolved: z.boolean(),
    resolvedBy: z.string().nullable(),
    outdated: z.boolean(),
    pinnedTo: threadPinSchema.nullable(),
    root: commentSchema,
});
export type Thread = z.infer<typeof threadSchema>;

/**
 * Черновик на создание (двухступенчатая модель, `docs/product.md §3`, принцип 6): сохраняется в хост мгновенно,
 * публикуется пакетом (`publishBatch`). Либо ответ (`parentId`), либо новый тред (`anchor`;
 * null и там и там — комментарий уровня PR).
 */
export const commentDraftSchema = z.object({
    body: z.string().min(1),
    parentId: hostIdSchema.nullable(),
    anchor: fileAnchorSchema.nullable(),
    /**
     * Открывает ли комментарий issue (требует ответа) — у любого комментария, включая ответы.
     * Для хостов без `commentIssues` не передаётся — хост ставит свой дефолт.
     */
    issue: z.boolean().optional(),
});
export type CommentDraft = z.infer<typeof commentDraftSchema>;

/**
 * Итог публикации пакета. Частичный провал — вердикт НЕ применяется,
 * ревью не считается завершённым (`docs/design/SPEC-elements.md §4.5`), UI показывает несдавшиеся.
 */
export const publishResultSchema = z.object({
    publishedCommentIds: z.array(hostIdSchema),
    failed: z.array(z.object({ commentId: hostIdSchema, message: z.string() })),
    verdictApplied: z.boolean(),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

/**
 * Зона ответственности ownership-линзы: граница из файла владения (CODEOWNERS или аналог хоста) —
 * каталог владеющего конфига, при subpaths-правилах — подпуть внутри него.
 * Файл диффа принадлежит не более чем одной зоне — самой глубокой границе.
 * Зоны описывают весь PR (не только зоны ревьюера) и осмысленны даже при
 * `available: false` линзы: у ревьюера нет своей зоны, но чужие зоны PR есть.
 */
export const lensZoneSchema = z.object({
    /** Граница зоны от корня репозитория, без ведущего и хвостового `/`. */
    path: z.string().min(1),
    /** Ревьюер — владелец зоны (чип «you · owner»). */
    mine: z.boolean(),
    /**
     * Имя владельца для чипа (алиас правила владения, например `@org/modules-team`);
     * null — правило без алиаса, UI подписывает чип обезличенно.
     */
    owner: z.string().nullable(),
    /** Пути файлов текущего диффа внутри зоны — членство, как в `paths` линзы. Пустых зон нет. */
    paths: z.array(z.string()).min(1),
});
export type LensZone = z.infer<typeof lensZoneSchema>;

/**
 * Линза — именованное множество путей для фильтра файлов (модель фильтров `docs/design/README.md`).
 * `available: false` — механизм линзы недоступен (нет зоны у ревьюера, сломалась
 * недокументированная ручка) — UI дизейблит фильтр с объяснением из `note`.
 */
export const lensSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Конкретные пути файлов текущего диффа (не префиксы каталогов) — фильтр в UI сводится к членству. */
    paths: z.array(z.string()),
    available: z.boolean(),
    note: z.string().nullable(),
    /**
     * Зоны ответственности PR — только у ownership-линзы; null — реализация зон
     * не различает (каталожная деградация Арканума, extra-линзы) — UI группирует
     * файлы по префиксу пути. Файлы вне всех зон группирует UI
     * (машинные, непокрытые правилами владения).
     */
    zones: z.array(lensZoneSchema).nullable(),
});
export type Lens = z.infer<typeof lensSchema>;

/**
 * Результат задачи `review.feedback` — ответ агента на раунд опубликованных комментариев
 * локального ревью (валидируется fail-closed при приёме `complete`; схема уходит в payload
 * задачи файлом). Ответы адресуются `threadId` треда; тред без ответа — не ошибка,
 * ревьюер и так видит, кому агент не ответил.
 */
export const reviewFeedbackResultSchema = z.object({
    replies: z
        .array(
            z.object({
                threadId: hostIdSchema,
                body: z.string().min(1).max(20_000),
            }),
        )
        .max(200),
    /** Короткий итог раунда для ревьюера: что агент сделал по замечаниям. */
    summary: z.string().min(1).max(4000),
});
export type ReviewFeedbackResult = z.infer<typeof reviewFeedbackResultSchema>;
