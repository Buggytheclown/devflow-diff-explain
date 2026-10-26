import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diffKeyOf, SharedPayloadStore } from './shared-payload.js';
import { mediumDiff } from './route/fixture-support.js';

describe('общий каталог payload', () => {
    let sharedDir: string;
    let store: SharedPayloadStore;
    /** Контекст ещё читаемых задач: чистка обязана сохранить их ключи. */
    let openContextFiles: string[];

    beforeEach(async () => {
        sharedDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-shared-')), 'shared');
        openContextFiles = [];
        store = new SharedPayloadStore(sharedDir, () => openContextFiles);
    });

    afterEach(async () => {
        await fs.promises.rm(path.dirname(sharedDir), { recursive: true, force: true });
    });

    it('ключ диффа — пара коммитов; путь стабилен и файл пишется один раз', () => {
        const diff = mediumDiff();
        const key = diffKeyOf(diff);

        expect(key).toBe(`${diff.baseCommit}-${diff.headCommit}`);
        const first = store.prDiff(key, 'первый текст');
        // Записанное по ключу не переписывается: путь общий и во времени.
        const second = store.prDiff(key, 'другой текст');

        expect(second).toBe(first);
        expect(first).toBe(path.join(sharedDir, 'diff', key, 'pr-diff.md'));
        expect(fs.readFileSync(first, 'utf8')).toBe('первый текст');
    });

    it('методичка адресуется хешем содержимого: новый текст — новый путь', () => {
        const first = store.guide('chat-guide', 'старая методичка');
        const second = store.guide('chat-guide', 'новая методичка');

        expect(first).not.toBe(second);
        expect(path.basename(first)).toMatch(/^chat-guide-[0-9a-f]{8}\.md$/);
        expect(fs.readFileSync(first, 'utf8')).toBe('старая методичка');
        expect(fs.readFileSync(second, 'utf8')).toBe('новая методичка');
        expect(store.guide('chat-guide', 'старая методичка')).toBe(first);
    });

    it('сторона файла адресуется fileId и стороной, а имя пути безопасно', () => {
        const first = store.fileSide('k1', 'src/../weird path/main.ts', 'new', 'текст');
        const second = store.fileSide('k1', 'src/../weird path/main.ts', 'new', 'другой текст');
        const other = store.fileSide('k1', 'src/../weird path/main.ts', 'old', 'старая сторона');

        expect(second).toBe(first);
        expect(other).not.toBe(first);
        expect(path.dirname(first)).toBe(path.join(sharedDir, 'diff', 'k1', 'files'));
        expect(path.basename(first)).not.toContain('/');
        expect(path.basename(first)).toMatch(/\.new\.md$/);
        expect(fs.readFileSync(first, 'utf8')).toBe('текст');
    });

    it('смена ключа заводит новый каталог и убирает прежний', () => {
        const before = store.prDiff('base-head', 'старый дифф');
        const after = store.prDiff('base-head2', 'новый дифф');

        expect(fs.existsSync(before)).toBe(false);
        expect(fs.existsSync(after)).toBe(true);
        expect(fs.readdirSync(path.join(sharedDir, 'diff'))).toEqual(['base-head2']);
    });

    it('смена ключа щадит дифф, который ещё читает открытая задача', () => {
        const held = store.prDiff('base-head', 'дифф открытой задачи');
        openContextFiles = [held, '/tmp/somewhere/else.md'];

        const after = store.prDiff('base-head2', 'новый дифф');

        expect(fs.readFileSync(held, 'utf8')).toBe('дифф открытой задачи');
        expect(fs.existsSync(after)).toBe(true);
        // Задача закрылась — следующая смена ключа уносит её каталог.
        openContextFiles = [];
        store.prDiff('base-head3', 'ещё дифф');

        expect(fs.existsSync(held)).toBe(false);
    });

    it('срез между итерациями присоединяется к сборке диффа, а не начинает свою', () => {
        const diff = store.prDiff('base-head', 'дифф итерации');
        const slice = store.interdiff('headA-headB', 'срез между итерациями');

        expect(slice).toBe(path.join(sharedDir, 'diff', 'headA-headB', 'interdiff.md'));
        // Оба каталога живы: задачи этой сборки ещё не поставлены, держать их некому.
        expect(fs.existsSync(diff)).toBe(true);
        expect(fs.existsSync(slice)).toBe(true);

        // Новый дифф итерации начинает новую сборку — прежние каталоги уходят.
        store.prDiff('base-head2', 'дифф после пуша');
        expect(fs.existsSync(diff)).toBe(false);
        expect(fs.existsSync(slice)).toBe(false);
    });

    it('срез щадится чисткой, пока на него ссылается открытая задача', () => {
        store.prDiff('base-head', 'дифф итерации');
        const slice = store.interdiff('headA-headB', 'срез между итерациями');
        openContextFiles = [slice];

        store.prDiff('base-head2', 'дифф после пуша');

        expect(fs.existsSync(slice)).toBe(true);
    });

    it('чистка на старте оставляет ключи, на которые ссылаются задачи', () => {
        const kept = store.prDiff('base-head', 'нужный дифф');
        // Второй ключ заводится в обход чистки по смене: так его увидел бы прошлый процесс.
        const stale = path.join(sharedDir, 'diff', 'old-key');
        fs.mkdirSync(stale, { recursive: true });
        fs.writeFileSync(path.join(stale, 'pr-diff.md'), 'прежний дифф');
        openContextFiles = [kept, '/tmp/somewhere/else.md'];

        store.sweepDiffKeys();

        expect(fs.existsSync(kept)).toBe(true);
        expect(fs.existsSync(stale)).toBe(false);
    });

    it('каталоги и файлы приватные: 0700 и 0600', () => {
        const file = store.prDiff('base-head', 'дифф');

        expect(fs.statSync(sharedDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('временных файлов после записи не остаётся', () => {
        store.prDiff('base-head', 'дифф');
        store.fileSide('base-head', 'f-main', 'new', 'файл');

        expect(fs.readdirSync(path.join(sharedDir, 'diff', 'base-head'))).toEqual(['files', 'pr-diff.md']);
        expect(fs.readdirSync(path.join(sharedDir, 'diff', 'base-head', 'files'))).toHaveLength(1);
    });
});
