import fs from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDir } from './paths.js';

/**
 * Кэш байтов картинок диффа на диске. `blobId` адресует содержимое, а не файл: одинаковые
 * байты у разных итераций и срезов дают один и тот же ключ, поэтому запись живёт без срока годности.
 *
 * Каталог — `blobs/` внутри стейта PR; имя файла — base64url от `blobId` (id непрозрачный и может
 * содержать `/`). Запись атомарная: временный файл рядом и `rename`, чтобы параллельные запросы
 * одного блоба не читали половину.
 *
 * Кэш не ограничен и не чистится: картинки ревью малы, а каталог живёт ровно столько же, сколько
 * стейт этого PR.
 */
export class BlobCache {
    private readonly sherpaDir: string;
    private readonly dir: string;

    constructor(sherpaDir: string, dir: string) {
        this.sherpaDir = sherpaDir;
        this.dir = dir;
    }

    /** Байты из кэша; null — этого блоба тут нет (или файл читается впервые и его нет вовсе). */
    async read(blobId: string): Promise<Uint8Array | null> {
        try {
            return new Uint8Array(await fs.readFile(this.pathOf(blobId)));
        } catch {
            return null;
        }
    }

    /** Кладёт байты в кэш; провал записи не ошибка вызывающего — блоб он уже получил. */
    async write(blobId: string, bytes: Uint8Array): Promise<void> {
        const target = this.pathOf(blobId);
        const temporary = `${target}.${String(process.pid)}.${String(writeCounter++)}.tmp`;
        try {
            await ensurePrivateDir(this.sherpaDir, this.dir);
            await fs.writeFile(temporary, bytes, { mode: 0o600 });
            await fs.rename(temporary, target);
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
            process.stderr.write(
                `sherpa-server: блоб картинки не записался в кэш: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }

    private pathOf(blobId: string): string {
        return path.join(this.dir, base64url(blobId));
    }
}

/** Счётчик временных имён: два параллельных запроса одного блоба не должны делить tmp-файл. */
let writeCounter = 0;

/** Имя файла из непрозрачного id: слэши и плюсы в путь попадать не должны. */
function base64url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}
