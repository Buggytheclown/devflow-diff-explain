import { z } from 'zod';

import { localeSchema } from './locale.js';

import { PROGRESS_TEXT_MAX_CHARS, RESULT_MAX_BYTES, VERDICTS_INSTRUCTION_MAX_CHARS } from './constants.js';
import { leaseSchema, taskIdSchema, taskSchema } from './task.js';
import { semverSchema } from './version.js';

/**
 * Поручение пользователя на исход локального ревью (`--verdicts <instruction>`): его словами,
 * непустое, в пределах `VERDICTS_INSTRUCTION_MAX_CHARS`.
 */
export const verdictsInstructionSchema = z
    .string()
    .max(VERDICTS_INSTRUCTION_MAX_CHARS)
    .refine((value) => value.trim() !== '', 'the instruction is empty');

/** Идентификатор сессии-воркера; генерируется на стороне скилла/CLI при старте сессии. */
export const workerIdSchema = z.string().min(1).max(128);
export type WorkerId = z.infer<typeof workerIdSchema>;

/**
 * Общая часть всех воркерских запросов. Версии — в каждом вызове: CLI не хранит состояние
 * между запусками, рукопожатие (`docs/protocol.md §9`) происходит на каждом запросе и стоит копейки.
 * Каждый такой запрос — отметка живости (`docs/protocol.md §7`).
 */
const workerRequestBase = z.object({
    protocolVersion: semverSchema,
    cliVersion: semverSchema,
    workerId: workerIdSchema,
});

/**
 * `devflow-diff-explain worker register` — регистрация сессии воркером PR при старте скилла (`docs/protocol.md §7`).
 * Новая сессия всегда права: регистрация со свежим workerId перехватывает слот даже у живого
 * воркера (`docs/architecture.md §7.7`), аренды вытесненного возвращаются в очередь сразу;
 * тот же workerId — идемпотентное продление. `worker_conflict` регистрация не кидает — его получает
 * вытесненная сессия на своих последующих вызовах.
 */
export const workerRegisterRequestSchema = workerRequestBase.extend({
    /** Метка харнеса для статуса в UI («claude-code», «codex»); свободная строка. */
    harness: z.string().min(1).max(64).optional(),
    /** Имя модели воркера для статуса в UI («claude-opus-5», «gpt-5»); свободная строка, модель называет себя сама. */
    model: z.string().min(1).max(64).optional(),
    /**
     * Подсказка языка: на каком языке пользователь общается с агентом —
     * UI берёт его, если ревьюер не выбрал язык явно. Отсутствует — агент не определил,
     * UI смотрит на язык браузера.
     */
    lang: localeSchema.optional(),
    /**
     * Режим вердиктов локального ревью от `devflow-diff-explain up --local`: строка — Ship и Request changes
     * с поручением пользователя на исход ревью (`--verdicts <instruction>`), null — только Comment.
     * Живой сервер переключается на режим последнего `up`. Нет поля — режим не меняется: так
     * регистрируются `worker register` и ревью PR.
     */
    localVerdicts: verdictsInstructionSchema.nullable().optional(),
});
export type WorkerRegisterRequest = z.infer<typeof workerRegisterRequestSchema>;

export const workerRegisterResponseSchema = z.object({
    kind: z.literal('registered'),
    message: z.string(),
    /**
     * Поручение, которое сервер применил по `localVerdicts` запроса (null — режим снят). Нет поля —
     * сервер режим не применял: запрос его не называл, хост не локальный или сервер старше этого поля.
     */
    localVerdicts: verdictsInstructionSchema.nullable().optional(),
});
export type WorkerRegisterResponse = z.infer<typeof workerRegisterResponseSchema>;

/**
 * Состояние воркера PR глазами сервера (`docs/protocol.md §7`): его показывает UI.
 * `disconnected` — от последнего вызова CLI прошло больше `WORKER_DEAD_AFTER_SECONDS`.
 */
export const workerStatusSchema = z.discriminatedUnion('kind', [
    /** Воркер на этом PR ещё ни разу не регистрировался. */
    z.object({ kind: z.literal('never') }),
    z.object({
        kind: z.literal('connected'),
        workerId: workerIdSchema,
        harness: z.string().optional(),
        model: z.string().optional(),
        lang: localeSchema.optional(),
        registeredAt: z.iso.datetime(),
        lastSeenAt: z.iso.datetime(),
    }),
    z.object({
        kind: z.literal('disconnected'),
        workerId: workerIdSchema,
        harness: z.string().optional(),
        model: z.string().optional(),
        lang: localeSchema.optional(),
        registeredAt: z.iso.datetime(),
        lastSeenAt: z.iso.datetime(),
    }),
]);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

/**
 * `devflow-diff-explain worker next` — long-poll за следующей задачей. Окно назначает сервер
 * (`LONG_POLL_DEFAULT_SECONDS`); ждать дольше CLI умеет сам, перезапрашивая.
 */
export const workerNextRequestSchema = workerRequestBase;
export type WorkerNextRequest = z.infer<typeof workerNextRequestSchema>;

export const workerNextResponseSchema = z.discriminatedUnion('kind', [
    /** Задача выдана в аренду. При живой аренде повторный `next` возвращает ту же задачу. */
    z.object({ kind: z.literal('task'), task: taskSchema, lease: leaseSchema }),
    /** Задач нет, long-poll вернулся по таймауту — вызови `next` снова. */
    z.object({ kind: z.literal('idle'), message: z.string() }),
    /**
     * Работа воркера окончена (DONE) — сессия может завершаться. Причина едет человекочитаемым
     * текстом в `message` (например «ревьюер закрыл вкладку») — воркер передаёт её человеку;
     * машинного поля причины нет: харнес ведёт себя одинаково при любой.
     */
    z.object({ kind: z.literal('done'), message: z.string() }),
]);
export type WorkerNextResponse = z.infer<typeof workerNextResponseSchema>;

/** `devflow-diff-explain task complete <id> --file <path>` — CLI передаёт содержимое файла результата. */
export const taskCompleteRequestSchema = workerRequestBase.extend({
    taskId: taskIdSchema,
    result: z.string().refine(
        (value) => new TextEncoder().encode(value).byteLength <= RESULT_MAX_BYTES,
        { message: `результат больше ${String(RESULT_MAX_BYTES)} байт — задача будет завершена ошибкой` },
    ),
});
export type TaskCompleteRequest = z.infer<typeof taskCompleteRequestSchema>;

export const taskCompleteResponseSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('accepted'), message: z.string() }),
    /** Fail-closed валидация результата не прошла: список ошибок в промпт-формате — исправь и вызови снова. */
    z.object({ kind: z.literal('rejected'), errors: z.array(z.string()).min(1) }),
    /** Задача уже закрыта — повторный вызов, no-op (`docs/protocol.md §5`, идемпотентность). */
    z.object({ kind: z.literal('noop'), message: z.string() }),
]);
export type TaskCompleteResponse = z.infer<typeof taskCompleteResponseSchema>;

/** `devflow-diff-explain task progress <id> --text` — дешёвая статусная отметка, UI показывает «агент работает: …». */
export const taskProgressRequestSchema = workerRequestBase.extend({
    taskId: taskIdSchema,
    text: z.string().min(1).max(PROGRESS_TEXT_MAX_CHARS),
});
export type TaskProgressRequest = z.infer<typeof taskProgressRequestSchema>;

/** `devflow-diff-explain task fail <id> --reason` — явный отказ; задача уходит в ошибку с причиной, видимой в UI. */
export const taskFailRequestSchema = workerRequestBase.extend({
    taskId: taskIdSchema,
    reason: z.string().min(1),
});
export type TaskFailRequest = z.infer<typeof taskFailRequestSchema>;

/** Общий ответ для progress/fail: принято либо no-op по уже закрытой задаче. */
export const taskAckResponseSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('accepted') }),
    z.object({ kind: z.literal('noop'), message: z.string() }),
]);
export type TaskAckResponse = z.infer<typeof taskAckResponseSchema>;

/**
 * Коды ошибок RPC. Тексты ошибок человекочитаемы: их видит и модель в выводе CLI,
 * и ревьюер в UI (`docs/protocol.md §9`).
 */
export const rpcErrorCodeSchema = z.enum([
    /** Нет или неверный bearer-токен. */
    'unauthorized',
    /** Версии протокола несовместимы — «обнови скилл/сервер». */
    'version_incompatible',
    /** Запрос не прошёл валидацию схемы. */
    'bad_request',
    /** Задачи с таким id нет. */
    'unknown_task',
    /** Запрошенной сущности нет (блоб картинки) — не ошибка хоста и не ошибка запроса. */
    'not_found',
    /** Задача не в аренде у этого воркера. */
    'lease_not_held',
    /** Слот воркера у другой (более новой) живой сессии — вызывающему пора остановить петлю. */
    'worker_conflict',
    /** Результат `complete` превысил лимит — задача завершена ошибкой (`docs/architecture.md §7.5`). */
    'result_too_large',
    /** prKey этого сервера не отображается ни на один хост — ревью-ручки недоступны. */
    'no_review_host',
    /** Хост-адаптер не смог: сеть, токен, ответ не прошёл схему. Текст — человекочитаемая причина. */
    'host_unavailable',
    /** Внутренняя ошибка сервера — не вина вызывающего, повтор может помочь. */
    'internal',
]);
export type RpcErrorCode = z.infer<typeof rpcErrorCodeSchema>;

export const rpcErrorSchema = z.object({
    error: z.object({
        code: rpcErrorCodeSchema,
        message: z.string().min(1),
        /** Детали списком — например, ошибки валидации по полям. */
        details: z.array(z.string()).optional(),
    }),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;
