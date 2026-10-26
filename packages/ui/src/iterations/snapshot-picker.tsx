import type { Locale } from '@sherpa/protocol';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { MessageKey, Translate } from '../i18n/index.js';
import { useLocale, useT } from '../i18n/index.js';
import { formatDateTime, relativeTime } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import { localeNameKey } from '../route/generation.js';
import type { PickerRow, PickerRows, RowAction, SliceRowMark, Viewing, ViewingLabel } from './viewing.js';
import { liveSliceEdge, rowAction, sameViewing, sliceMarks } from './viewing.js';
import './snapshot-picker.css';

/**
 * Пикер снапшотов (docs/design/README.md §1: индикатор справа в шапке PR; §6: карточка «Снапшоты» на Обзоре).
 * Меню в прототипе не нарисовано — оно собрано в токенах индикатора и по образцу селекта фильтра
 * файлов: Esc закрывает с возвратом фокуса, стрелки ходят, ⏎ выбирает.
 *
 * Срез между итерациями выбирается, как в Аркануме, в два шага: Shift+клик (в меню и Shift+⏎)
 * по первой итерации, клик по второй — правила в `rowAction`. Первый край — локальное состояние
 * меню и карточки: в адрес и в `Viewing` он не попадает.
 */

/** Первые 7 hex; полный коммит уходит в `title`. */
export function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

const STATUS_LABELS = {
    current: 'iteration.status.current',
    stale: 'iteration.status.stale',
    gone: 'iteration.status.gone',
    noRoute: 'iteration.status.noRoute',
    slice: 'iteration.status.slice',
    activeIteration: 'iteration.status.activeIteration',
    previousIteration: 'iteration.status.previousIteration',
} as const satisfies Readonly<Record<string, MessageKey>>;

/**
 * Подпись статуса. У локального ревью PR нет: итерация исчезает не из PR, а из истории
 * рабочего дерева — и сказано это должно быть тем, что ревьюер видит на экране.
 */
function statusText(status: keyof typeof STATUS_LABELS, t: Translate, localHost: boolean): string {
    return t(status === 'gone' && localHost ? 'iteration.status.goneLocal' : STATUS_LABELS[status]);
}

/** «снапшот 9f3c1ab · текущий», «дифф a71d4e2 · без маршрута» либо «срез 9f3c1ab → a71d4e2». */
export function pillText(label: ViewingLabel, t: Translate, localHost = false): string {
    if (label.kind === 'slice') {
        return t('iteration.pill.slice', shortCommit(label.baseCommit), shortCommit(label.commit));
    }
    const status = statusText(label.status, t, localHost);
    return label.kind === 'snapshot'
        ? t('iteration.pill.snapshot', shortCommit(label.commit), status)
        : t('iteration.pill.diff', shortCommit(label.commit), status);
}

/** Полные коммиты выбора — в подсказке индикатора: сверить с хостом ревьюер должен уметь. */
export function pillTitle(label: ViewingLabel, t: Translate): string {
    if (label.kind === 'slice') {
        return t('iteration.title.slice', label.baseCommit, label.commit);
    }
    return label.kind === 'snapshot'
        ? t('iteration.title.snapshot', label.commit)
        : t('iteration.title.iteration', label.commit);
}

/**
 * Время строки. Обычно округлённое («6 ч назад»), но если коммит строку не различает —
 * точное: иначе две итерации одного коммита читаются как одна и та же.
 */
function rowTime(row: PickerRow, now: number, locale: Locale): string | null {
    if (row.createdAt === null) {
        return null;
    }
    return row.ambiguous ? formatDateTime(row.createdAt, locale) : relativeTime(row.createdAt, now, locale);
}

/**
 * Строка меню: «9f3c1ab · 6 ч назад · sonnet-5 · текущий» у снапшота и
 * «a71d4e2 · активная итерация · без маршрута» у итерации без маршрута.
 */
export function rowText(row: PickerRow, now: number, t: Translate, locale: Locale, localHost = false): string {
    const time = rowTime(row, now, locale);
    if (row.kind === 'diff') {
        // Итерация без маршрута времени не печатает: её и так называют коммит и статус.
        const parts = [row.short];
        if (row.ambiguous && time !== null) {
            parts.push(time);
        }
        parts.push(statusText(row.status, t, localHost), t(STATUS_LABELS.noRoute));
        return parts.join(' · ');
    }
    const parts = [row.short];
    if (time !== null) {
        parts.push(time);
    }
    if (row.model !== null && row.model !== '') {
        parts.push(row.model);
    }
    parts.push(statusText(row.status, t, localHost));
    return parts.join(' · ');
}

/**
 * Провенанс снапшота словами: «claude-code · sonnet-5 · 9f3c1ab» (docs/design/README.md §13). Язык маршрута
 * дописывается по тому же правилу, что в индикаторе Обзора: только когда он не совпадает с языком
 * вкладки.
 */
export function provenanceText(row: PickerRow, t: Translate, uiLocale: Locale): string {
    const locale = row.locale ?? 'ru';
    return join([row.harness, row.model, row.short, locale === uiLocale ? null : t(localeNameKey(locale))]);
}

/** То же в подсказке, но с полным коммитом — сверить с хостом ревьюер должен уметь. */
export function rowTitle(row: PickerRow): string {
    return join([row.harness, row.model, row.commit]);
}

function join(parts: readonly (string | null)[]): string {
    return parts.filter((part) => part !== null && part !== '').join(' · ');
}

/**
 * Строки, отмеченные выбором. `current` отмечает строку текущего снапшота: в адресе его нет,
 * но смотрит ревьюер именно на него. У среза отмечены оба края — по первой строке группы
 * каждой итерации; промежуточные не отмечаются.
 */
export function selectedRows(rows: readonly PickerRow[], viewing: Viewing): ReadonlySet<PickerRow> {
    if (viewing.kind === 'slice') {
        return new Set(
            [viewing.base, viewing.head]
                .map((diffId) => rows.find((row) => row.diffId === diffId))
                .filter((row) => row !== undefined),
        );
    }
    return new Set(
        rows.filter((row) =>
            viewing.kind === 'current' ? row.kind === 'snapshot' && row.latest : sameViewing(row.viewing, viewing),
        ),
    );
}

/** Подсказка про Shift+клик: только когда хост умеет срезы и сравнить есть что. */
export function sliceHintVisible(rows: PickerRows): boolean {
    return rows.sliceOrder.size >= 2;
}

/** Подсказка внизу списка: как начать срез, а с выбранным первым краем — что делать дальше. */
function SliceHint({ rows, edge, className }: { rows: PickerRows; edge: string | null; className: string }) {
    const t = useT();
    if (!sliceHintVisible(rows)) {
        return null;
    }
    return (
        <div className={className}>
            {t(edge === null ? 'iteration.menu.sliceHint' : 'iteration.menu.sliceHintSecond')}
        </div>
    );
}

const ROLE_LABELS = {
    base: 'iteration.menu.sliceBase',
    head: 'iteration.menu.sliceHead',
} as const satisfies Readonly<Record<string, MessageKey>>;

function sliceClass(mark: SliceRowMark | undefined): string {
    if (mark === undefined) {
        return '';
    }
    return mark.part === 'edge' ? ' is-slice-edge' : ' is-slice-inside';
}

/** Подпись края активного среза: «база» или «голова». */
function SliceRole({ mark, className }: { mark: SliceRowMark | undefined; className: string }) {
    const t = useT();
    if (mark?.role == null) {
        return null;
    }
    return <span className={className}>{t(ROLE_LABELS[mark.role])}</span>;
}

/** Shift+клик по строке ставит край среза: браузер не должен заодно выделять текст. */
function keepSelectionOnShift(event: ReactMouseEvent): void {
    if (event.shiftKey) {
        event.preventDefault();
    }
}

export interface SnapshotListProps {
    readonly rows: PickerRows;
    readonly viewing: Viewing;
    /** Момент отсчёта относительного времени; инжектируется ради детерминированной галереи. */
    readonly now: number;
    /** Локальное ревью: у ушедшей итерации свои слова — PR здесь нет. */
    readonly localHost?: boolean;
    readonly onSelect: (viewing: Viewing) => void;
}

export interface SnapshotMenu extends SnapshotListProps {
    /** Галерея показывает раскрытое меню. */
    readonly initialOpen?: boolean;
    /** Галерея показывает меню с выбранным первым краем среза (`diffId`). */
    readonly initialSliceEdge?: string;
    /** Галерея ставит клавиатурный курсор на строку с этим индексом. */
    readonly initialCursor?: number;
}

export interface SnapshotPillProps {
    readonly label: ViewingLabel;
    /** Локальное ревью: у ушедшей итерации свои слова — PR здесь нет. */
    readonly localHost?: boolean;
    /** Без меню индикатор статичен: выбирать не из чего. */
    readonly menu?: SnapshotMenu;
}

export function SnapshotPill({ label, localHost = false, menu }: SnapshotPillProps) {
    const t = useT();
    const text = pillText(label, t, localHost);
    const title = pillTitle(label, t);
    if (menu === undefined) {
        return (
            <span className="snapshot-pill" title={title}>
                {text}
            </span>
        );
    }
    return <SnapshotPillMenu label={label} text={text} title={title} menu={menu} />;
}

function SnapshotPillMenu({
    label,
    text,
    title,
    menu,
}: {
    label: ViewingLabel;
    text: string;
    title: string;
    menu: SnapshotMenu;
}) {
    const t = useT();
    const locale = useLocale();
    const [open, setOpen] = useState(menu.initialOpen ?? false);
    const flat = menu.rows.iterations;
    const selected = selectedRows(flat, menu.viewing);
    const selectedIndex = flat.findIndex((row) => selected.has(row));
    const [cursor, setCursor] = useState(menu.initialCursor ?? Math.max(selectedIndex, 0));
    const [rawEdge, setEdge] = useState<string | null>(menu.initialSliceEdge ?? null);
    const edge = liveSliceEdge(menu.rows, rawEdge);
    const marks = sliceMarks(menu.rows, menu.viewing, edge, flat[cursor] ?? null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const listId = useId();

    const close = useCallback((returnFocus: boolean): void => {
        setOpen(false);
        setEdge(null);
        if (returnFocus) {
            buttonRef.current?.focus();
        }
    }, []);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: MouseEvent): void => {
            const { target } = event;
            if (!(target instanceof Node) || rootRef.current?.contains(target) !== true) {
                close(true);
            }
        };
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [close, open]);

    useEscapeLayer('popover', () => {
        if (edge === null) {
            close(true);
        } else {
            setEdge(null);
        }
    }, open);

    // Фокус уезжает на список: выделение внутри него двигает `aria-activedescendant`.
    useEffect(() => {
        if (open) {
            listRef.current?.focus();
        }
    }, [open]);

    const choose = (index: number, shift: boolean): void => {
        const row = flat[index];
        if (row === undefined) {
            return;
        }
        const action = rowAction(menu.rows, edge, row, shift);
        if (action.kind === 'edge') {
            setEdge(action.edge);
            return;
        }
        menu.onSelect(action.viewing);
        close(true);
    };

    const renderRow = (row: PickerRow, index: number) => {
        const checked = selected.has(row);
        const mark = marks.get(row);
        return (
            <div
                key={rowKey(row)}
                id={`${listId}-${String(index)}`}
                role="menuitemradio"
                aria-checked={checked}
                title={rowTitle(row)}
                data-snapshot={row.kind === 'snapshot' ? row.id : undefined}
                data-diff={row.kind === 'diff' ? row.id : undefined}
                className={`snapshot-picker__row${index === cursor ? ' is-cursor' : ''}${sliceClass(mark)}`}
                onMouseEnter={() => {
                    setCursor(index);
                }}
                onMouseDown={keepSelectionOnShift}
                onClick={(event) => {
                    setCursor(index);
                    choose(index, event.shiftKey);
                }}
            >
                <span className="snapshot-picker__tick" aria-hidden="true">
                    {checked ? <Icon name="check" size={13} /> : null}
                </span>
                <span className="snapshot-picker__row-text">
                    {rowText(row, menu.now, t, locale, menu.localHost ?? false)}
                </span>
                <SliceRole mark={mark} className="snapshot-picker__role" />
            </div>
        );
    };

    return (
        <div className="snapshot-picker" ref={rootRef}>
            <button
                type="button"
                ref={buttonRef}
                className="ctl snapshot-pill snapshot-pill--button"
                aria-haspopup="menu"
                aria-expanded={open}
                title={title}
                onClick={() => {
                    if (open) {
                        close(false);
                    } else {
                        setCursor(Math.max(selectedIndex, 0));
                        setOpen(true);
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && !open) {
                        event.preventDefault();
                        setCursor(Math.max(selectedIndex, 0));
                        setOpen(true);
                    }
                }}
            >
                {text}
                <span className="snapshot-pill__caret" aria-hidden="true">
                    <Icon name="chev-down" size={13} />
                </span>
            </button>

            {open ? (
                <div
                    className="snapshot-picker__menu"
                    role="menu"
                    ref={listRef}
                    tabIndex={-1}
                    aria-label={t('iteration.menu.aria')}
                    aria-activedescendant={`${listId}-${String(cursor)}`}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setCursor((index) => Math.min(index + 1, flat.length - 1));
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setCursor((index) => Math.max(index - 1, 0));
                        } else if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            choose(cursor, event.key === 'Enter' && event.shiftKey);
                        } else if (event.key === 'Tab') {
                            close(false);
                        }
                    }}
                >
                    {label.kind === 'slice' ? (
                        <div className="snapshot-picker__now">
                            {t('iteration.menu.now')}
                            <span className="snapshot-picker__now-value">{pillText(label, t)}</span>
                        </div>
                    ) : null}
                    <div className="snapshot-picker__section">{t('iteration.menu.timeline')}</div>
                    {flat.map(renderRow)}
                    <SliceHint rows={menu.rows} edge={edge} className="snapshot-picker__hint" />
                </div>
            ) : null}
        </div>
    );
}

/**
 * Карточка «Снапшоты» на Обзоре (docs/design/README.md §6): те же строки, что в меню индикатора,
 * плюс провенанс каждого снапшота отдельной строкой (docs/design/SPEC-elements.md §4.4). Срез
 * выбирается так же, как в меню; превью диапазона идёт за наведением и фокусом.
 */
export function SnapshotsCard({ rows, viewing, now, localHost = false, onSelect }: SnapshotListProps) {
    const t = useT();
    const locale = useLocale();
    const [rawEdge, setEdge] = useState<string | null>(null);
    /** Ключи строк под мышью и под фокусом: каждый источник снимает только своё. */
    const [hovered, setHovered] = useState<string | null>(null);
    const [focused, setFocused] = useState<string | null>(null);
    const edge = liveSliceEdge(rows, rawEdge);

    useEscapeLayer('popover', () => {
        setEdge(null);
    }, edge !== null);

    const all = rows.iterations;
    if (all.length === 0) {
        return <p className="overview-card__empty">{t('iteration.empty')}</p>;
    }
    const selected = selectedRows(all, viewing);
    // Мышь главнее фокуса: она точнее показывает, куда придётся клик.
    const pointed = hovered ?? focused;
    const marks = sliceMarks(rows, viewing, edge, all.find((row) => rowKey(row) === pointed) ?? null);
    const apply = (action: RowAction): void => {
        if (action.kind === 'edge') {
            setEdge(action.edge);
            return;
        }
        setEdge(null);
        onSelect(action.viewing);
    };
    return (
        <>
            <ul className="snapshot-list">
                {all.map((row) => {
                    const key = rowKey(row);
                    const checked = selected.has(row);
                    const mark = marks.get(row);
                    const drop = (current: string | null): string | null => (current === key ? null : current);
                    return (
                        <li key={key}>
                            <button
                                type="button"
                                className={`snapshot-list__row${checked ? ' is-current' : ''}${sliceClass(mark)}`}
                                aria-pressed={checked}
                                title={rowTitle(row)}
                                data-snapshot={row.kind === 'snapshot' ? row.id : undefined}
                                data-diff={row.kind === 'diff' ? row.id : undefined}
                                onMouseDown={keepSelectionOnShift}
                                onMouseEnter={() => {
                                    setHovered(key);
                                }}
                                onMouseLeave={() => {
                                    setHovered(drop);
                                }}
                                onFocus={() => {
                                    setFocused(key);
                                }}
                                onBlur={() => {
                                    setFocused(drop);
                                }}
                                onClick={(event) => {
                                    apply(rowAction(rows, edge, row, event.shiftKey));
                                }}
                            >
                                <span className="snapshot-list__line">
                                    {rowText(row, now, t, locale, localHost)}
                                    <SliceRole mark={mark} className="snapshot-list__role" />
                                </span>
                                {row.kind === 'snapshot' ? (
                                    <span className="snapshot-list__provenance">
                                        {provenanceText(row, t, locale)}
                                    </span>
                                ) : null}
                            </button>
                        </li>
                    );
                })}
            </ul>
            <SliceHint rows={rows} edge={edge} className="snapshot-list__hint" />
        </>
    );
}

function rowKey(row: PickerRow): string {
    return `${row.kind}:${row.id}`;
}
