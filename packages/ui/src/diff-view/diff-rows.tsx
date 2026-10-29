import type { FileContent } from '@sherpa/protocol';
import type { KeyboardEvent, ReactNode } from 'react';
import { Fragment, memo, useId, useMemo, useRef, useState } from 'react';

import type { DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { ContextExpandRequest, GapExpandResult } from './context-expansion.js';
import type { ExpandDirection } from './expand.js';
import { EXPAND_STEP, gapKeyOf, hiddenLinesOf } from './expand.js';
import type { LineSegment } from './line-segments.js';
import { hasTabs, lineSegments } from './line-segments.js';
import type { LineKey, LineSelection } from './selection.js';
import { lineKey, selectedLines } from './selection.js';
type DiffMode = 'unified' | 'split';

/**
 * Строки диффа: unified (docs/spec.md «Diff rows (unified)») и side-by-side. Разметка и цвета —
 * дословно из docs/spec.md поведение — из docs/spec.md
 *
 * События мыши висят на контейнере, а не на строках: у большого файла строк тысячи, и вешать
 * на каждую по паре слушателей дорого. Строка узнаётся по `data-key`.
 */

interface LineCell {
    /** `null` — у строки нет номеров (кривой патч): выделять её нечем. */
    readonly key: LineKey | null;
    readonly line: DiffLine;
}

/**
 * `hunk` стоит на первой строке каждого ханка: по нему аутлайн однофайлового PR находит
 * начало ханка в DOM. У остальных строк его нет — атрибут на каждой строке
 * тысячестрочного файла не бесплатен.
 */
type Row = { readonly hunk?: number } & (
    | { readonly kind: 'gap'; readonly gap: DiffGap }
    | { readonly kind: 'line'; readonly cell: LineCell }
    | { readonly kind: 'pair'; readonly left: LineCell | null; readonly right: LineCell | null }
);

export interface DiffRowsProps {
    readonly showHunkHeaders?: boolean;
    readonly model: DiffFileModel;
    readonly mode: DiffMode;
    /** Нужно только чтобы честно назвать длину хвостового пропуска. */
    readonly content: FileContent | null;
    readonly selection: LineSelection | null;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onExpandContext?: ((request: ContextExpandRequest) => Promise<GapExpandResult>) | undefined;
    /** Третьим числом — изменённые строки чужих остановок: их раскрытие не достаёт. */
    readonly onContextExpanded?: ((loaded: number, hidden: number, hiddenChanged: number) => void) | undefined;
    readonly initialGapError?: boolean;
    readonly contextAvailable?: boolean;
}

const NOOP_EXPAND = (): Promise<GapExpandResult> =>
    Promise.resolve({ feedback: null, loaded: 0, hidden: 0, hiddenChanged: 0 });
const NOOP_ANNOUNCE = (): void => undefined;

export function DiffRows({
    showHunkHeaders = false,
    model,
    mode,
    content,
    selection,
    renderAfterLine,
    onLineFocus,
    onLineBlur,
    onExpandContext = NOOP_EXPAND,
    onContextExpanded = NOOP_ANNOUNCE,
    initialGapError = false,
    contextAvailable = true,
}: DiffRowsProps) {
    const t = useT();
    // Односторонний файл в split занял бы половину карточки пустотой (docs/spec.md).
    const oneSided = model.onlyAdditions || model.onlyDeletions;
    const effective: DiffMode = mode === 'split' && !oneSided ? 'split' : 'unified';
    const rows = useMemo(() => buildRows(model, effective), [model, effective]);
    const hunks = useMemo(() => model.content.kind === 'text' ? model.content.blocks.filter((block) => block.kind === 'hunk') : [], [model]);
    const selected = useMemo(() => selectedLines(model, selection), [model, selection]);

    const firstGap = rows.find((row) => row.kind === 'gap');
    const firstGapKey = firstGap?.kind === 'gap' ? gapKeyOf(firstGap.gap) : null;

    return (
        <div
            className={`diff-rows diff-rows--${effective}`}
            data-file={model.fileId}
            title={
                mode === 'split' && oneSided
                    ? t(
                          'diff.oneSided',
                          t(model.onlyAdditions ? 'diff.oneSided.additions' : 'diff.oneSided.deletions'),
                      )
                    : undefined
            }
        >
            {rows.map((row, index) => {
                if (row.kind === 'gap') {
                    return (
                        <GapRow
                            // Ключ раскрытия у кусков одного промежутка среза общий, а строка
                            // рисуется на каждый: React-ключу нужны ещё и границы куска.
                            key={`${gapKeyOf(row.gap)}:${String(row.gap.oldStart)}:${String(row.gap.newStart)}`}
                            gap={row.gap}
                            content={content}
                            mode={effective}
                            onExpand={onExpandContext}
                            onExpanded={onContextExpanded}
                            initialError={initialGapError && gapKeyOf(row.gap) === firstGapKey}
                            contextAvailable={contextAvailable}
                        />
                    );
                }
                if (row.kind === 'line') {
                    const positions = positionsOf(row.cell);
                    return (
                        <Fragment key={`row-${String(index)}`}>
                            {showHunkHeaders && row.hunk !== undefined ? <div className="diff-hunk-header">{hunkLabel(row.hunk, hunks)}</div> : null}
                            <UnifiedRow
                                cell={row.cell}
                                selected={isSelected(selected, row.cell)}

                                hunk={row.hunk}

                                onLineFocus={onLineFocus}
                                onLineBlur={onLineBlur}
                            />
                            {positions.map((position) => (
                                <Fragment key={`${position.side}:${String(position.line)}`}>
                                    {renderAfterLine?.(position.side, position.line)}
                                </Fragment>
                            ))}
                        </Fragment>
                    );
                }
                const oldLine = row.left?.line.oldLine ?? null;
                const newLine = row.right?.line.newLine ?? null;
                const oldExtra = oldLine === null ? null : (renderAfterLine?.('old', oldLine) ?? null);
                const newExtra = newLine === null ? null : (renderAfterLine?.('new', newLine) ?? null);
                return (
                    <Fragment key={`pair-${String(index)}`}>
                        {showHunkHeaders && row.hunk !== undefined ? <div className="diff-hunk-header">{hunkLabel(row.hunk, hunks)}</div> : null}
                        <SplitRow
                            left={row.left}
                            right={row.right}
                            leftSelected={isSelected(selected, row.left)}
                            rightSelected={isSelected(selected, row.right)}

                            hunk={row.hunk}

                            onLineFocus={onLineFocus}
                            onLineBlur={onLineBlur}
                        />
                        {oldExtra === null && newExtra === null ? null : (
                            <div className="diff-row-extras--split">
                                <div>{oldExtra}</div>
                                <div>{newExtra}</div>
                            </div>
                        )}
                    </Fragment>
                );
            })}
        </div>
    );
}

function hunkLabel(index: number, hunks: readonly DiffHunk[]): string {
    const hunk = hunks[index];
    return hunk === undefined ? '' : `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`;
}

function isSelected(selected: ReadonlySet<LineKey>, cell: LineCell | null): boolean {
    return cell?.key != null && selected.has(cell.key);
}

function buildRows(model: DiffFileModel, mode: DiffMode): Row[] {
    if (model.content.kind !== 'text') {
        return [];
    }

    const rows: Row[] = [];
    let hunkIndex = 0;
    for (const item of model.content.blocks) {
        if (item.kind === 'gap') {
            rows.push({ kind: 'gap', gap: item });
            continue;
        }

        const first = rows.length;
        const markFirst = (): void => {
            const row = rows[first];
            if (row !== undefined) {
                rows[first] = { ...row, hunk: hunkIndex };
            }
            hunkIndex += 1;
        };

        if (mode === 'unified') {
            for (const value of item.lines) {
                rows.push({ kind: 'line', cell: { key: lineKey(value), line: value } });
            }
            markFirst();
            continue;
        }

        let index = 0;
        while (index < item.lines.length) {
            const current = item.lines[index];
            if (current === undefined) {
                break;
            }
            if (current.kind === 'context') {
                const cell = { key: lineKey(current), line: current };
                rows.push({ kind: 'pair', left: cell, right: cell });
                index += 1;
                continue;
            }

            // Ран удалённых и идущий следом ран добавленных спариваются по индексу внутри рана.
            const dels: LineCell[] = [];
            while (item.lines[index]?.kind === 'del') {
                const line = item.lines[index];
                if (line !== undefined) {
                    dels.push({ key: lineKey(line), line });
                }
                index += 1;
            }
            const adds: LineCell[] = [];
            while (item.lines[index]?.kind === 'add') {
                const line = item.lines[index];
                if (line !== undefined) {
                    adds.push({ key: lineKey(line), line });
                }
                index += 1;
            }

            for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) {
                rows.push({ kind: 'pair', left: dels[i] ?? null, right: adds[i] ?? null });
            }
        }
        markFirst();
    }
    return rows;
}

function gapLabel(gap: DiffGap, content: FileContent | null, t: Translate): string {
    const changed = gap.hiddenChanged ?? 0;
    const hidden = hiddenLinesOf(gap, content);
    const unchanged = hidden === null ? t('diff.gap.toEndOfFile') : t('diff.gap.unchanged', hidden);
    if (changed === 0) {
        return unchanged;
    }
    // Обрезка по якорям остановки: изменённые строки за срезом объяснены в других остановках.
    const elsewhere = t('diff.elsewhere', changed);
    return hidden === 0 ? elsewhere : t('diff.gap.both', unchanged, elsewhere);
}

function GapRow({
    gap,
    content,
    mode,
    onExpand,
    onExpanded,
    initialError,
    contextAvailable,
}: {
    gap: DiffGap;
    content: FileContent | null;
    mode: DiffMode;
    onExpand: (request: ContextExpandRequest) => Promise<GapExpandResult>;
    onExpanded: (loaded: number, hidden: number, hiddenChanged: number) => void;
    initialError: boolean;
    contextAvailable: boolean;
}) {
    const t = useT();
    const hidden = hiddenLinesOf(gap, content);
    const directions = contextAvailable ? gapDirections(gap, hidden) : [];
    const [selected, setSelected] = useState<ExpandDirection>(directions[0] ?? 'all');
    const [hovered, setHovered] = useState<ExpandDirection | null>(null);
    const [loading, setLoading] = useState(false);
    const [pendingState, setPendingState] = useState(false);
    const [failed, setFailed] = useState(initialError);
    const targetIdPrefix = useId();
    const pending = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const active = directions.includes(selected) ? selected : (directions[0] ?? 'all');
    const key = gapKeyOf(gap);
    const targetId = (direction: ExpandDirection): string => `${targetIdPrefix}-${direction}`;

    const run = (direction: ExpandDirection): void => {
        if (pending.current || directions.length === 0) {
            return;
        }
        pending.current = true;
        setPendingState(true);
        setSelected(direction);
        setFailed(false);
        timer.current = setTimeout(() => {
            setLoading(true);
        }, 150);
        const amount = hidden === null ? EXPAND_STEP : Math.min(EXPAND_STEP, hidden);
        void onExpand({ kind: 'gap', gapKey: key, direction, ...(direction === 'all' ? { amount } : {}) }).then(
            (result) => {
                if (timer.current !== null) {
                    clearTimeout(timer.current);
                }
                timer.current = null;
                pending.current = false;
                setPendingState(false);
                setLoading(false);
                if (result.feedback !== null) {
                    setFailed(true);
                    return;
                }
                // Остаток чужих изменений — по всем кускам ключа: раскрытие делит промежуток,
                // и цифра этого куска рассказала бы только про его половину.
                onExpanded(result.loaded, result.hidden, result.hiddenChanged);
            },
            () => {
                if (timer.current !== null) {
                    clearTimeout(timer.current);
                }
                timer.current = null;
                pending.current = false;
                setPendingState(false);
                setLoading(false);
                setFailed(true);
            },
        );
    };

    if (failed) {
        return (
            <button
                type="button"
                className={`diff-gap diff-gap--${mode} diff-gap--error`}
                data-gap-key={key}
                onClick={() => {
                    run(active);
                }}
            >
                <span className="diff-gap__error-label">{t('diff.gap.expandFailed')}</span>
            </button>
        );
    }

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (directions.length > 1) {
                const index = directions.indexOf(active);
                const step = event.key === 'ArrowRight' ? 1 : -1;
                setSelected(directions[(index + step + directions.length) % directions.length] ?? active);
            }
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            run(active);
        }
    };

    const label = loading ? t('diff.gap.loading') : gapCounterLabel(gap, content, hovered, t);
    const target = (direction: ExpandDirection): ReactNode => {
        if (!directions.includes(direction)) {
            return <span className="diff-gap__empty" aria-hidden="true" />;
        }
        const icon = direction === 'all' ? 'updown' : direction === 'up' ? 'arrow-up' : 'arrow-down';
        return (
            <button
                type="button"
                id={targetId(direction)}
                className={`ctl ctl--toolbar-icon diff-gap__target${active === direction ? ' is-active' : ''}`}
                data-direction={direction}
                role="radio"
                tabIndex={-1}
                disabled={pendingState}
                aria-checked={active === direction}
                aria-label={gapAriaLabel(direction, hidden, t)}
                onMouseEnter={() => {
                    setHovered(direction);
                }}
                onMouseLeave={() => {
                    setHovered(null);
                }}
                onClick={() => {
                    run(direction);
                }}
            >
                <Icon name={icon} size={13} />
            </button>
        );
    };

    return (
        <div
            className={`diff-gap diff-gap--${mode}${loading ? ' is-loading' : ''}`}
            data-gap-key={key}
            data-edge={gap.edge}
            data-hidden={hidden ?? 'unknown'}
            role="radiogroup"
            aria-label={t('diff.gap.aria')}
            aria-activedescendant={directions.length === 0 ? undefined : targetId(active)}
            tabIndex={directions.length === 0 ? undefined : 0}
            onKeyDown={onKeyDown}
        >
            <span className="diff-gap__slot diff-gap__slot--up">{target(directions.includes('all') ? 'all' : 'up')}</span>
            <span className="diff-gap__slot diff-gap__slot--down">{target('down')}</span>
            <span className="diff-gap__counter">{label}</span>
        </div>
    );
}

function gapDirections(gap: DiffGap, hidden: number | null): readonly ExpandDirection[] {
    if (hidden === 0) {
        return [];
    }
    if (hidden !== null && hidden < EXPAND_STEP) {
        return ['all'];
    }
    if (gap.edge === 'leading') {
        return ['up'];
    }
    if (gap.edge === 'trailing') {
        return ['down'];
    }
    return ['up', 'down'];
}

function gapCounterLabel(
    gap: DiffGap,
    content: FileContent | null,
    hovered: ExpandDirection | null,
    t: Translate,
): string {
    const hidden = hiddenLinesOf(gap, content);
    const base = gapLabel(gap, content, t);
    // Остаток меньше шага: одна мишень раскрывает всё, подпись без приглашения — иначе она читается
    // как кликабельная (решение 2026-09-12), а «+20 вверх» на наведении соврал бы про объём.
    if (hidden !== null && hidden > 0 && hidden < EXPAND_STEP) {
        return base;
    }
    if (hovered === 'up') {
        return t('diff.gap.expandUp', EXPAND_STEP, base);
    }
    if (hovered === 'down') {
        return t('diff.gap.expandDown', EXPAND_STEP, base);
    }
    return base;
}

function gapAriaLabel(direction: ExpandDirection, hidden: number | null, t: Translate): string {
    const amount = hidden === null ? EXPAND_STEP : Math.min(EXPAND_STEP, hidden);
    const hiddenLabel = hidden === null ? t('diff.gap.hiddenToEnd') : t('diff.gap.hiddenCount', hidden);
    if (direction === 'all') {
        return t('diff.gap.loadAll', amount, hiddenLabel);
    }
    return direction === 'up'
        ? t('diff.gap.loadUp', amount, hiddenLabel)
        : t('diff.gap.loadDown', amount, hiddenLabel);
}

const UnifiedRow = memo(function UnifiedRow({
    cell,
    selected,
    hunk,
    onLineFocus,
    onLineBlur,
}: {
    cell: LineCell;
    selected: boolean;

    hunk: number | undefined;

    onLineFocus: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineBlur: (() => void) | undefined;
}) {
    const { line } = cell;
    const position = positionOf(cell, 'new');
    return (
        <div
            className={`diff-row diff-row--${line.kind}${selected ? ' is-selected' : ''}`}
            data-key={cell.key ?? undefined}
            data-hunk={hunk}
            tabIndex={position === null ? undefined : 0}
            onFocus={(event) => {
                if (event.currentTarget.dataset.restoringFocus === 'true') return;
                if (position !== null) {
                    onLineFocus?.(position.side, position.line);
                }
            }}
            onBlur={onLineBlur}
        >
            <span className="diff-row__gutter">{line.oldLine ?? ''}</span>
            <span className="diff-row__gutter diff-row__gutter--code">
                {line.newLine ?? ''}
            </span>
            <span className="diff-row__sign">{sign(line)}</span>
            <Code line={line} />
        </div>
    );
});

const SplitRow = memo(function SplitRow({
    left,
    right,
    leftSelected,
    rightSelected,
    hunk,
    onLineFocus,
    onLineBlur,
}: {
    left: LineCell | null;
    right: LineCell | null;
    leftSelected: boolean;
    rightSelected: boolean;

    hunk: number | undefined;

    onLineFocus: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineBlur: (() => void) | undefined;
}) {
    return (
        <div className="diff-row diff-row--pair" data-hunk={hunk}>
            <Side
                cell={left}
                side="old"
                selected={leftSelected}

                onLineFocus={onLineFocus}
                onLineBlur={onLineBlur}
            />
            <Side
                cell={right}
                side="new"
                selected={rightSelected}

                onLineFocus={onLineFocus}
                onLineBlur={onLineBlur}
            />
        </div>
    );
});

function Side({
    cell,
    side,
    selected,
    onLineFocus,
    onLineBlur,
}: {
    cell: LineCell | null;
    side: 'old' | 'new';
    selected: boolean;

    onLineFocus: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineBlur: (() => void) | undefined;
}) {
    // Правая половина открывается разделителем — и когда её строка пуста.
    const halfStart = side === 'new' ? ' diff-row__half-start' : '';
    if (cell === null) {
        return (
            <>
                <span className={`diff-row__gutter diff-row__gutter--empty${halfStart}`} />
                <span className="diff-row__sign diff-row__sign--empty" />
                <span className="diff-row__code diff-row__code--empty" />
            </>
        );
    }

    const { line } = cell;
    const className = `diff-side diff-side--${line.kind}${selected ? ' is-selected' : ''}`;
    const key = cell.key ?? undefined;
    const position = positionOf(cell, side);
    return (
        <>
            <span
                className={`diff-row__gutter diff-row__gutter--code ${className}${halfStart}`}
                data-key={key}
                data-side={side}
            >
                {(side === 'old' ? line.oldLine : line.newLine) ?? ''}
            </span>
            <span className={`diff-row__sign ${className}`} data-key={key} data-side={side}>
                {sign(line)}
            </span>
            <Code
                line={line}
                className={className}
                keyString={key}
                side={side}
                tabIndex={position === null ? undefined : 0}
                onFocus={
                    position === null
                        ? undefined
                        : () => {
                              onLineFocus?.(position.side, position.line);
                          }
                }
                onBlur={onLineBlur}
            />
        </>
    );
}

function Code({
    line,
    className = '',
    keyString,
    side,
    tabIndex,
    onFocus,
    onBlur,
}: {
    line: DiffLine;
    className?: string;
    keyString?: string | undefined;
    side?: 'old' | 'new' | undefined;
    tabIndex?: number | undefined;
    onFocus?: (() => void) | undefined;
    onBlur?: (() => void) | undefined;
}) {
    const t = useT();
    const segments = lineSegments(line);
    return (
        <code
            className={`diff-row__code ${className}`}
            data-key={keyString}
            data-side={side}
            tabIndex={tabIndex}
            onFocus={onFocus}
            onBlur={onBlur}
            title={hasTabs(line) ? t('diff.row.tabs') : undefined}
        >
            {segments.length === 0 ? ' ' : segments.map((segment, index) => <Segment key={index} segment={segment} />)}
            {line.noNewline === true ? (
                <span className="diff-row__no-newline">{t('diff.row.noNewline')}</span>
            ) : null}
        </code>
    );
}

function Segment({ segment }: { segment: LineSegment }) {
    const classes = [
        segment.kind === null ? null : `syntax-${segment.kind}`,
        segment.word ? 'diff-word' : null,
        segment.trailing ? 'diff-trailing' : null,
    ].filter((value) => value !== null);

    if (classes.length === 0) {
        return segment.text;
    }
    return <span className={classes.join(' ')}>{segment.text}</span>;
}

function positionsOf(cell: LineCell): { side: 'old' | 'new'; line: number }[] {
    const positions: { side: 'old' | 'new'; line: number }[] = [];
    if (cell.line.oldLine !== null) {
        positions.push({ side: 'old', line: cell.line.oldLine });
    }
    if (cell.line.newLine !== null) {
        positions.push({ side: 'new', line: cell.line.newLine });
    }
    return positions;
}

function positionOf(cell: LineCell | null, preferred: 'old' | 'new'): { side: 'old' | 'new'; line: number } | null {
    if (cell === null) {
        return null;
    }
    const preferredLine = preferred === 'old' ? cell.line.oldLine : cell.line.newLine;
    if (preferredLine !== null) {
        return { side: preferred, line: preferredLine };
    }
    const side = preferred === 'old' ? 'new' : 'old';
    const line = side === 'old' ? cell.line.oldLine : cell.line.newLine;
    return line === null ? null : { side, line };
}

function sign(line: DiffLine): string {
    if (line.kind === 'add') {
        return '+';
    }
    return line.kind === 'del' ? '−' : '';
}
