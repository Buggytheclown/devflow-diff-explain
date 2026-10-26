import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyReviewData, fileThreadsStore } from './threads-store.js';

describe('файловое хранилище тредов', () => {
    let dir: string;
    let filePath: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-threads-'));
        filePath = path.join(dir, 'state', 'local-review.json');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('файла нет — пустое ревью, запись создаёт каталог и файл под 0600', async () => {
        const store = fileThreadsStore(filePath);
        expect(await store.read()).toEqual(emptyReviewData());

        const data = emptyReviewData();
        data.nextId = 7;
        data.verdict = { verdict: 'ship', diffId: 'deadbeef' };
        await store.write(data);

        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        expect(await store.read()).toEqual(data);
        // Временный файл записи не остаётся рядом с результатом.
        expect(fs.readdirSync(path.dirname(filePath))).toEqual(['local-review.json']);
    });

    it('файл, записанный до `avatarUrl`, читается: фото у автора — null', async () => {
        const author = { login: 'alice', displayName: null, bot: false };
        const root = {
            id: 'c1',
            author,
            body: 'текст',
            draft: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            editedAt: null,
            idempotencyKey: null,
            replies: [],
        };
        const thread = {
            id: 't1',
            anchor: null,
            fileId: null,
            fileHash: null,
            resolved: false,
            resolvedBy: null,
            pinnedTo: null,
            root,
        };
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ nextId: 2, verdict: null, threads: [thread], rounds: [] }));

        const data = await fileThreadsStore(filePath).read();
        expect(data.threads[0]?.root.author).toEqual({ ...author, avatarUrl: null });
    });

    it('чужой формат — ошибка с путём, а не молчаливый чистый лист', async () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '{"nextId":"много"}');

        await expect(fileThreadsStore(filePath).read()).rejects.toThrow(filePath);
    });
});
