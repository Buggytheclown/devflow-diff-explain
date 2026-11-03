import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { arcVcs, parseArcStatus, parseNameStatus } from './arc-vcs.js';
import { FakeArc } from './fake-arc.js';
import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { isBinaryContent, synthesizeAddPatch } from './patch.js';
import { MAX_FILE_BYTES } from './snapshot.js';
import type { CommandRunner } from './vcs.js';

const PREFIX = 'app';

/** Ждёт условия: опрос живёт своим таймером, фиксированная пауза здесь была бы гаданием. */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`не дождались: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe('патч неотслеживаемого файла', () => {
    it('текст едет одним ханком «добавлено целиком»', () => {
        const patch = synthesizeAddPatch('src/new.ts', Buffer.from('const a = 1;\nconst b = 2;\n'));

        expect(patch).toBe(
            [
                'diff --git a/src/new.ts b/src/new.ts',
                'new file mode 100644',
                '--- /dev/null',
                '+++ b/src/new.ts',
                '@@ -0,0 +1,2 @@',
                '+const a = 1;',
                '+const b = 2;',
                '',
            ].join('\n'),
        );
    });

    it('файл без перевода строки в конце помечается как в git', () => {
        const patch = synthesizeAddPatch('a.txt', Buffer.from('one\ntwo'));

        expect(patch).toContain('@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n');
    });

    it('пустой файл — заголовок без ханка', () => {
        expect(synthesizeAddPatch('empty.txt', Buffer.alloc(0))).toBe(
            'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n--- /dev/null\n+++ b/empty.txt\n',
        );
    });

    it('двоичное содержимое патча не получает вовсе', () => {
        expect(isBinaryContent(Buffer.from([0x01, 0x00, 0x02]))).toBe(true);
        expect(synthesizeAddPatch('logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBeNull();
    });

    // Нулевой байт ищется только в начале файла: читать гигабайтный дамп целиком незачем.
    it('нулевой байт за пределами пробы двоичным файл не делает', () => {
        const content = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);

        expect(isBinaryContent(content)).toBe(false);
    });
});

describe('разбор вывода arc', () => {
    it('status: чистое дерево печатает пустой объект', () => {
        expect(parseArcStatus('{"status":{}}')).toEqual({ changed: [], untracked: [] });
    });

    it('status: изменения и неотслеживаемые файлы путями от корня чекаута', () => {
        const status = parseArcStatus(
            JSON.stringify({
                status: {
                    changed: [{ status: 'modified', type: 'file', path: 'junk/app/README.md' }],
                    untracked: [
                        { status: 'untracked', type: 'file', path: 'junk/app/new/note.md' },
                        { status: 'untracked', type: 'directory', path: 'junk/app/other' },
                    ],
                },
            }),
        );

        expect(status.changed).toEqual([{ status: 'modified', path: 'junk/app/README.md' }]);
        // Каталог означал бы, что arc в него не заглянул: диффу нужны файлы.
        expect(status.untracked).toEqual(['junk/app/new/note.md']);
    });

    it('status: нечитаемый вывод — ошибка, а не пустое дерево', () => {
        expect(() => parseArcStatus('not json')).toThrow('arc status');
    });

    // Живой `arc` добивает букву статуса пробелами до колонки, табом её не отделяет.
    it('name-status: буква статуса отделена пробелами', () => {
        expect(parseNameStatus('M       README.md\nA       src/new.ts\nD       src/old.ts\n')).toEqual([
            { changeType: 'modify', path: 'README.md', oldPath: null },
            { changeType: 'add', path: 'src/new.ts', oldPath: null },
            { changeType: 'delete', path: 'src/old.ts', oldPath: null },
        ]);
    });

    it('name-status: переименование несёт прежний путь, копия — нет', () => {
        expect(parseNameStatus('R100\tsrc/old.ts\tsrc/new.ts\nC75\tsrc/a.ts\tsrc/b.ts\n')).toEqual([
            { changeType: 'move', path: 'src/new.ts', oldPath: 'src/old.ts' },
            { changeType: 'copy', path: 'src/b.ts', oldPath: null },
        ]);
    });

    it('name-status: пробел внутри пути разделителем не считается', () => {
        expect(parseNameStatus('M       docs/my notes.md\n')).toEqual([
            { changeType: 'modify', path: 'docs/my notes.md', oldPath: null },
        ]);
    });
});

describe('локальный хост на рабочем дереве', () => {
    let root: string;
    let fake: FakeArc;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-unit-')));
        fake = new FakeArc({ root, prefix: PREFIX });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function makeHost(
        overrides: { branch?: string | null } = {},
    ): LocalHost {
        return new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: overrides.branch === undefined ? fake.branch : overrides.branch,
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });
    }

    it('в диффе и правка, и неотслеживаемый файл, а чужой каталог — нет', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        fake.writeDisk(`${PREFIX}/scratch/notes.md`, '# notes\n');
        fake.commit('other/b.ts', 'const b = 1;\n');
        fake.writeDisk('other/b.ts', 'const b = 2;\n');

        const diff = await makeHost().getDiff();

        expect(diff.files.map((file) => file.path).sort()).toEqual(['scratch/notes.md', 'src/a.ts']);
        const untracked = diff.files.find((file) => file.path === 'scratch/notes.md');
        expect(untracked?.changeType).toBe('add');
        expect(untracked?.additions).toBe(1);
        expect(untracked?.patch).toContain('+# notes');
        expect(diff.files.every((file) => file.fileId.startsWith(`${diff.diffId}:`))).toBe(true);
    });

    it('удалённый файл едет как delete, содержимое новой стороны — null', async () => {
        fake.commit(`${PREFIX}/src/gone.ts`, 'export const gone = 1;\n');
        fake.removeDisk(`${PREFIX}/src/gone.ts`);
        const host = makeHost();

        const diff = await host.getDiff();
        const file = diff.files.find((candidate) => candidate.path === 'src/gone.ts');
        expect(file?.changeType).toBe('delete');

        const content = await host.getFileContent(file?.fileId ?? '');
        expect(content?.oldText).toBe('export const gone = 1;\n');
        expect(content?.newText).toBeNull();
    });

    it('дифф не изменился — итерация та же, изменился — новая', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();
        const first = await host.getDiff();

        await host.refresh();
        expect((await host.getDiff()).diffId).toBe(first.diffId);

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();
        expect((await host.getDiff()).diffId).not.toBe(first.diffId);
    });

    it('смена ветки чекаута отбивает все ручки хоста', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();
        await host.getDiff();

        fake.branch = 'another';
        await expect(host.refresh()).rejects.toThrow(
            `checkout switched to branch another; run \`devflow-diff-explain up --local ${fake.projectDir}\` again`,
        );
        await expect(host.getDiff()).rejects.toThrow('checkout switched to branch another');

        // Вернулись на свою ветку — отказ снимается следующим опросом.
        fake.branch = 'feature';
        await host.refresh();
        expect((await host.getDiff()).files).toHaveLength(1);
    });

    it('ветка ключа фиксируется первым снимком, когда её ещё не знают', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const resolved: string[] = [];
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: null,
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            onBranchResolved: (branch) => resolved.push(branch),
        });

        await host.getDiff();
        expect(resolved).toEqual(['feature']);

        fake.branch = 'another';
        await expect(host.refresh()).rejects.toThrow('checkout switched to branch another');
    });

    it('байты картинки отдаются по blobId, обе стороны различимы', async () => {
        const before = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]);
        fake.commit(`${PREFIX}/logo.png`, before);
        fake.writeDisk(`${PREFIX}/logo.png`, after);
        const host = makeHost();

        const file = (await host.getDiff()).files[0];
        expect(file?.binary).toBe(true);
        expect(file?.patch).toBeNull();
        expect(file?.image?.mime).toBe('image/png');
        expect(file?.image?.before?.size).toBe(before.length);
        expect(file?.image?.after?.size).toBe(after.length);

        const bytes = await host.getBlob(file?.image?.after?.blobId ?? '');
        expect(Buffer.from(bytes ?? new Uint8Array())).toEqual(after);
        expect(await host.getBlob('no-such-blob')).toBeNull();
    });

    // Опрос обязан быть дешёвым: `arc diff` на каталоге проекта — самая дорогая часть снимка.
    it('тик опроса без правок не читает дифф', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            iterations: memoryIterationsStore(),
            pollIntervalMs: 5,
        });

        const stop = host.watchIterations(() => undefined);
        await host.getDiff();
        const diffCalls = fake.countOf('diff');
        const statusCalls = fake.countOf('status');

        await waitUntil(() => fake.countOf('status') >= statusCalls + 3, 'три тика опроса');
        stop();

        expect(fake.countOf('diff')).toBe(diffCalls);
    });

    // Раскрывать неотслеживаемый каталог самим значило бы не знать про `.arcignore`: в дифф
    // поехали бы node_modules и сборка, а лимит на число файлов выел бы мусор.
    it('состав неотслеживаемых спрашивается у arc: игнорируемое в дифф не попадает', async () => {
        fake.writeDisk(`${PREFIX}/app/index.ts`, 'export const app = 1;\n');
        fake.writeDisk(`${PREFIX}/app/node_modules/dep/index.js`, 'module.exports = 1;\n');
        fake.ignored.push(`${PREFIX}/app/node_modules/`);

        const diff = await makeHost().getDiff();

        expect(diff.files.map((file) => file.path)).toEqual(['app/index.ts']);
    });

    it('неотслеживаемых файлов больше лимита — отказ с объяснением, а не тихая обрезка', async () => {
        fs.mkdirSync(path.join(root, PREFIX), { recursive: true });
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(floodedArc(root, 1001)),
            projectDir: path.join(root, PREFIX),
            base: null,
            branch: 'feature',
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });

        await expect(host.getDiff()).rejects.toThrow('1001 untracked files');
    });

    it('неотслеживаемый файл за лимитом размера едет в дифф без содержимого', async () => {
        fake.writeDisk(`${PREFIX}/dump.csv`, Buffer.alloc(MAX_FILE_BYTES + 1, 0x41));
        const host = makeHost();

        const file = (await host.getDiff()).files[0];
        expect(file?.path).toBe('dump.csv');
        expect(file?.binary).toBe(true);
        expect(file?.patch).toBeNull();
        expect(file?.additions).toBe(0);
        expect(await host.getFileContent(file?.fileId ?? '')).toBeNull();
    });

    // Содержимое читается с диска сейчас, поэтому оно обязано совпадать с патчем той же итерации.
    it('getFileContent догоняет снимок, устаревший fileId отбивает', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();
        const stale = (await host.getDiff()).files[0]?.fileId ?? '';

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 333;\n');
        await expect(host.getFileContent(stale)).rejects.toThrow('older diff');

        const fresh = (await host.getDiff()).files[0]?.fileId ?? '';
        expect((await host.getFileContent(fresh))?.newText).toBe('const a = 333;\n');
    });

    // Явная база — ref, а он двигается: сравнивать надо с тем, где он сейчас.
    it('явная база разрешается в коммит на каждом опросе', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        fake.refs.set('trunk', 'a'.repeat(40));
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: 'trunk',
            branch: fake.branch,
            iterations: memoryIterationsStore(),
            pollIntervalMs: 5,
        });

        const stop = host.watchIterations(() => undefined);
        expect((await host.getDiff()).baseCommit).toBe('a'.repeat(40));

        fake.refs.set('trunk', 'b'.repeat(40));
        // Опрос обещает сходимость, а не мгновенную реакцию: ждём снимок на новой базе.
        await expect.poll(async () => (await host.getDiff()).baseCommit).toBe('b'.repeat(40));
        stop();
    });

    // Принудительный пересчёт зовут ради правки, которой идущий проход ещё не видел.
    it('принудительный пересчёт не делит проход с уже идущим', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        let release: () => void = () => undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reachedDiff = false;
        const gated: CommandRunner = async (args) => {
            if (args[0] === 'diff' && !reachedDiff) {
                reachedDiff = true;
                await blocked;
            }
            return fake.runner(args);
        };
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(gated),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });

        const first = host.getDiff();
        await waitUntil(() => reachedDiff, 'первый проход дошёл до диффа');
        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
        const forced = host.refresh();
        release();
        await first;
        await forced;

        expect((await host.getDiff()).files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

});

/**
 * Подставной `arc` с каталогом, забитым неотслеживаемыми файлами: диска на них не нужно —
 * проверяется только реакция на перебор лимита.
 */
function floodedArc(root: string, count: number): CommandRunner {
    const untracked = Array.from({ length: count }, (_, index) => ({
        status: 'untracked',
        type: 'file',
        path: `${PREFIX}/scratch/file-${String(index)}.txt`,
    }));

    return (args) => {
        const answers: Record<string, string> = {
            root: `${root}\n`,
            info: JSON.stringify({ branch: 'feature', hash: '1'.repeat(40), user_login: 'reviewer' }),
            'merge-base': `${'0'.repeat(40)}\n`,
            status: JSON.stringify({ status: { untracked } }),
        };
        return Promise.resolve({ code: 0, stdout: Buffer.from(answers[args[0] ?? ''] ?? ''), stderr: '' });
    };
}
