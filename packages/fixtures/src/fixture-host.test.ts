import type { Thread } from '@sherpa/protocol';
import { prDiffSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureIteration, MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2, MEDIUM_DIFF_ID_V3 } from './data/index.js';
import { makeFixtureHost } from './fixture-host.js';

// Общий контрактный набор `ReviewHost` гоняется на этих же фикстурах из пакета сервера,
// где он и живёт: `packages/server/src/hosts/fixture-host.contract.test.ts`.

/** Первый снапшот подписки — синхронный, поэтому в тестах фикстуры его можно просто взять. */
function threadsOf(host: ReturnType<typeof makeFixtureHost>): Thread[] {
    let snapshot: Thread[] = [];
    const stop = host.watchThreads((threads) => {
        snapshot = threads;
    });
    stop();
    return snapshot;
}

describe('FixtureHost', () => {
    // Здесь проверяется только то, что хост не искажает исходные данные при чтении;
    // чистота самих билдеров фикстур — в fixtures.test.ts, через две сборки с нуля.
    it('два хоста одной фикстуры отдают одни и те же данные', async () => {
        const first = makeFixtureHost('medium');
        const second = makeFixtureHost('medium');

        expect(await first.getPr()).toEqual(await second.getPr());
        expect(await first.getDiff()).toEqual(await second.getDiff());
        expect(threadsOf(first)).toEqual(threadsOf(second));
    });

    it('мутации не протекают в следующий хост', async () => {
        const baseline = threadsOf(makeFixtureHost('medium'));

        const first = makeFixtureHost('medium');
        await first.saveDraft({ body: 'draft', parentId: null, anchor: null });
        await first.publishBatch('ship');
        expect(threadsOf(first)).not.toEqual(baseline);

        const second = makeFixtureHost('medium');
        expect(threadsOf(second)).toEqual(baseline);
        expect((await second.getPr()).statusLabel).toBe('review_in_progress');
    });

    it('отданные наружу данные — копии: их правка не меняет хост', async () => {
        const host = makeFixtureHost('medium');
        const diff = await host.getDiff();
        const file = diff.files.at(0);
        if (file === undefined) {
            throw new Error('фикстура medium без файлов');
        }
        file.additions = -1;
        const ownership = await host.ownershipLens();
        const zonePath = ownership?.zones?.at(0)?.paths.at(0);
        if (zonePath === undefined || ownership?.zones?.[0] === undefined) {
            throw new Error('фикстура medium без ownership-зоны');
        }
        ownership.zones[0].paths[0] = 'mutated/outside.ts';

        expect((await host.getDiff()).files.at(0)?.additions).toBeGreaterThan(0);
        expect((await host.ownershipLens())?.zones?.at(0)?.paths.at(0)).toBe(zonePath);
    });

    it('таймштампы и id черновиков считаются от фикстуры, а не от часов', async () => {
        const host = makeFixtureHost('medium');
        const first = await host.saveDraft({ body: 'one', parentId: null, anchor: null });
        const second = await host.saveDraft({ body: 'two', parentId: null, anchor: null });

        expect(first.createdAt).toBe('2026-08-20T09:01:00.000Z');
        expect(second.createdAt).toBe('2026-08-20T09:02:00.000Z');
        expect(await makeFixtureHost('medium').saveDraft({ body: 'one', parentId: null, anchor: null })).toEqual(first);
    });

    it('id черновика: у инлайнового положительный, у уровня PR — отрицательный', async () => {
        const host = makeFixtureHost('medium');
        const diff = await host.getDiff();
        const file = diff.files.at(0);
        if (file === undefined) {
            throw new Error('фикстура medium без файлов');
        }

        const prLevel = await host.saveDraft({ body: 'pr level', parentId: null, anchor: null });
        const inline = await host.saveDraft({
            body: 'inline',
            parentId: null,
            anchor: { fileId: file.fileId, path: file.path, position: { side: 'new', line: 4, size: 1 } },
        });

        expect(Number(prLevel.id)).toBeLessThan(0);
        expect(Number(inline.id)).toBeGreaterThan(0);
    });

    it('хранит issue у поддерживающей фикстуры, edge игнорирует флаг', async () => {
        const host = makeFixtureHost('medium');
        const draft = await host.saveDraft({ body: 'issue', parentId: null, anchor: null, issue: true });
        expect(host.issueOf(draft.id)).toBe(true);

        await host.updateDraft(draft.id, 'не issue', false);
        expect(host.issueOf(draft.id)).toBe(false);

        // Черновик без флага — не issue, а не «статус неизвестен»: `null` бывает только у edge.
        const plain = await host.saveDraft({ body: 'обычный', parentId: null, anchor: null });
        expect(host.issueOf(plain.id)).toBe(false);

        const edge = makeFixtureHost('edge');
        const degraded = await edge.saveDraft({ body: 'ignored', parentId: null, anchor: null, issue: true });
        await edge.updateDraft(degraded.id, 'still ignored', false);
        expect(edge.issueOf(degraded.id)).toBeNull();
    });

    it('снятый issue сбрасывает resolved комментария и открывает тред', async () => {
        const host = makeFixtureHost('medium');
        const setResolved = host.setCommentResolved?.bind(host);
        if (setResolved === undefined) {
            throw new Error('фикстура medium объявляет commentResolve');
        }
        const draft = await host.saveDraft({ body: 'issue', parentId: null, anchor: null, issue: true });
        await setResolved(draft.id, true);

        await host.updateDraft(draft.id, 'уже не замечание', false);

        const thread = threadsOf(host).find((candidate) => candidate.id === draft.id);
        expect(thread?.root.resolved).toBe(false);
        expect(thread?.resolved).toBe(false);
    });

    it('ответ на комментарий существующего треда встаёт в его поддерево', async () => {
        const host = makeFixtureHost('medium');
        const before = threadsOf(host);
        const parent = before.at(0)?.root.replies.at(0);
        if (parent === undefined) {
            throw new Error('в фикстуре medium ожидался тред с ответами');
        }

        const reply = await host.saveDraft({ body: 'my reply', parentId: parent.id, anchor: null });
        const after = threadsOf(host);
        const stored = after.at(0)?.root.replies.at(0);

        expect(stored?.replies.map((child) => child.id)).toContain(reply.id);
        expect(after.length).toBe(before.length);
    });

    it('опубликованный комментарий не редактируется и не удаляется', async () => {
        const host = makeFixtureHost('medium');
        const published = threadsOf(host).at(0)?.root;
        if (published === undefined) {
            throw new Error('в фикстуре medium ожидались треды');
        }

        await expect(host.updateDraft(published.id, 'nope')).rejects.toThrow(/опубликован/);
        await expect(host.deleteDraft(published.id)).rejects.toThrow(/опубликован/);
    });

    it('частичный провал публикации не применяет вердикт', async () => {
        // Id черновиков детерминированы, поэтому будущий черновик можно «уронить» заранее.
        const probe = await makeFixtureHost('medium').saveDraft({ body: 'probe', parentId: null, anchor: null });

        const host = makeFixtureHost('medium', { failPublishFor: [probe.id] });
        const doomed = await host.saveDraft({ body: 'will fail', parentId: null, anchor: null });
        const fine = await host.saveDraft({ body: 'will publish', parentId: null, anchor: null });
        expect(doomed.id).toBe(probe.id);

        const result = await host.publishBatch('ship');

        expect(result.verdictApplied).toBe(false);
        expect(result.publishedCommentIds).toEqual([fine.id]);
        expect(result.failed.map((entry) => entry.commentId)).toEqual([doomed.id]);
        expect(host.appliedVerdict()).toBeNull();
        expect((await host.getPr()).statusLabel).toBe('review_in_progress');
    });

    it('вердикт меняет статус PR только при полном успехе', async () => {
        const host = makeFixtureHost('medium');
        await host.saveDraft({ body: 'ok', parentId: null, anchor: null });

        const result = await host.publishBatch('request_changes');

        expect(result.verdictApplied).toBe(true);
        expect(host.appliedVerdict()).toBe('request_changes');
        expect((await host.getPr()).statusLabel).toBe('needs_work');
    });

    it('вердикт вне publishVerdicts отклоняется хостом', async () => {
        const host = makeFixtureHost('edge');
        expect((await host.getPr()).capabilities.publishVerdicts).not.toContain('sticky_ship');
        await expect(host.publishBatch('sticky_ship')).rejects.toThrow(/sticky_ship/);
    });

    it('comment публикует черновики, но статус PR не меняет', async () => {
        const host = makeFixtureHost('medium');
        const before = (await host.getPr()).statusLabel;
        const draft = await host.saveDraft({ body: 'ok', parentId: null, anchor: null });

        const result = await host.publishBatch('comment');

        expect(result).toEqual({ publishedCommentIds: [draft.id], failed: [], verdictApplied: true });
        expect(host.appliedVerdict()).toBe('comment');
        expect((await host.getPr()).statusLabel).toBe(before);
    });

    it('хост без fileViewedSync не предоставляет setFileViewed', async () => {
        const host = makeFixtureHost('small');
        expect((await host.getPr()).capabilities.fileViewedSync).toBe(false);
        expect(host.setFileViewed).toBeUndefined();
    });

    it('до пуша хост перечисляет одну активную итерацию', async () => {
        const host = makeFixtureHost('medium');
        const v1 = fixtureIteration('medium').diff;

        expect(await host.listIterations()).toEqual([
            {
                diffId: v1.diffId,
                baseCommit: v1.baseCommit,
                headCommit: v1.headCommit,
                createdAt: fixtureIteration('medium').iteration.createdAt,
                status: 'active',
            },
        ]);
        expect((await host.getDiff()).diffId).toBe(v1.diffId);
    });

    it('advanceIteration делает следующую итерацию активной, прошлую — previous', async () => {
        const host = makeFixtureHost('medium');

        const advanced = host.advanceIteration();

        expect(advanced.diffId).toBe(MEDIUM_DIFF_ID_V2);
        expect(advanced.status).toBe('active');
        expect(await host.listIterations()).toEqual([
            expect.objectContaining({ diffId: MEDIUM_DIFF_ID, status: 'previous' }),
            expect.objectContaining({ diffId: MEDIUM_DIFF_ID_V2, status: 'active' }),
        ]);
        expect((await host.getDiff()).diffId).toBe(MEDIUM_DIFF_ID_V2);
    });

    it('force-push убирает переписанную итерацию из списка и упирается в конец фикстуры', async () => {
        const host = makeFixtureHost('medium');
        host.advanceIteration();
        host.advanceIteration();

        expect((await host.listIterations()).map((iteration) => iteration.diffId)).toEqual([
            MEDIUM_DIFF_ID,
            MEDIUM_DIFF_ID_V3,
        ]);
        expect(() => host.advanceIteration()).toThrow(/итераций больше нет/);
    });

    it('watchIterations получает снапшот сразу и после каждого пуша', () => {
        const host = makeFixtureHost('medium');
        const seen: string[][] = [];
        const stop = host.watchIterations((list) => seen.push(list.map((iteration) => iteration.diffId)));

        host.advanceIteration();
        stop();
        host.advanceIteration();

        expect(seen).toEqual([[MEDIUM_DIFF_ID], [MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2]]);
    });

    it('срез отдаётся по объявленной паре и отклоняется по неизвестной', async () => {
        const host = makeFixtureHost('medium');
        host.advanceIteration();

        const slice = await host.getDiff({ base: MEDIUM_DIFF_ID, head: MEDIUM_DIFF_ID_V2 });
        expect(prDiffSchema.parse(slice).diffId).toBe(MEDIUM_DIFF_ID_V2);
        expect(slice.files.length).toBeGreaterThan(0);

        await expect(host.getDiff({ base: MEDIUM_DIFF_ID_V3, head: MEDIUM_DIFF_ID_V2 })).rejects.toThrow(
            /итерация 183044 неизвестна хосту/,
        );
        await expect(host.getDiff({ base: MEDIUM_DIFF_ID_V2, head: MEDIUM_DIFF_ID })).rejects.toThrow(/среза .+ нет/);
    });

    it('треды едут за активной итерацией: ответ автора и тред на ушедшем файле', () => {
        const host = makeFixtureHost('medium');
        expect(threadsOf(host).find((thread) => thread.id === '4820260')?.outdated).toBe(false);

        host.advanceIteration();
        const threads = threadsOf(host);

        const handlers = threads.find((thread) => thread.id === '4820242');
        expect(handlers?.root.replies[0]?.replies.at(-1)?.body).toMatch(/only returned for `edit-window-closed`/);
        const departed = threads.find((thread) => thread.id === '4820260');
        expect(departed?.outdated).toBe(true);
    });

    it('фикстура без итераций срез не отдаёт вовсе', async () => {
        const host = makeFixtureHost('small');
        const iterations = await host.listIterations();

        expect(iterations.length).toBe(1);
        expect((await host.getPr()).capabilities.iterations).toBe(false);
        await expect(
            host.getDiff({ base: iterations[0]?.diffId ?? '', head: iterations[0]?.diffId ?? '' }),
        ).rejects.toThrow(/capabilities.iterations/);
        expect(() => host.advanceIteration()).toThrow(/итераций больше нет/);
    });

    it('resolve треда подписывается текущим пользователем фикстуры', async () => {
        const host = makeFixtureHost('medium');
        const target = threadsOf(host).find((thread) => !thread.resolved);
        if (target === undefined) {
            throw new Error('в фикстуре medium ожидался неразрешённый тред');
        }

        await host.setThreadResolved(target.id, true);
        expect(threadsOf(host).find((thread) => thread.id === target.id)?.resolvedBy).toBe('alice');

        await host.setThreadResolved(target.id, false);
        expect(threadsOf(host).find((thread) => thread.id === target.id)?.resolvedBy).toBeNull();
    });
});
