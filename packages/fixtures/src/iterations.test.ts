import type { PrDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    FIXTURE_NAMES,
    fixtureData,
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_DIFF_ID_V3,
    routeFixtures,
} from './data/index.js';

/**
 * Срезы между итерациями объявлены данными, а не вычислены, — значит, их надо сверять с патчами
 * самих итераций. Гвардия ловит ровно ту ошибку, которую легко сделать руками: ханк среза уехал
 * относительно ханка итерации, и «что изменилось с прошлого захода» показывает не те строки.
 */

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

interface NewSideRange {
    start: number;
    end: number;
}

/** Диапазоны новой стороны, накрытые ханками патча. */
function hunkRanges(patch: string): NewSideRange[] {
    const ranges: NewSideRange[] = [];
    for (const line of patch.split('\n')) {
        const header = HUNK_HEADER.exec(line);
        if (header !== null) {
            const start = Number(header[1]);
            const count = header[2] === undefined ? 1 : Number(header[2]);
            ranges.push({ start, end: start + count - 1 });
        }
    }
    return ranges;
}

/** Номера добавленных строк новой стороны. */
function addedLines(patch: string): number[] {
    const added: number[] = [];
    let line = 0;
    let inHunk = false;
    for (const raw of patch.split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header !== null) {
            line = Number(header[1]);
            inHunk = true;
            continue;
        }
        if (!inHunk) {
            continue;
        }
        const prefix = raw.slice(0, 1);
        if (prefix === '+') {
            added.push(line);
            line += 1;
        } else if (prefix === ' ') {
            line += 1;
        }
    }
    return added;
}

/** Затронутые срезом строки новой стороны по путям: строка внутри ханка — «затронута». */
function touchedNewLines(slice: PrDiff): Map<string, NewSideRange[]> {
    const touched = new Map<string, NewSideRange[]>();
    for (const file of slice.files) {
        if (file.patch !== null) {
            touched.set(file.path, hunkRanges(file.patch));
        }
    }
    return touched;
}

function pathsOf(diff: PrDiff): Set<string> {
    return new Set(diff.files.map((file) => file.path));
}

/** Пути, которых слайс коснулся: файлы среза без пустых патчей. */
function touchedPaths(diff: PrDiff): Set<string> {
    return new Set(diff.files.filter((file) => file.patch !== null).map((file) => file.path));
}

function diffOf(name: 'medium', diffId: string): PrDiff {
    const iteration = fixtureData(name).iterations.find((candidate) => candidate.iteration.diffId === diffId);
    if (iteration === undefined) {
        throw new Error(`в фикстуре ${name} нет итерации ${diffId}`);
    }
    return iteration.diff;
}

function sliceOf(base: string, head: string): PrDiff {
    const found = fixtureData('medium').interdiffs.find(
        (interdiff) => interdiff.base === base && interdiff.head === head,
    );
    if (found === undefined) {
        throw new Error(`в фикстуре medium нет среза ${base}→${head}`);
    }
    return found.diff;
}

describe('итерации фикстур', () => {
    it('medium несёт три итерации, force-push переписывает вторую', () => {
        const { iterations, interdiffs } = fixtureData('medium');

        expect(iterations.map((iteration) => iteration.iteration.diffId)).toEqual([
            MEDIUM_DIFF_ID,
            MEDIUM_DIFF_ID_V2,
            MEDIUM_DIFF_ID_V3,
        ]);
        expect(iterations.map((iteration) => iteration.replaces)).toEqual([null, null, MEDIUM_DIFF_ID_V2]);
        // Итерации идут по времени вперёд: на этом держится порядок списка у хоста.
        const created = iterations.map((iteration) => Date.parse(iteration.iteration.createdAt));
        expect([...created].sort((left, right) => left - right)).toEqual(created);
        expect(interdiffs.map((interdiff) => `${interdiff.base}→${interdiff.head}`)).toEqual([
            `${MEDIUM_DIFF_ID}→${MEDIUM_DIFF_ID_V2}`,
            `${MEDIUM_DIFF_ID_V2}→${MEDIUM_DIFF_ID_V3}`,
            `${MEDIUM_DIFF_ID}→${MEDIUM_DIFF_ID_V3}`,
        ]);
        expect(fixtureData('medium').pr.capabilities.iterations).toBe(true);
    });

    it('у остальных фикстур одна итерация и ни одного среза', () => {
        for (const name of FIXTURE_NAMES.filter((candidate) => candidate !== 'medium')) {
            const data = fixtureData(name);
            expect(data.iterations.length, name).toBe(1);
            expect(data.interdiffs, name).toEqual([]);
            expect(data.pr.capabilities.iterations, name).toBe(false);
        }
    });

    it('второй пуш задевает файлы трёх стопов, добавляет файл и уносит один из PR', () => {
        const v1 = pathsOf(diffOf('medium', MEDIUM_DIFF_ID));
        const v2 = pathsOf(diffOf('medium', MEDIUM_DIFF_ID_V2));

        expect([...v1].filter((path) => !v2.has(path))).toEqual(['services/orders/src/payments/card-token.ts']);
        expect([...v2].filter((path) => !v1.has(path))).toEqual(['services/orders/src/api/rejection-status.ts']);
        expect(touchedPaths(sliceOf(MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2))).toEqual(
            new Set([
                'services/orders/src/domain/policies/edit-policy.ts',
                'services/orders/src/api/handlers.ts',
                'services/orders/src/api/rejection-status.ts',
                'services/orders/src/payments/card-token.ts',
                'pnpm-lock.yaml',
            ]),
        );
    });

    it('срез несёт свои fileId и коммиты своей пары итераций', () => {
        const slice = sliceOf(MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2);
        const head = diffOf('medium', MEDIUM_DIFF_ID_V2);
        const base = diffOf('medium', MEDIUM_DIFF_ID);

        expect(slice.diffId).toBe(head.diffId);
        expect(slice.baseCommit).toBe(base.headCommit);
        expect(slice.headCommit).toBe(head.headCommit);

        const headIds = new Set(head.files.map((file) => file.fileId));
        for (const file of slice.files) {
            expect(headIds.has(file.fileId), `${file.path}: fileId среза совпал с fileId итерации`).toBe(false);
        }
    });

    for (const [base, head] of [
        [MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2],
        [MEDIUM_DIFF_ID_V2, MEDIUM_DIFF_ID_V3],
        [MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V3],
    ] as const) {
        describe(`срез ${base}→${head}`, () => {
            const slice = sliceOf(base, head);
            const baseDiff = diffOf('medium', base);
            const headDiff = diffOf('medium', head);

            it('пути среза — подмножество объединения путей двух итераций', () => {
                const union = new Set([...pathsOf(baseDiff), ...pathsOf(headDiff)]);
                for (const file of slice.files) {
                    expect(union.has(file.path), `${file.path} нет ни в одной из итераций`).toBe(true);
                }
            });

            it('каждая добавленная строка лежит внутри ханка head-итерации', () => {
                const headFiles = new Map(headDiff.files.map((file) => [file.path, file] as const));
                for (const file of slice.files) {
                    if (file.patch === null) {
                        continue;
                    }
                    const headFile = headFiles.get(file.path);
                    if (headFile === undefined) {
                        // Файл ушёл из PR: в срезе он возвращается к базе, и сверять его не с чем.
                        expect(pathsOf(baseDiff).has(file.path), `${file.path} нет ни в base, ни в head`).toBe(true);
                        continue;
                    }
                    const ranges = hunkRanges(headFile.patch ?? '');
                    for (const line of addedLines(file.patch)) {
                        expect(
                            ranges.some((range) => line >= range.start && line <= range.end),
                            `${file.path}:${String(line)} вне ханков итерации ${head}`,
                        ).toBe(true);
                    }
                }
            });
        });
    }

    it('срез v1→v3 задевает всё, что задел v1→v2, и сверх того', () => {
        const shortest = touchedPaths(sliceOf(MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2));
        const longest = touchedPaths(sliceOf(MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V3));

        for (const path of shortest) {
            expect(longest.has(path), `${path} потерялся в срезе v1→v3`).toBe(true);
        }
        expect(longest.size).toBeGreaterThan(shortest.size);
    });

    it('классификация стопов снапшота v2 сходится с интердиффом v1→v2', () => {
        // Считать классификацию будет сервер, а снапшот фикстуры несёт
        // её готовой — значения обязаны совпасть, иначе UI покажет бейдж, которого сервер не даст.
        const snapshot = routeFixtures('medium')?.secondPass?.snapshot;
        if (snapshot === undefined || snapshot === null) {
            throw new Error('у фикстуры medium нет маршрута второго захода');
        }
        const touched = touchedNewLines(sliceOf(MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2));

        for (const stop of snapshot.stops) {
            let lines = 0;
            let hits = 0;
            for (const anchor of stop.anchors) {
                for (let line = anchor.start; line <= anchor.end; line += 1) {
                    lines += 1;
                    // Сторона `old` при общем base итераций переносится тождественно.
                    const ranges = anchor.side === 'new' ? (touched.get(anchor.path) ?? []) : [];
                    if (ranges.some((range) => line >= range.start && line <= range.end)) {
                        hits += 1;
                    }
                }
            }
            const expected = hits === 0 ? null : hits === lines ? 'new' : 'changed';
            expect(stop.change?.kind ?? null, `стоп ${stop.id}: ${String(hits)} из ${String(lines)} строк затронуты`).toBe(
                expected,
            );
        }
    });

    it('треды второй итерации: ответ автора, съехавший якорь и файл, которого больше нет', () => {
        const v1 = fixtureData('medium').iterations[0];
        const v2 = fixtureData('medium').iterations[1];
        if (v1 === undefined || v2 === undefined) {
            throw new Error('у фикстуры medium ожидались две первые итерации');
        }

        const handlers = v2.threads.find((thread) => thread.id === '4820242');
        expect(handlers?.outdated).toBe(true);
        expect(handlers?.pinnedTo?.diffId).toBe(MEDIUM_DIFF_ID);
        expect(handlers?.root.replies[0]?.replies.map((reply) => reply.author.login)).toEqual(['avery']);

        const lint = v2.threads.find((thread) => thread.id === '4820263');
        const lintBefore = v1.threads.find((thread) => thread.id === '4820263');
        expect(lint?.outdated).toBe(false);
        expect(lint?.anchor?.position?.line).toBeGreaterThan(lintBefore?.anchor?.position?.line ?? 0);
        expect(lint?.pinnedTo).toEqual({ diffId: MEDIUM_DIFF_ID, commit: v1.iteration.headCommit });

        const departed = v2.threads.find((thread) => thread.id === '4820260');
        expect(departed?.outdated).toBe(true);
        expect(departed?.anchor?.path).toBe('services/orders/src/payments/card-token.ts');
        expect(v2.diff.files.some((file) => file.path === departed?.anchor?.path)).toBe(false);
    });
});
