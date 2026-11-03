import type { FileContent, HostId, Iteration, PrDiff, PrMeta } from './review.js';

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
