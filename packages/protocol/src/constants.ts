/**
 * Лимиты и тайминги протокола (`docs/protocol.md §5, §7`; `docs/architecture.md §7.5`).
 * Это дефолты контракта: сервер может переопределить их конфигом, но семантика неизменна.
 */

/** Лимит результата `complete`; больше — задача завершается ошибкой с понятным текстом. */
export const RESULT_MAX_BYTES = 256 * 1024;

/** Окно одного long-poll `worker next`; по его исчерпании CLI перезапрашивает сам. */
export const LONG_POLL_DEFAULT_SECONDS = 240;

/**
 * Молчание с арендой дольше этого срока → воркер считается мёртвым.
 * На ожидание в `next` не влияет: пока вызов висит, его открытое соединение и есть признак жизни
 * (`docs/protocol.md §7`) — долгое ожидание не делает воркера мёртвым.
 */
export const WORKER_DEAD_AFTER_SECONDS = 360;

/**
 * Грейс ухода UI: `done` уходит воркеру, когда последнее UI-подключение закрыто дольше этого
 * срока. Перезагрузка страницы, переход между вкладками, сон ноутбука и моргнувшая
 * сеть рвут SSE на секунды — это не уход ревьюера, поэтому меньше минуты ставить нельзя.
 */
export const UI_GONE_GRACE_SECONDS = 60;

/** TTL аренды по классам приоритета. */
export const LEASE_TTL_SECONDS = { interactive: 600, background: 1800 } as const;

/** Попыток на задачу; исчерпаны — задача уходит в ошибку, видимую в UI. */
export const MAX_TASK_ATTEMPTS = 3;

/**
 * Лимит стороны картинки в диффе (`ImageSide.size`): больше — UI не грузит сторону и предлагает
 * скачать у хоста, `getBlob` хоста отвечает null. Порядок — как у текстового содержимого файла.
 */
export const IMAGE_BLOB_MAX_BYTES = 10_000_000;

/** Лимит текста `task progress` — это статусная строка для UI, не результат. */
export const PROGRESS_TEXT_MAX_CHARS = 500;

/**
 * Лимит поручения на исход локального ревью (`devflow-diff-explain up --local --verdicts <instruction>`): оно
 * дословно печатается в задаче `review.feedback`, а это просьба пользователя, не документ.
 */
export const VERDICTS_INSTRUCTION_MAX_CHARS = 2000;

/**
 * Пути воркерских ручек — часть контракта CLI↔сервер (`docs/protocol.md §3`).
 * Все — POST с JSON-телом соответствующей схемы из `messages.ts`.
 */
export const WORKER_ENDPOINTS = {
    register: '/api/worker/register',
    next: '/api/worker/next',
    complete: '/api/task/complete',
    progress: '/api/task/progress',
    fail: '/api/task/fail',
} as const;
