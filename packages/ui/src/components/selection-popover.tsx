import type { ChatAnchor } from '@sherpa/protocol';
import type { CSSProperties } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { LineSelection } from '../diff-view/selection.js';
import { selectedLineRange, selectedLines, selectionSide } from '../diff-view/selection.js';
import { useT } from '../i18n/index.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { selectionLinkHash } from '../selection-link.js';
import { ASK_SELECTION_DISABLED_TITLE } from './chat-prompts.js';
import { copyText } from './clipboard.js';
import './selection-popover.css';

const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;
const SCROLL_CLOSE_DISTANCE = 200;

export interface SelectionPopoverProps {
    readonly host: HTMLElement | null;
    /** Итерация, в которой сделано выделение: она уезжает в якорь вопроса. */
    readonly diffId: string;
    readonly file: { readonly fileId: string; readonly path: string };
    readonly model: DiffFileModel;
    readonly selection: LineSelection;
    readonly dragging: boolean;
    readonly agentConnected: boolean;
    readonly inFlight?: boolean;
    readonly onAsk: (anchor: ChatAnchor) => void;
    /**
     * Вопрос про выделение запрещён не из-за агента: строка объясняет, почему (в срезе между
     * итерациями `fileId` из чужого пространства имён, и якорь вопроса некуда положить).
     */
    readonly askDisabledReason?: string | null;
    readonly onSelectionAnchorChange?: (anchor: ChatAnchor | null) => void;
    readonly onComment: (side: 'old' | 'new', line: number) => void;
    readonly onClear: () => void;
    /** Галерея рисует состояния без DOM-замеров и сервера. */
    readonly gallery?: { readonly mode: 'rest' | 'sent'; readonly position: { left: number; top: number } };
}

export interface SelectionPopoverPositionInput {
    readonly host: { readonly top: number; readonly left: number; readonly width: number; readonly scrollTop: number; readonly scrollLeft: number };
    readonly selection: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };
    readonly popover: { readonly width: number; readonly height: number };
    readonly viewportHeight: number;
    readonly viewportTop?: number;
    readonly viewportBottom?: number;
    readonly gap?: number;
    readonly margin?: number;
}

export interface SelectionPopoverPosition {
    readonly left: number;
    readonly top: number;
    readonly placement: 'above' | 'below';
}

/** Координаты абсолютного узла внутри скролл-контейнера; зазор до строк всегда не больше 60px. */
export function calculateSelectionPopoverPosition(input: SelectionPopoverPositionInput): SelectionPopoverPosition {
    const gap = Math.min(input.gap ?? POPOVER_GAP, 60);
    const margin = input.margin ?? POPOVER_MARGIN;
    const viewportTop = (input.viewportTop ?? 0) + margin;
    const viewportBottom = (input.viewportBottom ?? input.viewportHeight) - margin;
    const belowFits = input.selection.bottom + gap + input.popover.height <= viewportBottom;
    const preferredTop = belowFits
        ? input.selection.bottom + gap
        : input.selection.top - gap - input.popover.height;
    const viewportPopoverTop = Math.min(
        Math.max(preferredTop, viewportTop),
        Math.max(viewportTop, viewportBottom - input.popover.height),
    );
    const centered =
        (input.selection.left + input.selection.right) / 2 - input.host.left + input.host.scrollLeft - input.popover.width / 2;
    const minLeft = input.host.scrollLeft + margin;
    const maxLeft = Math.max(minLeft, input.host.scrollLeft + input.host.width - input.popover.width - margin);
    return {
        left: Math.min(Math.max(centered, minLeft), maxLeft),
        top: viewportPopoverTop - input.host.top + input.host.scrollTop,
        placement: belowFits ? 'below' : 'above',
    };
}

export function selectionScrolledPast(openingTop: number, currentTop: number, limit = SCROLL_CLOSE_DISTANCE): boolean {
    return Math.abs(currentTop - openingTop) > limit;
}

export function selectionAskDisabled(agentConnected: boolean): boolean {
    return !agentConnected;
}

export function chatAnchorFromSelection(
    file: { readonly fileId: string; readonly path: string },
    model: DiffFileModel,
    selection: LineSelection,
    diffId: string,
): ChatAnchor | null {
    if (selection.fileId !== file.fileId) {
        return null;
    }
    const side = selectionSide(selection);
    const range = selectedLineRange(model, selection, side);
    return range === null
        ? null
        : {
              ...(selection.selectedText === undefined ? {} : { selectedText: selection.selectedText }),
              diffId,
              fileId: file.fileId,
              path: file.path,
              side,
              start: range.line,
              end: range.line + range.size - 1,
          };
}

export function SelectionPopover(props: SelectionPopoverProps) {
    const t = useT();
    const {
        diffId,
        file,
        model,
        selection,
        dragging,
        agentConnected,
        inFlight = false,
        onAsk,
        askDisabledReason = null,
        onSelectionAnchorChange,
        onComment,
        onClear,
        gallery,
    } = props;
    const anchor = useMemo(
        () => chatAnchorFromSelection(file, model, selection, diffId),
        [diffId, file, model, selection],
    );
    const selectedKeys = useMemo(() => selectedLines(model, selection), [model, selection]);
    const count = selectedKeys.size;
    const mode = gallery?.mode ?? (inFlight ? 'sent' : 'rest');
    const [error, setError] = useState<string | null>(null);
    // Спросить агента можно и из прошлой итерации, комментировать — нет.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const [position, setPosition] = useState<SelectionPopoverPosition | null>(
        gallery === undefined ? null : { ...gallery.position, placement: 'below' },
    );
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const opening = useRef<{ top: number; width: number; height: number } | null>(null);
    const rowsCache = useRef<SelectionRowsCache | null>(null);
    const measureFrame = useRef<number | null>(null);
    const scrollFrame = useRef<number | null>(null);
    /**
     * Точка отсчёта закрытия по прокрутке. Перекладка хоста (открылась панель чата, сменилось окно)
     * двигает строки без жеста ревьюера, поэтому при новом размере хоста точка снимается заново.
     */
    const openingTopFor = useCallback((host: HTMLElement, top: number): number => {
        const current = opening.current;
        if (current !== null && current.width === host.clientWidth && current.height === host.clientHeight) {
            return current.top;
        }
        opening.current = { top, width: host.clientWidth, height: host.clientHeight };
        return top;
    }, []);
    useLayoutEffect(() => {
        onSelectionAnchorChange?.(anchor);
        return () => {
            onSelectionAnchorChange?.(null);
        };
    }, [anchor, onSelectionAnchorChange]);

    const selectionBounds = useCallback((): SelectionBounds | null => {
        const host = props.host;
        if (host === null) {
            return null;
        }
        const cached = rowsCache.current;
        const groups =
            cached !== null &&
            cached.host === host &&
            cached.fileId === file.fileId &&
            cached.keys === selectedKeys &&
            cached.groups.every((group) => group.rows.every((row) => row.isConnected))
                ? cached.groups
                : findSelectionRows(host, file.fileId, selectedKeys);
        rowsCache.current = { host, fileId: file.fileId, keys: selectedKeys, groups };
        return boundsOfSelectionRows(groups);
    }, [file.fileId, props.host, selectedKeys]);

    const measure = useCallback((): SelectionBounds | null => {
        const host = props.host;
        const popover = popoverRef.current;
        if (gallery !== undefined || host === null || popover === null) {
            return null;
        }
        const bounds = selectionBounds();
        if (bounds === null) {
            return null;
        }
        const hostRect = host.getBoundingClientRect();
        const popoverRect = popover.getBoundingClientRect();
        setPosition(
            calculateSelectionPopoverPosition({
                host: {
                    top: hostRect.top,
                    left: hostRect.left,
                    width: host.clientWidth,
                    scrollTop: host.scrollTop,
                    scrollLeft: host.scrollLeft,
                },
                selection: bounds,
                popover: { width: popoverRect.width, height: popoverRect.height },
                viewportHeight: window.innerHeight,
                ...popoverViewportBounds(host),
            }),
        );
        openingTopFor(host, bounds.top);
        return bounds;
    }, [gallery, openingTopFor, props.host, selectionBounds]);
    const scheduleMeasure = useCallback(() => {
        if (measureFrame.current !== null) {
            return;
        }
        measureFrame.current = requestAnimationFrame(() => {
            measureFrame.current = null;
            measure();
        });
    }, [measure]);

    useLayoutEffect(() => {
        if (gallery !== undefined || dragging) {
            return;
        }
        measure();
        const popover = popoverRef.current;
        const host = props.host;
        if (popover === null || host === null) {
            return;
        }
        const resize = new ResizeObserver(scheduleMeasure);
        resize.observe(popover);
        resize.observe(host);
        window.addEventListener('resize', scheduleMeasure);
        return () => {
            resize.disconnect();
            window.removeEventListener('resize', scheduleMeasure);
            if (measureFrame.current !== null) {
                cancelAnimationFrame(measureFrame.current);
                measureFrame.current = null;
            }
        };
    }, [dragging, gallery, measure, props.host, scheduleMeasure]);

    useLayoutEffect(() => {
        const host = props.host;
        if (gallery !== undefined || dragging || host === null) {
            return;
        }
        const closeAfterScroll = (): void => {
            if (scrollFrame.current !== null) {
                return;
            }
            scrollFrame.current = requestAnimationFrame(() => {
                scrollFrame.current = null;
                const bounds = selectionBounds();
                if (bounds === null) {
                    onClear();
                    return;
                }
                if (selectionScrolledPast(openingTopFor(host, bounds.top), bounds.top)) {
                    onClear();
                }
            });
        };
        window.addEventListener('scroll', closeAfterScroll, true);
        return () => {
            window.removeEventListener('scroll', closeAfterScroll, true);
            if (scrollFrame.current !== null) {
                cancelAnimationFrame(scrollFrame.current);
                scrollFrame.current = null;
            }
        };
    }, [dragging, gallery, onClear, openingTopFor, props.host, selectionBounds]);

    if (dragging || anchor === null || count === 0) {
        return null;
    }

    const copyLink = (): void => {
        const url = new URL(window.location.href);
        url.hash = selectionLinkHash(url.hash, anchor);
        void copyText(url.toString()).then((outcome) => {
            if (outcome === 'unavailable') {
                setError(t('selection.clipboardUnavailable'));
            } else if (outcome === 'failed') {
                setError(t('selection.copyFailed'));
            }
        });
    };
    const style =
        position === null
            ? ({ left: 0, top: 0, visibility: 'hidden' } satisfies CSSProperties)
            : ({ left: position.left, top: position.top } satisfies CSSProperties);

    if (mode === 'sent') {
        return (
            <div className="selection-popover selection-popover--chip" ref={popoverRef} style={style} role="status">
                {t('chat.ask.asked')}
            </div>
        );
    }

    const countLabel = t('selection.count', count);
    const askDisabled = askDisabledReason !== null || selectionAskDisabled(agentConnected);
    const askTitle =
        askDisabledReason ??
        (selectionAskDisabled(agentConnected) ? t(ASK_SELECTION_DISABLED_TITLE) : undefined);
    return (
        <div className="selection-popover" ref={popoverRef} style={style} data-placement={position?.placement}>
            <div className="selection-popover__row">
                <span className="selection-popover__count">{countLabel}</span>
                <button
                    type="button"
                    className="ctl ctl--primary selection-popover__button"
                    disabled={askDisabled}
                    title={askTitle}
                    onClick={() => {
                        setError(null);
                        onAsk(anchor);
                    }}
                >
                    {t('selection.ask')}
                </button>
                <button
                    type="button"
                    className="ctl ctl--ghost selection-popover__button"
                    disabled={readOnly}
                    title={readOnly ? readOnlyReason : undefined}
                    onClick={() => {
                        onComment(anchor.side, anchor.start);
                    }}
                >
                    {t('selection.comment')}
                </button>
                <button type="button" className="ctl ctl--ghost selection-popover__button" onClick={copyLink}>
                    {t('selection.copyLink')}
                </button>
            </div>
            {error === null ? null : (
                <div className="selection-popover__error" role="alert">
                    {error}
                </div>
            )}
        </div>
    );
}

interface SelectionBounds {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
}

interface SelectionRowsGroup {
    readonly rows: readonly HTMLElement[];
}

interface SelectionRowsCache {
    readonly host: HTMLElement;
    readonly fileId: string;
    readonly keys: ReadonlySet<string>;
    readonly groups: readonly SelectionRowsGroup[];
}

function findSelectionRows(host: HTMLElement, fileId: string, keys: ReadonlySet<string>): readonly SelectionRowsGroup[] {
    const cards = host.querySelectorAll<HTMLElement>(`.file-card[data-file="${CSS.escape(fileId)}"]`);
    const groups: SelectionRowsGroup[] = [];
    for (const card of cards) {
        const rows = new Set<HTMLElement>();
        for (const key of keys) {
            const cell = card.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
            const row = cell?.closest<HTMLElement>('.diff-row, .markdown-review__block') ?? null;
            if (row !== null) {
                rows.add(row);
            }
        }
        if (rows.size > 0) {
            groups.push({ rows: [...rows] });
        }
    }
    return groups;
}

function boundsOfSelectionRows(groups: readonly SelectionRowsGroup[]): SelectionBounds | null {
    let best: { readonly bounds: SelectionBounds; readonly visible: number } | null = null;
    for (const group of groups) {
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        let left = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let visible = 0;
        for (const row of group.rows) {
            const rect = row.getBoundingClientRect();
            top = Math.min(top, rect.top);
            bottom = Math.max(bottom, rect.bottom);
            left = Math.min(left, rect.left);
            right = Math.max(right, rect.right);
            if (rect.bottom > 0 && rect.top < window.innerHeight) {
                visible += 1;
            }
        }
        const bounds = { top, bottom, left, right };
        if (best === null || visible > best.visible) {
            best = { bounds, visible };
        }
    }
    return best?.bounds ?? null;
}

function popoverViewportBounds(host: HTMLElement): { readonly viewportTop: number; readonly viewportBottom: number } {
    const toolbar = host.querySelector<HTMLElement>('.full-diff__toolbar, .route-toolbar');
    const toolbarRect = toolbar?.getBoundingClientRect() ?? null;
    const actionBar = document.querySelector<HTMLElement>('.review-action-bar');
    const actionBarRect = actionBar?.getBoundingClientRect() ?? null;
    return {
        viewportTop: toolbarRect !== null && toolbarRect.height > 0 && toolbarRect.bottom > 0 ? toolbarRect.bottom : 0,
        viewportBottom:
            actionBarRect !== null && actionBarRect.height > 0 && actionBarRect.top < window.innerHeight
                ? actionBarRect.top
                : window.innerHeight,
    };
}
