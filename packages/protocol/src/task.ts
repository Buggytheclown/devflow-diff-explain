import { z } from 'zod';

/**
 * Рабочие задачи объяснения: план, заполнение блоков, схема потока данных и явный вопрос чата.
 * `echo` проверяет петлю в дев-режиме. `review.feedback` читается из прежней очереди,
 * чтобы сервер мог отозвать такую работу при обновлении; новые задачи этого типа не создаются.
 * Неизвестный тип отбивается валидацией — fail-closed.
 */
export const taskTypeSchema = z.enum([
    'echo',
    'route.skeleton',
    'route.section',
    'route.diagram',
    'chat',
    'review.feedback',
]);
export type TaskType = z.infer<typeof taskTypeSchema>;

/** Два класса приоритета (`docs/protocol.md §5`): интерактивные всегда обгоняют фоновые, внутри класса FIFO. */
export const priorityClassSchema = z.enum(['interactive', 'background']);
export type PriorityClass = z.infer<typeof priorityClassSchema>;

/** Идентификатор задачи; в промптах и UI показывается как `sherpa/<id>`. */
export const taskIdSchema = z.number().int().positive();
export type TaskId = z.infer<typeof taskIdSchema>;

/**
 * Задача, выдаваемая воркеру. Самодостаточна (`docs/protocol.md §4`): сессия могла умереть
 * и переподключиться — весь нужный контекст в payload, память сессии — бонус, не контракт.
 */
export const taskSchema = z.object({
    id: taskIdSchema,
    type: taskTypeSchema,
    priority: priorityClassSchema,
    /** Номер попытки, с 1; растёт при возврате задачи в очередь по истечении аренды. */
    attempt: z.number().int().min(1),
    /** Готовый промпт задачи — модель читает его глазами, тяжёлый контекст не сюда. */
    instructions: z.string().min(1),
    /** Абсолютные пути к материализованным сервером файлам контекста (markdown). */
    contextFiles: z.array(z.string().min(1)),
    /** Путь к JSON-схеме результата — только у структурных задач; приёмка валидируется fail-closed. */
    resultSchemaFile: z.string().min(1).optional(),
});
export type Task = z.infer<typeof taskSchema>;

/**
 * Аренда задачи (`docs/protocol.md §5`). Не dequeue: аренда истекла молча — задача возвращается
 * в очередь с инкрементом попытки.
 */
export const leaseSchema = z.object({
    taskId: taskIdSchema,
    ttlSeconds: z.number().int().positive(),
    /** ISO-8601; истина о времени — на сервере, воркеру срок сообщается справочно. */
    expiresAt: z.iso.datetime(),
});
export type Lease = z.infer<typeof leaseSchema>;
