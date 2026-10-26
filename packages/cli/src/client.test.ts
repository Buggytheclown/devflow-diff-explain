import { LONG_POLL_DEFAULT_SECONDS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { NEXT_TIMEOUT_MS, requestNext } from './client.js';
import { CliError } from './errors.js';

/**
 * Клиент обрывает `next` позже сервера: ответ на исчерпанном окне уже в пути, и рвать его —
 * значит потерять выданную задачу.
 */
describe('таймаут клиента для next', () => {
    it('переживает серверное окно с запасом, но остаётся конечным', () => {
        expect(NEXT_TIMEOUT_MS).toBe((LONG_POLL_DEFAULT_SECONDS + 30) * 1000);
    });
});

/**
 * Транспорт `next` собирает запрос сам, и сборка может сорваться до выхода в сеть — например,
 * на битом токене из манифеста. Для вызывающего это такая же недоступность сервера,
 * как отказ сокета: наружу должен идти готовый текст, а не сырая ошибка Node.
 */
describe('транспорт next: отказ до выхода в сеть', () => {
    it('битый токен в манифесте — CliError о недоступном сервере', async () => {
        const connection = {
            prKey: 'fixture-medium',
            port: 1,
            token: 'broken\ntoken',
            workerId: 'w-1',
        };

        const failure = await requestNext(connection).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CliError);
        expect((failure as CliError).message).toContain('fixture-medium');
    });
});
