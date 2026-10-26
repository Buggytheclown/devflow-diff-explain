import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FileDiff, PrDiff } from '@sherpa/protocol';
import { prDiffSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { walkPatch } from '../../route/diff-index.js';

import { arcVcs } from './arc-vcs.js';
import { FakeArc } from './fake-arc.js';
import type { LocalIterationRecord, LocalIterationsStore } from './iterations-store.js';
import { fileIterationsStore, MAX_LOCAL_ITERATIONS, memoryIterationsStore } from './iterations-store.js';
import type { LocalHostOptions } from './local-host.js';
import { LocalHost } from './local-host.js';
import { MAX_FILE_BYTES } from './snapshot.js';
import { memoryThreadsStore } from './threads-store.js';
import type { CommandRunner } from './vcs.js';

/**
 * История итераций локального хоста и срез между двумя из них: чем живут перенос прогресса,
 * якоря заметок и баннер устаревшего маршрута.
 */

const PREFIX = 'app';

function fileOf(diff: PrDiff, filePath: string): FileDiff {
    const file = diff.files.find((candidate) => candidate.path === filePath);
    if (file === undefined) {
        throw new Error(`в срезе нет файла ${filePath}`);
    }
    return file;
}

describe('история итераций локального хоста', () => {
    let root: string;
    let fake: FakeArc;
    let iterations: LocalIterationsStore;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-iters-')));
        fake = new FakeArc({ root, prefix: PREFIX });
        iterations = memoryIterationsStore();
        fake.commit(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n'));
        fake.writeDisk(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 22;', 'const c = 3;', ''].join('\n'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function makeHost(overrides: Partial<LocalHostOptions> = {}): LocalHost {
        return new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations,
            pollIntervalMs: 600_000,
            ...overrides,
        });
    }

    it('правка заводит следующую итерацию, прошлая остаётся в списке', async () => {
        const host = makeHost();
        const first = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 222;', 'const c = 3;', ''].join('\n'));
        await host.refresh();
        const second = (await host.getDiff()).diffId;

        expect(second).not.toBe(first);
        expect((await host.listIterations()).map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [first, 'previous'],
            [second, 'active'],
        ]);
        // Ревьюируемая сторона рабочего дерева — сам дифф: коротких одинаковых голов быть не должно.
        const heads = (await host.listIterations()).map((iteration) => iteration.headCommit.slice(0, 7));
        expect(new Set(heads).size).toBe(2);
    });

    it('подписка получает полный список на каждое изменение', async () => {
        const host = makeHost();
        const seen: string[][] = [];
        const stop = host.watchIterations((list) => seen.push(list.map((iteration) => iteration.diffId)));
        const first = (await host.getDiff()).diffId;
        await expect.poll(() => seen.length).toBeGreaterThan(0);

        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
        await host.refresh();
        const second = (await host.getDiff()).diffId;

        await expect.poll(() => seen.at(-1)).toEqual([first, second]);
        stop();
    });

    it('история переживает пересоздание хоста на том же хранилище', async () => {
        const first = (await makeHost().getDiff()).diffId;
        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 1;\n');

        const revived = makeHost();
        const second = (await revived.getDiff()).diffId;

        expect((await revived.listIterations()).map((iteration) => iteration.diffId)).toEqual([first, second]);
    });

    it('перезапуск на том же дереве поднимает ту же итерацию, а не заводит новую', async () => {
        const first = await makeHost().listIterations();

        const revived = await makeHost().listIterations();

        expect(revived).toEqual(first);
    });

    it('срез правки: модификация с патчем, который читается разметкой ханков', async () => {
        const host = makeHost();
        const base = (await host.getDiff()).diffId;
        fake.writeDisk(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 222;', 'const c = 3;', ''].join('\n'));
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const slice = await host.getDiff({ base, head });

        expect(() => prDiffSchema.parse(slice)).not.toThrow();
        expect(slice.diffId).toBe(head);
        expect(slice.baseCommit).toBe(base);
        const file = fileOf(slice, 'src/a.ts');
        expect(file.changeType).toBe('modify');
        expect(file.fileId).toBe(`slice:${base.slice(0, 12)}:${head.slice(0, 12)}:src/a.ts`);
        expect(file).toMatchObject({ additions: 1, deletions: 1, binary: false });
        // Патч среза читается тем же разборщиком, что и патч итерации: номера строк — новой стороны.
        const changed = [...walkPatch(file.patch ?? '')].filter((line) => line.changed && line.new !== null);
        expect(changed.map((line) => [line.new, line.raw])).toEqual([[2, '+const b = 222;']]);
    });

    it('срез добавления и удаления: файл есть только с одной стороны', async () => {
        const host = makeHost();
        fake.commit(`${PREFIX}/src/gone.ts`, 'export const gone = 1;\n');
        fake.writeDisk(`${PREFIX}/src/gone.ts`, 'export const gone = 2;\n');
        await host.refresh();
        const base = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/src/fresh.ts`, 'export const fresh = 1;\n');
        fake.removeDisk(`${PREFIX}/src/gone.ts`);
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const slice = await host.getDiff({ base, head });

        const added = fileOf(slice, 'src/fresh.ts');
        expect(added.changeType).toBe('add');
        expect(added.patch).toContain('--- /dev/null');
        expect(added.patch).toContain('+export const fresh = 1;');
        expect(added).toMatchObject({ additions: 1, deletions: 0 });

        const removed = fileOf(slice, 'src/gone.ts');
        expect(removed.changeType).toBe('delete');
        expect(removed.patch).toContain('+++ /dev/null');
        expect(removed).toMatchObject({ additions: 0, deletions: 1 });

        // Файл, который между итерациями не трогали, в срез не попадает.
        expect(slice.files.map((file) => file.path)).toEqual(['src/fresh.ts', 'src/gone.ts']);
    });

    it('двоичная сторона едет срезом без патча', async () => {
        const host = makeHost();
        fake.writeDisk(`${PREFIX}/cache.bin`, Buffer.from([0x01, 0x00, 0x02]));
        await host.refresh();
        const base = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/cache.bin`, Buffer.from([0x01, 0x00, 0x03]));
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const file = fileOf(await host.getDiff({ base, head }), 'cache.bin');
        expect(file).toMatchObject({ changeType: 'modify', binary: true, patch: null });
    });

    it('сторона за лимитом размера в срез едет без содержимого', async () => {
        const host = makeHost();
        const base = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/dump.csv`, Buffer.alloc(MAX_FILE_BYTES + 1, 0x41));
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const file = fileOf(await host.getDiff({ base, head }), 'dump.csv');
        expect(file).toMatchObject({ changeType: 'add', binary: true, patch: null });
    });

    it('срез итерации с самой собой пуст', async () => {
        const host = makeHost();
        const only = (await host.getDiff()).diffId;

        const slice = await host.getDiff({ base: only, head: only });

        expect(slice.files).toEqual([]);
        expect(slice.diffId).toBe(only);
    });

    it('отказ хранилища истории не роняет ревью: дифф на месте, срезов нет', async () => {
        const logs: string[] = [];
        const broken: LocalIterationsStore = {
            read: () => Promise.reject(new Error('index.json: EACCES')),
            append: () => Promise.reject(new Error('ENOSPC: no space left on device')),
            blob: () => Promise.resolve(null),
        };
        const host = makeHost({ iterations: broken, log: (message) => logs.push(message) });

        const diff = await host.getDiff();
        expect(diff.files.map((file) => file.path)).toContain('src/a.ts');
        await expect(host.getPr()).resolves.toMatchObject({ id: 'local-arc-app-0badc0de' });
        // Прошлых итераций хост не знает — остаётся одна активная, срез по ней отклоняется.
        expect(await host.listIterations()).toMatchObject([{ diffId: diff.diffId, status: 'active' }]);
        await expect(host.getDiff({ base: 'diff-0', head: diff.diffId })).rejects.toThrow('is unknown');

        expect(logs.join('\n')).toContain('история итераций не прочитана: index.json: EACCES');
        expect(logs.join('\n')).toContain(`итерация ${diff.diffId} не записана в историю: ENOSPC`);
    });

    it('файл, переписанный между диффом и чтением, едет в историю без содержимого', async () => {
        // Правка ложится на диск после диффа: патч снят со старого состояния, а файл уже новый.
        let raced = false;
        const racing: CommandRunner = async (args) => {
            const outcome = await fake.runner(args);
            if (args.includes('--name-status') && !raced) {
                raced = true;
                fake.writeDisk(
                    `${PREFIX}/src/a.ts`,
                    ['const a = 1;', 'const b = 2222222;', 'const c = 3;', ''].join('\n'),
                );
            }
            return outcome;
        };
        const host = makeHost({ vcs: arcVcs(racing) });

        const base = (await host.getDiff()).diffId;
        const recorded = (await iterations.read()).at(-1)?.files.find((file) => file.path === 'src/a.ts');
        expect(recorded?.blob).toBeNull();

        // Содержимое этой стороны неизвестно — срез показывает файл без патча, и отметка
        // «просмотрено» на него не переезжает.
        await host.refresh();
        const head = (await host.getDiff()).diffId;
        expect(fileOf(await host.getDiff({ base, head }), 'src/a.ts')).toMatchObject({
            binary: true,
            patch: null,
        });
    });

    it('неизвестная итерация отклоняется окончательно', async () => {
        const host = makeHost();
        const head = (await host.getDiff()).diffId;

        await expect(host.getDiff({ base: 'no-such-iteration', head })).rejects.toMatchObject({
            code: 'bad_request',
            message: 'iteration no-such-iteration is unknown to the local host',
        });
        await expect(host.getDiff({ base: head, head: 'no-such-iteration' })).rejects.toThrow('is unknown');
    });
});

describe('хранилище истории итераций', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-history-')));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function recordOf(index: number): { record: LocalIterationRecord; blobs: Map<string, Uint8Array> } {
        const text = `line ${String(index)}\n`;
        const blob = String(index).padStart(64, '0');
        return {
            record: {
                diffId: `diff-${String(index)}`,
                baseCommit: 'base',
                headCommit: `diff-${String(index)}`,
                createdAt: new Date(Date.UTC(2026, 8, 12, 0, 0, index)).toISOString(),
                files: [{ path: 'src/a.ts', changeType: 'modify', kind: 'text', hash: `hash-${String(index)}`, blob }],
            },
            blobs: new Map([[blob, new TextEncoder().encode(text)]]),
        };
    }

    it('потолок истории обрезает старые итерации и уносит их блобы', async () => {
        const store = fileIterationsStore(dir);
        for (let index = 0; index < MAX_LOCAL_ITERATIONS + 5; index += 1) {
            const { record, blobs } = recordOf(index);
            await store.append(record, blobs);
        }

        const history = await store.read();
        expect(history).toHaveLength(MAX_LOCAL_ITERATIONS);
        expect(history[0]?.diffId).toBe('diff-5');
        expect(fs.readdirSync(path.join(dir, 'blobs'))).toHaveLength(MAX_LOCAL_ITERATIONS);
        expect(await store.blob('0'.padStart(64, '0'))).toBeNull();
        expect(await store.blob('5'.padStart(64, '0'))).toBe('line 5\n');
    });

    it('повтор того же diffId не удваивает итерацию, а поднимает её в конец', async () => {
        const store = fileIterationsStore(dir);
        const first = recordOf(1);
        const second = recordOf(2);
        await store.append(first.record, first.blobs);
        await store.append(second.record, second.blobs);
        await store.append(first.record, first.blobs);

        expect((await store.read()).map((record) => record.diffId)).toEqual(['diff-2', 'diff-1']);
    });

    it('права истории — только владельцу, а битый индекс не начинает с чистого листа', async () => {
        const store = fileIterationsStore(dir);
        const { record, blobs } = recordOf(1);
        await store.append(record, blobs);

        const indexPath = path.join(dir, 'index.json');
        expect(fs.statSync(indexPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(dir, 'blobs', record.files[0]?.blob ?? '')).mode & 0o777).toBe(0o600);

        fs.writeFileSync(indexPath, 'не json');
        await expect(fileIterationsStore(dir).read()).rejects.toThrow('is not valid JSON');
    });

    it('нечитаемый индекс — отказ, а не пустая история', async () => {
        const store = fileIterationsStore(dir);
        const first = recordOf(1);
        await store.append(first.record, first.blobs);

        // Каталог на месте индекса: чтение отказывает не «файла нет», а `EISDIR`.
        const indexPath = path.join(dir, 'index.json');
        fs.rmSync(indexPath);
        fs.mkdirSync(indexPath);

        await expect(store.read()).rejects.toThrow('EISDIR');
        // Запись начинается с чтения: молча заменить историю одной записью она не должна.
        const second = recordOf(2);
        await expect(store.append(second.record, second.blobs)).rejects.toThrow('EISDIR');
    });
});
