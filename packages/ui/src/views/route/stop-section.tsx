import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../i18n/index.js';
import type { StopLink } from '../../markdown/markdown.tsx';
import type { readStateOf } from '../../progress/read-state.js';
import { buildDigest, buildDigestTestCode } from '../../route/digest.js';
import type { RouteEntry, RouteFileGroup, RouteStopView } from '../../route/route-model.js';
import { canUnmountStopDiff, lazyCards } from '../../route/route-model.js';
import { FileChips } from './file-chips.tsx';
import type { StopChangeThread } from './stop-card.tsx';
import {
    AnchorDrift,
    CollapsedStop,
    EmptyStop,
    StopCard,
    StopConflicts,
    StopSkeleton,
    ViewedSummary,
} from './stop-card.tsx';
import { TestDigest } from './test-digest.tsx';
import { useNearViewport, useOnScreen } from './use-on-screen.js';

/**
 * Одна остановка маршрута: карточка рассказа слева и колонка диффа справа, обрезанная якорями
 * остановки. Колонка снимается с DOM, когда ревьюер уехал далеко, — место держит
 * плейсхолдер в последнюю измеренную высоту.
 */

export interface StopSectionProps {
    readonly view: RouteStopView;
    /** Первая остановка маршрута: её колонка диффа с DOM не снимается. */
    readonly first: boolean;
    /** Первая свёрнутая low-остановка: на её свёртке стоит цель шага тура `fold-<stopId>`. */
    readonly tourFold: boolean;
    /** Файлы с живым выделением, открытым композером или фокусом строки — по всему маршруту. */
    readonly busyFileIds: ReadonlySet<string>;
    /** Метка раскладки колонки: её смена обнуляет измеренную высоту, `null` — мерить рано. */
    readonly layoutKeyOf: (stopId: string, files: readonly RouteFileGroup[]) => string | null;
    /** Остановка — цель незакончившегося прыжка. */
    readonly jumping: boolean;
    readonly entries: readonly RouteEntry[];
    readonly stopCount: number;
    readonly comments: number;
    /** Ссылки на треды-причины блока «почему изменилась остановка». */
    readonly changeThreads: readonly StopChangeThread[];
    readonly onOpenThread?: (threadId: string) => void;
    /** null — показывать все файлы остановки (фильтра нет или остановка удержана на экране). */
    readonly fileIds: ReadonlySet<string> | null;
    readonly keptInView: boolean;
    readonly viewed: boolean;
    /** Файлы остановки ещё разбираются: диапазоны отметки посчитать не из чего. */
    readonly pending: boolean;
    /** У части файлов разбор сорвался: их диапазонов не будет, пока его не повторили. */
    readonly parseFailed: boolean;
    /** Агент отвалился посреди генерации: у заполненного встаёт тихая пометка (docs/design/SPEC-elements.md §4.4). */
    readonly filledBeforeStop: boolean;
    /** Свёрнута: отметкой, ручной свёрткой `x` или свёрткой low-тира по умолчанию. */
    readonly collapsed: boolean;
    readonly collapsedManually: boolean;
    /** См. `StopCardProps.marked`. */
    readonly marked: boolean;
    /** Значение сорвавшейся записи отметки; `null` — записи не срывались. */
    readonly failedViewed: boolean | null;
    readonly flash: boolean;
    readonly readStateOf: (fileId: string) => ReturnType<typeof readStateOf>;
    readonly onViewed: (viewed: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    readonly onExpand: () => void;
    readonly onOpenFile: (stopId: string, fileId: string) => void;
    /** Переход по внутренней ссылке описания; `stopId` — остановка, из описания которой кликнули. */
    readonly onOpenLink?: (stopId: string, link: StopLink) => void;
    readonly onVisible: (fileIds: readonly string[]) => void;
    readonly renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
    /** Дайджест-остановка: тест-код раскрыт под карточкой дайджеста (docs/design/README.md §2). */
    readonly testCodeShown: boolean;
    readonly onToggleTestCode: () => void;
    /** Есть ли на маршруте карточка, в которой нарисован файл якоря утверждения. */
    readonly anchorReachable: (fileId: string, line: number) => boolean;
    readonly onOpenAnchor: (fileId: string, line: number) => void;
}

/**
 * Рисует ли остановка плашку свёртки. Те же условия, по которым колонка диффа в `StopSection`
 * выбирает `collapsed`: остановка заполнена, якоря на месте, и файлы после линзы у неё есть.
 */
export function collapsedStopShown(view: RouteStopView, fileIds: ReadonlySet<string> | null): boolean {
    if (view.stop.status === 'queued' || view.stop.status === 'filling' || view.drift) {
        return false;
    }
    const files = fileIds === null ? view.files : view.files.filter((group) => fileIds.has(group.fileId));
    return files.length > 0 || buildDigest(view.stop) !== null;
}

export function StopSection({
    view,
    first,
    tourFold,
    busyFileIds,
    layoutKeyOf,
    jumping,
    entries,
    stopCount,
    comments,
    changeThreads,
    onOpenThread,
    fileIds,
    keptInView,
    viewed,
    pending,
    parseFailed,
    filledBeforeStop,
    collapsed,
    collapsedManually,
    marked,
    failedViewed,
    flash,
    readStateOf: readState,
    onViewed,
    onFillStop,
    onExpand,
    onOpenFile,
    onOpenLink,
    onVisible,
    renderCard,
    testCodeShown,
    onToggleTestCode,
    anchorReachable,
    onOpenAnchor,
}: StopSectionProps) {
    const t = useT();
    const ref = useRef<HTMLDivElement | null>(null);
    const diffRef = useRef<HTMLDivElement | null>(null);
    const onScreen = useOnScreen(ref);
    const nearViewport = useNearViewport(ref, {
        mountMargin: MOUNT_MARGIN,
        unmountMargin: UNMOUNT_MARGIN,
    });
    const files = useMemo(
        () => (fileIds === null ? view.files : view.files.filter((group) => fileIds.has(group.fileId))),
        [fileIds, view.files],
    );
    // Заказ разбора идёт по всем файлам остановки, включая спрятанный тест-код: seen-диапазоны
    // отметки считаются по якорям остановки и от тогла не зависят.
    const ids = useMemo(() => files.map((group) => group.fileId), [files]);
    useEffect(() => {
        if (onScreen) {
            onVisible(ids);
        }
    }, [ids, onScreen, onVisible]);

    const digest = useMemo(() => buildDigest(view.stop), [view.stop]);
    // Гибрид «дайджест + обычные файлы»: прячется только пересечение файлов якорей утверждений
    // с файлами этой остановки после линзы. Остальные карточки рисуются как всегда.
    const testCode = useMemo(
        () =>
            digest === null
                ? null
                : buildDigestTestCode(
                      digest,
                      entries,
                      view.stop.id,
                      files.map((group) => group.fileId),
                      t,
                  ),
        [digest, entries, files, t, view.stop.id],
    );
    const shownFiles = useMemo(
        () =>
            testCode === null || testCodeShown
                ? files
                : files.filter((group) => !testCode.hiddenFileIds.has(group.fileId)),
        [files, testCode, testCodeShown],
    );

    const lines = files.reduce((total, group) => total + group.additions + group.deletions, 0);
    const cards = onScreen ? shownFiles : lazyCards(shownFiles);

    /**
     * Метка раскладки этой колонки. Считается по нарисованным файлам, поэтому линза, тогл
     * тест-кода и правки в соседних остановках сюда не протекают.
     */
    const layoutKey = useMemo(() => {
        const key = layoutKeyOf(view.stop.id, shownFiles);
        return key === null ? null : `${key}|${testCodeShown ? 'test' : ''}`;
    }, [layoutKeyOf, shownFiles, testCodeShown, view.stop.id]);

    /**
     * Высота колонки диффа, измеренная под текущей раскладкой. Меряется, пока колонка на месте;
     * плейсхолдер держит ровно её, поэтому снятие с DOM не двигает документ и не сбивает прокрутку.
     */
    const [measured, setMeasured] = useState<{ readonly key: string; readonly height: number } | null>(null);
    const measuredHeight = measured !== null && measured.key === layoutKey ? measured.height : null;
    const busy = view.files.some((group) => busyFileIds.has(group.fileId));

    const status = view.stop.status;
    /** Что рисует колонка диффа: всё, кроме `cards`, укладывается в скелетон или одну строку. */
    const content: 'skeleton' | 'drift' | 'conflicts' | 'empty' | 'collapsed' | 'cards' =
        status === 'queued' || status === 'filling'
            ? 'skeleton'
            : view.drift
              ? 'drift'
              : files.length === 0 && digest === null
                ? view.conflictPaths.length > 0
                    ? // Вся остановка ушла в конфликтные файлы: «ханков нет» тут соврало бы.
                      'conflicts'
                    : 'empty'
                : collapsed
                  ? 'collapsed'
                  : 'cards';

    const unmounted = canUnmountStopDiff({
        nearViewport,
        measuredHeight,
        first,
        rendersCards: content === 'cards',
        jumping: jumping || flash,
        busy,
    });

    /**
     * Мерить можно только колонку в её полном виде: у остановки, которая ещё не побывала на
     * экране, нарисована лишь голова списка (`lazyCards`), а вместо карточек могут стоять
     * скелетоны и однострочные сводки — такой замер увёл бы плейсхолдер на сотни пикселей.
     */
    const measurable = !unmounted && layoutKey !== null && onScreen && content === 'cards';

    useEffect(() => {
        const element = diffRef.current;
        if (layoutKey === null || !measurable || element === null) {
            return;
        }
        const record = (): void => {
            const height = element.offsetHeight;
            setMeasured((previous) =>
                previous !== null && previous.key === layoutKey && Math.abs(previous.height - height) < 1
                    ? previous
                    : { key: layoutKey, height },
            );
        };
        // Первый замер — руками: смена раскладки не всегда меняет высоту, а мерить её заново надо.
        record();
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        const observer = new ResizeObserver(record);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [layoutKey, measurable]);

    const diff = unmounted ? (
        // Колонка снята с DOM: место держит последняя измеренная высота, документ не дёргается.
        <div
            className="route-stop__placeholder"
            style={{ height: `${String(measuredHeight ?? 0)}px` }}
            aria-hidden="true"
        />
    ) : content === 'skeleton' ? (
        // Слот плана ждёт заполнения: скелет, а не «ханков нет» — рассказывать пока нечего.
        <StopSkeleton />
    ) : content === 'drift' ? (
        <AnchorDrift paths={view.unresolvedPaths} />
    ) : content === 'conflicts' ? (
        <StopConflicts paths={view.conflictPaths} />
    ) : content === 'empty' ? (
        <EmptyStop
            text={t(
                status === 'failed'
                    ? 'route.emptyStop.unfilled'
                    : view.empty
                      ? 'route.emptyStop.noRanges'
                      : 'route.emptyStop.filtered',
            )}
        />
    ) : content === 'collapsed' ? (
        viewed ? (
            <ViewedSummary
                lines={lines}
                files={files.length}
                assertions={digest?.total ?? 0}
                onExpand={onExpand}
            />
        ) : (
            <CollapsedStop
                label={t(
                    'route.collapsed',
                    lines,
                    files.length,
                    t(collapsedManually ? 'route.collapsed.reason.manual' : 'route.collapsed.reason.low'),
                )}
                {...(tourFold ? { dataTour: `fold-${view.stop.id}` } : {})}
                onExpand={onExpand}
            />
        )
    ) : (
        <>
            {/* Часть якорей не резолвится, часть — да: нотис встаёт над уцелевшими карточками. */}
            {view.unresolvedPaths.length === 0 ? null : <AnchorDrift paths={view.unresolvedPaths} partial />}
            {view.conflictPaths.length === 0 ? null : <StopConflicts paths={view.conflictPaths} />}
            {digest === null ? null : (
                <TestDigest
                    model={digest}
                    shown={testCodeShown}
                    onToggle={onToggleTestCode}
                    hiddenFiles={testCode?.hiddenFileIds.size ?? 0}
                    location={testCode?.location ?? null}
                    anchorReachable={(anchor) => anchorReachable(anchor.fileId, anchor.line)}
                    onOpenAnchor={(anchor) => {
                        onOpenAnchor(anchor.fileId, anchor.line);
                    }}
                />
            )}
            {cards.map((group) => renderCard(view.stop.id, group))}
            {cards.length < shownFiles.length ? (
                <p className="route-stop__lazy">{t('route.lazyMore', shownFiles.length - cards.length)}</p>
            ) : null}
        </>
    );

    return (
        <div ref={ref} data-stop={view.stop.id}>
            <StopCard
                view={view}
                tourAnchors={first}
                stopCount={stopCount}
                comments={comments}
                changeThreads={changeThreads}
                {...(onOpenThread === undefined ? {} : { onOpenThread })}
                viewed={viewed}
                pending={pending}
                parseFailed={parseFailed}
                filledBeforeStop={filledBeforeStop}
                onViewed={onViewed}
                {...(onFillStop === undefined ? {} : { onFillStop })}
                {...(onOpenLink === undefined
                    ? {}
                    : {
                          onOpenLink: (link: StopLink) => {
                              onOpenLink(view.stop.id, link);
                          },
                      })}
                failedViewed={failedViewed}
                marked={marked}
                keptInView={keptInView}
                flash={flash}
                chips={
                    <FileChips
                        files={files}
                        readStateOf={readState}
                        onOpen={(fileId) => {
                            onOpenFile(view.stop.id, fileId);
                        }}
                    />
                }
                diffRef={diffRef}
                diff={diff}
            />
        </div>
    );
}

/**
 * Границы гистерезиса, по которым колонка диффа остановки возвращается на DOM и уходит с него.
 * Монтируем за экран вперёд — карточки успевают отрисоваться до подъезда; снимаем
 * заметно дальше, чтобы край остановки, стоящий ровно на границе, не мигал каждый кадр.
 */
const MOUNT_MARGIN = 1200;
const UNMOUNT_MARGIN = 2500;
