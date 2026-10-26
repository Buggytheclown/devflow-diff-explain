import fs from 'node:fs';
import path from 'node:path';

import { RpcFailure } from './errors.js';

/** Права файла идентичности и каталога стейта — как у остального стейта PR (docs/architecture.md §6). */
const WORKER_ID_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

/**
 * Публикация владельца слота в файл стейта PR: следующие вызовы сессии берут свою идентичность
 * оттуда, потому что env между вызовами харнеса не живёт.
 *
 * Файл пишет сервер, а не CLI: с перехватом слота обе параллельные сессии
 * получают успешный `register`, и порядок их записей в общий файл определялся бы гонкой сетевых
 * ответов — в файле мог бы остаться id уже вытесненной сессии, а победивший слот ходил бы под
 * чужим id и упирался в `worker_conflict`. Здесь писатель один, запись синхронная и идёт в той же
 * ручке сразу за захватом слота, поэтому порядок записей совпадает с порядком регистраций, а к
 * моменту ответа файл уже верен.
 */
export function writeWorkerIdFile(filePath: string, workerId: string): void {
    try {
        // Каталог стейта PR заведён при старте сервера; досоздаём на случай, если его снесли из-под нас.
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });
        fs.writeFileSync(filePath, `${workerId}\n`, { mode: WORKER_ID_FILE_MODE });
        // writeFileSync применяет mode только при создании файла и с оглядкой на umask — досоздаём права явно.
        fs.chmodSync(filePath, WORKER_ID_FILE_MODE);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new RpcFailure(
            'internal',
            // Следующий шаг допишет CLI по коду ошибки — здесь только факт и куда смотреть.
            `The worker slot is taken by this session, but its identity file ${filePath} could not be ` +
                `written: ${detail}. Without it the next commands of this session would run under ` +
                'another identity — check the permissions on the Sherpa state directory.',
        );
    }
}
