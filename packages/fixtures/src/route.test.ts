import type { PrDiff, RouteSnapshot, RouteStop, RouteTier } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { buildRouteFixtures, fixtureData, fixtureIteration, routeFixtures } from './data/index.js';

/**
 * Маршрутные фикстуры сверяются не с самими собой, а с диффом: покрытие пересчитывается
 * из патчей (`+`/`−` строки ханков) и сравнивается с числами дизайн-хендоффа. Сдвиг любого якоря
 * на строку роняет либо проверку «якорь только по изменённым строкам», либо счёт непокрытого.
 */

const HUNK_HEADER = /^@@ -(\d+),\d+ \+(\d+),\d+ @@/;

/** Целевые доли полосы покрытия из `docs/design/README.md §1` (862 строки: 188 / 348 / 292 + 34 неразмеченных). */
const TIER_TARGETS: Record<'high' | 'medium' | 'low', number> = { high: 188, medium: 348, low: 292 };
const TIER_TOLERANCE = 25;
const UNEXPLAINED_LINES = 40;
const UNEXPLAINED_FILES = 4;

interface ChangedFile {
    fileId: string;
    /** Номера изменённых строк по сторонам: added живут в `new`, removed — в `old`. */
    old: Set<number>;
    new: Set<number>;
}

/** Изменённые строки диффа: то же определение, что у математики покрытия в `docs/design/SPEC-elements.md §2.4` (added + removed). */
function changedLines(diff: PrDiff): Map<string, ChangedFile> {
    const files = new Map<string, ChangedFile>();
    for (const file of diff.files) {
        if (file.patch === null) {
            continue;
        }
        const changed: ChangedFile = { fileId: file.fileId, old: new Set(), new: new Set() };
        let oldLine = 0;
        let newLine = 0;
        let inHunk = false;
        for (const line of file.patch.split('\n')) {
            const header = HUNK_HEADER.exec(line);
            if (header !== null) {
                oldLine = Number(header[1]);
                newLine = Number(header[2]);
                inHunk = true;
                continue;
            }
            if (!inHunk) {
                continue;
            }
            const prefix = line.slice(0, 1);
            if (prefix === '+') {
                changed.new.add(newLine);
                newLine += 1;
            } else if (prefix === '-') {
                changed.old.add(oldLine);
                oldLine += 1;
            } else if (prefix === ' ') {
                oldLine += 1;
                newLine += 1;
            }
        }
        files.set(file.path, changed);
    }
    return files;
}

function totalChangedLines(files: Map<string, ChangedFile>): number {
    let total = 0;
    for (const file of files.values()) {
        total += file.old.size + file.new.size;
    }
    return total;
}

/** Пути файлов диффа: якорь утверждения в файл вне этого множества валидатор отбрасывает. */
function diffPaths(): Set<string> {
    return new Set(fixtureIteration('medium').diff.files.map((file) => file.path));
}

function mediumSnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot;
    if (snapshot === undefined || snapshot === null) {
        throw new Error('у фикстуры medium нет готового снапшота маршрута');
    }
    return snapshot;
}

function stopById(snapshot: RouteSnapshot, id: string): RouteStop {
    const stop = snapshot.stops.find((candidate) => candidate.id === id);
    if (stop === undefined) {
        throw new Error(`в снапшоте нет стопа ${id}`);
    }
    return stop;
}

/**
 * Покрытие по тирам: строка достаётся тиру того стопа, который заявил её первым
 * (порядок массива `stops` — триаж). Дублей якорей в фикстуре нет, но считать надо так же,
 * как считает валидатор, иначе тест разойдётся с UI на первом же дубле.
 */
function coverageByTier(snapshot: RouteSnapshot, files: Map<string, ChangedFile>) {
    const owner = new Map<string, RouteTier>();
    for (const stop of snapshot.stops) {
        for (const anchor of stop.anchors) {
            const file = files.get(anchor.path);
            expect(file, `якорь стопа ${stop.id} ведёт в файл вне диффа: ${anchor.path}`).toBeDefined();
            expect(anchor.fileId).toBe(file?.fileId);
            expect(anchor.end).toBeGreaterThanOrEqual(anchor.start);

            const changed = anchor.side === 'old' ? file?.old : file?.new;
            for (let line = anchor.start; line <= anchor.end; line += 1) {
                expect(
                    changed?.has(line),
                    `якорь стопа ${stop.id} накрыл неизменённую строку ${anchor.path}:${anchor.side}:${String(line)}`,
                ).toBe(true);
                const key = `${anchor.path}:${anchor.side}:${String(line)}`;
                if (!owner.has(key)) {
                    owner.set(key, stop.tier);
                }
            }
        }
    }

    const byTier: Record<string, number> = { high: 0, medium: 0, low: 0, other: 0 };
    for (const tier of owner.values()) {
        byTier[tier] = (byTier[tier] ?? 0) + 1;
    }

    const unexplainedFiles = new Set<string>();
    let unexplained = 0;
    for (const [path, file] of files) {
        for (const side of ['old', 'new'] as const) {
            for (const line of file[side]) {
                if (!owner.has(`${path}:${side}:${String(line)}`)) {
                    unexplained += 1;
                    unexplainedFiles.add(path);
                }
            }
        }
    }

    return { byTier, unexplained, unexplainedFiles };
}

describe('маршрут фикстуры medium', () => {
    const files = changedLines(fixtureIteration('medium').diff);
    const snapshot = mediumSnapshot();
    const coverage = coverageByTier(snapshot, files);

    it('считает те же изменённые строки, что и шапка PR', () => {
        expect(totalChangedLines(files)).toBe(868);
    });

    // Картинки маршрут не видит вовсе: строки добавленной svg честно
    // остаются без объяснения, в UI это «Прочее».
    it('оставляет без объяснения ровно 40 строк ровно в 4 файлах', () => {
        expect(coverage.unexplained).toBe(UNEXPLAINED_LINES);
        expect([...coverage.unexplainedFiles].sort()).toEqual([
            '.github/CODEOWNERS',
            '.github/workflows/ci.yml',
            'services/orders/src/payments/generated/psp-schema.ts',
            'services/orders/src/ui/assets/countdown-icon.svg',
        ]);
        expect(coverage.unexplainedFiles.size).toBe(UNEXPLAINED_FILES);
    });

    it('держит пропорцию полосы coverage по тирам', () => {
        for (const [tier, target] of Object.entries(TIER_TARGETS)) {
            expect(Math.abs((coverage.byTier[tier] ?? 0) - target)).toBeLessThanOrEqual(TIER_TOLERANCE);
        }
        // «Прочее» ничего не покрывает: его содержимое UI считает сам от непокрытых диапазонов.
        expect(coverage.byTier.other).toBe(0);
        const explained = Object.values(coverage.byTier).reduce((sum, lines) => sum + lines, 0);
        expect(explained + coverage.unexplained).toBe(totalChangedLines(files));
    });

    it('несёт 7 стопов плана с синтетическим «Прочим» последним', () => {
        expect(snapshot.stops.length).toBe(7);
        expect(snapshot.stops.map((stop) => stop.planIndex)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(snapshot.stops.map((stop) => stop.tier)).toEqual([
            'high',
            'high',
            'medium',
            'medium',
            'low',
            'low',
            'other',
        ]);

        const other = stopById(snapshot, 'other');
        expect(other.planIndex).toBe(7);
        expect(other.status).toBe('ready');
        expect(other.anchors).toEqual([]);
        expect(other.paragraph).toBeNull();
    });

    it('tourOrder — перестановка id всех стопов, «Прочее» последним', () => {
        expect([...snapshot.tourOrder].sort()).toEqual([...snapshot.stops.map((stop) => stop.id)].sort());
        expect(snapshot.tourOrder.at(-1)).toBe('other');
        // Осмысленная перестановка, а не план-порядок.
        expect(snapshot.tourOrder).not.toEqual(snapshot.stops.map((stop) => stop.id));
    });

    it('все стопы готовы, у снапшота есть contentHash и провенанс', () => {
        for (const stop of snapshot.stops) {
            expect(stop.status).toBe('ready');
            expect(stop.provenance).toBeNull();
        }
        expect(snapshot.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(snapshot.provenance).toEqual({ harness: 'claude-code', model: 'claude-opus-5', locale: null });
        expect(snapshot.commit).toBe(fixtureIteration('medium').diff.headCommit);
        expect(snapshot.diffId).toBe(fixtureIteration('medium').diff.diffId);
        expect(snapshot.summary.split('\n\n').length).toBeGreaterThanOrEqual(2);
    });

    it('свёрнутые якоря стоят на машинных строках лок-файла', () => {
        const collapsed = snapshot.stops.flatMap((stop) => stop.anchors.filter((anchor) => anchor.collapsed));
        expect(collapsed.length).toBeGreaterThanOrEqual(1);
        expect(collapsed.length).toBeLessThanOrEqual(2);
        for (const anchor of collapsed) {
            expect(anchor.path).toBe('pnpm-lock.yaml');
        }
    });

    it('дайджест — 12 утверждений с якорями в тест-файлы диффа', () => {
        const digest = stopById(snapshot, 's04');
        expect(digest.tests.length).toBe(12);
        expect(digest.droppedClaims).toBe(2);
        // Пометка валидатора называет файл, из-за которого утверждения отброшены.
        expect(digest.validationNotes.join(' ')).toContain('services/orders/src/domain/__tests__/factories.ts');
        expect(digest.tests.filter((claim) => claim.kind === 'weakened').length).toBeGreaterThanOrEqual(1);
        expect(digest.tests.filter((claim) => claim.kind === 'uncovered').length).toBeGreaterThanOrEqual(1);

        for (const claim of digest.tests) {
            if (claim.anchor === null) {
                // Якорь отсутствует только у `uncovered`: тестового якоря у такого утверждения нет.
                expect(claim.kind).toBe('uncovered');
                continue;
            }
            const file = files.get(claim.anchor.path);
            expect(file, `утверждение ведёт в файл вне диффа: ${claim.anchor.path}`).toBeDefined();
            expect(claim.anchor.fileId).toBe(file?.fileId);
            expect(file?.new.has(claim.anchor.line)).toBe(true);
            if (claim.kind !== 'uncovered') {
                expect(claim.anchor.path).toMatch(/__tests__\/.+\.test\.ts$/);
            }
        }
    });

    it('остальные стопы дайджеста не несут', () => {
        for (const stop of snapshot.stops) {
            if (stop.id === 's04') {
                continue;
            }
            expect(stop.tests).toEqual([]);
            expect(stop.droppedClaims).toBe(0);
        }
    });

    it('тексты стопов русские и заполнены по формуле', () => {
        for (const stop of snapshot.stops) {
            expect(stop.title).toMatch(/[а-яё]/i);
            if (stop.id === 'other') {
                continue;
            }
            expect(stop.paragraph ?? '').toMatch(/[а-яё]/i);
            expect((stop.paragraph ?? '').split(/(?<=\.)\s/).length).toBeGreaterThanOrEqual(2);
        }
    });
});

describe('промежуточные состояния маршрута', () => {
    it('фаза filling — картина `docs/design/README.md §7`: готовы 01, 02 и 05, огоньки не по порядку', () => {
        const filling = routeFixtures('medium')?.states.filling;
        const snapshot = filling?.snapshot;
        expect(filling?.phase).toBe('filling');
        expect(snapshot?.contentHash).toBeNull();

        const statuses = new Map((snapshot?.stops ?? []).map((stop) => [stop.id, stop.status]));
        expect(Object.fromEntries(statuses)).toEqual({
            s01: 'ready',
            s02: 'ready',
            s03: 'queued',
            s04: 'queued',
            s05: 'ready',
            s06: 'filling',
            other: 'ready',
        });

        for (const stop of snapshot?.stops ?? []) {
            expect(stop.title.length).toBeGreaterThan(0);
            if (stop.status !== 'ready') {
                expect(stop.paragraph).toBeNull();
                expect(stop.anchors).toEqual([]);
            }
        }

        const ready = (snapshot?.stops ?? []).filter((stop) => stop.status === 'ready' && stop.id !== 'other');
        expect(ready.length).toBe(3);
    });

    it('фазы reading, none и failed снапшота не несут', () => {
        const states = routeFixtures('medium')?.states;
        expect(states?.reading?.snapshot).toBeNull();
        expect(states?.none?.snapshot).toBeNull();
        expect(states?.failed?.snapshot).toBeNull();
        expect(states?.failed?.failure?.message).toMatch(/^Генерация остановлена на валидации:/);
        expect(states?.failed?.failure?.message.split('. ').length).toBe(1);
        // Сырой вывод — разбираемый JSON: «Open raw output» показывает то, что вернула модель.
        expect(() => {
            JSON.parse(states?.failed?.failure?.rawOutput ?? '');
        }).not.toThrow();
    });

    it('малый PR помечен smallPr, у large и edge — свои состояния', () => {
        expect(routeFixtures('small')?.states.none).toEqual({
            phase: 'none',
            smallPr: true,
            snapshot: null,
            failure: null,
            stale: null,
        });
        expect(routeFixtures('large')?.states.none?.smallPr).toBe(false);
        expect(routeFixtures('edge')?.states.failed?.failure?.rawOutput).toContain('infra/clock.ts');
    });
});

describe('сырые выводы модели', () => {
    const raw = routeFixtures('medium')?.rawResults;

    it('скелет — 6 стопов без «Прочего», tourOrder — перестановка 1..6', () => {
        expect(raw?.skeleton.stops.length).toBe(6);
        for (const stop of raw?.skeleton.stops ?? []) {
            expect(['high', 'medium', 'low']).toContain(stop.tier);
        }
        expect([...(raw?.skeleton.tourOrder ?? [])].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('секции покрывают весь план и повторяют содержимое снапшота целиком', () => {
        const snapshot = mediumSnapshot();
        const paths = diffPaths();
        expect(raw?.sections.length).toBe(6);

        for (const section of raw?.sections ?? []) {
            expect(section.stops.length).toBe(1);
            const [rawStop] = section.stops;
            const stop = snapshot.stops.find((candidate) => candidate.planIndex === rawStop?.planIndex);
            expect(stop).toBeDefined();
            expect(rawStop?.paragraph).toBe(stop?.paragraph);
            expect(rawStop?.bridge ?? null).toBe(stop?.bridge ?? null);

            // Якорь сравнивается целиком: сдвиг `end` или потерянная директива свёртки разведут
            // секцию со снапшотом — а валидатор собирает снапшот именно из секции.
            expect(
                rawStop?.anchors.map(
                    (anchor) =>
                        `${anchor.path}:${anchor.side}:${String(anchor.start)}-${String(anchor.end)}:${String(anchor.collapsed ?? false)}`,
                ),
            ).toEqual(
                stop?.anchors.map(
                    (anchor) =>
                        `${anchor.path}:${anchor.side}:${String(anchor.start)}-${String(anchor.end)}:${String(anchor.collapsed)}`,
                ),
            );
            // Якоря модели — по пути: `fileId` резолвит валидатор.
            for (const anchor of rawStop?.anchors ?? []) {
                expect(anchor).not.toHaveProperty('fileId');
            }

            // Дайджест: модель отдаёт всё, снапшот несёт принятое, разница — ровно `droppedClaims`.
            const rawTests = rawStop?.tests ?? [];
            expect(rawTests.length).toBe((stop?.tests.length ?? 0) + (stop?.droppedClaims ?? 0));
            const accepted = rawTests.filter((claim) => claim.testPath === undefined || paths.has(claim.testPath));
            expect(
                accepted.map(
                    (claim) => `${claim.kind}|${claim.text}|${claim.testPath ?? ''}:${String(claim.testLine ?? 0)}`,
                ),
            ).toEqual(
                stop?.tests.map(
                    (claim) =>
                        `${claim.kind}|${claim.text}|${claim.anchor?.path ?? ''}:${String(claim.anchor?.line ?? 0)}`,
                ),
            );
        }
    });

    it('дайджест секции 04 несёт два утверждения, которые валидатор отбросит', () => {
        const digestSection = raw?.sections.find((section) => section.stops[0]?.planIndex === 4);
        const rawTests = digestSection?.stops[0]?.tests ?? [];
        expect(rawTests.length).toBe(14);

        const paths = diffPaths();
        const dropped = rawTests.filter((claim) => claim.testPath !== undefined && !paths.has(claim.testPath));
        expect(dropped.map((claim) => claim.testPath)).toEqual([
            'services/orders/src/domain/__tests__/factories.ts',
            'services/orders/src/domain/__tests__/factories.ts',
        ]);
        // Счётчик «2 claims dropped» рождается из вывода модели, а не вписан в снапшот руками.
        expect(stopById(mediumSnapshot(), 's04').droppedClaims).toBe(dropped.length);
    });

    it('битые выводы ломаются семантикой, а не схемой', () => {
        const broken = raw?.broken;
        expect(broken?.sectionUnknownFile.stops[0]?.anchors[0]?.path).toBe(
            'services/orders/src/domain/order-state.ts',
        );
        expect(fixtureIteration('medium').diff.files.some((file) => file.path.endsWith('order-state.ts'))).toBe(false);

        const outside = broken?.sectionRangeOutsideChanges.stops[0]?.anchors[0];
        const readme = changedLines(fixtureIteration('medium').diff).get('services/orders/README.md');
        expect(outside?.path).toBe('services/orders/README.md');
        expect(readme?.new.has(outside?.start ?? 0)).toBe(false);

        const tour = broken?.skeletonTourOrderNotPermutation.tourOrder ?? [];
        expect(new Set(tour).size).toBeLessThan(tour.length);
    });
});

describe('маршрут второго захода', () => {
    const snapshot = routeFixtures('medium')?.secondPass?.snapshot;
    if (snapshot === undefined || snapshot === null) {
        throw new Error('у фикстуры medium нет маршрута второго захода');
    }
    const second = fixtureData('medium').iterations[1];
    if (second === undefined) {
        throw new Error('у фикстуры medium нет второй итерации');
    }
    const files = changedLines(second.diff);

    it('построен по второй итерации и помнит, от какого снапшота перенесён прогресс', () => {
        expect(snapshot.diffId).toBe(second.diff.diffId);
        expect(snapshot.commit).toBe(second.diff.headCommit);
        expect(snapshot.previousSnapshotId).toBe(mediumSnapshot().snapshotId);
        expect(snapshot.carried).toEqual({ kept: 3, total: 6, zeroReason: null });
        expect(snapshot.contentHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('три стопа помечены изменёнными, остальные — нет', () => {
        const changed = snapshot.stops.filter((stop) => stop.change !== null);
        expect(changed.map((stop) => stop.id)).toEqual(['s02', 's03', 's06']);
        expect(changed.map((stop) => stop.change?.kind)).toEqual(['changed', 'changed', 'new']);
        // Перенос прогресса и число нетронутых стопов обязаны сходиться: считаем по стопам
        // с якорями — «Прочее» перенос накрыть не может и в знаменателе не стоит.
        const anchored = snapshot.stops.filter((stop) => stop.anchors.length > 0);
        expect(anchored.length).toBe(snapshot.carried?.total);
        expect(anchored.length - changed.length).toBe(snapshot.carried?.kept);
        for (const stop of changed) {
            expect(stop.change?.reason ?? '').toMatch(/[а-яё]/i);
        }
    });

    it('ссылка на тред ведёт в тред второй итерации', () => {
        const threadIds = snapshot.stops.flatMap((stop) => stop.change?.threadIds ?? []);
        expect(threadIds.length).toBe(1);
        const known = new Set(second.threads.map((thread) => thread.id));
        for (const id of threadIds) {
            expect(known.has(id), `тред ${id} не найден во второй итерации`).toBe(true);
        }
    });

    it('якоря резолвятся против второй итерации и стоят только на изменённых строках', () => {
        for (const stop of snapshot.stops) {
            for (const anchor of stop.anchors) {
                const file = files.get(anchor.path);
                expect(file, `якорь стопа ${stop.id} ведёт в файл вне второй итерации: ${anchor.path}`).toBeDefined();
                expect(anchor.fileId).toBe(file?.fileId);
                const changed = anchor.side === 'old' ? file?.old : file?.new;
                for (let line = anchor.start; line <= anchor.end; line += 1) {
                    expect(
                        changed?.has(line),
                        `якорь стопа ${stop.id} накрыл неизменённую строку ${anchor.path}:${anchor.side}:${String(line)}`,
                    ).toBe(true);
                }
            }
        }
    });

    it('выжимка и дайджест пересобраны под вторую итерацию', () => {
        // Тексты второго захода обязаны сходиться с его диффом: `card-token.ts` из PR ушёл,
        // и утверждать «маскирование PAN не покрыто» модели уже не о чем.
        expect(snapshot.summary).not.toBe(mediumSnapshot().summary);
        expect(snapshot.summary).toContain('rejection-status.ts');
        expect(routeFixtures('medium')?.rawResultsV2?.skeleton.summary).toBe(snapshot.summary);

        const claims = snapshot.stops.flatMap((stop) => stop.tests.map((claim) => claim.text));
        expect(claims.some((text) => text.includes('recordedAt'))).toBe(true);
        expect(claims.some((text) => text.includes('Маскирование PAN'))).toBe(false);
    });

    it('секции второго захода объясняют ровно затронутые стопы', () => {
        const sections = routeFixtures('medium')?.rawResultsV2?.sections ?? [];
        const withReason = sections.flatMap((section) =>
            section.stops.filter((stop) => stop.changeReason !== undefined).map((stop) => stop.planIndex),
        );
        expect(withReason).toEqual([2, 3, 6]);
        const withThreads = sections.flatMap((section) =>
            section.stops.filter((stop) => stop.changeThreadIds !== undefined).map((stop) => stop.planIndex),
        );
        expect(withThreads).toEqual([3]);
    });
});

/**
 * Перф-фикстура: сверять покрытие не с чем — цифр дизайн-хендоффа для неё нет, и стопы собраны
 * по шаблону. Проверяется только то, на чём стоит перф-прогон: план на 25 стопов и якоря,
 * которые лежат исключительно на изменённых строках (иначе валидатор их вырежет).
 */
describe('маршрут фикстуры huge', () => {
    const raw = routeFixtures('huge')?.rawResults;
    const files = changedLines(fixtureIteration('huge').diff);

    it('план — 25 стопов, tourOrder — перестановка плановых номеров, но не план-порядок', () => {
        expect(raw?.skeleton.stops.length).toBe(25);
        expect(raw?.sections.length).toBe(25);
        const tour = raw?.skeleton.tourOrder ?? [];
        expect([...tour].sort((left, right) => left - right)).toEqual(
            Array.from({ length: 25 }, (_, index) => index + 1),
        );
        expect(tour).not.toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    });

    it('якоря секций стоят только на изменённых строках', () => {
        for (const section of raw?.sections ?? []) {
            for (const stop of section.stops) {
                expect(stop.anchors.length).toBeGreaterThan(0);
                for (const anchor of stop.anchors) {
                    const file = files.get(anchor.path);
                    expect(file, `якорь ведёт в файл вне диффа: ${anchor.path}`).toBeDefined();
                    const changed = anchor.side === 'old' ? file?.old : file?.new;
                    for (let line = anchor.start; line <= anchor.end; line += 1) {
                        expect(
                            changed?.has(line),
                            `якорь накрыл неизменённую строку ${anchor.path}:${anchor.side}:${String(line)}`,
                        ).toBe(true);
                    }
                }
            }
        }
    });

    it('тексты стопов русские, у машинных файлов якорей нет', () => {
        const generated = new Set(
            fixtureIteration('huge')
                .diff.files.filter((file) => file.generated)
                .map((file) => file.path),
        );
        for (const stop of raw?.skeleton.stops ?? []) {
            expect(stop.title).toMatch(/[а-яё]/i);
        }
        for (const section of raw?.sections ?? []) {
            for (const stop of section.stops) {
                expect(stop.paragraph).toMatch(/[а-яё]/i);
                expect(stop.paragraph.split(/(?<=\.)\s/).length).toBeGreaterThanOrEqual(2);
                for (const anchor of stop.anchors) {
                    expect(generated.has(anchor.path)).toBe(false);
                }
            }
        }
    });
});

describe('маршрутные фикстуры: раздача', () => {
    for (const name of ['medium', 'small', 'large', 'edge', 'huge'] as const) {
        it(`${name}: детерминирована и отдаётся копией`, () => {
            // Две сборки с нуля: сравнение двух обращений к кэшу прошло бы и с `Date.now()` внутри.
            expect(JSON.stringify(buildRouteFixtures(name))).toBe(JSON.stringify(buildRouteFixtures(name)));

            const first = routeFixtures(name);
            const second = routeFixtures(name);
            expect(first).not.toBe(second);
            expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        });
    }
});

describe('маршрутные фикстуры: английский набор выводов', () => {
    const en = routeFixtures('medium')?.rawResultsEn;
    const ru = routeFixtures('medium')?.rawResults;

    it('план совпадает с русским по числу стопов, тирам и порядку тура', () => {
        expect(en?.skeleton.stops).toHaveLength(ru?.skeleton.stops.length ?? 0);
        expect(en?.skeleton.stops.map((stop) => stop.tier)).toEqual(ru?.skeleton.stops.map((stop) => stop.tier));
        expect(en?.skeleton.tourOrder).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('тексты английские: кириллицы нет ни в плане, ни в секциях', () => {
        const texts = [
            en?.skeleton.summary ?? '',
            ...(en?.skeleton.stops.flatMap((stop) => [stop.title, stop.intent]) ?? []),
            ...(en?.sections.flatMap((section) =>
                section.stops.flatMap((stop) => [
                    stop.paragraph,
                    stop.bridge ?? '',
                    ...(stop.tests ?? []).map((claim) => claim.text),
                ]),
            ) ?? []),
        ];
        for (const text of texts) {
            expect(text).not.toMatch(/[а-яё]/i);
        }
    });

    it('якоря секций те же, что у русского набора: язык не двигает строки', () => {
        for (const section of en?.sections ?? []) {
            const planIndex = section.stops[0]?.planIndex ?? 0;
            const mirror = ru?.sections.find((candidate) => candidate.stops[0]?.planIndex === planIndex);
            expect(section.stops[0]?.anchors).toEqual(mirror?.stops[0]?.anchors);
        }
    });
});
