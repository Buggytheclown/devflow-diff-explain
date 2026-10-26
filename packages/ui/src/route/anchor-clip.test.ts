import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { FileExpansion } from '../diff-view/expand.js';
import {
    expandAllGaps,
    expandFileContext,
    expandGap,
    gapKeyOf,
    remainingHiddenLines,
} from '../diff-view/expand.js';
import { changedLinesOf } from '../progress/read-state.js';
import type { AnchorSpan, ClippedModel } from './anchor-clip.js';
import {
    ANCHOR_CONTEXT,
    clipModelToAnchors,
    coveredChangedLines,
    coveredChangedRanges,
    droppedWhitespaceLines,
    spanLines,
    uncoveredRanges,
} from './anchor-clip.js';

/** Обрезка по якорям: срез обязан содержать ровно то, за что отвечает остановка. */

const DATA = fixtureIteration('medium');
const READY = routeFixtures('medium')?.states.ready ?? null;

function fileOf(path: string): FileDiff {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`в фикстуре medium нет файла ${path}`);
    }
    return file;
}

function modelOf(path: string): DiffFileModel {
    return parseFileDiff(toParseRequest(fileOf(path)));
}

function hunks(model: DiffFileModel): DiffHunk[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffHunk => block.kind === 'hunk')
        : [];
}

function lines(model: DiffFileModel): DiffLine[] {
    return hunks(model).flatMap((hunk) => hunk.lines);
}

function gapsOf(clipped: ClippedModel): DiffGap[] {
    return clipped.model.content.kind === 'text'
        ? clipped.model.content.blocks.filter((block): block is DiffGap => block.kind === 'gap')
        : [];
}

/** Пропуски одного края среза: краевые от внутренних отличает только `edge`. */
function gapsAt(clipped: ClippedModel, edge: DiffGap['edge']): DiffGap[] {
    return gapsOf(clipped).filter((gap) => gap.edge === edge);
}

const POLICY = 'services/orders/src/domain/policies/edit-policy.ts';
const WINDOW = 'services/orders/src/domain/edit-window.ts';

describe('обрезка модели по якорям', () => {
    it('пустой набор якорей даёт пустой срез, а не весь файл', () => {
        const clipped = clipModelToAnchors(modelOf(WINDOW), []);

        expect(clipped.hunks).toBe(0);
        expect(clipped.changedLines).toBe(0);
        expect(lines(clipped.model)).toHaveLength(0);
    });

    it('оставляет только строки якоря и контекст вокруг них', () => {
        const model = modelOf(POLICY);
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 30, end: 43 }];
        const clipped = clipModelToAnchors(model, anchors);

        const kept = lines(clipped.model);
        expect(kept.length).toBeGreaterThan(0);
        // Изменённых строк вне якоря в срезе нет: расширение идёт только по неизменённым.
        for (const line of kept.filter((candidate) => candidate.kind !== 'context')) {
            expect(line.newLine ?? 0).toBeGreaterThanOrEqual(30);
            expect(line.newLine ?? 0).toBeLessThanOrEqual(43);
        }
        expect(kept.filter((line) => line.kind === 'context').length).toBeLessThanOrEqual(2 * ANCHOR_CONTEXT);
        // Изменённые строки среза — ровно те, что попали в якорь.
        expect(clipped.changedLines).toBe(
            coveredChangedLines(model, anchors).additions + coveredChangedLines(model, anchors).deletions,
        );
    });

    it('считает обе стороны: якорь на old берёт удалённые строки', () => {
        const model = modelOf(POLICY);
        const old: readonly AnchorSpan[] = [{ side: 'old', start: 28, end: 34 }];
        const clipped = clipModelToAnchors(model, old);
        const deletions = lines(clipped.model).filter(
            (line) => line.kind === 'del' && (line.oldLine ?? 0) >= 28 && (line.oldLine ?? 0) <= 34,
        );

        expect(deletions.length).toBeGreaterThan(0);
        expect(clipped.changedLines).toBe(deletions.length);
        expect(coveredChangedLines(model, old).additions).toBe(0);
    });

    it('границы диапазона включительны', () => {
        const model = modelOf(POLICY);
        const changed = changedLinesOf(model);
        const first = [...(changed?.new ?? [])].sort((a, b) => a - b)[0] ?? 0;

        expect(clipModelToAnchors(model, [{ side: 'new', start: first, end: first }]).changedLines).toBe(1);
        expect(clipModelToAnchors(model, [{ side: 'new', start: first + 1, end: first }]).changedLines).toBe(0);
    });

    it('между кусками рождается пропуск с честными числами', () => {
        const model = modelOf(WINDOW);
        const changed = [...(changedLinesOf(model)?.new ?? [])].sort((a, b) => a - b);
        const first = changed[0] ?? 1;
        const last = changed.at(-1) ?? 1;
        const clipped = clipModelToAnchors(model, [
            { side: 'new', start: first, end: first },
            { side: 'new', start: last, end: last },
        ]);

        const gaps =
            clipped.model.content.kind === 'text'
                ? clipped.model.content.blocks.filter((block) => block.kind === 'gap')
                : [];
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.kind === 'gap' ? (gaps[0].hiddenChanged ?? 0) : 0).toBeGreaterThan(0);
        expect(clipped.changedLines).toBe(2);
    });

    it('края файла остаются пропусками: срез не съедает начало и хвост молча', () => {
        // Форма живого README: единственный ханк в середине файла, якорь — только добавления.
        const fileLines = Array.from({ length: 17 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = {
            oldText: fileLines.slice(0, 12).join('\n'),
            newText: fileLines.join('\n'),
        };
        const model = parseFileDiff({
            fileId: 'route-edges',
            path: 'README.md',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: [
                '@@ -10,3 +10,8 @@',
                ' line-10',
                ' line-11',
                ' line-12',
                '+line-13',
                '+line-14',
                '+line-15',
                '+line-16',
                '+line-17',
                '',
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 13, end: 17 }];
        const clipped = clipModelToAnchors(model, anchors);

        expect(gapsAt(clipped, 'leading')[0]).toMatchObject({ hiddenLines: 9 });
        // Хвост файла из патча не измерить — длину даёт содержимое, как и в Полном диффе.
        expect(gapsAt(clipped, 'trailing')[0]).toMatchObject({ hiddenLines: null });
        expect(remainingHiddenLines(clipped.model, content)).toBe(9);

        // «Раскрыть файл» считает по исходной модели и раскрывает весь файл: краёв больше нет.
        const expansion = expandAllGaps(model, new Map());
        const whole = clipModelToAnchors(expandFileContext(model, content, expansion), anchors, ANCHOR_CONTEXT, expansion);
        expect(lines(whole.model)).toHaveLength(17);
        expect(remainingHiddenLines(whole.model, content)).toBe(0);
    });

    it('раскрывает только выбранный промежуток среза и сохраняет его ключ', () => {
        const context = Array.from({ length: 17 }, (_, index) => ` line-${String(index + 3)}`);
        const model = parseFileDiff({
            fileId: 'route-gap',
            path: 'src/route-gap.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,20 +1,20 @@', ' line-1', '-old-2', '+new-2', ...context, '-old-20', '+new-20'].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [
            { side: 'new', start: 2, end: 2 },
            { side: 'new', start: 20, end: 20 },
        ];
        const initial = clipModelToAnchors(model, anchors);
        const gap = gapsAt(initial, 'inner')[0];
        if (gap === undefined) {
            throw new Error('в срезе нет промежутка');
        }
        const key = gapKeyOf(gap);
        const expansion = expandGap(new Map(), key, 'up', 2);
        const expanded = clipModelToAnchors(model, anchors, ANCHOR_CONTEXT, expansion);
        const nextGap = gapsAt(expanded, 'inner')[0];

        expect(lines(expanded.model).filter((line) => line.kind === 'context')).toHaveLength(
            lines(initial.model).filter((line) => line.kind === 'context').length + 2,
        );
        expect(nextGap?.sourceKey).toBe(key);
        expect(nextGap?.hiddenChanged).toBe(gap.hiddenChanged);
    });

    it('раскрытие перешагивает чужие изменённые строки у границы промежутка', () => {
        const context = Array.from({ length: 25 }, (_, index) => ` line-${String(index + 8)}`);
        const model = parseFileDiff({
            fileId: 'route-foreign',
            path: 'src/route-foreign.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            // Сразу за контекстом якоря идёт правка чужой остановки, и только за ней — неизменённые строки.
            patch: [
                '@@ -1,32 +1,32 @@',
                ' line-1',
                ' line-2',
                '-old-3',
                '+new-3',
                ' line-4',
                ' line-5',
                ' line-6',
                '-old-7',
                '+new-7',
                ...context,
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 3, end: 3 }];
        const initial = clipModelToAnchors(model, anchors);
        const gap = gapsAt(initial, 'trailing')[0];
        if (gap === undefined) {
            throw new Error('в срезе нет хвостового промежутка');
        }
        const key = gapKeyOf(gap);
        expect(gap.hiddenChanged).toBe(2);

        const expanded = clipModelToAnchors(model, anchors, ANCHOR_CONTEXT, expandGap(new Map(), key, 'down', 20));
        const revealed = lines(expanded.model).filter((line) => line.kind === 'context');

        expect(revealed.length).toBe(lines(initial.model).filter((line) => line.kind === 'context').length + 20);
        // Чужая правка осталась скрытой и стала собственным пропуском, а раскрытие у кусков общее.
        for (const line of lines(expanded.model)) {
            expect(line.kind === 'context' || (line.newLine ?? 0) === 3).toBe(true);
        }
        expect(gapsOf(expanded).map((block) => gapKeyOf(block))).toContain(key);
        expect(gapsOf(expanded).filter((block) => (block.hiddenChanged ?? 0) > 0)).toHaveLength(2);
    });

    it('хвост ханка из одних чужих правок отдаёт мишень слипшейся с ним перемычке', () => {
        const fileLines = Array.from({ length: 60 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: fileLines.join('\n'), newText: fileLines.join('\n') };
        const model = parseFileDiff({
            fileId: 'route-merged-gap',
            path: 'src/route-merged-gap.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            // За контекстом якоря ханк кончается добавлениями чужой остановки, дальше — перемычка модели.
            patch: [
                '@@ -1,6 +1,9 @@',
                ' line-1',
                ' line-2',
                '-old-3',
                '+new-3',
                ' line-4',
                ' line-5',
                ' line-6',
                '+new-7',
                '+new-8',
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 3, end: 3 }];
        const show = (expansion: FileExpansion): ClippedModel =>
            clipModelToAnchors(expandFileContext(model, content, expansion), anchors, ANCHOR_CONTEXT, expansion);

        const initial = show(new Map());
        const tail = gapsAt(initial, 'trailing')[0];
        if (tail === undefined) {
            throw new Error('в срезе нет хвостового промежутка');
        }
        // Раскрывать в самом срезе нечего — ключ достался настоящей перемычке, и мишень работает.
        expect(tail.hiddenChanged).toBe(2);
        expect(gapKeyOf(tail).startsWith('clip:')).toBe(false);

        const expanded = show(expandGap(new Map(), gapKeyOf(tail), 'down'));
        expect(lines(expanded.model).length).toBe(lines(initial.model).length + 20);
    });

    it('не прячет обратно контекст исходной перемычки и сохраняет её ключ до исчезновения', () => {
        const contentLines = Array.from({ length: 60 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: contentLines.join('\n'), newText: contentLines.join('\n') };
        const model = parseFileDiff({
            fileId: 'route-source-gap',
            path: 'src/route-source-gap.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: [
                '@@ -1,5 +1,5 @@',
                ' line-1',
                ' line-2',
                '-old-3',
                '+new-3',
                ' line-4',
                ' line-5',
                '@@ -50,5 +50,5 @@',
                ' line-50',
                ' line-51',
                '-old-52',
                '+new-52',
                ' line-53',
                ' line-54',
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [
            { side: 'new', start: 3, end: 3 },
            { side: 'new', start: 52, end: 52 },
        ];
        const sourceGap =
            model.content.kind === 'text'
                ? model.content.blocks.find((block): block is DiffGap => block.kind === 'gap' && block.edge === 'inner')
                : undefined;
        if (sourceGap === undefined) {
            throw new Error('в исходной модели нет внутренней перемычки');
        }
        const key = gapKeyOf(sourceGap);
        const show = (expansion: ReturnType<typeof expandGap>) =>
            clipModelToAnchors(expandFileContext(model, content, expansion), anchors, ANCHOR_CONTEXT, expansion);
        const visibleNewLines = (clipped: ClippedModel): number =>
            new Set(lines(clipped.model).flatMap((line) => (line.newLine === null ? [] : [line.newLine]))).size;

        const initial = show(new Map());
        const onceExpansion = expandGap(new Map(), key, 'up');
        const once = show(onceExpansion);
        const twiceExpansion = expandGap(onceExpansion, key, 'up');
        const twice = show(twiceExpansion);

        expect(visibleNewLines(once)).toBe(visibleNewLines(initial) + 20);
        expect(gapsAt(once, 'inner')[0]?.sourceKey).toBe(key);
        expect(gapsAt(twice, 'inner')[0]?.sourceKey).toBe(key);

        const fullyExpanded = show(expandGap(twiceExpansion, key, 'up'));
        expect(visibleNewLines(fullyExpanded)).toBe(visibleNewLines(initial) + 46);
        expect(gapsAt(fullyExpanded, 'inner')[0]).toMatchObject({
            sourceKey: key,
            hiddenLines: 0,
            hiddenChanged: 1,
        });

        const allExpansion = expandAllGaps(model, new Map());
        const all = show(allExpansion);
        expect(visibleNewLines(all)).toBe(60);
        expect(remainingHiddenLines(all.model, content)).toBe(0);
    });

    it('свёрнутые якоря считаются отдельно от показанных', () => {
        const snapshot = READY?.snapshot;
        if (snapshot == null) {
            throw new Error('фикстуре medium нужен готовый снапшот маршрута');
        }
        const lock = snapshot.stops.find((stop) => stop.id === 's06');
        const model = modelOf('pnpm-lock.yaml');
        const collapsed = (lock?.anchors ?? []).map(({ side, start, end }) => ({ side, start, end }));

        expect(collapsed).toHaveLength(2);
        expect(clipModelToAnchors(model, []).changedLines).toBe(0);
        const changed = changedLinesOf(model);
        const total = (changed?.old.size ?? 0) + (changed?.new.size ?? 0);
        expect(clipModelToAnchors(model, collapsed).changedLines).toBe(total);
    });

    it('непокрытые диапазоны склеиваются и покрывают остаток изменённых строк', () => {
        const model = modelOf('services/orders/src/payments/generated/psp-schema.ts');
        const changed = changedLinesOf(model);
        const total = (changed?.old.size ?? 0) + (changed?.new.size ?? 0);
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 3, end: 8 }];
        const covered = coveredChangedLines(model, anchors);
        const rest = uncoveredRanges(model, anchors);

        // Пробельные строки вне якорей из статистики выпали: они и есть разница с `total`.
        const dropped = droppedWhitespaceLines(model, anchors);
        expect(dropped).toBe(2);
        expect(spanLines(rest) + covered.additions + covered.deletions).toBe(total - dropped);
        // Диапазоны отсортированы и не соприкасаются: соседние номера уже склеены.
        for (const [index, span] of rest.entries()) {
            const previous = rest[index - 1];
            if (previous?.side === span.side) {
                expect(span.start).toBeGreaterThan(previous.end + 1);
            }
        }
    });

    it('пробельные строки вне якорей выпадают из непокрытого, под якорем — считаются', () => {
        // alpha=old1/new1; пустой add=new2 и beta=new3 под якорем; пробельный add=new5 и
        // удаление одного таба old3 — вне якорей; delta=new6 — единственное непокрытое.
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,4 +1,7 @@', ' alpha', '+', '+beta', ' gamma', '+  ', '+delta', '-\t', ' omega', ''].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 2, end: 3 }];
        const changed = changedLinesOf(model);
        const total = (changed?.old.size ?? 0) + (changed?.new.size ?? 0);
        const covered = coveredChangedLines(model, anchors);

        expect(total).toBe(5);
        expect(uncoveredRanges(model, anchors)).toEqual([{ side: 'new', start: 6, end: 6 }]);
        expect(droppedWhitespaceLines(model, anchors)).toBe(2);
        // Якорь объясняет пустую строку наравне с текстовой: правило действует только вне якорей.
        expect(covered).toEqual({ additions: 2, deletions: 0 });
        expect(coveredChangedRanges(model, anchors)).toEqual([{ side: 'new', start: 2, end: 3 }]);
        expect(spanLines(uncoveredRanges(model, anchors)) + covered.additions + covered.deletions).toBe(
            total - droppedWhitespaceLines(model, anchors),
        );
    });

    it('пропуск среза считает и пробельные строки: правило пробельных про статистику, а не про срез', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,2 +1,6 @@', ' alpha', '+one', '+', '+two', '+three', ' omega', ''].join('\n'),
        });
        // Срез из новых 2 и 5: между ними осталась пустая новая 3 и текстовая новая 4.
        const gaps = gapsAt(
            clipModelToAnchors(model, [
                { side: 'new', start: 2, end: 2 },
                { side: 'new', start: 5, end: 5 },
            ]),
            'inner',
        );

        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.hiddenChanged).toBe(2);
        expect(gaps[0]?.hiddenLines).toBe(0);
    });

    it('одна пробельная строка между кусками тоже даёт пропуск: куски не склеиваются молча', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,2 +1,5 @@', ' alpha', '+one', '+', '+two', ' omega', ''].join('\n'),
        });
        const gaps = gapsAt(
            clipModelToAnchors(model, [
                { side: 'new', start: 2, end: 2 },
                { side: 'new', start: 4, end: 4 },
            ]),
            'inner',
        );

        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.hiddenChanged).toBe(1);
    });

    it('без якорей пробельные строки не попадают в непокрытое', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,2 +1,4 @@', ' alpha', '+', '+   ', ' omega', ''].join('\n'),
        });

        expect(uncoveredRanges(model, [])).toEqual([]);
        expect(droppedWhitespaceLines(model, [])).toBe(2);
    });

    it('нетекстовое содержимое возвращается как есть — резать нечего', () => {
        const binary = fixtureIteration('edge').diff.files.find((file) => file.binary);
        if (binary === undefined) {
            throw new Error('в фикстуре edge должен быть двоичный файл');
        }
        const model = parseFileDiff(toParseRequest(binary));
        const clipped = clipModelToAnchors(model, [{ side: 'new', start: 1, end: 10 }]);

        expect(clipped.model).toBe(model);
        expect(clipped.hunks).toBe(0);
    });
});
