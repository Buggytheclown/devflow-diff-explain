import { z } from 'zod';

import { semverSchema } from './version.js';

/** Лимит фразы `whatsNew`: тост показывает её в две строки с обрезкой. */
export const DISTRIBUTION_WHATS_NEW_MAX_CHARS = 140;

/**
 * `version.json` дистрибутива: источник истины для проверки
 * «вышла ли новая версия». Сборка (`build.mjs`) пишет `version` и `builtFrom`, команда релиза
 * дописывает `releasedAt` и `whatsNew`; сервер читает файл из trunk и сравнивает с зашитой версией.
 * Поля релиза nullable: `dist/` до релиза — тот же файл без них.
 */
export const distributionVersionSchema = z.object({
    version: semverSchema,
    /** Идентификатор исходников сборки: хеш HEAD в arc, `-dirty` при незакоммиченных правках; null — вне Аркадии. */
    builtFrom: z.string().nullable(),
    releasedAt: z.iso.datetime().nullable(),
    /** Одна фраза «что нового» для тоста обновления — не changelog. */
    whatsNew: z.string().max(DISTRIBUTION_WHATS_NEW_MAX_CHARS).nullable(),
});
export type DistributionVersion = z.infer<typeof distributionVersionSchema>;
