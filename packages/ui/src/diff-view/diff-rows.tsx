import type { ReactNode } from 'react';
import { Fragment, memo, useMemo } from 'react';

import type { DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
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
    readonly selection: LineSelection | null;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;

}

export function DiffRows({
    showHunkHeaders = false,
    model,
    mode,
    selection,
    renderAfterLine,
    onLineFocus,
    onLineBlur,
}: DiffRowsProps) {
    const t = useT();
    // Односторонний файл в split занял бы половину карточки пустотой (docs/spec.md).
    const oneSided = model.onlyAdditions || model.onlyDeletions;
    const effective: DiffMode = mode === 'split' && !oneSided ? 'split' : 'unified';
    const rows = useMemo(() => buildRows(model, effective), [model, effective]);
    const hunks = useMemo(() => model.content.kind === 'text' ? model.content.blocks.filter((block) => block.kind === 'hunk') : [], [model]);
    const selected = useMemo(() => selectedLines(model, selection), [model, selection]);

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
                        <GapRow key={`${row.gap.edge}:${String(row.gap.oldStart)}:${String(row.gap.newStart)}`} gap={row.gap} mode={effective} />
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

function gapLabel(gap: DiffGap, t: Translate): string {
    return gap.hiddenLines === null ? t('diff.gap.toEndOfFile') : t('diff.gap.unchanged', gap.hiddenLines);
}

function GapRow({ gap, mode }: { gap: DiffGap; mode: DiffMode }) {
    const t = useT();
    return <div className={`diff-gap diff-gap--${mode}`} data-edge={gap.edge} data-hidden={gap.hiddenLines ?? 'unknown'}>
        <span className="diff-gap__counter">{gapLabel(gap, t)}</span>
    </div>;
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
