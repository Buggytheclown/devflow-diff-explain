import type {
    CommentDraft,
    Comment,
    FileContent,
    HostId,
    Iteration,
    Lens,
    PrDiff,
    PrMeta,
    PublishResult,
    Thread,
    Verdict,
} from './review.js';

    /**
 * Интерфейс хост-адаптера (`docs/architecture.md`, `docs/architecture.md`). Одна
 * абстракция, четыре реализации: Арканум, GitHub, локальный чекаут (бэкенды arc и git)
 * и фикстурный хост для UI и тестов. Всё хост-специфичное — за этой границей; ядро (маршрут, очередь, прогресс,
 * снапшоты) хоста не знает. Контрактные тесты (`docs/testing.md §3`) гоняются на всех реализациях одним набором.
 */
export interface ReviewHost extends ReviewSource {

    /** Разовое чтение тредов — текущее состояние без подписки. */
    getThreads(): Promise<Thread[]>;

    /**
     * Подписка на треды: колбэк получает полный снапшот при каждом изменении
     * (и один раз сразу после подписки). Транспорт — деталь адаптера; общий
     * знаменатель хостов — поллинг, поэтому реактивность
     * не гарантируется, только сходимость.
     */
    watchThreads(onChange: (threads: Thread[]) => void): () => void;

    /**
     * Сохранить черновик в хост немедленно (двухступенчатая модель). Возвращает созданный комментарий.
     * `idempotencyKey` — ключ повтора из буфера черновиков: повтор с тем же ключом
     * не должен создать второй комментарий. Хост без такой ручки ключ игнорирует.
     */
    saveDraft(draft: CommentDraft, options?: { idempotencyKey?: string }): Promise<Comment>;

    /**
     * Правка своего черновика. `issue` передаётся только при `capabilities.commentIssues`,
     * у любого комментария, включая ответы; undefined — статус не менять.
     */
    updateDraft(commentId: HostId, body: string, issue?: boolean): Promise<void>;

    deleteDraft(commentId: HostId): Promise<void>;

    /**
     * Resolve уровня треда — для хостов без `capabilities.commentResolve`. У хоста с резолвом
     * по комментарию метод остаётся и действует на корень треда.
     */
    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void>;

    /**
     * Resolve отдельного комментария с issue. Наличие метода обязано совпадать с
     * `capabilities.commentResolve` (контрактный набор проверяет). Закрытие комментария без issue —
     * ошибка хоста, не тихий успех.
     */
    setCommentResolved?(commentId: HostId, resolved: boolean): Promise<void>;

    /**
     * Правка и удаление своего опубликованного комментария. Наличие обоих методов обязано совпадать
     * с `capabilities.editPublished` (контрактный набор проверяет). Удаление опубликованного у хоста
     * может быть мягким — наружу такой комментарий больше не отдаётся. Черновики ходят через
     * `updateDraft`/`deleteDraft` и буфер черновиков, сюда не попадают.
     */
    updateComment?(commentId: HostId, body: string, issue?: boolean): Promise<void>;
    deleteComment?(commentId: HostId): Promise<void>;

/**
     * Опубликовать свои черновики пакетом и применить вердикт.
     * Вердикт вне `capabilities.publishVerdicts` хост отклоняет, ничего не публикуя.
     * Вердикт применяется только если опубликовались все (`docs/architecture.md`);
     * у `comment` применять нечего — `verdictApplied` значит «опубликовались все». `comment` без
     * черновиков ничего не делает: `{ publishedCommentIds: [], failed: [], verdictApplied: true }`.
     * Итоговое состояние PR результат не несёт — перечитывается через `getPr`.
     */
    publishBatch(verdict: Verdict): Promise<PublishResult>;

    /**
     * Синхронизация «просмотрено» с хостом. Наличие метода обязано совпадать
     * с `capabilities.fileViewedSync` — это проверяет контрактный набор.
     */
    setFileViewed?(fileId: HostId, viewed: boolean): Promise<void>;

    /**
     * Чем хост называет источник зон ответственности в подписях UI («Мои файлы · CODEOWNERS»):
     * имя файла правил или то, откуда зона берётся у локального ревью. UI его не переводит.
     * null — у хоста нет понятия ownership; тогда и `ownershipLens` отдаёт null.
     */
    readonly ownershipSource: string | null;

    /**
     * Линза «мои файлы» (CODEOWNERS или аналог хоста); null — у хоста нет понятия ownership.
     * `zones` линзы — все зоны PR с границами и владельцами (не только зоны
     * ревьюера); null — реализация различает лишь членство «моё/не моё».
     */
    ownershipLens(): Promise<Lens | null>;

    /** Дополнительные линзы хоста (PCI DSS — только Арканум). */
    extraLenses(): Promise<Lens[]>;
}

/** Источник кода и закреплённых ревизий без возможностей публикации ревью. */
export interface ReviewSource {

    getPr(): Promise<PrMeta>;


    /**
     * Итерации PR в порядке появления, активная — последняя и ровно одна. Статусы —
     * только `active`/`previous`: `gone` адаптер не отдаёт (см. `iterationStatusSchema`).
     * Без `capabilities.iterations` — список из одной активной итерации.
     */
    listIterations(): Promise<Iteration[]>;


    /**
     * Дифф итерации. Без аргументов — активная итерация хоста; `{base, head}` — срез
     * между двумя перечисленными итерациями (интердифф: что изменилось от `base` к `head`),
     * аргументы — их `diffId`. Срез с неизвестной итерацией или без
     * `capabilities.iterations` отклоняется понятной ошибкой. Пути файлов среза —
     * подмножество объединения путей обеих итераций.
     */
    getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff>;


    /**
     * Подписка на итерации: колбэк получает полный список при каждом изменении
     * (новый пуш, force-push) и один раз сразу после подписки. Транспорт и
     * гарантии — как у `watchThreads` (поллинг, сходимость без реактивности).
     */
    watchIterations(onChange: (iterations: Iteration[]) => void): () => void;


    /**
     * Содержимое файла целиком по обе стороны диффа — для «Expand context».
     * Наличие метода обязано совпадать с `capabilities.fileContent` (контрактный
     * набор проверяет). null — содержимого нет именно у этого файла (binary,
     * слишком большой) — UI дизейблит расширение для него.
     */
    getFileContent?(fileId: HostId): Promise<FileContent | null>;


    /** Контекст схемы по точной ревизии; null — текст недоступен. Без подмены текущим checkout. */
    getSourceAtRevision?(path: string, revision: string): Promise<string | null>;


    /**
     * Байты по `ImageSide.blobId` — для карточки-картинки. Наличие метода обязано совпадать
     * с `capabilities.blobs` (контрактный набор проверяет). null — хост не знает такого
     * блоба или сторона больше `IMAGE_BLOB_MAX_BYTES`. Формат байтов хост не проверяет:
     * тип для ответа сервер определяет по магическим байтам сам.
     */
    getBlob?(blobId: HostId): Promise<Uint8Array | null>;
}
