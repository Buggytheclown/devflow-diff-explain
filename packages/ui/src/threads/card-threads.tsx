import type { Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { LinePosition } from '../diff-view/diff-rows.tsx';
import type { ThreadsCollapse } from '../diff-view/file-card.tsx';
import type { LineRange } from '../diff-view/selection.js';
import type { AnchorSpan } from '../route/anchor-clip.js';
import type { ComposerLayout } from './composer-markdown.js';
import { placeThreadsOnVisibleLines, positionLastLine, threadAtLines } from './model.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import type { ThreadActions } from './thread-list.tsx';
import { NewCommentComposer, ThreadList } from './thread-list.tsx';
import { ThreadMarker } from './thread-marker.tsx';

/**
 * Раскладка тредов и композеров по карточке файла: что уходит под шапку, а что встаёт
 * под конкретной строкой. Одна механика на обе вью — карточки полного диффа и карточки
 * остановок маршрута обязаны вести себя одинаково (принцип 5 в `docs/product.md` §3: одна читалка, два порядка).
 *
 * На маршруте модель карточки обрезана якорями остановки, поэтому тред со строки, которой
 * в срезе нет, честно уезжает под шапку — тем же путём, что и тред без позиции.
 */

export interface CardThreadsInput {
    /** Модель, которая реально нарисована в карточке (после раскрытия контекста и обрезки). */
    readonly model: DiffFileModel | null;
    /** Строки диффа рисуются: свёрнутая карточка тредов по строкам не раскладывает. */
    readonly rowsShown: boolean;
    /**
     * Карточка свёрнута (вручную, просмотром, машинный файл, размер). Тред, который стоял бы у строки,
     * получает маркер на кромке у сводки и под шапку выходит, только пока раскрыт. Если строк нет
     * по другой причине (провал разбора, нотис), все треды стоят под шапкой без маркеров.
     */
    readonly cardCollapsed?: boolean;
    readonly threads: readonly Thread[];
    readonly composers: readonly ComposerSnapshot[];
    readonly store: ThreadStore;
    readonly actions: ThreadActions;
    readonly now: number;
    readonly onFocusThread: (threadId: string | null) => void;
    /** Только галерея: раскладка редактора должна быть детерминированной. */
    readonly initialLayout?: ComposerLayout;
    /**
     * Куда девать тред, чьей строки в нарисованной модели нет. `nearest` (полный дифф) сажает
     * его на ближайшую видимую строку: там модель полная, и соседняя строка — та же правка.
     * `exact` (маршрут) уводит такой тред под шапку: карточка остановки показывает лишь её
     * диапазоны, и «ближайшая» строка была бы из чужого куска файла.
     */
    readonly placement?: 'nearest' | 'exact';
    /**
     * Диапазоны, которыми `exact` режет модель (якоря остановки). По ним свёрнутая карточка
     * решает, кому рисовать маркер, одинаково до разбора модели и после.
     */
    readonly shownSpans?: readonly AnchorSpan[];
}

export interface CardThreads {
    readonly threadsUnderHeader: ReactNode;
    readonly renderAfterLine: (side: 'old' | 'new', line: number) => ReactNode;
    /** Маркер на кромке карточки: рисуется внутри самого ряда, колонки под него нет. */
    readonly renderLineMarker: (positions: readonly LinePosition[]) => ReactNode;
    /**
     * Маркеры свёрнутой карточки у сводки: свёрнутые треды строками ниже последнего раскрытого
     * (или все, если раскрытых нет), по одному на тред; `null`, если их нет.
     */
    readonly collapsedMarkers: ReactNode;
    readonly focusedThreadRange: LineRange | null;
    /** Треды этого файла, стоящие у своих строк: по ним считается «свернуть все». */
    readonly lineThreadIds: readonly string[];
}

export function useCardThreads({
    model,
    rowsShown,
    cardCollapsed = false,
    threads,
    composers,
    store,
    actions,
    now,
    onFocusThread,
    initialLayout,
    placement = 'nearest',
    shownSpans,
}: CardThreadsInput): CardThreads {
    const [focusedThreadRange, setFocusedThreadRange] = useState<LineRange | null>(null);
    // Итерация нарисованного диффа: в старой у своих строк стоят только треды её пина.
    // Роль итерации меняется на лету (пуш делает её прошлой), поэтому читается из стора.
    // Раскрытость тредов приезжает тем же снапшотом — маркер и блок под строкой обязаны
    // переключаться одним кадром.
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const iteration = snapshot.iterationLayout;
    const openThreads = snapshot.openThreads;
    const focusThread = useCallback(
        (threadId: string | null): void => {
            const thread = threads.find((candidate) => candidate.id === threadId);
            setFocusedThreadRange(
                thread !== undefined && threadAtLines(thread, iteration) ? (thread.anchor?.position ?? null) : null,
            );
            onFocusThread(threadId);
        },
        [iteration, onFocusThread, threads],
    );
    const layout = useMemo(() => {
        const underHeader = threads.filter((thread) => !threadAtLines(thread, iteration));
        const positional = threads.filter((thread) => threadAtLines(thread, iteration));
        const onScreen =
            placement === 'exact'
                ? positional.filter((thread) => positionShown(model, rowsShown, thread.anchor?.position))
                : positional;
        const offScreen = placement === 'exact' ? positional.filter((thread) => !onScreen.includes(thread)) : [];
        const placed = rowsShown
            ? placeThreadsOnVisibleLines(model, onScreen)
            : { byLine: new Map<string, readonly Thread[]>(), unplaced: onScreen };
        const atLinesWhenShown =
            rowsShown || !cardCollapsed ? EMPTY_IDS : threadsAtLinesWhenShown(model, positional, placement, shownSpans);
        return {
            byLine: placed.byLine,
            underHeader: [...underHeader, ...placed.unplaced, ...offScreen],
            atLinesWhenShown,
            collapsedMarked:
                atLinesWhenShown.size === 0
                    ? EMPTY_THREADS
                    : sortByLine(positional.filter((thread) => atLinesWhenShown.has(thread.id))),
        };
    }, [cardCollapsed, iteration, model, placement, rowsShown, shownSpans, threads]);
    const shownUnderHeader = useMemo(
        () =>
            layout.atLinesWhenShown.size === 0
                ? layout.underHeader
                : layout.underHeader.filter((thread) => !layout.atLinesWhenShown.has(thread.id)),
        [layout],
    );
    // Треды с маркерами свёрнутой карточки идут одним списком в порядке строк: раскрытый тред
    // разрезает стопку маркеров, свёрнутые строками выше остаются над ним, ниже — под ним.
    // Хвост стопки после последнего раскрытого стоит у сводки, остальное — под шапкой.
    const markedSegments = useMemo(() => {
        const head: MarkedSegment[] = [];
        let pending: Thread[] = [];
        for (const thread of layout.collapsedMarked) {
            if (openThreads.has(thread.id)) {
                if (pending.length > 0) {
                    head.push({ open: false, threads: pending });
                    pending = [];
                }
                head.push({ open: true, thread });
            } else {
                pending.push(thread);
            }
        }
        return { head, tail: pending };
    }, [layout.collapsedMarked, openThreads]);
    const collapsedMarkers = useMemo(
        () =>
            markedSegments.tail.length === 0
                ? null
                : markedSegments.tail.map((thread) => (
                      <ThreadMarker key={thread.id} threads={[thread]} store={store} openThreads={openThreads} />
                  )),
        [markedSegments.tail, openThreads, store],
    );
    const markedThreads = useMemo(
        () =>
            markedSegments.head.length === 0
                ? null
                : markedSegments.head.map((segment) =>
                      segment.open ? (
                          <div key={segment.thread.id} className="diff-row-extra thread-fade file-card__marked-thread">
                              <ThreadMarker threads={[segment.thread]} store={store} openThreads={openThreads} />
                              <div className={`thread-line${segment.thread.resolved ? ' thread-line--resolved' : ''}`}>
                                  <ThreadList
                                      threads={[segment.thread]}
                                      store={store}
                                      actions={actions}
                                      now={now}
                                      onFocusThread={focusThread}
                                      {...(initialLayout === undefined ? {} : { initialLayout })}
                                  />
                              </div>
                          </div>
                      ) : (
                          <div key={segment.threads[0]?.id} className="file-card__collapsed-markers">
                              {segment.threads.map((thread) => (
                                  <ThreadMarker
                                      key={thread.id}
                                      threads={[thread]}
                                      store={store}
                                      openThreads={openThreads}
                                  />
                              ))}
                          </div>
                      ),
                  ),
        [actions, focusThread, initialLayout, markedSegments.head, now, openThreads, store],
    );

    const composerLayout = useMemo(() => {
        const byLine: ComposerSnapshot[] = [];
        const underHeader: ComposerSnapshot[] = [];
        for (const composer of composers) {
            if (positionShown(model, rowsShown, composer.anchor?.position)) {
                byLine.push(composer);
            } else {
                underHeader.push(composer);
            }
        }
        return { byLine, underHeader };
    }, [composers, model, rowsShown]);

    const threadsUnderHeader = useMemo(
        () =>
            shownUnderHeader.length === 0 &&
            composerLayout.underHeader.length === 0 &&
            markedThreads === null ? null : (
                <>
                    {shownUnderHeader.length === 0 ? null : (
                        <ThreadList
                            threads={shownUnderHeader}
                            store={store}
                            actions={actions}
                            now={now}
                            onFocusThread={focusThread}
                            {...(initialLayout === undefined ? {} : { initialLayout })}
                        />
                    )}
                    {markedThreads}
                    {composerLayout.underHeader.map((composer) => (
                        <div key={composer.key} className="diff-row-extra thread-fade">
                            <NewCommentComposer
                                composerKey={composer.key}
                                store={store}
                                transport={actions.transport}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        </div>
                    ))}
                </>
            ),
        [
            actions,
            composerLayout.underHeader,
            initialLayout,
            markedThreads,
            shownUnderHeader,
            now,
            focusThread,
            store,
        ],
    );

    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const lineThreads = layout.byLine.get(`${side}:${String(line)}`) ?? EMPTY_THREADS;
            // Свёрнутый тред не занимает ни строки: в DOM от него остаётся только маркер.
            const shown = lineThreads.filter((thread) => openThreads.has(thread.id));
            const composer = composerLayout.byLine.find(
                (candidate) =>
                    candidate.anchor?.position?.side === side && positionLastLine(candidate.anchor.position) === line,
            );
            if (shown.length === 0 && composer === undefined) {
                return null;
            }
            return (
                <div className="diff-row-extra thread-fade">
                    {shown.length === 0 ? null : (
                        <div
                            className={`thread-line${shown.every((thread) => thread.resolved) ? ' thread-line--resolved' : ''}`}
                        >
                            <ThreadList
                                threads={shown}
                                store={store}
                                actions={actions}
                                now={now}
                                onFocusThread={focusThread}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        </div>
                    )}
                    {composer === undefined ? null : (
                        <div className="diff-line-composer">
                            <NewCommentComposer
                                composerKey={composer.key}
                                store={store}
                                transport={actions.transport}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        </div>
                    )}
                </div>
            );
        },
        [
            actions,
            composerLayout.byLine,
            initialLayout,
            layout.byLine,
            now,
            focusThread,
            openThreads,
            store,
        ],
    );

    const renderLineMarker = useCallback(
        (positions: readonly LinePosition[]): ReactNode => {
            // Несколько тредов одной строки сворачиваются в один маркер: аватар первого
            // автора, счётчик — суммарный, клик раскрывает и сворачивает их вместе.
            const lineThreads = positions.flatMap(
                (position) => layout.byLine.get(`${position.side}:${String(position.line)}`) ?? EMPTY_THREADS,
            );
            if (lineThreads.length === 0) {
                return null;
            }
            return <ThreadMarker threads={lineThreads} store={store} openThreads={openThreads} />;
        },
        [layout.byLine, openThreads, store],
    );

    const lineThreadIds = useMemo(
        () => [...layout.byLine.values()].flatMap((bucket) => bucket.map((thread) => thread.id)),
        [layout.byLine],
    );

    return {
        threadsUnderHeader,
        renderAfterLine,
        renderLineMarker,
        collapsedMarkers,
        focusedThreadRange,
        lineThreadIds,
    };
}

/**
 * «Свернуть все / развернуть все» треды карточки (docs/design/SPEC-changes-2026-09-20.md §3):
 * кнопка есть, только когда тредов у строк хотя бы два. Подпись обещает то, что кнопка сделает.
 *
 * Тред с открытым композером скопом не сворачивается: там несохранённый текст ревьюера. Такой
 * тред не считается и в подписи — иначе она застряла бы на «свернуть все» у кнопки, которой
 * уже нечего сворачивать.
 */
export function useThreadsCollapse(store: ThreadStore, threadIds: readonly string[]): ThreadsCollapse | null {
    const openThreads = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).openThreads;
    const typing = useSyncExternalStore(
        store.subscribeComposers,
        store.getComposersSnapshot,
        store.getComposersSnapshot,
    ).openThreadIds;
    const canCollapse = threadIds.some((id) => openThreads.has(id) && !typing.has(id));
    const onToggle = useCallback(() => {
        const open = store.getSnapshot().openThreads;
        const busy = store.getComposersSnapshot().openThreadIds;
        const collapse = threadIds.some((id) => open.has(id) && !busy.has(id));
        store.setThreadsOpen(collapse ? threadIds.filter((id) => !busy.has(id)) : threadIds, !collapse);
    }, [store, threadIds]);
    return threadIds.length < 2 ? null : { canCollapse, onToggle };
}

/**
 * Треды, которые стояли бы у строк, будь карточка развёрнута: свёрнутая карточка рисует им маркеры у сводки
 * и выпускает под шапку только раскрытые.
 *
 * Полный дифф свёрнутую карточку не разбирает, поэтому без модели у строк считается каждый тред с позицией.
 * Маршрут разбирает файлы фоном, и приход модели не должен сам выпустить свёрнутый тред под шапку:
 * для `exact` тред, чья последняя строка внутри `shownSpans`, считается у строк и до разбора, и после,
 * даже если этой строки нет в патче. Тред на строке контекста вне спанов (у кромки якоря, на другой
 * стороне) до разбора стоит под шапкой, после уходит к строкам: без модели его не отличить.
 *
 * Поэтому множество шире маркеров развёрнутой карточки. Тред внутри `shownSpans` на строке, которой нет
 * в срезе, свёрнутая карточка показывает маркером, а развёрнутая — под шапкой, раскрытым и без маркера.
 * Так же расходится файл с нотисом «только пробелы» при выключенном показе пробелов: развёрнутая карточка
 * строк не рисует, а `whitespaceOnly` и `showWhitespace` здесь не учитываются.
 */
function threadsAtLinesWhenShown(
    model: DiffFileModel | null,
    positional: readonly Thread[],
    placement: 'nearest' | 'exact',
    shownSpans: readonly AnchorSpan[] | undefined,
): ReadonlySet<string> {
    if (model === null) {
        const atLines =
            placement === 'exact' && shownSpans !== undefined
                ? positional.filter((thread) => positionInSpans(shownSpans, thread.anchor?.position))
                : positional;
        return new Set(atLines.map((thread) => thread.id));
    }
    const candidates =
        placement === 'exact'
            ? positional.filter((thread) => positionShown(model, true, thread.anchor?.position))
            : positional;
    const ids = new Set<string>();
    for (const bucket of placeThreadsOnVisibleLines(model, candidates).byLine.values()) {
        for (const thread of bucket) {
            ids.add(thread.id);
        }
    }
    if (placement === 'exact' && shownSpans !== undefined) {
        for (const thread of positional) {
            if (positionInSpans(shownSpans, thread.anchor?.position)) {
                ids.add(thread.id);
            }
        }
    }
    return ids;
}

function positionInSpans(
    spans: readonly AnchorSpan[],
    position: { readonly side: 'old' | 'new'; readonly line: number; readonly size: number } | null | undefined,
): boolean {
    if (position === null || position === undefined) {
        return false;
    }
    const line = positionLastLine(position);
    return spans.some((span) => span.side === position.side && line >= span.start && line <= span.end);
}

/** Строка позиции реально нарисована в карточке. */
function positionShown(
    model: DiffFileModel | null,
    rowsShown: boolean,
    position: { readonly side: 'old' | 'new'; readonly line: number; readonly size: number } | null | undefined,
): boolean {
    return (
        rowsShown &&
        position !== null &&
        position !== undefined &&
        modelHasPosition(model, position.side, positionLastLine(position))
    );
}

export function modelHasPosition(model: DiffFileModel | null, side: 'old' | 'new', line: number): boolean {
    if (model?.content.kind !== 'text') {
        return false;
    }
    return model.content.blocks.some(
        (block) =>
            block.kind === 'hunk' &&
            block.lines.some((candidate) => (side === 'old' ? candidate.oldLine : candidate.newLine) === line),
    );
}

/**
 * Порядок маркеров свёрнутой карточки — по последней строке якоря, при равенстве старая сторона раньше.
 * Без модели старые и новые номера не сопоставить, зато порядок не прыгает, когда модель приходит.
 */
function sortByLine(threads: readonly Thread[]): readonly Thread[] {
    const key = (thread: Thread): readonly [number, number] => {
        const position = thread.anchor?.position;
        return position === null || position === undefined
            ? [Number.MAX_SAFE_INTEGER, 0]
            : [positionLastLine(position), position.side === 'old' ? 0 : 1];
    };
    return [...threads].sort((a, b) => {
        const [lineA, sideA] = key(a);
        const [lineB, sideB] = key(b);
        return lineA - lineB || sideA - sideB;
    });
}

/** Кусок списка тредов с маркерами под шапкой: раскрытый тред или стопка свёрнутых перед ним. */
type MarkedSegment =
    | { readonly open: true; readonly thread: Thread }
    | { readonly open: false; readonly threads: readonly Thread[] };

const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_IDS: ReadonlySet<string> = new Set();
