import { z } from 'zod';

import { commentDraftSchema, hostIdSchema } from './review.js';

/**
 * Буфер черновиков (`docs/architecture.md §6` «драфты не теряются никогда»): запись
 * композера, которую сервер принял, но в хост ещё не довёз. Живёт в per-PR SQLite
 * (`draft_buffer`), в стор тредов UI не попадает — это не комментарий, а текст в поле,
 * который переживает перезагрузку вкладки и падение хоста.
 *
 * Жизненный цикл: UI шлёт `clientKey` с каждым save/update → сервер пишет запись
 * (`pending`) → пробует хост → успех: запись удаляется, UI получает `saved`; провал:
 * запись остаётся `failed` с текстом ошибки, повтор — по таймеру сервера и по кнопке.
 */
export const draftBufferStateSchema = z.enum(['pending', 'failed']);
export type DraftBufferState = z.infer<typeof draftBufferStateSchema>;

export const draftBufferEntrySchema = z.object({
    /** `clientKey` композера: UUID, который UI генерирует на первый save и держит до успеха. */
    id: z.string().min(1),
    /**
     * Что записать в хост. Для правки существующего черновика (`commentId !== null`)
     * значимы только `body` и `issue`; `parentId`/`anchor` там null — композер правки
     * рисуется у своего комментария в списке тредов, якорь ему не нужен.
     */
    draft: commentDraftSchema,
    /** null — создание (`saveDraft`); иначе правка своего черновика (`updateDraft`). */
    commentId: hostIdSchema.nullable(),
    state: draftBufferStateSchema,
    /** Текст последней ошибки хоста; null, пока попыток не было или последняя удалась. */
    error: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});
export type DraftBufferEntry = z.infer<typeof draftBufferEntrySchema>;
