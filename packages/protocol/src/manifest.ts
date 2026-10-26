import { z } from 'zod';

import { semverSchema } from './version.js';

/**
 * Ключ PR вида `<host>-<pr>`: имя манифеста и каталога стейта в `~/.sherpa/prs/`.
 * Алфавит ограничен, потому что ключ подставляется в пути — иначе он уводит запись из `~/.sherpa`.
 * Проверяют обе стороны: сервер перед созданием стейта, CLI перед чтением манифеста.
 */
export const prKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export type PrKey = z.infer<typeof prKeySchema>;

/**
 * Манифест discovery: `~/.sherpa/servers/<prKey>.json`, права файла 0600 (`docs/protocol.md §8`).
 * CLI резолвит PR из cwd или `SHERPA_PR` → манифест → порт + токен; агент не знает ни того, ни другого.
 * Протухший манифест (PID мёртв) чистится при следующем запуске скилла.
 */
export const serverManifestSchema = z.object({
    prKey: prKeySchema,
    port: z.number().int().min(1).max(65535),
    /** Имя или адрес из ссылки UI; старые манифесты без поля остаются локальными. */
    uiHost: z.string().min(1).optional(),
    pid: z.number().int().positive(),
    token: z.string().min(1),
    protocolVersion: semverSchema,
    serverVersion: semverSchema,
    createdAt: z.iso.datetime(),
});
export type ServerManifest = z.infer<typeof serverManifestSchema>;
