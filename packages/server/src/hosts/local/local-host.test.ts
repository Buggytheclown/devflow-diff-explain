import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CommentDraft, PrDiff, Thread } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { arcVcs, parseArcStatus, parseNameStatus } from './arc-vcs.js';
import { FakeArc } from './fake-arc.js';
import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { isBinaryContent, synthesizeAddPatch } from './patch.js';
import { MAX_FILE_BYTES } from './snapshot.js';
import type { LocalThreadsStore } from './threads-store.js';
import { emptyReviewData, fileThreadsStore, memoryThreadsStore } from './threads-store.js';
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

const ON_SHIP = 'on ship, commit and open a PR';

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
        overrides: { branch?: string | null; threads?: LocalThreadsStore; verdicts?: string | null } = {},
    ): LocalHost {
        return new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: overrides.branch === undefined ? fake.branch : overrides.branch,
            ...(overrides.verdicts === undefined ? {} : { verdicts: overrides.verdicts }),
            threads: overrides.threads ?? memoryThreadsStore(),
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

    it('все файлы диффа — зона ревьюера', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        fake.writeDisk(`${PREFIX}/scratch/notes.md`, '# notes\n');
        const host = makeHost();

        const lens = await host.ownershipLens();

        expect(host.ownershipSource).toBe('arc diff');
        expect(lens).toMatchObject({ id: 'mine', available: true, zones: null });
        expect([...lens.paths].sort()).toEqual(['scratch/notes.md', 'src/a.ts']);
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

    it('мета ревью описывает каталог и ветку, вердиктов без публикации нет', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');

        const pr = await makeHost().getPr();

        expect(pr).toMatchObject({
            id: 'local-arc-app-0badc0de',
            url: `file://${fake.projectDir}`,
            title: fake.branch,
            fromBranch: fake.branch,
            toBranch: 'trunk',
            statusLabel: 'local',
            verdicts: [],
        });
        expect(pr.author.login).toBe(fake.login);
        // Локальное дерево читает его же владелец.
        expect(pr.viewer).toEqual({ login: fake.login, displayName: null, bot: false, avatarUrl: null });
        expect(pr.capabilities).toEqual({
            publishVerdicts: ['comment'],
            fileViewedSync: false,
            fileContent: true,
            commentIssues: false,
            commentResolve: false,
            editPublished: true,
            iterations: true,
            blobs: true,
        });
    });

    it('вердикт из старого файла живёт внутри итерации: новый дифф его снимает', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const { diffId } = await makeHost().getDiff();
        // Без `--verdicts` ship не публикуется, но файлы, записанные раньше, обязаны читаться.
        const host = makeHost({
            threads: memoryThreadsStore({ ...emptyReviewData(), verdict: { verdict: 'ship', diffId } }),
        });

        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: fake.login, displayName: null, bot: false, avatarUrl: null }, verdict: 'ship' },
        ]);

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();
        expect((await host.getPr()).verdicts).toEqual([]);
    });

    it('публикуются только комментарии: вердикт отклоняется, черновик остаётся', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const draft = await host.saveDraft({ body: 'про B', parentId: null, anchor: null });

        for (const verdict of ['ship', 'sticky_ship', 'request_changes'] as const) {
            await expect(host.publishBatch(verdict)).rejects.toThrow(/только комментарии/);
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
        expect(await host.pendingRounds()).toEqual([]);

        await host.publishBatch('comment');
        // Публикация без вердикта вердиктом ревьюера не считается.
        expect((await host.getPr()).verdicts).toEqual([]);
    });

    it('с --verdicts режимы как в PR: Request changes и Ship, без Comment', async () => {
        seedTwoFiles(fake);

        expect((await makeHost({ verdicts: ON_SHIP }).getPr()).capabilities.publishVerdicts).toEqual([
            'request_changes',
            'ship',
        ]);
        expect((await makeHost({ verdicts: null }).getPr()).capabilities.publishVerdicts).toEqual(['comment']);
    });

    it('с --verdicts comment и sticky_ship отклоняются, черновик остаётся', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });
        const draft = await host.saveDraft({ body: 'про B', parentId: null, anchor: null });

        for (const verdict of ['comment', 'sticky_ship'] as const) {
            await expect(host.publishBatch(verdict)).rejects.toThrow(/через Request changes/);
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
        expect(await host.pendingRounds()).toEqual([]);
    });

    it('вердикт заводит раунд и без комментариев: сессия обязана его узнать', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });

        expect(await host.publishBatch('ship')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(await host.publishBatch('request_changes')).toEqual({
            publishedCommentIds: [],
            failed: [],
            verdictApplied: true,
        });

        const rounds = await host.pendingRounds();
        expect(rounds.map((round) => [round.verdict, round.threadIds])).toEqual([
            ['ship', []],
            ['request_changes', []],
        ]);
        // Последний вердикт итерации — в шапке.
        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: fake.login, displayName: null, bot: false, avatarUrl: null }, verdict: 'request_changes' },
        ]);
    });

    it('ship с черновиками публикует их и везёт треды в раунд', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });
        const draft = await host.saveDraft({ body: 'про B', parentId: null, anchor: null });

        const result = await host.publishBatch('ship');

        expect(result.publishedCommentIds).toEqual([draft.id]);
        expect(await host.pendingRounds()).toMatchObject([{ verdict: 'ship', threadIds: [draft.id] }]);
        expect((await host.roundContext((await host.pendingRounds())[0]?.id ?? '')).verdict).toBe('ship');
    });

    it('контекст раунда несёт текущее поручение хоста', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });
        await host.publishBatch('ship');
        const roundId = (await host.pendingRounds())[0]?.id ?? '';

        expect((await host.roundContext(roundId)).instruction).toBe(ON_SHIP);

        host.setVerdicts('on ship, merge into trunk');
        expect((await host.roundContext(roundId)).instruction).toBe('on ship, merge into trunk');

        host.setVerdicts(null);
        expect((await host.roundContext(roundId)).instruction).toBeNull();
    });

    it('режим переключается на живом хосте и сообщает о смене', async () => {
        seedTwoFiles(fake);
        const changes: (string | null)[] = [];
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            onVerdictsChanged: (verdicts) => changes.push(verdicts),
        });

        expect(host.setVerdicts(null)).toBe(false);
        expect(host.setVerdicts(ON_SHIP)).toBe(true);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['request_changes', 'ship']);
        await expect(host.publishBatch('comment')).rejects.toThrow();

        // Новое поручение при включённом режиме: сохраняется, но мету перечитывать незачем.
        expect(host.setVerdicts('on ship, merge into trunk')).toBe(false);
        expect(host.setVerdicts('on ship, merge into trunk')).toBe(false);

        expect(host.setVerdicts(null)).toBe(true);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);
        expect(changes).toEqual([ON_SHIP, 'on ship, merge into trunk', null]);
    });

    // Неудачная запись режим в памяти не сдвигает: иначе повторный `up` счёл бы его уже включённым.
    it('режим, который не удалось сохранить, повторный вызов сохраняет снова', async () => {
        seedTwoFiles(fake);
        const stored: (string | null)[] = [];
        let calls = 0;
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            onVerdictsChanged: (verdicts) => {
                calls += 1;
                if (calls === 1) {
                    throw new Error('диск полон');
                }
                stored.push(verdicts);
            },
        });

        expect(() => host.setVerdicts(ON_SHIP)).toThrow('диск полон');
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);

        expect(host.setVerdicts(ON_SHIP)).toBe(true);
        expect(calls).toBe(2);
        expect(stored).toEqual([ON_SHIP]);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['request_changes', 'ship']);
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
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            onBranchResolved: (branch) => resolved.push(branch),
        });

        await host.getDiff();
        expect(resolved).toEqual(['feature']);

        fake.branch = 'another';
        await expect(host.refresh()).rejects.toThrow('checkout switched to branch another');
    });

    it('черновики переживают пересоздание хоста на том же хранилище', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const threads = memoryThreadsStore();

        const first = makeHost({ threads });
        const diff = await first.getDiff();
        const file = diff.files[0];
        const created = await first.saveDraft({
            body: 'смотри сюда',
            parentId: null,
            anchor: { fileId: file?.fileId ?? '', path: 'src/a.ts', position: { side: 'new', line: 1, size: 1 } },
        });

        const revived = await makeHost({ threads }).getThreads();
        expect(revived).toHaveLength(1);
        expect(revived[0]?.root.id).toBe(created.id);
        expect(revived[0]?.root.body).toBe('смотри сюда');
        expect(revived[0]?.root.draft).toBe(true);
        expect(revived[0]?.pinnedTo?.diffId).toBe(diff.diffId);
    });

    it('якорь переезжает на новую итерацию по пути файла', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft({
            body: 'вопрос',
            parentId: null,
            anchor: {
                fileId: before.files[0]?.fileId ?? '',
                path: 'src/a.ts',
                position: { side: 'new', line: 1, size: 1 },
            },
        });

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();

        const after = await host.getDiff();
        const thread = (await host.getThreads())[0];
        expect(thread?.anchor?.fileId).toBe(after.files[0]?.fileId);
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    // Любая правка в дереве двигает `diffId`, поэтому устаревание считается по файлу треда:
    // иначе чужая правка снимала бы все треды со своих строк.
    it('правка соседнего файла тред не устаревает: пин переезжает на активную итерацию', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 3;\n');
        await host.refresh();

        const after = await host.getDiff();
        expect(after.diffId).not.toBe(before.diffId);
        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(false);
        expect(thread?.pinnedTo?.diffId).toBe(after.diffId);
        expect(thread?.pinnedTo?.commit).toBe(after.headCommit);
        expect(thread?.anchor?.fileId).toBe(fileIdOf(after, 'src/a.ts'));
    });

    it('правка своего файла делает тред устаревшим с пином итерации, на которой он написан', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();

        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    it('файл треда ушёл из диффа — тред устарел', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        // Правку откатили: файла в диффе больше нет вовсе.
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        await host.refresh();

        expect((await host.getDiff()).files.map((file) => file.path)).toEqual(['src/b.ts']);
        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    it('повтор записи с тем же ключом идемпотентности не заводит второй комментарий', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();

        const first = await host.saveDraft(
            { body: 'один раз', parentId: null, anchor: null },
            { idempotencyKey: 'retry-1' },
        );
        const repeated = await host.saveDraft(
            { body: 'один раз', parentId: null, anchor: null },
            { idempotencyKey: 'retry-1' },
        );

        expect(repeated.id).toBe(first.id);
        expect(await host.getThreads()).toHaveLength(1);
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
            threads: memoryThreadsStore(),
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
            threads: memoryThreadsStore(),
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

    it('параллельные черновики доезжают до файла оба', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const reviewPath = path.join(root, 'state', 'local-review.json');
        const host = makeHost({ threads: fileThreadsStore(reviewPath) });

        const [first, second] = await Promise.all([
            host.saveDraft({ body: 'раз', parentId: null, anchor: null }),
            host.saveDraft({ body: 'два', parentId: null, anchor: null }),
        ]);

        expect(first.id).not.toBe(second.id);
        const revived = await makeHost({ threads: fileThreadsStore(reviewPath) }).getThreads();
        expect(revived.map((thread) => thread.root.body).sort()).toEqual(['два', 'раз']);
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
            threads: memoryThreadsStore(),
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

    it('публикация открывает раунд с тредами своих комментариев', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const diff = await host.getDiff();
        const onA = await host.saveDraft(draftOnA(diff));
        // Второй тред опубликован раньше — в новый раунд он не попадает.
        await host.saveDraft({ body: 'про B', parentId: null, anchor: null });
        await host.publishBatch('comment');

        const reply = await host.saveDraft({ body: 'а тут?', parentId: onA.id, anchor: null });
        await host.publishBatch('comment');

        const rounds = await host.pendingRounds();
        expect(rounds).toHaveLength(2);
        expect(rounds[0]?.verdict).toBe('comment');
        expect(rounds[0]?.threadIds.length).toBe(2);
        expect(rounds[1]).toMatchObject({ verdict: 'comment', threadIds: [onA.id] });
        expect(reply.draft).toBe(true);
    });

    it('публикация без единого комментария раунда не открывает и ничего не пишет', async () => {
        seedTwoFiles(fake);
        const threads = memoryThreadsStore();
        const host = makeHost({ threads });

        expect(await host.publishBatch('comment')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(await host.pendingRounds()).toEqual([]);
        expect(await threads.read()).toEqual(emptyReviewData());
    });

    it('контекст раунда несёт абсолютный путь, строку и фрагмент патча', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const diff = await host.getDiff();
        const comment = await host.saveDraft(draftOnA(diff));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        const context = await host.roundContext(round?.id ?? '');

        expect(context.verdict).toBe('comment');
        expect(context.projectDir).toBe(fake.projectDir);
        const thread = context.threads[0];
        expect(thread?.threadId).toBe(comment.id);
        expect(thread?.file).toBe(path.join(fake.projectDir, 'src/a.ts'));
        expect(thread?.position).toEqual({ side: 'new', line: 1, size: 1 });
        expect(thread?.excerpt).toContain('+const a = 2;');
        expect(thread?.note).toBeNull();
        expect(thread?.comments[0]?.body).toBe('вопрос про A');
    });

    it('устаревший тред едет в раунд пометкой вместо фрагмента', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 42;\n');
        await host.refresh();

        const thread = (await host.roundContext(round?.id ?? '')).threads[0];
        expect(thread?.excerpt).toBeNull();
        expect(thread?.note).toContain('outdated');
    });

    // Контекст раунда читается при постановке задачи, а не при публикации: до публикации
    // текст треда наружу не уходит.
    it('черновик, написанный после публикации, в контекст раунда не едет', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        await host.saveDraft({ body: 'ещё не отправлено', parentId: comment.id, anchor: null });
        const round = (await host.pendingRounds())[0];

        const thread = (await host.roundContext(round?.id ?? '')).threads[0];

        expect(thread?.comments).toHaveLength(1);
        expect(thread?.comments[0]?.replies).toEqual([]);
    });

    it('ответ агента становится комментарием-ботом, раунд закрывается', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];
        const seen: Thread[][] = [];
        const stop = host.watchThreads((threads) => seen.push(threads));

        await host.completeRound(
            round?.id ?? '',
            { replies: [{ threadId: comment.id, body: 'вынес в константу' }], summary: 'поправил одно' },
            { login: 'claude-code', displayName: 'Агент · claude-opus-5', bot: true, avatarUrl: null },
        );
        stop();

        const thread = (await host.getThreads()).find((candidate) => candidate.id === comment.id);
        expect(thread?.root.replies).toHaveLength(1);
        expect(thread?.root.replies[0]).toMatchObject({
            body: 'вынес в константу',
            draft: false,
            author: { login: 'claude-code', displayName: 'Агент · claude-opus-5', bot: true, avatarUrl: null },
        });
        expect(await host.pendingRounds()).toEqual([]);
        // Итог раунда — обсуждение уровня PR от того же автора.
        const summary = (await host.getThreads()).find((candidate) => candidate.anchor === null);
        expect(summary?.root).toMatchObject({
            body: 'поправил одно',
            draft: false,
            author: { login: 'claude-code', bot: true },
        });
        expect(summary?.pinnedTo).toBeNull();
        // Подписчики тредов увидели ответ, не дожидаясь тика опроса.
        expect(seen.at(-1)?.find((candidate) => candidate.id === comment.id)?.root.replies).toHaveLength(1);
    });

    it('свой опубликованный комментарий правится и удаляется физически', async () => {
        seedTwoFiles(fake);
        const threads = memoryThreadsStore();
        const host = makeHost({ threads });
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');

        await host.updateComment(comment.id, 'вопрос про A, переписанный');
        const edited = (await host.getThreads()).find((candidate) => candidate.id === comment.id);
        expect(edited?.root.body).toBe('вопрос про A, переписанный');
        expect(edited?.root.editedAt).not.toBeNull();

        await host.deleteComment(comment.id);
        expect((await host.getThreads()).some((candidate) => candidate.id === comment.id)).toBe(false);
        // Удаление физическое: в хранилище комментария не остаётся вовсе.
        expect((await threads.read()).threads).toEqual([]);
    });

    it('чужой и черновой комментарии правке и удалению не поддаются', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));

        await expect(host.updateComment(comment.id, 'правка черновика')).rejects.toThrow('is a draft');

        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];
        await host.completeRound(
            round?.id ?? '',
            { replies: [{ threadId: comment.id, body: 'поправил' }], summary: 'итог' },
            { login: 'claude-code', displayName: 'Агент', bot: true, avatarUrl: null },
        );
        const reply = (await host.getThreads()).find((candidate) => candidate.id === comment.id)?.root.replies[0];

        await expect(host.deleteComment(reply?.id ?? '')).rejects.toThrow('belongs to claude-code');
    });

    it('ответ в чужой тред раунда отбивается', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        await expect(
            host.completeRound(
                round?.id ?? '',
                { replies: [{ threadId: 'не-наш', body: 'ответ' }], summary: 'итог' },
                { login: 'agent', displayName: 'Агент', bot: true, avatarUrl: null },
            ),
        ).rejects.toThrow('is not in review round');
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
            threads: memoryThreadsStore(),
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


/** Два изменённых файла в диффе: на одном живёт тред, второй правят, чтобы двигать итерацию. */
function seedTwoFiles(fake: FakeArc): void {
    fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
    fake.commit(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
    fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
    fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 2;\n');
}

function fileIdOf(diff: PrDiff, filePath: string): string {
    return diff.files.find((file) => file.path === filePath)?.fileId ?? '';
}

function draftOnA(diff: PrDiff): CommentDraft {
    return {
        body: 'вопрос про A',
        parentId: null,
        anchor: {
            fileId: fileIdOf(diff, 'src/a.ts'),
            path: 'src/a.ts',
            position: { side: 'new', line: 1, size: 1 },
        },
    };
}

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
