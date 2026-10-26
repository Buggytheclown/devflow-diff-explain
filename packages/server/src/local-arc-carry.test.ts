import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UI_ENDPOINTS, uiReviewProgressResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { arcVcs } from './hosts/local/arc-vcs.js';
import { FakeArc } from './hosts/local/fake-arc.js';
import { memoryIterationsStore } from './hosts/local/iterations-store.js';
import { LocalHost } from './hosts/local/local-host.js';
import { memoryThreadsStore } from './hosts/local/threads-store.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Перенос прогресса на живом сервере с локальным хостом: правка одного файла в рабочем дереве
 * не должна снимать отметки просмотра с остальных. Раньше их снимало отсутствие срезов у хоста.
 */

const PR = 'local-arc-app-0badc0de';
const PREFIX = 'app';

describe('прогресс между итерациями локального хоста', () => {
    let sherpaDir: string;
    let checkout: string;
    let server: SherpaServer | null;
    let events: AbortController | null;
    let logged: string[];
    let restoreStderr: (() => void) | null;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-carry-')));
        server = null;
        events = null;
        logged = [];
        restoreStderr = null;
    });

    afterEach(async () => {
        restoreStderr?.();
        events?.abort();
        await server?.close();
        fs.rmSync(checkout, { recursive: true, force: true });
        await removeTempSherpaDir(sherpaDir);
    });

    /** Лог сервера идёт в stderr — читаем его тем же способом, что и человек в `server.log`. */
    function captureStderr(): void {
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
            logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
            return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
        };
        restoreStderr = () => {
            process.stderr.write = original;
        };
    }

    it('правка одного файла не снимает отметку просмотра с другого', async () => {
        captureStderr();
        const fake = new FakeArc({ root: checkout, prefix: PREFIX });
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.commit(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 2;\n');
        const host = new LocalHost({
            prKey: PR,
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });
        server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.1,
            reviewHostFactory: () => ({ name: 'local-arc', host, refresh: () => host.refresh() }),
        });
        // Подписка на итерации ленивая: без открытой вкладки перенос никто не заказывает.
        events = new AbortController();
        const stream = await fetch(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            { signal: events.signal },
        );
        expect(stream.status).toBe(200);

        const before = await host.getDiff();
        const fileA = before.files.find((file) => file.path === 'src/a.ts')?.fileId ?? '';
        const viewed = await postJson(
            server.port,
            UI_ENDPOINTS.reviewFileViewed,
            { fileId: fileA, viewed: true },
            server.token,
        );
        expect(viewed.status).toBe(200);

        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 3;\n');
        await host.refresh();
        const after = await host.getDiff();
        expect(after.diffId).not.toBe(before.diffId);

        const freshA = after.files.find((file) => file.path === 'src/a.ts')?.fileId ?? '';
        const freshB = after.files.find((file) => file.path === 'src/b.ts')?.fileId ?? '';
        await expect
            .poll(async () => (await readProgress(after.diffId)).find((file) => file.fileId === freshA)?.viewed)
            .toBe(true);
        expect((await readProgress(after.diffId)).find((file) => file.fileId === freshB)?.viewed ?? null).toBeNull();
        expect(logged.join('')).toContain(
            `перенос прогресса ${before.diffId} → ${after.diffId}: диапазонов 0, файлов 1`,
        );
    });

    async function readProgress(diffId: string): Promise<{ fileId: string; viewed: boolean | null }[]> {
        const current = server;
        if (current === null) {
            throw new Error('сервер не запущен');
        }
        const response = await get(
            current.port,
            `${UI_ENDPOINTS.reviewProgress}?diffId=${encodeURIComponent(diffId)}`,
            current.token,
        );
        expect(response.status).toBe(200);
        return uiReviewProgressResponseSchema.parse(await response.json()).files;
    }
});
