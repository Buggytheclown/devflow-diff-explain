import { z } from 'zod';

import { localeSchema } from './locale.js';
import { hostIdSchema } from './review.js';
import { taskIdSchema } from './task.js';
import { storyExplanationEvidenceSchema } from './story-evidence.js';

    /**
 * Чат с агентом и ИИ-заметки (`docs/spec.md`, сценарий F2). Доменные схемы; ручки и SSE — в `ui.ts`.
 *
 * Модель данных — обмен (вопрос + ответ одной записью), а не лента реплик: статус
 * живёт в одном месте, «ответ без вопроса» непредставим, cancel/retry адресуют одну
 * сущность. В ленту из двух реплик (you/agent, `docs/spec.md`) обмен
 * разворачивает UI.
 */

/**
 * Якорь вопроса и заметки: диапазон строк одной стороны файла диффа (форма — как у
 * якоря стопа маршрута) в конкретной итерации. `path` дублирует `fileId` ради подписи
 * чипа («order_service.py:148–151») и на случай, когда файл ушёл из диффа:
 * подпись переживает потерю резолва. `diffId` — итерация, в которой сделано выделение:
 * сервер строит контекст вопроса из её сохранённого диффа, даже если она уже не активна.
 */
export const chatAnchorSchema = z.object({
    diffId: hostIdSchema,
    fileId: hostIdSchema,
    path: z.string().min(1),
    /** Точная цитата из отображаемого документа; строки остаются общим якорем. */
    selectedText: z.string().min(1).max(4000).optional(),
    side: z.enum(['old', 'new']),
    /** Включительно; `end >= start`. Нумерация — строки файла соответствующей стороны. */
    start: z.number().int().positive(),
    end: z.number().int().positive(),
});
export type ChatAnchor = z.infer<typeof chatAnchorSchema>;

/**
 * Жизненный цикл обмена. `queued` — задача ждёт воркера (в том числе пока
 * генерируется маршрут — очередь честная, `docs/spec.md`); `running` — воркер взял
 * задачу. Терминальные: `done` — ответ принят; `failed` — ошибка или исчерпаны
 * попытки, вопрос сохранён (`docs/spec.md`), `retry` ставит новую задачу; `cancelled` —
 * остановлен ревьюером (воркер, занятый отменённой задачей, узнаёт об отмене при
 * следующем вызове CLI — `docs/protocol.md §5`, UI честно показывает «агент ещё занят»).
 */
export const chatExchangeStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type ChatExchangeStatus = z.infer<typeof chatExchangeStatusSchema>;

export const chatExchangeIdSchema = z.number().int().positive();
export type ChatExchangeId = z.infer<typeof chatExchangeIdSchema>;

export const chatExplanationSchema = z.object({
    snapshotId: z.string().min(1).nullable(),
    diffId: hostIdSchema,
    commit: z.string().min(1),
    sectionId: z.string().min(1).optional(),
    /** Явно прикреплённый файл; версия задаётся diffId/commit всего вопроса. */
    file: z.object({ fileId: hostIdSchema, path: z.string().min(1) }).strict().optional(),
    text: z.string().max(40_000),
    evidence: storyExplanationEvidenceSchema.optional(),
});
export type ChatExplanation = z.infer<typeof chatExplanationSchema>;

export const chatExchangeSchema = z.object({
    explanation: chatExplanationSchema.nullable().optional(),
    id: chatExchangeIdSchema,
    /** Вопрос ревьюера как введён (plain text). */
    question: z.string().min(1),
    /** null — без диапазона; явный файл может быть прикреплён в explanation.file. */
    anchor: chatAnchorSchema.nullable(),
    status: chatExchangeStatusSchema,
    /**
     * Задача очереди, которая отвечает на вопрос (`retry` ставит новую — id меняется). По ней UI
     * находит свою запись в `tasks` снапшота: пока у той `heldByWorker`, агент занят этим
     * вопросом — в том числе отменённым. null — обмен без задачи (обмен пережил её потерю).
     */
    taskId: taskIdSchema.nullable(),
    /** Markdown; только при `done`, иначе null. Токен-стриминга нет — приходит целиком (`docs/protocol.md §6`). */
    answer: z.string().nullable(),
    /** Последняя строка `task progress` — только при `running`, иначе null. */
    progressText: z.string().nullable(),
    /** Ревьюер-читаемая причина — только при `failed`, иначе null. */
    error: z.string().nullable(),
    /** Язык, на котором просили ответить; null — обмен старого формата, ответ русский. */
    locale: localeSchema.nullable().default(null),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});
export type ChatExchange = z.infer<typeof chatExchangeSchema>;

/**
 * ИИ-заметка у кода (`docs/spec.md`): принятый ответ на вопрос с якорем сервер
 * закрепляет заметкой в той же транзакции. Локальна — в бекенд ревью не уходит
 * никогда. `text` — копия ответа: заметка самодостаточна, живёт и удаляется
 * независимо от истории чата. Отметку «закреплено заметкой» у обмена UI выводит
 * поиском по `exchangeId` — после удаления заметки она гаснет сама.
 */
export const agentNoteIdSchema = z.number().int().positive();
export type AgentNoteId = z.infer<typeof agentNoteIdSchema>;

/**
 * Исходный якорь заметки — где она была закреплена при создании. Не меняется:
 * после миграции на новую итерацию `AgentNote.anchor` переезжает, `origin` остаётся.
 * `commit` — ревьюируемый коммит той итерации; null — сервер не смог его определить.
 */
export const agentNoteOriginSchema = z.object({
    commit: z.string().nullable(),
    anchor: chatAnchorSchema,
});
export type AgentNoteOrigin = z.infer<typeof agentNoteOriginSchema>;

export const agentNoteSchema = z.object({
    id: agentNoteIdSchema,
    exchangeId: chatExchangeIdSchema,
    /** Текущий якорь: после пуша сервер переносит его на активную итерацию по интердиффу. */
    anchor: chatAnchorSchema,
    /** Markdown — копия принятого ответа. */
    text: z.string().min(1),
/**
     * Диапазон заметки затронут пушем и якорь перенести не удалось (`docs/spec.md`): заметка
     * уходит из кода, остаётся в чате с пометкой; `anchor` при этом — последний удачный.
     */
    lostAnchor: z.boolean(),
    origin: agentNoteOriginSchema,
    createdAt: z.iso.datetime(),
});
export type AgentNote = z.infer<typeof agentNoteSchema>;
