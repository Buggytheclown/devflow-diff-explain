import { comment, fixtureIteration, human, thread } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ThreadsCollapse } from '../diff-view/file-card.tsx';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { AnchorSpan } from '../route/anchor-clip.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import { useCardThreads, useThreadsCollapse } from './card-threads.tsx';
import type { IterationLayout } from './model.js';
import { createThreadStore } from './store.js';
import type { ThreadStore } from './store.js';
import { openFileComposer, openReply } from './thread-list.tsx';

/**
 * Куда карточка файла кладёт тред, приколотый к прошлой итерации: в активной
 * итерации устаревший якорь уводит его под шапку, в итерации своего пина он стоит у строк.
 */

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);
const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const PATH = 'services/orders/src/api/handlers.ts';

const OUTDATED: Thread = (() => {
    const thread = V2.threads.find((candidate) => candidate.outdated && candidate.anchor?.path === PATH);
    if (thread === undefined) {
        throw new Error('фикстуре medium нужен устаревший тред на handlers.ts');
    }
    return thread;
})();

const ACTIONS = {
    transport: {
        save: () => Promise.reject(new Error('в тесте не сохраняем')),
        update: () => Promise.reject(new Error('в тесте не сохраняем')),
        delete: () => Promise.reject(new Error('в тесте не сохраняем')),
    },
    resolve: () => Promise.resolve(true),
};

function fileOf(iteration: typeof V1, path: string) {
    const file = iteration.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`в итерации нет ${path}`);
    }
    return file;
}

function underHeader(iteration: typeof V1, layout: IterationLayout | null): string {
    const file = fileOf(iteration, PATH);
    const model = parseFileDiff(toParseRequest(file));
    const store = createThreadStore([OUTDATED], new Set([file.fileId]), layout);

    function Harness() {
        const { threadsUnderHeader } = useCardThreads({
            model,
            rowsShown: true,
            threads: [OUTDATED],
            composers: [],
            store,
            actions: ACTIONS,
            now: NOW,
            onFocusThread: () => undefined,
        });
        return <div>{threadsUnderHeader}</div>;
    }

    return renderToStaticMarkup(<Harness />);
}

const V1_LAYOUT: IterationLayout = {
    diffId: V1.diff.diffId,
    fileIdByPath: new Map(V1.diff.files.map((file) => [file.path, file.fileId])),
};

describe('раскладка тредов по карточке файла', () => {
    it('в активной итерации устаревший тред уезжает под шапку файла', () => {
        expect(underHeader(V2, null)).toContain(`thread-${OUTDATED.id}`);
    });

    it('в итерации своего пина тот же тред под шапкой не появляется — он у строк', () => {
        expect(underHeader(V1, V1_LAYOUT)).not.toContain(`thread-${OUTDATED.id}`);
    });

    it('пин указывает на чужую итерацию — тред снова под шапкой', () => {
        const alien: IterationLayout = { ...V1_LAYOUT, diffId: 'другая-итерация' };

        expect(underHeader(V1, alien)).toContain(`thread-${OUTDATED.id}`);
    });

    /** Комментарий к картинке — якорь без строки, и садится он туда же. */
    it('композер с якорем без строки встаёт под шапкой, а не у строк', () => {
        const file = fileOf(V2, PATH);
        const store = createThreadStore([], new Set([file.fileId]));
        openFileComposer(store, file.fileId, file.path, false);
        const composer = store.getComposersSnapshot().byFile.get(file.fileId) ?? [];

        function Harness() {
            const { threadsUnderHeader, renderAfterLine } = useCardThreads({
                model: parseFileDiff(toParseRequest(file)),
                rowsShown: true,
                threads: [],
                composers: composer,
                store,
                actions: ACTIONS,
                now: NOW,
                onFocusThread: () => undefined,
            });
            return (
                <div>
                    <div data-slot="header">{threadsUnderHeader}</div>
                    <div data-slot="line">{renderAfterLine('new', 1)}</div>
                </div>
            );
        }

        const html = renderToStaticMarkup(<Harness />);
        const header = html.slice(html.indexOf('data-slot="header"'), html.indexOf('data-slot="line"'));

        expect(composer).toHaveLength(1);
        expect(composer[0]?.anchor?.position).toBeNull();
        expect(header).toContain('thread-composer');
        expect(header).toContain('Замечание по файлу целиком');
        expect(html.slice(html.indexOf('data-slot="line"'))).not.toContain('thread-composer');
    });
});

const FILE = fileOf(V1, PATH);
const MODEL = parseFileDiff(toParseRequest(FILE));
const LINE = 48;

function lineThread(id: string, line: number, author = human('kai', 'Kai Kennedy')): Thread {
    return thread({
        id,
        anchor: { fileId: FILE.fileId, path: FILE.path, position: { side: 'new', line, size: 1 } },
        root: comment({ id: `${id}-root`, author, body: 'вопрос по строке', createdAt: '2026-08-24T10:00:00.000Z' }),
    });
}

describe('маркер треда на кромке карточки', () => {
    function markerHtml(threads: readonly Thread[], line = LINE): string {
        const store = createThreadStore(threads, new Set([FILE.fileId]));
        store.setThreadsOpen(
            threads.map((item) => item.id),
            false,
        );

        function Harness() {
            const { renderLineMarker, renderAfterLine, lineThreadIds } = useCardThreads({
                model: MODEL,
                rowsShown: true,
                threads,
                composers: [],
                store,
                actions: ACTIONS,
                now: NOW,
                onFocusThread: () => undefined,
            });
            return (
                <div data-ids={lineThreadIds.join(',')}>
                    <div data-slot="marker">{renderLineMarker([{ side: 'new', line }])}</div>
                    <div data-slot="line">{renderAfterLine('new', line)}</div>
                </div>
            );
        }

        return renderToStaticMarkup(<Harness />);
    }

    it('маркер встаёт у своей строки, чужие строки его не получают', () => {
        const html = markerHtml([lineThread('m1', LINE)]);
        const marker = html.slice(html.indexOf('data-slot="marker"'), html.indexOf('data-slot="line"'));

        expect(marker).toContain('thread-marker');
        expect(marker).toContain('aria-expanded="false"');
        expect(marker).toContain('Раскрыть: Kai Kennedy · вопрос по строке');
        expect(markerHtml([lineThread('m1', LINE)], LINE + 1)).not.toContain('thread-marker');
    });

    it('свёрнутый тред не занимает ни строки — под строкой пусто', () => {
        const html = markerHtml([lineThread('m1', LINE)]);

        expect(html.slice(html.indexOf('data-slot="line"'))).not.toContain('thread-list');
    });

    it('несколько тредов одной строки дают один маркер с суммарным счётчиком', () => {
        const html = markerHtml([lineThread('m1', LINE), lineThread('m2', LINE, human('ada', 'Ada Ortiz'))]);
        const marker = html.slice(html.indexOf('data-slot="marker"'), html.indexOf('data-slot="line"'));

        expect([...marker.matchAll(/class="ctl thread-marker/g)]).toHaveLength(1);
        expect(marker).toContain('>2<');
        // Аватар — первого автора строки.
        expect(marker).toContain('>KK<');
    });
});

describe('треды свёрнутой карточки', () => {
    interface CardSlots {
        /** Разметка под шапкой: треды без маркера, раскрытые треды и свёрнутые строками выше них. */
        readonly header: string;
        /** Разметка стопки маркеров у сводки: свёрнутые треды после последнего раскрытого. */
        readonly markers: string;
    }

    function slots(html: string): CardSlots {
        return {
            header: html.slice(html.indexOf('data-slot="header"'), html.indexOf('data-slot="markers"')),
            markers: html.slice(html.indexOf('data-slot="markers"')),
        };
    }

    /** Раскрыты в сторе только треды из `open`. */
    function storeWith(threads: readonly Thread[], open: readonly string[]): ThreadStore {
        const store = createThreadStore(threads, new Set([FILE.fileId]));
        store.setThreadsOpen(
            threads.map((item) => item.id),
            false,
        );
        store.setThreadsOpen(open, true);
        return store;
    }

    function cardOf(
        threads: readonly Thread[],
        open: readonly string[],
        options: {
            cardCollapsed: boolean;
            model?: typeof MODEL | null;
            placement?: 'nearest' | 'exact';
            shownSpans?: readonly AnchorSpan[];
            store?: ThreadStore;
        },
    ): CardSlots {
        const store = options.store ?? storeWith(threads, open);

        function Harness() {
            const { threadsUnderHeader, collapsedMarkers } = useCardThreads({
                model: options.model === undefined ? MODEL : options.model,
                rowsShown: false,
                cardCollapsed: options.cardCollapsed,
                threads,
                composers: [],
                store,
                actions: ACTIONS,
                now: NOW,
                onFocusThread: () => undefined,
                ...(options.placement === undefined ? {} : { placement: options.placement }),
                ...(options.shownSpans === undefined ? {} : { shownSpans: options.shownSpans }),
            });
            return (
                <div>
                    <div data-slot="header">{threadsUnderHeader}</div>
                    <div data-slot="markers">{collapsedMarkers}</div>
                </div>
            );
        }

        return slots(renderToStaticMarkup(<Harness />));
    }

    /** Маркеры стопки по порядку: `aria-expanded` каждого. */
    function markerStates(markers: string): string[] {
        return [...markers.matchAll(/class="ctl thread-marker[^"]*" aria-expanded="(true|false)"/g)].map(
            (match) => match[1] ?? '',
        );
    }

    const folded = lineThread('folded', LINE);
    const opened = lineThread('opened', LINE + 1);

    it('у каждого треда у строки свой маркер; свёрнутый под шапку не выходит, раскрытый выходит', () => {
        for (const placement of ['nearest', 'exact'] as const) {
            const card = cardOf([folded, opened], [opened.id], { cardCollapsed: true, placement });

            expect(card.header).not.toContain('thread-folded');
            expect(card.header).toContain('thread-opened');
            // Свёрнутый тред строкой выше раскрытого стоит над ним, у сводки маркеров не остаётся.
            expect(markerStates(card.header)).toEqual(['false', 'true']);
            expect(card.header).toContain('class="ctl thread-marker is-open"');
            expect(markerStates(card.markers)).toEqual([]);
        }
    });

    it('маркеры стоят по порядку строк, а не по порядку тредов', () => {
        const top = lineThread('top', LINE - 2, human('ada', 'Ada Ortiz'));
        const card = cardOf([folded, top], [], { cardCollapsed: true });

        expect(card.markers.indexOf('>AO<')).toBeLessThan(card.markers.indexOf('>KK<'));
    });

    it('тред без позиции стоит под шапкой раскрытым и маркера не получает', () => {
        const general = thread({
            id: 'general',
            anchor: { fileId: FILE.fileId, path: FILE.path, position: null },
            root: comment({
                id: 'general-root',
                author: human('kai', 'Kai Kennedy'),
                body: 'про файл',
                createdAt: '2026-08-24T10:00:00.000Z',
            }),
        });
        const card = cardOf([general, folded], [], { cardCollapsed: true });

        expect(card.header).toContain('thread-general');
        expect(markerStates(card.markers)).toEqual(['false']);

        // Тред без маркера стоит под шапкой первым, раскрытый тред с маркером — после него.
        const withOpen = cardOf([folded, general], [folded.id], { cardCollapsed: true });
        expect(markerStates(withOpen.header)).toEqual(['true']);
        expect(withOpen.header.indexOf('thread-general')).toBeLessThan(
            withOpen.header.indexOf('file-card__marked-thread'),
        );
    });

    it('без модели свёрнутая карточка рисует маркеры тредам с позицией', () => {
        const card = cardOf([folded, opened], [opened.id], { cardCollapsed: true, model: null });

        expect(card.header).not.toContain('thread-folded');
        expect(card.header).toContain('thread-opened');
        expect(markerStates(card.header)).toEqual(['false', 'true']);
        expect(markerStates(card.markers)).toEqual([]);
    });

    /**
     * Маршрут разбирает свёрнутые карточки фоном: приход модели не должен сам раскрыть тред.
     * Якорь шире ханка: строка 66 внутри него, но в патче её нет (пропуск 62–77).
     */
    it('карточка остановки до и после разбора одинаково раскладывает треды', () => {
        const spans: readonly AnchorSpan[] = [{ side: 'new', start: 46, end: 70 }];
        const inside = lineThread('inside', LINE);
        const beyondPatch = lineThread('beyond-patch', 66);
        const outside = lineThread('outside', 85);
        const threads = [inside, beyondPatch, outside];
        const store = storeWith(threads, []);

        for (const model of [null, clipModelToAnchors(MODEL, spans).model]) {
            const card = cardOf(threads, [], { cardCollapsed: true, placement: 'exact', shownSpans: spans, model, store });

            expect(card.header).not.toContain('thread-inside');
            expect(card.header).not.toContain('thread-beyond-patch');
            // Вне среза остановки тред и в развёрнутой карточке стоит под шапкой без маркера.
            expect(card.header).toContain('thread-outside');
            expect(markerStates(card.markers)).toEqual(['false', 'false']);
        }
    });

    it('строк нет не из-за свёртки (провал разбора, нотис) — все треды под шапкой, маркеров нет', () => {
        const card = cardOf([folded, opened], [opened.id], { cardCollapsed: false });

        expect(card.header).toContain('thread-folded');
        expect(card.header).toContain('thread-opened');
        expect(card.markers).not.toContain('thread-marker');
    });
});

describe('«свернуть все» в шапке карточки', () => {
    /** Хук читается со свежего рендера: подпись кнопки обязана следовать за стором. */
    function collapseOf(store: ThreadStore, ids: readonly string[]): ThreadsCollapse | null {
        let captured: ThreadsCollapse | null = null;

        function Harness() {
            captured = useThreadsCollapse(store, ids);
            return null;
        }

        renderToStaticMarkup(<Harness />);
        return captured;
    }

    it('кнопки нет, пока тред у строк один', () => {
        const single = lineThread('one', LINE);
        const store = createThreadStore([single], new Set([FILE.fileId]));

        expect(collapseOf(store, [single.id])).toBeNull();
    });

    it('тред с открытым композером не сворачивается и не держит подпись на «свернуть все»', () => {
        const typing = lineThread('c1', LINE);
        const plain = lineThread('c2', LINE + 1);
        const store = createThreadStore([typing, plain], new Set([FILE.fileId]));
        const ids = [typing.id, plain.id];

        expect(collapseOf(store, ids)?.canCollapse).toBe(true);

        openReply(store, typing, false);
        collapseOf(store, ids)?.onToggle();
        expect(store.isThreadOpen(typing.id)).toBe(true);
        expect(store.isThreadOpen(plain.id)).toBe(false);

        // Сворачивать больше нечего: кнопка снова предлагает раскрыть — и раскрывает.
        const next = collapseOf(store, ids);
        expect(next?.canCollapse).toBe(false);
        next?.onToggle();
        expect(store.isThreadOpen(plain.id)).toBe(true);
    });
});
