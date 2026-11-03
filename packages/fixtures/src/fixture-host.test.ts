import { prDiffSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureIteration, MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2, MEDIUM_DIFF_ID_V3 } from './data/index.js';
import { makeFixtureHost } from './fixture-host.js';

// Общий контрактный набор `ReviewHost` гоняется на этих же фикстурах из пакета сервера,
// где он и живёт: `packages/server/src/hosts/fixture-host.contract.test.ts`.


describe('FixtureHost', () => {

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
});
