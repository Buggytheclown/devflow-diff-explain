import type { AgentNote, FileContent, FileDiff, Thread } from '@sherpa/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode, Ref } from 'react';
import {
    memo,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { useT } from '../i18n/index.js';
import { useUiSettings } from '../settings/context.tsx';
import { useCssPixelSizes } from '../styles/use-css-pixel-sizes.js';
import type { CardNoteActions } from '../notes/card-notes.tsx';
import { useCardNotes } from '../notes/card-notes.tsx';
import type { FileReadState } from '../progress/read-state.js';
import { readStateOf as computeReadState } from '../progress/read-state.js';
import type { AnchorSpan } from '../route/anchor-clip.js';
import type { RouteMarginFile, RouteMarginModel } from '../route/margin-model.js';
import type { SessionStore } from '../session/session-store.js';
import type { MarginStripActions } from '../route/route-margin.tsx';
import { RouteBadge, useMarginStrips } from '../route/route-margin.tsx';
import { useCardThreads, useThreadsCollapse } from '../threads/card-threads.tsx';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { createThreadStore } from '../threads/store.js';
import type { ComposerSnapshot, ThreadStore } from '../threads/store.js';
import type { ContextExpandRequest, ContextExpandResult } from './context-expansion.js';
import { expandContext } from './context-expansion.js';
import type { FileExpansion } from './expand.js';
import type { Feedback, FileCardActions } from './file-card.tsx';
import type { LineSelection } from './selection.js';
import { COLLAPSE_THRESHOLD, FileCard, showsCollapsedSummary, shownFileModel } from './file-card.tsx';
import type { DiffMode, DiffViewStore, FileCollapseReason } from './store.js';
import { fileCollapseReason } from './store.js';
import { useSelectionLifecycle } from './use-selection.js';

/**
 * Список карточек диффа с виртуализацией (docs/design/SPEC-elements.md §8 п.8: 60+ файлов при 60fps). В DOM живут
 * только видимые карточки плюс запас за краем окна, поэтому и разбор диффа воркером ленивый: файл
 * разбирается ровно тогда, когда до него доскроллили.
 *
 * Высоты карточек меряются по факту (`measureElement`) — оценка живёт ровно до первого замера.
 * Ключ к тому, чтобы замер не переставлял скролл: скелетон «дифф разбирается…» сам по себе ниже
 * готовой карточки в разы, поэтому он получает min-height по той же оценке. Тогда холодная
 * карточка меряется примерно в свой слот, а приход модели меняет высоту на малую дельту.
 *
 * Мерять и холодную карточку обязательно: кроме скелетона в ней живут треды, полосы маршрута и
 * пометка о фильтре — их высоту из метаданных файла не вывести никак, а незамеренный слот на них
 * не рассчитан, и карточка налезала бы на следующую.
 */

/** Однострочный нотис или свёрнутая карточка: отступы 7+7, строка 11px/1.5 и рамка. */
const NOTICE_ROW_HEIGHT = 32;
/**
 * Грубая поправка на неизменённые строки контекста и перемычки между ханками: их числа в
 * метаданных файла нет, а из одних `additions`/`deletions` его не вывести. Значение — замер
 * `fixture-large`: три строки контекста и две перемычки. У файла с несколькими ханками оценка
 * останется заниженной — точность здесь вторична, недостачу добирает измерение с компенсацией.
 */
const HUNK_CONTEXT_HEIGHT = 104;

/** Сколько карточек держать за пределами экрана: меньше — видно подгрузку, больше — дороже. */
const OVERSCAN = 3;

const DIFF_CSS_SIZES = {
    codeLineHeight: '--line-height-code',
    cardChromeHeight: '--diff-card-estimate-chrome-height',
} as const;

/** Кадров на доводку прокрутки к файлу из ссылки: за это время карточки успевают измериться. */
const SCROLL_TO_FILE_FRAMES = 12;

/** Императивное управление списком: дерево файлов просит прокрутить к своей строке. */
export interface DiffListHandle {
    /**
     * `true` — карточка найдена и виртуализатор закончил доводку; `false` — запрос отменён или
     * файла нет. `reveal: false` оставляет свёртку цели как есть: переход к следующему файлу
     * после отметки не должен разворачивать уже просмотренный или generated-файл.
     */
    readonly scrollToFile: (fileId: string, options?: { readonly reveal?: boolean }) => Promise<boolean>;
}

export interface DiffFileListProps {
    /** Единственный скролл-контейнер вью; список сам остаётся обычным блоком. */
    readonly scrollElement: HTMLElement | null;
    /** Узел над списком: изменение его высоты сдвигает начало виртуального списка. */
    readonly scrollMarginElement?: HTMLElement | null;
    /** Липкая полоса над карточками: переход к файлу оставляет цель сразу под ней. */
    readonly scrollPaddingStart: number;
    readonly files: readonly FileDiff[];
    readonly store: DiffViewStore;
    /** Хост умеет отдавать содержимое файлов (`capabilities.fileContent`). */
    readonly contentAvailable: boolean;
    /** Почему содержимого нет: у среза между итерациями оно недоступно и без хоста. */
    readonly noContentReason?: string | undefined;
    /** Разбор патча — воркером на живых данных, синхронным парсером в галерее. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** Отметка «просмотрено»: оптимистичная запись живёт во вью, список её только зовёт. */
    readonly onViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    readonly session: SessionStore;
    readonly notes?: readonly AgentNote[];
    readonly noteActions?: CardNoteActions;
    readonly threadStore?: ThreadStore | undefined;
    readonly threadActions?: ThreadActions | undefined;
    readonly threadVisible?: ((thread: Thread) => boolean) | undefined;
    readonly onCommentLine?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    /** Комментарий к файлу без строки: пункт меню карточки-картинки. */
    readonly onCommentFile?: ((fileId: string) => void) | undefined;
    readonly onLineFocus?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onFocusThread?: ((threadId: string | null) => void) | undefined;
    readonly threadNow?: number | undefined;
    readonly outsideThreads?: ReactNode;
    /** Маршрут на полях карточек (docs/design/README.md §10); null — маршрута нет, полей тоже. */
    readonly routeMargin?: RouteMarginModel | null;
    /** Действие штрихованной полосы (docs/design/README.md §10); без него полоса остаётся подписью. */
    readonly marginActions?: MarginStripActions | null;
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** Файл из фрагмента URL (`file=`): к нему прокручиваемся при открытии. */
    readonly initialFileId?: string | null;
    /**
     * Файл, оставленный на экране вопреки фильтру (docs/design/SPEC-elements.md §2.7): карточка получает пометку
     * «вне текущего фильтра». Кто его туда положил — дело вью.
     */
    readonly keptFileId?: string | null;
    /**
     * Файл, от которого вью уже заказало переход к следующему: его схлопывание якорь не ставит,
     * иначе доводка списка и прокрутка вью тянули бы экран в разные стороны.
     */
    readonly advancingFileId?: string | null;
    /** Верхняя карточка вьюпорта — scroll-spy для активной строки дерева. */
    readonly onTopFileChange?: (fileId: string | null) => void;
    /**
     * Прокрутка ревьюера: ею вью снимает пометку «оставлен на экране». Собственная доводка
     * списка (ссылка на файл, прыжок из дерева, перекладка после фильтра) сюда не приходит.
     */
    readonly onScroll?: () => void;
    readonly ref?: Ref<DiffListHandle>;
}

export function DiffFileList({
    scrollElement,
    scrollMarginElement = null,
    scrollPaddingStart,
    files,
    store,
    contentAvailable,
    noContentReason,
    parse,
    loadContent,
    onViewed,
    session,
    notes = EMPTY_NOTES,
    noteActions = EMPTY_NOTE_ACTIONS,
    threadStore = EMPTY_THREAD_STORE,
    threadActions = EMPTY_THREAD_ACTIONS,
    threadVisible = HIDE_THREAD,
    onCommentLine = NOOP_LINE,
    onCommentFile = NOOP_FILE,
    onLineFocus = NOOP_LINE,
    onLineBlur = NOOP,
    onFocusThread = NOOP_THREAD,
    threadNow: providedThreadNow,
    outsideThreads = null,
    routeMargin = null,
    marginActions = null,
    onJumpToStop,
    initialFileId = null,
    keptFileId = null,
    advancingFileId = null,
    onTopFileChange,
    onScroll,
    ref,
}: DiffFileListProps) {
    const t = useT();
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
    const composersSnapshot = useSyncExternalStore(threadStore.subscribeComposers, threadStore.getComposersSnapshot);
    const notesByFile = useMemo(() => {
        const grouped = new Map<string, AgentNote[]>();
        for (const note of notes) {
            const bucket = grouped.get(note.anchor.fileId);
            if (bucket === undefined) {
                grouped.set(note.anchor.fileId, [note]);
            } else {
                bucket.push(note);
            }
        }
        return grouped;
    }, [notes]);
    const threadNowRef = useRef(providedThreadNow ?? Date.now());
    const threadNow = providedThreadNow ?? threadNowRef.current;
    const { textSize } = useUiSettings();
    const { codeLineHeight, cardChromeHeight } = useCssPixelSizes(scrollElement, DIFF_CSS_SIZES);
    const listRef = useRef<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    const requested = useRef(new Set<string>());
    // Файлы, разбор которых сорвался: сам собой он не повторится, повтор просит ревьюер.
    const [parseErrors, setParseErrors] = useState<ReadonlyMap<string, string>>(new Map());

    // Режим, в котором считаются оценки. За тумблером он следует, только пока не разобран ни
    // один файл: пересчёт оценок посреди жизни списка увёз бы всё, что ниже сгиба, — смену
    // оценки виртуализатор не компенсирует, он умеет только измеренные высоты. Стартовое
    // значение так успевает дождаться замера ширины.
    const estimateMode = useRef(snapshot.effectiveMode);
    if (snapshot.models.size === 0) {
        estimateMode.current = snapshot.effectiveMode;
    }
    const { readState, collapseCollapsed, collapseExpanded, collapseExpandedViewed } = snapshot;
    const collapseReasons = useMemo(() => {
        const reasons = new Map<string, FileCollapseReason>();
        const collapseSnapshot = { readState, collapseCollapsed, collapseExpanded, collapseExpandedViewed };
        for (const file of files) {
            const reason = fileCollapseReason(collapseSnapshot, file);
            if (reason !== null) {
                reasons.set(file.fileId, reason);
            }
        }
        return reasons;
    }, [files, readState, collapseCollapsed, collapseExpanded, collapseExpandedViewed]);

    // `scrollMargin` переводит позиции виртуализатора в координаты внешнего скроллера.
    // Снимаем его до отрисовки и после изменений раскладки; rect надёжнее цепочки offsetParent.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (list === null || scrollElement === null) {
            return;
        }
        const report = (): void => {
            const margin =
                list.getBoundingClientRect().top -
                scrollElement.getBoundingClientRect().top +
                scrollElement.scrollTop;
            setScrollMargin((previous) => (previous === margin ? previous : margin));
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(list);
        observer.observe(scrollElement);
        if (scrollMarginElement !== null) {
            observer.observe(scrollMarginElement);
        }
        return () => {
            observer.disconnect();
        };
    }, [files, scrollElement, scrollMarginElement, scrollPaddingStart]);

    const virtualizer = useVirtualizer({
        count: files.length,
        getScrollElement: () => scrollElement,
        estimateSize: (index) =>
            cardChromeHeight +
            estimateBodyHeight(files[index], estimateMode.current, collapseReasons.has(files[index]?.fileId ?? ''), codeLineHeight),
        overscan: OVERSCAN,
        getItemKey: (index) => files[index]?.fileId ?? index,
        scrollMargin,
        scrollPaddingStart,
    });

    /**
     * `shouldAdjustScrollPositionOnItemSizeChange` в virtual-core 3.17.8 — свойство инстанса,
     * а не опция хука: переданное в `useVirtualizer` молча игнорируется.
     *
     * Правило: карточка, целиком лежащая выше вьюпорта, компенсируется всегда — в любом
     * направлении прокрутки. Умолчание библиотеки при движении вверх компенсацию отключает,
     * и разобравшийся выше файл утаскивал список из-под курсора. Карточка, задевающая вьюпорт
     * или лежащая ниже, растёт вниз: двигать под ней скролл значило бы увезти видимый текст.
     */
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
        item.end <= (virtualizer.scrollOffset ?? 0) + scrollPaddingStart + virtualizer.scrollAdjustments;

    const previousTypography = useRef({ textSize, codeLineHeight, cardChromeHeight });
    useEffect(() => {
        const previous = previousTypography.current;
        if (
            previous.textSize === textSize &&
            previous.codeLineHeight === codeLineHeight &&
            previous.cardChromeHeight === cardChromeHeight
        ) {
            return;
        }
        previousTypography.current = { textSize, codeLineHeight, cardChromeHeight };
        // Невидимые карточки тоже меняют размеры: ResizeObserver измеряет только элементы в DOM.
        virtualizer.measure();
        for (const element of virtualizer.elementsCache.values()) {
            virtualizer.measureElement(element);
        }
    }, [textSize, codeLineHeight, cardChromeHeight, virtualizer]);

    const items = virtualizer.getVirtualItems();

    // Разбор видимых файлов: воркер отвечает асинхронно, повторно один файл не заказываем.
    useEffect(() => {
        for (const item of items) {
            const file = files[item.index];
            if (
                file === undefined ||
                collapseReasons.has(file.fileId) ||
                requested.current.has(file.fileId)
            ) {
                continue;
            }
            requested.current.add(file.fileId);
            void parse(file).then(
                (model) => {
                    store.setModel(file.fileId, model);
                },
                (error: unknown) => {
                    // Файл остаётся в `requested`: сам собой повтор ушёл бы в цикл на падающем
                    // воркере. Карточка честно говорит о провале и предлагает кнопку повтора.
                    setParseErrors((previous) =>
                        new Map(previous).set(file.fileId, error instanceof Error ? error.message : String(error)),
                    );
                },
            );
        }
        // `parseErrors` в зависимостях ради повтора: набор видимых файлов от него не меняется,
        // но снятая отметка о провале обязана заново привести сюда — иначе повтор ждал бы
        // случайной прокрутки.
    }, [items, files, parse, store, parseErrors, collapseReasons]);

    const retryParse = useCallback((fileId: string) => {
        requested.current.delete(fileId);
        setParseErrors((previous) => {
            const next = new Map(previous);
            next.delete(fileId);
            return next;
        });
    }, []);

    // Ширина, доступная диффу: ниже 1100px side-by-side недоступен (docs/design/SPEC-elements.md §2.6). Меряется сам
    // список, а не окно: слева от него панель дерева, и её ширина диффу не принадлежит.
    // Считаем padding-box (`clientWidth`): страничные отступы — часть места, отданного диффу,
    // иначе на эталонных 1440px (`docs/design/README.md` «Fidelity») порог не проходил бы никогда.
    // Стартовое значение снимается сразу: ResizeObserver в фоновой вкладке молчит.
    useEffect(() => {
        const element = listRef.current;
        if (element === null) {
            return;
        }
        const report = (): void => {
            store.setAvailableWidth(element.clientWidth);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [store]);

    useSelectionLifecycle(store);

    // Пока список доводит прокрутку сам (ссылка `#file=`, прыжок из дерева, перекладка после
    // смены фильтра), наверх не уходит ни одно событие прокрутки: это не жест ревьюера, и по
    // нему нельзя гасить пометку «оставлен на экране» (docs/design/SPEC-elements.md §2.7).
    const settling = useRef(0);
    // Активная лесенка доводки: её отменяет и новый переход, и колесо ревьюера.
    const converging = useRef<ConvergingScroll | null>(null);
    const converge = useCallback(
        (index: number) => {
            // Две наложенные доводки тянули бы список в разные стороны.
            converging.current?.cancel();
            settling.current += 1;
            const run = convergeScroll(
                () => {
                    virtualizer.scrollToIndex(index, { align: 'start' });
                },
                () => scrollElement?.scrollTop ?? 0,
                () => {
                    if (converging.current === run) {
                        converging.current = null;
                    }
                    // Кадром позже: события прокрутки браузер рассылает после последнего шага.
                    requestAnimationFrame(() => {
                        settling.current -= 1;
                    });
                },
            );
            converging.current = run;
            return run;
        },
        [scrollElement, virtualizer],
    );

    // ResizeObserver не видит карточку вне DOM. При смене свёртки явно заменяем её старый замер
    // новой оценкой; липкую шапку схлопнувшейся карточки оставляем под тулбаром — ревьюер
    // остался на ней. Единственное исключение — карточка, от которой вью уже заказало переход
    // к следующему файлу (`advancingFileId`): держать её значило бы
    // тянуть экран назад против собственной прокрутки вью.
    const previousCollapseReasons = useRef<ReadonlyMap<string, FileCollapseReason>>(collapseReasons);
    useEffect(() => {
        const previous = previousCollapseReasons.current;
        const frame = requestAnimationFrame(() => {
            previousCollapseReasons.current = collapseReasons;
            const viewportTop =
                (virtualizer.scrollOffset ?? 0) + scrollPaddingStart + virtualizer.scrollAdjustments;
            let anchorIndex: number | null = null;
            for (let index = 0; index < files.length; index += 1) {
                const file = files[index];
                if (file === undefined) {
                    continue;
                }
                const wasCollapsed = previous.has(file.fileId);
                const collapsed = collapseReasons.has(file.fileId);
                if (wasCollapsed === collapsed) {
                    continue;
                }
                const measurement = virtualizer.measurementsCache[index];
                if (
                    collapsed &&
                    file.fileId !== advancingFileId &&
                    measurement !== undefined &&
                    measurement.start < viewportTop &&
                    measurement.end > viewportTop
                ) {
                    anchorIndex = index;
                }
                virtualizer.resizeItem(
                    index,
                    cardChromeHeight + estimateBodyHeight(file, estimateMode.current, collapsed, codeLineHeight),
                );
            }
            if (anchorIndex !== null) {
                virtualizer.scrollToIndex(anchorIndex, { align: 'start' });
                converge(anchorIndex);
            }
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [advancingFileId, cardChromeHeight, codeLineHeight, collapseReasons, converge, files, scrollPaddingStart, virtualizer]);

    // Доводка длится до 12 кадров и всё это время дёргает `scrollToIndex` — без отмены колесо
    // и палец ревьюера на эти кадры просто не действовали бы.
    useEffect(() => {
        const element = scrollElement;
        if (element === null) {
            return;
        }
        return watchUserScroll(element, () => {
            converging.current?.cancel();
        });
    }, [scrollElement]);

    const focusCheck = useRef<number | null>(null);
    const handleScroll = useCallback(() => {
        if (settling.current === 0) {
            onScroll?.();
        }
        if (focusCheck.current !== null) {
            cancelAnimationFrame(focusCheck.current);
        }
        focusCheck.current = requestAnimationFrame(() => {
            focusCheck.current = null;
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || active.closest('.diff-row') === null) {
                onLineBlur();
            }
        });
    }, [onLineBlur, onScroll]);
    useEffect(() => {
        const element = scrollElement;
        if (element === null) {
            return;
        }
        element.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            element.removeEventListener('scroll', handleScroll);
        };
    }, [handleScroll, scrollElement]);
    useEffect(
        () => () => {
            if (focusCheck.current !== null) {
                cancelAnimationFrame(focusCheck.current);
            }
        },
        [],
    );

    // Ссылка на файл (`#file=`) открывает дифф прокрученным к нему.
    const scrolled = useRef<string | null>(null);
    useEffect(() => {
        if (initialFileId === null) {
            scrolled.current = null;
            return;
        }
        if (scrolled.current === initialFileId) {
            return;
        }
        const target = initialFileId;
        const index = files.findIndex((file) => file.fileId === target);
        if (index < 0) {
            return;
        }
        scrolled.current = target;
        store.revealFile(target);

        const run = converge(index);
        return () => {
            // Доводку прервали, не доведя (StrictMode размонтирует эффекты дважды) — значит
            // прокрутки не было, и следующий заход обязан её повторить.
            if (!run.cancel() && scrolled.current === target) {
                scrolled.current = null;
            }
        };
    }, [files, initialFileId, converge, store]);

    // Прокрутка к файлу по требованию дерева. Предыдущую доводку отменяет сам `converge`.
    useImperativeHandle(
        ref,
        () => ({
            scrollToFile: (fileId: string, options) => {
                const index = files.findIndex((file) => file.fileId === fileId);
                if (index < 0) {
                    return Promise.resolve(false);
                }
                if (options?.reveal !== false) {
                    store.revealFile(fileId);
                }
                return converge(index).finished;
            },
        }),
        [files, converge, store],
    );

    // Scroll-spy для дерева: верхняя карточка вьюпорта. Виртуализатор перерисовывает список
    // на каждом кадре прокрутки, поэтому отдельного слушателя не нужно.
    const topFileId = topFile(files, items, (virtualizer.scrollOffset ?? 0) + scrollPaddingStart);
    const reportedTop = useRef<string | null>(null);
    useEffect(() => {
        if (onTopFileChange !== undefined && topFileId !== reportedTop.current) {
            reportedTop.current = topFileId;
            onTopFileChange(topFileId);
        }
    }, [topFileId, onTopFileChange]);

    const expand = useCallback(
        (fileId: string, request: ContextExpandRequest): Promise<ContextExpandResult> =>
            expandContext({ store, fileId, request, contentAvailable, loadContent, t }),
        [contentAvailable, loadContent, store, t],
    );

    const actions = useMemo<FileCardActions>(
        () => ({
            onViewed,
            onExpand: expand,
            onRetryParse: retryParse,
            onToggleCollapse: store.toggleFileCollapse,
            onOpenFile: store.openFile,
            onShowWhitespace: store.showWhitespace,
            onToggleMarkdown: store.toggleMarkdown,
            onSelectText: store.selectText,
            onClearSelection: store.clearSelection,
            onSelectStart: (fileId, key, side, extend) => {
                store.beginSelection();
                if (extend) {
                    store.extendSelection(fileId, key, side);
                } else {
                    store.startSelection(fileId, key, side);
                }
            },
            onSelectExtend: store.dragSelection,
            onCommentLine,
            onCommentFile,
            onLineFocus,
            onLineBlur,
        }),
        [expand, onCommentFile, onCommentLine, onLineBlur, onLineFocus, onViewed, retryParse, store],
    );

    return (
        <div
            className="diff-list"
            ref={listRef}
            data-collapsed-files={collapseReasons.size}
            data-generated-collapsed-files={countGeneratedCollapsed(files, collapseReasons)}
        >
            <div className="diff-list__inner" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
                {items.map((item) => {
                    const file = files[item.index];
                    if (file === undefined) {
                        return null;
                    }
                    return (
                        <VirtualFileCard
                            key={file.fileId}
                            file={file}
                            index={item.index}
                            start={item.start - scrollMargin}
                            measure={virtualizer.measureElement}
                            model={snapshot.models.get(file.fileId) ?? null}
                            parseError={parseErrors.get(file.fileId) ?? null}
                            mode={snapshot.effectiveMode}
                            estimatedBody={estimateBodyHeight(
                                file,
                                estimateMode.current,
                                collapseReasons.has(file.fileId),
                                codeLineHeight,
                            )}
                            collapseReason={collapseReasons.get(file.fileId) ?? null}
                            content={snapshot.content.get(file.fileId)}
                            contentAvailable={contentAvailable}
                            noContentReason={noContentReason}
                            expansion={snapshot.expansion.get(file.fileId) ?? EMPTY_EXPANSION}
                            read={readStateOf(snapshot, file)}
                            opened={snapshot.opened.has(file.fileId)}
                            showWhitespace={snapshot.whitespaceShown.has(file.fileId)}
                            markdown={snapshot.markdownShown.has(file.fileId)}
                            keptInView={file.fileId === keptFileId}
                            selection={snapshot.selection?.fileId === file.fileId ? snapshot.selection : null}
                            session={session}
                            notes={notesByFile.get(file.fileId) ?? EMPTY_NOTES}
                            noteActions={noteActions}
                            threads={threadSnapshot.byFile.get(file.fileId) ?? EMPTY_THREADS}
                            keptThreadIds={threadSnapshot.keptByFile.get(file.fileId) ?? EMPTY_THREAD_IDS}
                            composers={composersSnapshot.byFile.get(file.fileId) ?? EMPTY_COMPOSERS}
                            threadVisible={threadVisible}
                            threadStore={threadStore}
                            threadActions={threadActions}
                            threadNow={threadNow}
                            onFocusThread={onFocusThread}
                            margin={routeMargin?.files.get(file.fileId) ?? null}
                            marginActions={marginActions}
                            otherStopId={routeMargin?.otherStopId ?? null}
                            onJumpToStop={onJumpToStop}
                            actions={actions}
                        />
                    );
                })}
            </div>
            {outsideThreads}
        </div>
    );
}

const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_NOTES: readonly AgentNote[] = [];
const EMPTY_NOTE_ACTIONS: CardNoteActions = {
    onOpenInChat: () => undefined,
    onTurnIntoDraft: () => undefined,
    onDelete: () => Promise.reject(new Error('deleting notes is unavailable here')),
};
const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set();
const EMPTY_EXPANSION: FileExpansion = new Map();
const EMPTY_COMPOSERS: readonly ComposerSnapshot[] = [];
const EMPTY_SPANS: readonly AnchorSpan[] = [];

const VirtualFileCard = memo(function VirtualFileCard({
    file,
    index,
    start,
    measure,
    model,
    parseError,
    mode,
    estimatedBody,
    collapseReason,
    content,
    contentAvailable,
    noContentReason,
    expansion,
    read,
    opened,
    showWhitespace,
    markdown,
    keptInView,
    selection,
    session,
    notes,
    noteActions,
    threads,
    keptThreadIds,
    composers,
    threadVisible,
    threadStore,
    threadActions,
    threadNow,
    onFocusThread,
    margin,
    marginActions,
    otherStopId,
    onJumpToStop,
    actions,
}: {
    file: FileDiff;
    index: number;
    start: number;
    measure: (element: HTMLDivElement | null) => void;
    model: DiffFileModel | null;
    parseError: string | null;
    mode: DiffMode;
    /** Оценка тела карточки от списка — ею скелетон занимает свой виртуальный слот. */
    estimatedBody: number;
    collapseReason: FileCollapseReason | null;
    content: FileContent | null | undefined;
    contentAvailable: boolean;
    noContentReason: string | undefined;
    expansion: FileExpansion;
    read: FileReadState;
    opened: boolean;
    showWhitespace: boolean;
    markdown: boolean;
    keptInView: boolean;
    selection: LineSelection | null;
    session: SessionStore;
    notes: readonly AgentNote[];
    noteActions: CardNoteActions;
    threads: readonly Thread[];
    keptThreadIds: ReadonlySet<string>;
    composers: readonly ComposerSnapshot[];
    threadVisible: (thread: Thread) => boolean;
    threadStore: ThreadStore;
    threadActions: ThreadActions;
    threadNow: number;
    onFocusThread: (threadId: string | null) => void;
    margin: RouteMarginFile | null;
    marginActions: MarginStripActions | null;
    otherStopId: string | null;
    onJumpToStop: ((stopId: string) => void) | undefined;
    actions: FileCardActions;
}) {
    const shownModel = useMemo(
        () => shownFileModel(model, content ?? null, expansion),
        [content, expansion, model],
    );
    const visibleThreads = useMemo(
        () => threads.filter((thread) => keptThreadIds.has(thread.id) || threadVisible(thread)),
        [keptThreadIds, threadVisible, threads],
    );
    const changed = (model?.additions ?? file.additions) + (model?.deletions ?? file.deletions);
    const sizeCollapsed = !opened && changed > COLLAPSE_THRESHOLD;
    const canRenderRows =
        collapseReason === null &&
        parseError === null &&
        shownModel?.content.kind === 'text' &&
        (!shownModel.whitespaceOnly || showWhitespace) &&
        !sizeCollapsed;
    const {
        threadsUnderHeader,
        renderAfterLine: renderThreads,
        renderLineMarker,
        collapsedMarkers,
        focusedThreadRange,
        lineThreadIds,
    } = useCardThreads({
        model: shownModel,
        rowsShown: canRenderRows,
        cardCollapsed: showsCollapsedSummary(collapseReason, sizeCollapsed, parseError, model),
        threads: visibleThreads,
        composers,
        store: threadStore,
        actions: threadActions,
        now: threadNow,
        onFocusThread,
    });
    const { notesUnderHeader, renderAfterLine: renderNotes } = useCardNotes({
        model: shownModel,
        rowsShown: canRenderRows,
        notes,
        placement: 'nearest',
        session,
        actions: noteActions,
    });
    const { underHeader: stripsUnderHeader, renderAfterLine: renderStrip } = useMarginStrips({
        model: shownModel,
        rowsShown: canRenderRows,
        ranges: margin?.uncovered ?? EMPTY_SPANS,
        file,
        actions: marginActions,
    });
    const underHeader = threadsUnderHeader === null && notesUnderHeader === null ? null : (
        <>
            {threadsUnderHeader}
            {notesUnderHeader}
        </>
    );
    // Треды, заметки и штриховка делят слот под строкой; порядок остаётся одинаковым на обеих вью.
    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const threads = renderThreads(side, line);
            const noteRows = renderNotes(side, line);
            const strip = renderStrip(side, line);
            if (threads === null && noteRows === null && strip === null) {
                return null;
            }
            return (
                <>
                    {threads}
                    {noteRows}
                    {strip}
                </>
            );
        },
        [renderNotes, renderStrip, renderThreads],
    );
    const threadsCollapse = useThreadsCollapse(threadStore, lineThreadIds);

    return (
        <div
            className="diff-list__item"
            data-index={index}
            ref={measure}
            // Позиция через `top`, а не `transform`: липкая шапка карточки считается по
            // layout-позиции и иначе «залипает» у своего низа вместо верхней кромки экрана.
            style={{ top: `${String(start)}px` }}
        >
            <FileCard
                file={file}
                model={model}
                parseError={parseError}
                mode={mode}
                content={content}
                contentAvailable={contentAvailable}
                noContentReason={noContentReason}
                expansion={expansion}
                shownModel={shownModel}
                read={read}
                collapseReason={collapseReason}
                onToggleCollapse={() => {
                    actions.onLineBlur?.();
                    // Состояние живёт в DiffViewStore; FileCard остаётся чистым и маршрут его не получает.
                    actions.onToggleCollapse?.(file.fileId);
                }}
                opened={opened}
                showWhitespace={showWhitespace}
                markdown={markdown}
                keptInView={keptInView}
                loadingMinHeight={estimatedBody}
                selection={selection}
                routeBadge={
                    margin === null ? null : (
                        <RouteBadge
                            file={margin}
                            otherStopId={otherStopId}
                            variant="card"
                            onJump={onJumpToStop}
                        />
                    )
                }
                routeStrips={stripsUnderHeader}
                threadsUnderHeader={underHeader}
                focusedThreadRange={focusedThreadRange}
                renderAfterLine={renderAfterLine}
                renderLineMarker={renderLineMarker}
                collapsedMarkers={collapsedMarkers}
                threadsCollapse={threadsCollapse}
                actions={actions}
            />
        </div>
    );
});

interface ConvergingScroll {
    /** `true` — доводка уже успела закончиться сама. */
    readonly cancel: () => boolean;
    /** Естественное завершение даёт `true`, отмена конкурирующим переходом — `false`. */
    readonly finished: Promise<boolean>;
}

/**
 * Доводка прокрутки виртуализатора: до первого измерения карточек высоты — оценка, поэтому
 * цель уезжает и одного вызова мало. Повторяем, пока позиция не перестанет меняться.
 * `onDone` зовётся ровно один раз — и на естественном конце, и на отмене.
 */
export function convergeScroll(
    step: () => void,
    currentTop: () => number,
    onDone: (completed: boolean) => void,
): ConvergingScroll {
    let attempts = 0;
    let previousTop = -1;
    let done = false;
    let resolveFinished: (completed: boolean) => void = () => undefined;
    const finished = new Promise<boolean>((resolve) => {
        resolveFinished = resolve;
    });
    const finish = (completed: boolean): void => {
        if (!done) {
            done = true;
            onDone(completed);
            resolveFinished(completed);
        }
    };

    let frame = requestAnimationFrame(function tick() {
        step();
        attempts += 1;
        const top = currentTop();
        const converged = top === previousTop;
        previousTop = top;
        if (!converged && attempts < SCROLL_TO_FILE_FRAMES) {
            frame = requestAnimationFrame(tick);
            return;
        }
        attempts = SCROLL_TO_FILE_FRAMES;
        finish(true);
    });

    return {
        finished,
        cancel: () => {
            cancelAnimationFrame(frame);
            const completed = attempts >= SCROLL_TO_FILE_FRAMES;
            finish(completed);
            return completed;
        },
    };
}

/**
 * Read-state файла из снапшота. Файла нет в карте (стор собран на другом наборе) — считаем
 * от умолчаний самого файла, а не показываем пустую коробку.
 */
function readStateOf(snapshot: { readState: ReadonlyMap<string, FileReadState> }, file: FileDiff): FileReadState {
    return snapshot.readState.get(file.fileId) ?? computeReadState({ file, record: null });
}

/** Первая карточка, чей низ ещё ниже верхней кромки вьюпорта; null — показывать нечего. */
function topFile(
    files: readonly FileDiff[],
    items: readonly { index: number; end: number }[],
    offset: number,
): string | null {
    for (const item of items) {
        if (item.end > offset) {
            return files[item.index]?.fileId ?? null;
        }
    }
    return null;
}

const EMPTY_THREAD_STORE = createThreadStore([], new Set());
const EMPTY_THREAD_ACTIONS: ThreadActions = {
    transport: {
        save: () => Promise.reject(new Error('drafts are unavailable here')),
        update: () => Promise.reject(new Error('drafts are unavailable here')),
        delete: () => Promise.reject(new Error('drafts are unavailable here')),
    },
    resolve: () => Promise.reject(new Error('resolve is unavailable here')),
};
const HIDE_THREAD = (): boolean => false;
const NOOP = (): void => undefined;
const NOOP_LINE = (): void => undefined;
const NOOP_FILE = (): void => undefined;
const NOOP_THREAD = (): void => undefined;

function countGeneratedCollapsed(
    files: readonly FileDiff[],
    reasons: ReadonlyMap<string, FileCollapseReason>,
): number {
    return files.reduce((count, file) => count + (file.generated && reasons.has(file.fileId) ? 1 : 0), 0);
}

/**
 * Оценка тела карточки — всего, что ниже шапки. Ею живёт виртуализатор до измерения, ею же
 * скелетон занимает свой слот, чтобы приход модели менял высоту на малую дельту, а не в разы.
 */
export function estimateBodyHeight(
    file: FileDiff | undefined,
    mode: DiffMode,
    collapsed: boolean,
    codeLineHeight: number,
): number {
    if (file === undefined) {
        return 0;
    }
    const changed = file.additions + file.deletions;
    // Двоичный файл, файл без текстового диффа и любая свёртка — однострочный нотис. Это
    // состояние известно до первого кадра, поэтому свёртки и просмотр не раздувают скроллбар.
    if (collapsed || file.binary || file.patch === null || changed > COLLAPSE_THRESHOLD) {
        return NOTICE_ROW_HEIGHT;
    }

    // В split удаление и добавление встают парой в одну строку; односторонний файл парами не
    // схлопывается и рисуется unified во всю ширину (docs/design/README.md §1).
    const lines =
        mode === 'split' && file.additions > 0 && file.deletions > 0
            ? Math.max(file.additions, file.deletions)
            : changed;
    // У add/delete весь файл идёт одним ханком — неизменённого контекста в нём нет.
    const context = file.changeType === 'add' || file.changeType === 'delete' ? 0 : HUNK_CONTEXT_HEIGHT;
    return lines * codeLineHeight + context;
}

/**
 * Прокрутка руками ревьюера — колесо и палец. Событие `scroll` для этого не годится: его шлёт
 * и сама доводка, а отменять её собственной прокруткой значило бы не начать её никогда.
 */
export function watchUserScroll(element: HTMLElement, onInput: () => void): () => void {
    const handle = (): void => {
        onInput();
    };
    element.addEventListener('wheel', handle, { passive: true });
    element.addEventListener('touchmove', handle, { passive: true });
    return () => {
        element.removeEventListener('wheel', handle);
        element.removeEventListener('touchmove', handle);
    };
}
