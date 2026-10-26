import type { FileDiff } from '@sherpa/protocol';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { FileContextMenu, useContextMenu } from '../components/context-menu.tsx';
import type { FileFilter } from '../filters/lens-filters.js';
import type { MessageKey } from '../i18n/index.js';
import { useFormat, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { usePrState, usePrStateStore } from '../pr-state/context.tsx';
import { collapsedFromMap, collapsedToMap } from '../pr-state/pr-state-store.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import type { FileReadState } from '../progress/read-state.js';
import { readStateTooltip } from '../progress/read-state.js';
import type { RouteMarginModel } from '../route/margin-model.js';
import { marginFooterNote } from '../route/margin-model.js';
import { RouteBadge } from '../route/route-margin.tsx';
import type { FileTree, TreeDirRow, TreeFileRow, TreeRow } from './file-tree.js';
import { buildFileTree, filterByQuery, readBox, rowIndent, rowKey, splitLabel, toggleDirectory } from './file-tree.js';
import './file-tree.css';
import { treeKeyCommand } from './tree-keys.js';
import { useCssPixelSizes } from '../styles/use-css-pixel-sizes.js';

/**
 * Левая панель полного диффа (docs/design/README.md §10, docs/design/SPEC-elements.md §2.20):
 * поле фильтра, чипы фильтров-линз и дерево файлов. Панель ничего не грузит и ничем не владеет, кроме своего локального
 * состояния: свёрнутости каталогов, строки поиска и позиции клавиатурного курсора.
 *
 * Однофайловый PR получает вместо однострочного дерева аутлайн файла — список ханков.
 */

const OVERSCAN = 8;

const TREE_CSS_SIZES = { rowHeight: '--tree-row-height', indentStep: '--tree-indent-step' } as const;

/**
 * Курсор дерева наружу: клавиша `v` полного диффа берёт файл отсюда, когда мышь не последний
 * сигнал, а фокус держит дерево (docs/design/SPEC-elements.md §5).
 */
export interface FileTreeCursor {
    /** Файл под клавиатурным курсором, пока дерево в фокусе; иначе `null`. */
    readonly cursorFileId: () => string | null;
}

/** Один ханк в аутлайне однофайлового PR. */
export interface OutlineEntry {
    readonly index: number;
    readonly label: string;
}

/**
 * Аутлайн однофайлового PR: разбор ещё идёт, разбор закончился и оглавлять нечего (бинарник,
 * неразобранный патч, файл без ханков) или готовые пункты.
 */
export type FileOutlineModel =
    | { readonly state: 'parsing' }
    | { readonly state: 'empty'; readonly reason: MessageKey }
    | { readonly state: 'ready'; readonly entries: readonly OutlineEntry[] };

export interface FilePanelProps {
    /** Файлы после фильтра-линзы; поиск по строке панель применяет сама. */
    readonly files: readonly FileDiff[];
    readonly filters: readonly FileFilter[];
    readonly activeFilter: FileFilter;
    readonly onFilter: (id: string) => void;
    readonly pciFileIds: ReadonlySet<string>;
    /** null — ownership-линзы нет: «чужие корни» не приглушаются. */
    readonly mineFileIds: ReadonlySet<string> | null;
    readonly readState: ReadonlyMap<string, FileReadState>;
    /** Маршрут на полях (docs/design/README.md §10): бейджи строк и футер-нота. null — маршрута нет. */
    readonly route: RouteMarginModel | null;
    /** Переход к остановке на вкладке маршрута; без него бейджи остаются подписями. */
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** Активный файл — верхняя карточка вьюпорта (scroll-spy правой панели). */
    readonly activeFileId: string | null;
    readonly onOpenFile: (fileId: string) => void;
    /** Единое действие коробки просмотра и клавиши `v` на строке файла (docs/design/SPEC-elements.md §2.10). */
    readonly onToggleViewed: (fileId: string) => void;
    /** Сорвавшаяся запись отметки из дерева: инлайн-подсказка с повтором (docs/design/SPEC-elements.md §1.2, §2.10). */
    readonly writeError: { readonly text: string; readonly onRetry: () => void } | null;
    /** Аутлайн вместо дерева; null — файлов в PR больше одного. */
    readonly outline: FileOutlineModel | null;
    readonly onOpenHunk: (index: number) => void;
    readonly inputRef?: RefObject<HTMLInputElement | null>;
    /** Куда панель кладёт доступ к своему курсору; в аутлайне однофайлового PR курсора нет. */
    readonly cursorRef?: RefObject<FileTreeCursor | null>;
}

export function FilePanel(props: FilePanelProps) {
    const t = useT();
    const { files, filters, activeFilter, onFilter, outline, inputRef, writeError, route } = props;
    const [query, setQuery] = useState('');
    // Нота — про маршрут целиком, а не про текущий фильтр: бейджи от фильтра тоже не зависят.
    const footer = route === null ? null : marginFooterNote(route, t);

    return (
        <aside className="file-panel" aria-label={t('tree.aria')}>
            <div className="file-panel__search">
                <span className="file-panel__search-icon" aria-hidden="true">
                    <Icon name="search" size={13} />
                </span>
                <input
                    ref={inputRef}
                    className="file-panel__input"
                    type="search"
                    value={query}
                    placeholder={t('tree.filter.placeholder')}
                    aria-label={t('tree.filter.aria')}
                    onChange={(event) => {
                        setQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        // Esc очищает запрос; лестница реестра получает его только когда
                        // очищать было нечего — иначе поле съедало бы закрытие оверлея.
                        if (event.key === 'Escape' && query !== '') {
                            event.stopPropagation();
                            setQuery('');
                        }
                    }}
                />
            </div>

            {/* Один фильтр («Все») ни на что не переключает — ряд не рисуем. */}
            {filters.length < 2 ? null : (
                <div className="file-panel__chips">
                    {filters.map((filter) => (
                        <button
                            key={filter.id}
                            type="button"
                            className={`ctl ctl--chip file-panel__chip${filter.id === activeFilter.id ? ' is-on' : ''}`}
                            disabled={!filter.available}
                            aria-pressed={filter.id === activeFilter.id}
                            title={filter.available ? filter.label : (filter.note ?? t('tree.filter.unavailable'))}
                            onClick={() => {
                                onFilter(filter.id);
                            }}
                        >
                            {filter.shortLabel} <span className="file-panel__chip-count">{filter.count}</span>
                        </button>
                    ))}
                </div>
            )}

            {writeError === null ? null : (
                <p className="file-panel__notice" role="status">
                    {writeError.text}
                    <button type="button" className="ctl ctl--link file-panel__link" onClick={writeError.onRetry}>
                        {t('tree.retry')}
                    </button>
                </p>
            )}

            {outline === null ? (
                <FileTreeView
                    {...props}
                    query={query}
                    onClearQuery={() => {
                        setQuery('');
                    }}
                />
            ) : (
                <FileOutline outline={outline} onOpenHunk={props.onOpenHunk} name={files[0]?.path ?? ''} />
            )}

            {/* Футер-нота маршрута (docs/design/README.md §10): числа вычисленные, живёт
                под деревом, а не в его прокрутке. */}
            {footer === null ? null : <p className="file-panel__footer">{footer}</p>}
        </aside>
    );
}

interface FileTreeViewProps extends FilePanelProps {
    readonly query: string;
    readonly onClearQuery: () => void;
}

function FileTreeView({
    files,
    query,
    onClearQuery,
    pciFileIds,
    mineFileIds,
    readState,
    activeFileId,
    onOpenFile,
    onToggleViewed,
    route,
    onJumpToStop,
    cursorRef,
}: FileTreeViewProps) {
    const t = useT();
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
    const { rowHeight, indentStep } = useCssPixelSizes(scrollElement, TREE_CSS_SIZES);
    // Свёрнутость каталогов живёт в состоянии PR на сервере: хранится явный выбор ревьюера,
    // каталог без записи слушается умолчания по размеру.
    const prState = usePrStateStore();
    const treeCollapsed = usePrState().treeCollapsed;
    const collapsed = useMemo(() => collapsedToMap(treeCollapsed), [treeCollapsed]);

    const tree: FileTree = useMemo(
        () =>
            buildFileTree({
                files: filterByQuery(files, query),
                pciFileIds,
                mineFileIds,
                readState,
                routeFiles: route?.files ?? null,
                collapsed,
            }),
        [files, query, pciFileIds, mineFileIds, readState, route, collapsed],
    );

    const persist = useCallback(
        (next: ReadonlyMap<string, boolean>) => {
            prState.update({ treeCollapsed: collapsedFromMap(next) });
        },
        [prState],
    );

    const [cursor, setCursor] = useState(-1);
    // Меню одно на дерево: строка, для которой его позвали, помнится отдельно от точки привязки.
    const menu = useContextMenu();
    const [menuRow, setMenuRow] = useState<TreeFileRow | null>(null);
    const virtualizer = useVirtualizer({
        count: tree.rows.length,
        getScrollElement: () => scrollElement,
        estimateSize: () => rowHeight,
        overscan: OVERSCAN,
        getItemKey: (index) => {
            const row = tree.rows[index];
            return row === undefined ? index : rowKey(row);
        },
        // Строка под клавиатурным курсором рисуется всегда, даже уехав за окно виртуализации:
        // на её id ссылается `aria-activedescendant`, и без элемента в DOM озвучка курсора
        // просто пропадает.
        rangeExtractor: (range) => {
            const indexes = defaultRangeExtractor(range);
            if (cursor < 0 || cursor >= tree.rows.length || indexes.includes(cursor)) {
                return indexes;
            }
            return [...indexes, cursor].sort((a, b) => a - b);
        },
    });

    const previousRowHeight = useRef(rowHeight);
    useEffect(() => {
        if (previousRowHeight.current !== rowHeight) {
            previousRowHeight.current = rowHeight;
            virtualizer.measure();
        }
    }, [rowHeight, virtualizer]);

    // Активная строка приезжает от scroll-spy правой панели — её надо показать.
    const activeIndex = tree.rows.findIndex((row) => row.kind === 'file' && row.fileId === activeFileId);
    useEffect(() => {
        if (activeIndex >= 0) {
            virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
        }
    }, [activeIndex, rowHeight, scrollElement, virtualizer]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const command = treeKeyCommand(event.key, tree.rows, cursor);
        if (command === null) {
            return;
        }
        event.preventDefault();
        if (command.kind === 'focus') {
            setCursor(command.index);
            virtualizer.scrollToIndex(command.index, { align: 'auto' });
        } else if (command.kind === 'setCollapsed') {
            persist(new Map(collapsed).set(command.path, command.collapsed));
        } else {
            onOpenFile(command.fileId);
        }
    };

    const cursorRow = cursor < 0 ? undefined : tree.rows[cursor];
    // Курсор наружу: сама команда `v` объявлена во вью полного диффа — у неё есть и вторая цель,
    // карточка файла под мышью, а команда в реестре обязана быть одна.
    useImperativeHandle(
        cursorRef,
        (): FileTreeCursor => ({
            cursorFileId: () =>
                cursorRow?.kind === 'file' && scrollElement?.contains(document.activeElement) === true
                    ? cursorRow.fileId
                    : null,
        }),
        [cursorRow, scrollElement],
    );

    if (files.length === 0) {
        return <p className="file-panel__empty">{t('tree.empty.filter')}</p>;
    }
    if (tree.rows.length === 0) {
        return (
            <p className="file-panel__empty">
                {t('tree.empty.query')}
                <button type="button" className="ctl ctl--link file-panel__link" onClick={onClearQuery}>
                    {t('tree.empty.clear')}
                </button>
            </p>
        );
    }

    return (
        <div
            className="file-tree"
            ref={setScrollElement}
            role="tree"
            aria-label={t('tree.rows.aria')}
            tabIndex={0}
            aria-activedescendant={cursorRow === undefined ? undefined : rowDomId(cursorRow)}
            onKeyDown={onKeyDown}
        >
            <div className="file-tree__inner" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
                {virtualizer.getVirtualItems().map((item) => {
                    const row = tree.rows[item.index];
                    if (row === undefined) {
                        return null;
                    }
                    return (
                        <div
                            key={rowKey(row)}
                            id={rowDomId(row)}
                            role="treeitem"
                            aria-level={row.depth + 1}
                            aria-expanded={row.kind === 'dir' ? !row.collapsed : undefined}
                            aria-selected={row.kind === 'file' && row.fileId === activeFileId}
                            // Строка файла — такая же цель команд «под курсором», как карточка в списке.
                            data-file={row.kind === 'file' ? row.fileId : undefined}
                            title={
                                row.kind === 'dir'
                                    ? t('tree.dir.read', row.readFiles, row.files)
                                    : t('tree.file.title', row.path, readStateTooltip(t, row.read))
                            }
                            className={rowClassName(row, activeFileId, item.index === cursor)}
                            // Позиция через `top`, а не `transform`: трансформ ломает липкие
                            // элементы внутри прокручиваемой панели.
                            style={{ top: `${String(item.start)}px`, paddingLeft: `${String(rowIndent(row, indentStep))}px` }}
                            onClick={(event) => {
                                setCursor(item.index);
                                if (row.kind === 'dir') {
                                    persist(toggleDirectory(tree, collapsed, row.path, event.altKey));
                                } else {
                                    onOpenFile(row.fileId);
                                }
                            }}
                            onContextMenu={(event) => {
                                if (row.kind !== 'file') {
                                    return;
                                }
                                setCursor(item.index);
                                setMenuRow(row);
                                menu.openAtPointer(event);
                            }}
                        >
                            {row.kind === 'dir' ? (
                                <DirRow row={row} />
                            ) : (
                                <FileRow
                                    row={row}
                                    otherStopId={route?.otherStopId ?? null}
                                    onJumpToStop={onJumpToStop}
                                    menuOpen={menu.open && menuRow?.fileId === row.fileId}
                                    onMenu={(event) => {
                                        setCursor(item.index);
                                        setMenuRow(row);
                                        menu.openAtButton(event);
                                    }}
                                    onToggleViewed={(fileId) => {
                                        setCursor(item.index);
                                        onToggleViewed(fileId);
                                    }}
                                />
                            )}
                        </div>
                    );
                })}
            </div>

            {menu.anchor === null || menuRow === null ? null : (
                <FileContextMenu
                    file={menuRow}
                    viewed={menuRow.read.state === 'read'}
                    onToggleViewed={() => {
                        onToggleViewed(menuRow.fileId);
                    }}
                    anchor={menu.anchor}
                    onClose={menu.close}
                    toggleRef={menu.toggleRef}
                />
            )}
        </div>
    );
}

/** Идентификатор строки в DOM: ключ строки, безопасно закодированный (пробел в IDREF нельзя). */
function rowDomId(row: TreeRow): string {
    return `tree-row-${encodeURIComponent(rowKey(row))}`;
}

function rowClassName(row: TreeRow, activeFileId: string | null, cursor: boolean): string {
    const classes = ['file-tree__row', `file-tree__row--${row.kind}`];
    if (row.kind === 'file' && row.fileId === activeFileId) {
        classes.push('is-active');
    }
    if (cursor) {
        classes.push('is-cursor');
    }
    if (row.generated) {
        classes.push('is-generated');
    }
    if (row.kind === 'dir' && row.foreign) {
        classes.push('is-foreign');
    }
    if (isRowRead(row)) {
        classes.push('is-read');
    }
    return classes.join(' ');
}

/** Файл прочитан целиком; каталог — когда прочитаны все видимые файлы его поддерева. */
function isRowRead(row: TreeRow): boolean {
    return row.kind === 'file' ? row.read.state === 'read' : row.files > 0 && row.readFiles === row.files;
}

function DirRow({ row }: { row: TreeDirRow }) {
    return (
        <>
            <span className="file-tree__chevron" aria-hidden="true">
                <Icon name={row.collapsed ? 'chev-right' : 'chev-down'} size={9} />
            </span>
            <Label label={row.label} title={row.path} />
            <Counts additions={row.additions} />
        </>
    );
}

function FileRow({
    row,
    otherStopId,
    onJumpToStop,
    menuOpen,
    onMenu,
    onToggleViewed,
}: {
    row: TreeFileRow;
    otherStopId: string | null;
    onJumpToStop?: ((stopId: string) => void) | undefined;
    menuOpen: boolean;
    onMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onToggleViewed: (fileId: string) => void;
}) {
    const t = useT();
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    return (
        <>
            {/* Шеврона у файла нет: коробка встаёт в колонку шевронов соседних каталогов. */}
            {/* Метка остановки живёт в зоне отступа строки, поэтому стоит до всего остального. */}
            {row.route === null ? null : (
                <RouteBadge file={row.route} otherStopId={otherStopId} variant="tree" onJump={onJumpToStop} />
            )}
            {/* Три состояния read-state (docs/design/SPEC-elements.md §2.12); тултип всегда с числами. */}
            <button
                type="button"
                className={`file-tree__read file-tree__read--${readBox(row.read.state)}`}
                aria-pressed={row.read.state === 'read'}
                aria-hidden="true"
                tabIndex={-1}
                disabled={readOnly}
                title={readOnly ? readOnlyReason : readStateTooltip(t, row.read)}
                onMouseDown={(event) => {
                    event.preventDefault();
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    onToggleViewed(row.fileId);
                }}
            >
                {row.read.state === 'read' ? <Icon name="check" size={9} /> : null}
            </button>
            {/* Подпись файла — только имя: путь целиком остаётся в тултипе строки. */}
            <Label label={row.label} />
            {row.pci ? <span className="file-tree__tag">pci</span> : null}
            {row.generated ? <span className="file-tree__tag file-tree__tag--gen">gen</span> : null}
            {row.conflict ? (
                <span className="file-tree__tag file-tree__tag--conflict">{t('file.conflict')}</span>
            ) : null}
            {/* Кнопка меню вне tab-порядка, как коробка прочитанности: по дереву ходят стрелками. */}
            <button
                type="button"
                className={`ctl ctl--chevron file-tree__more${menuOpen ? ' is-open' : ''}`}
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('file.menu.more')}
                onMouseDown={(event) => {
                    event.preventDefault();
                }}
                onClick={onMenu}
            >
                ⋯
            </button>
            <Counts additions={row.additions} />
        </>
    );
}

/**
 * Подпись строки (docs/design/SPEC-elements.md §1.2): цепочка каталогов обрезается слева и уступает место первой,
 * последний сегмент с расширением держится до последнего и, если всё же не влезает, режется с конца.
 * `bdi` изолирует направление — иначе левая обрезка (`direction: rtl`) утащила бы слэш на другой край.
 *
 * Цепочка бывает только у строки каталога: подпись файла — это его имя. `title` тоже нужен
 * одному каталогу: у файла он на самой строке и говорит ещё и о прогрессе чтения.
 */
function Label({ label, title }: { label: string; title?: string }) {
    const { dir, name } = splitLabel(label);
    return (
        <span className="file-tree__label" title={title}>
            {dir === '' ? null : (
                <span className="file-tree__label-dir">
                    <bdi>{dir}</bdi>
                </span>
            )}
            <span className="file-tree__label-name">
                <bdi>{name}</bdi>
            </span>
        </span>
    );
}

/**
 * Объём строки — только `+N` в колонке 30px справа (docs/design/SPEC-theming-2026-09-12.md §6a):
 * колонка читается сверху вниз, а удаления остались в шапке карточки диффа.
 */
function Counts({ additions }: { additions: number }) {
    const { count } = useFormat();
    return <span className="file-tree__counts">+{count(additions)}</span>;
}

/**
 * Аутлайн однофайлового PR (docs/design/SPEC-elements.md §2.20: «the tree is replaced by the file's outline»).
 * Пункты — ханки, подписанные диапазоном строк.
 */
function FileOutline({
    outline,
    onOpenHunk,
    name,
}: {
    outline: FileOutlineModel;
    onOpenHunk: (index: number) => void;
    name: string;
}) {
    const t = useT();
    if (outline.state === 'parsing') {
        return <p className="file-panel__empty">{t('tree.outline.parsing')}</p>;
    }
    if (outline.state === 'empty') {
        return <p className="file-panel__empty">{t(outline.reason)}</p>;
    }

    return (
        <nav className="file-tree file-tree--outline" aria-label={t('tree.outline.aria', name)}>
            {outline.entries.map((entry) => (
                <button
                    key={entry.index}
                    type="button"
                    className="file-tree__row file-tree__row--outline"
                    onClick={() => {
                        onOpenHunk(entry.index);
                    }}
                >
                    <span className="file-tree__outline-label">{entry.label}</span>
                </button>
            ))}
        </nav>
    );
}
