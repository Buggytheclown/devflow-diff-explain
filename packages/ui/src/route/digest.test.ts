import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { anchorLabel, buildDigest, buildDigestTestCode, claimLabel, resolveAnchor } from './digest.js';
import { buildRouteModel, stopSeenRanges } from './route-model.js';
import { createT } from '../i18n/index.js';

const t = createT('ru');

/**
 * Дайджест тестов на фикстуре `medium`: стоп s04 — 12 принятых утверждений и два
 * отброшенных валидатором. Числа берутся из данных, а не пишутся в тесте руками: разъехавшийся
 * с фикстурой дайджест — это враньё про контракт тестов.
 */

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();

function stop(id: string): RouteStop {
    const found = SNAPSHOT.stops.find((candidate) => candidate.id === id);
    if (found === undefined) {
        throw new Error(`в снапшоте фикстуры нет стопа ${id}`);
    }
    return found;
}

function routeModel(snapshot: RouteSnapshot = SNAPSHOT) {
    const models = new Map(DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]));
    return buildRouteModel({ snapshot, files: DATA.diff.files, models });
}

/** Переносит якоря обычных утверждений s04 в другие записи, не меняя якоря самой остановки. */
function digestTargets(...targetStopIds: readonly string[]): RouteSnapshot {
    const targets = targetStopIds.map((stopId) => {
        const anchor = SNAPSHOT.stops.find((candidate) => candidate.id === stopId)?.anchors[0];
        if (anchor === undefined) {
            throw new Error(`у остановки ${stopId} нужен якорь для теста дайджеста`);
        }
        return { fileId: anchor.fileId, path: anchor.path, line: anchor.start };
    });
    let targetIndex = 0;
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((candidate) =>
            candidate.id !== 's04'
                ? candidate
                : {
                      ...candidate,
                      tests: candidate.tests.map((claim) => {
                          if (claim.kind === 'uncovered') {
                              return claim;
                          }
                          const anchor = targets[targetIndex % targets.length];
                          targetIndex += 1;
                          return { ...claim, anchor: anchor ?? null };
                      }),
                  },
        ),
    };
}

function digestWithNonTestFile(): RouteSnapshot {
    const anchor = SNAPSHOT.stops.find((candidate) => candidate.id === 's01')?.anchors[0];
    if (anchor === undefined) {
        throw new Error('у остановки s01 нужен якорь нетестового файла');
    }
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((candidate) =>
            candidate.id === 's04' ? { ...candidate, anchors: [...candidate.anchors, anchor] } : candidate,
        ),
    };
}

function digestTestCode(snapshot: RouteSnapshot) {
    const model = routeModel(snapshot);
    const entry = model.entries.find((candidate) => candidate.kind === 'stop' && candidate.view.stop.id === 's04');
    if (entry?.kind !== 'stop') {
        throw new Error('в модели маршрута нет дайджест-остановки s04');
    }
    const digest = buildDigest(entry.view.stop);
    if (digest === null) {
        throw new Error('у остановки s04 должен быть дайджест');
    }
    return buildDigestTestCode(
        digest,
        model.entries,
        entry.view.stop.id,
        entry.view.files.map((file) => file.fileId), t);
}

function anchorLocation(testCode: ReturnType<typeof buildDigestTestCode>) {
    if (testCode.location?.kind !== 'anchor') {
        throw new Error('ожидалась ссылка на другую запись маршрута');
    }
    return testCode.location;
}

describe('поведенческий дайджест', () => {
    it('обычная остановка дайджеста не имеет', () => {
        expect(buildDigest(stop('s01'))).toBeNull();
    });

    it('стоп s04 — 12 утверждений: 10 строк списка, 2 футерных, 2 отброшено', () => {
        const digest = buildDigest(stop('s04'));

        expect(digest?.total).toBe(12);
        expect(digest?.rows).toHaveLength(10);
        expect(digest?.footer).toHaveLength(2);
        expect(digest?.dropped).toBe(2);
    });

    it('категории считаются по данным модели: 6 new, 2 changed, 2 weakened, 2 uncovered', () => {
        const digest = buildDigest(stop('s04'));
        const kinds = [...(digest?.rows ?? []), ...(digest?.footer ?? [])].map((claim) => claim.kind);

        expect(kinds.filter((kind) => kind === 'new')).toHaveLength(6);
        expect(kinds.filter((kind) => kind === 'changed')).toHaveLength(2);
        expect(kinds.filter((kind) => kind === 'weakened')).toHaveLength(2);
        expect(kinds.filter((kind) => kind === 'uncovered')).toHaveLength(2);
    });

    it('порядок строк — порядок модели, вниз уезжает только uncovered', () => {
        const digest = buildDigest(stop('s04'));
        const model = stop('s04').tests;

        expect(digest?.rows.map((claim) => claim.text)).toEqual(
            model.filter((claim) => claim.kind !== 'uncovered').map((claim) => claim.text),
        );
        expect(digest?.footer.map((claim) => claim.text)).toEqual(
            model.filter((claim) => claim.kind === 'uncovered').map((claim) => claim.text),
        );
    });

    it('тест-кодом считаются только файлы якорей утверждений, но не код без покрытия', () => {
        const digest = buildDigest(stop('s04'));
        const paths = [...(digest?.testFileIds ?? [])].map(
            (fileId) => DATA.diff.files.find((file) => file.fileId === fileId)?.path ?? '',
        );

        expect(paths.every((path) => path.includes('__tests__'))).toBe(true);
        expect(paths).toHaveLength(3);
        // Якорь uncovered ведёт на код без покрытия — прятать его как тест-код нельзя.
        const uncovered = digest?.footer.find((claim) => claim.anchor !== null)?.anchor ?? null;
        expect(uncovered?.path).toBe('services/orders/src/domain/edit-window.ts');
        expect(digest?.testFileIds.has(uncovered?.fileId ?? '')).toBe(false);
    });

    it('пустое пересечение не прячет файлы и ведёт к первой записи с тест-кодом', () => {
        const testCode = digestTestCode(digestTargets('s01'));
        const location = anchorLocation(testCode);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(location.label).toBe('тест-код — в остановке 01');
        expect(location.target.stopId).toBe('s01');
    });

    it('линза спрятала тест-файлы своей остановки — сообщает об этом без самоссылки', () => {
        const snapshot = digestWithNonTestFile();
        const model = routeModel(snapshot);
        const entry = model.entries.find(
            (candidate) => candidate.kind === 'stop' && candidate.view.stop.id === 's04',
        );
        if (entry?.kind !== 'stop') {
            throw new Error('в модели маршрута нет дайджест-остановки s04');
        }
        const digest = buildDigest(entry.view.stop);
        if (digest === null) {
            throw new Error('у остановки s04 должен быть дайджест');
        }
        const visibleFileIds = entry.view.files
            .filter((file) => !digest.testFileIds.has(file.fileId))
            .map((file) => file.fileId);
        expect(visibleFileIds.length).toBeGreaterThan(0);

        const testCode = buildDigestTestCode(digest, model.entries, entry.view.stop.id, visibleFileIds, t);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(testCode.location?.kind).toBe('hidden-by-lens');
        expect(testCode.location?.label).toBe('тест-код скрыт линзой');
        expect(testCode.location?.anchor.fileId).not.toBe(visibleFileIds[0]);
        expect(testCode.location).not.toHaveProperty('target');
    });

    it('все утверждения uncovered — прятать нечего и вести некуда', () => {
        const snapshot: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((candidate) =>
                candidate.id === 's04'
                    ? {
                          ...candidate,
                          tests: candidate.tests.map((claim) => ({ ...claim, kind: 'uncovered' as const })),
                      }
                    : candidate,
            ),
        };
        const testCode = digestTestCode(snapshot);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(testCode.location).toBeNull();
    });

    it('разрешимые цели в разных записях ведут к первой с общей честной подписью', () => {
        const testCode = digestTestCode(digestTargets('s01', 's02'));
        const location = anchorLocation(testCode);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(location.label).toBe('тест-код — в других остановках');
        expect(location.target.stopId).toBe('s01');
    });

    it('единственная цель в «Прочем» получает его честную подпись', () => {
        const file = DATA.diff.files.find((candidate) => candidate.path.endsWith('generated/psp-schema.ts'));
        if (file === undefined) {
            throw new Error('фикстуре medium нужен generated/psp-schema.ts');
        }
        const snapshot: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((candidate) =>
                candidate.id !== 's04'
                    ? candidate
                    : {
                          ...candidate,
                          tests: candidate.tests.map((claim) =>
                              claim.kind === 'uncovered'
                                  ? claim
                                  : { ...claim, anchor: { fileId: file.fileId, path: file.path, line: 70 } },
                          ),
                      },
            ),
        };
        const testCode = digestTestCode(snapshot);
        const location = anchorLocation(testCode);

        expect(location.label).toBe('тест-код — в „Прочем“');
        expect(location.target.stopId).toBe('other');
    });

    it('ссылка печатается именем файла и строкой, путь остаётся в модели', () => {
        const anchor = buildDigest(stop('s04'))?.rows[0]?.anchor ?? null;

        expect(anchor?.path).toBe('services/orders/src/domain/__tests__/edit-window.test.ts');
        expect(anchorLabel(anchor ?? { fileId: '', path: '', name: '', line: 0 })).toBe('edit-window.test.ts:10');
    });

    it('у утверждения может не быть якоря вовсе — вью не должно его выдумывать', () => {
        const digest = buildDigest(stop('s04'));

        expect(digest?.footer.filter((claim) => claim.anchor === null)).toHaveLength(1);
    });

    it('подписи чипов — ключи словаря, по одному на категорию', () => {
        expect([claimLabel('new'), claimLabel('changed'), claimLabel('weakened'), claimLabel('uncovered')]).toEqual([
            'digest.kind.new',
            'digest.kind.changed',
            'digest.kind.weakened',
            'digest.kind.uncovered',
        ]);
    });
});

describe('переход по якорю утверждения', () => {
    it('тест-файл своей остановки ведёт в неё же, сторона восстанавливается из среза', () => {
        const entries = routeModel().entries;
        const anchor = buildDigest(stop('s04'))?.rows[0]?.anchor ?? null;

        expect(resolveAnchor(entries, 's04', anchor?.fileId ?? '', anchor?.line ?? 0)).toEqual({
            stopId: 's04',
            side: 'new',
        });
    });

    it('якорь uncovered ведёт на код — в ту остановку, которая его объясняет', () => {
        const entries = routeModel().entries;
        const anchor = buildDigest(stop('s04'))?.footer.find((claim) => claim.anchor !== null)?.anchor ?? null;

        // `edit-window.ts` объясняет остановка 01 — прыжок уезжает туда, а не остаётся в s04.
        expect(resolveAnchor(entries, 's04', anchor?.fileId ?? '', anchor?.line ?? 0)).toEqual({
            stopId: 's01',
            side: 'new',
        });
    });

    it('цель выбирается по строке, а не по одному лишь файлу', () => {
        const entries = routeModel().entries;
        // `psp-schema.ts` поделён между s03 (шапка файла) и «Прочим» (хвост без покрытия) —
        // штатная картина среза по якорям. s03 идёт раньше и файл у неё есть, но строки 70 в её
        // карточке нет: переход обязан уехать в «Прочее», где эта строка нарисована.
        const owners = entries.filter((entry) =>
            entry.view.files.some((file) => file.path.endsWith('generated/psp-schema.ts')),
        );
        expect(owners.map((entry) => entry.view.stop.id)).toEqual(['s03', 'other']);

        const fileId = owners[0]?.view.files.find((file) => file.path.endsWith('psp-schema.ts'))?.fileId ?? '';
        expect(resolveAnchor(entries, 's04', fileId, 70)).toEqual({ stopId: 'other', side: 'new' });
        // Строка 3 нарисована обеими: у s03 новой стороной, у «Прочего» — старой. Выигрывает
        // и более ранняя запись, и новая сторона.
        expect(resolveAnchor(entries, 's04', fileId, 3)).toEqual({ stopId: 's03', side: 'new' });
    });

    it('строки нет ни в одном срезе — цель остаётся карточкой файла, сторона неизвестна', () => {
        const entries = routeModel().entries;
        const fileId = entries[0]?.view.files[0]?.fileId ?? '';

        expect(resolveAnchor(entries, 's04', fileId, 100_000)).toEqual({
            stopId: entries[0]?.view.stop.id,
            side: null,
        });
    });

    it('файла нет на маршруте — ссылка никуда не ведёт, а не роняет вью', () => {
        expect(resolveAnchor(routeModel().entries, 's04', 'нет-такого-файла', 1)).toBeNull();
    });
});

describe('дайджест и отметка «просмотрено»', () => {
    it('диапазоны отметки считаются по якорям остановки — тест-код в них входит целиком', () => {
        const entry = routeModel().entries.find((candidate) => candidate.view.stop.id === 's04') ?? null;
        if (entry === null) {
            throw new Error('в модели маршрута нет стопа s04');
        }
        const ranges = stopSeenRanges(entry);
        const paths = new Set(
            ranges.map((range) => DATA.diff.files.find((file) => file.fileId === range.fileId)?.path ?? ''),
        );

        // Тогл Show/Hide в этот счёт не входит: модель маршрута о сессии ничего не знает,
        // и отметка дайджест-стопа честно закрывает его тест-файлы.
        expect(paths.size).toBe(3);
        expect([...paths].every((path) => path.includes('__tests__'))).toBe(true);
        expect(ranges.length).toBeGreaterThan(0);
    });
});
