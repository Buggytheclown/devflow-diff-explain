import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useReviewHost } from '../app/review-host-context.tsx';
import { fileWebActionLabel } from '../app/review-state.js';
import { useT } from '../i18n/index.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import { copyText } from './clipboard.js';
import './context-menu.css';

/**
 * Контекстное меню файла (docs/design/SPEC-elements.md §2.11): открывается правым кликом по
 * шапке карточки или строке дерева и кнопкой «⋯» в них же. Порядок пунктов фиксирован,
 * недоступный пункт остаётся в меню выключенным — иначе меню прыгало бы от файла к файлу.
 * Единственный необязательный пункт — «Комментарий к файлу» у карточек-картинок:
 * у остальных файлов комментарий ставится на строку.
 *
 * Меню живёт порталом в `body`: карточка режет содержимое `overflow`, а строки дерева
 * виртуализированы — внутри них меню жило бы ровно до следующей прокрутки.
 */

/** Точка привязки: у указателя (правый клик) или под кнопкой, правыми краями (кнопка «⋯»). */
export interface ContextMenuAnchor {
    readonly x: number;
    readonly y: number;
    readonly align: 'left' | 'right';
}

/** Ответ действия: строка — жалоба, меню показывает её и остаётся открытым; `null` — закрыть. */
type ItemOutcome = string | null;

export interface ContextMenuItem {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
    /** Подсказка пункта; у выключенного объясняет, почему нельзя. */
    readonly title?: string | undefined;
    /** Разделитель рисуется перед пунктом. */
    readonly separatorBefore?: boolean;
    readonly onSelect: () => ItemOutcome | Promise<ItemOutcome>;
}

export interface ContextMenuProps {
    readonly items: readonly ContextMenuItem[];
    readonly anchor: ContextMenuAnchor;
    readonly label: string;
    /** `returnFocus` — закрытие было клавиатурой: фокус обязан вернуться туда, откуда пришёл. */
    readonly onClose: (returnFocus: boolean) => void;
    /**
     * Кнопка «⋯», из которой меню открыто: mousedown по ней меню не закрывает, иначе тумблер
     * закрывался бы на mousedown и тут же открывался обратно на click.
     */
    readonly toggleRef?: RefObject<HTMLElement | null> | undefined;
}

/** Зазор между кнопкой и меню и минимальный отступ от края окна. */
const GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Ширина меню задаётся компонентом, а не стилем: по ней же считается
 * привязка правым краем к кнопке, и зависеть от того, доехал ли CSS, эта арифметика не должна.
 */
const MENU_WIDTH = 240;

export function ContextMenu({ items, anchor, label, onClose, toggleRef }: ContextMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const [cursor, setCursor] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

    const close = useCallback(
        (returnFocus: boolean) => {
            onClose(returnFocus);
        },
        [onClose],
    );

    // Меню кламится во вьюпорт: у указателя внизу экрана оно иначе уехало бы под край,
    // а из кнопки у правого края — за него. Окно без размера (скрытая вкладка, офскрин-рендер)
    // клампу не указ: по нему меню всегда складывалось бы в левый верхний угол.
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (menu === null) {
            return;
        }
        const viewportWidth = window.innerWidth === 0 ? Number.POSITIVE_INFINITY : window.innerWidth;
        const viewportHeight = window.innerHeight === 0 ? Number.POSITIVE_INFINITY : window.innerHeight;
        const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - MENU_WIDTH - VIEWPORT_MARGIN);
        const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - menu.offsetHeight - VIEWPORT_MARGIN);
        const wanted = anchor.align === 'right' ? anchor.x - MENU_WIDTH : anchor.x;
        setPosition({
            left: Math.min(Math.max(VIEWPORT_MARGIN, wanted), maxLeft),
            top: Math.min(Math.max(VIEWPORT_MARGIN, anchor.y), maxTop),
        });
    }, [anchor]);

    useEffect(() => {
        itemRefs.current[0]?.focus();
    }, []);

    // Клик мимо, прокрутка и смена размера окна закрывают меню: оно привязано к точке экрана,
    // а не к элементу, и после любого из этих событий указывало бы уже не туда. Кнопка,
    // из которой меню открыто, — исключение: её click работает тумблером.
    useEffect(() => {
        const onPointerDown = (event: globalThis.MouseEvent): void => {
            const { target } = event;
            if (!(target instanceof Node)) {
                close(false);
                return;
            }
            if (menuRef.current?.contains(target) === true || toggleRef?.current?.contains(target) === true) {
                return;
            }
            close(false);
        };
        const onViewportChange = (): void => {
            close(false);
        };
        window.addEventListener('mousedown', onPointerDown);
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
            window.removeEventListener('scroll', onViewportChange, true);
            window.removeEventListener('resize', onViewportChange);
        };
    }, [close, toggleRef]);

    useEscapeLayer('popover', () => {
        close(true);
    });

    const focusItem = (index: number): void => {
        const next = (index + items.length) % items.length;
        setCursor(next);
        itemRefs.current[next]?.focus();
    };

    const run = (item: ContextMenuItem): void => {
        if (item.disabled === true) {
            return;
        }
        const finish = (outcome: ItemOutcome): void => {
            if (typeof outcome === 'string') {
                setError(outcome);
            } else {
                close(true);
            }
        };
        const outcome = item.onSelect();
        if (outcome instanceof Promise) {
            void outcome.then(finish, (caught: unknown) => {
                setError(caught instanceof Error ? caught.message : String(caught));
            });
        } else {
            finish(outcome);
        }
    };

    const style =
        position === null
            ? { left: 0, top: 0, width: MENU_WIDTH, visibility: 'hidden' as const }
            : { left: position.left, top: position.top, width: MENU_WIDTH };

    return createPortal(
        <div
            className="context-menu"
            role="menu"
            aria-label={label}
            ref={menuRef}
            style={style}
            onKeyDown={(event) => {
                // Портал живёт в `body`, но по React-дереву события всплывают к родителю —
                // клавиатуре дерева (стрелки, ⏎ на открытие файла) события меню видеть нельзя.
                // Esc исключён: его ловит лестница реестра слушателем на window, и до неё
                // событие должно дойти.
                if (event.key !== 'Escape') {
                    event.stopPropagation();
                }
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusItem(cursor + 1);
                } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    focusItem(cursor - 1);
                } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusItem(0);
                } else if (event.key === 'End') {
                    event.preventDefault();
                    focusItem(items.length - 1);
                } else if (event.key === 'Tab') {
                    close(false);
                }
            }}
            onContextMenu={(event) => {
                event.preventDefault();
            }}
        >
            {items.map((item, index) => (
                <div key={item.id} className="context-menu__slot">
                    {item.separatorBefore === true ? <div className="context-menu__separator" role="none" /> : null}
                    <button
                        type="button"
                        role="menuitem"
                        className="context-menu__item"
                        ref={(element) => {
                            itemRefs.current[index] = element;
                        }}
                        aria-disabled={item.disabled === true ? true : undefined}
                        title={item.title}
                        onFocus={() => {
                            setCursor(index);
                        }}
                        onMouseEnter={() => {
                            itemRefs.current[index]?.focus();
                        }}
                        onClick={() => {
                            run(item);
                        }}
                    >
                        {item.label}
                    </button>
                </div>
            ))}
            {error === null ? null : (
                <p className="context-menu__error" role="status">
                    {error}
                </p>
            )}
        </div>,
        document.body,
    );
}

/**
 * Открытие меню и возврат фокуса. Правый клик возвращает фокус туда, откуда позвали (ближайший
 * фокусируемый предок — для дерева это сам контейнер `role="tree"` с его курсором), кнопка «⋯» —
 * на себя.
 */
export interface ContextMenuController {
    readonly anchor: ContextMenuAnchor | null;
    readonly open: boolean;
    /** Отдаётся `ContextMenu`, чтобы кнопка «⋯» работала тумблером. */
    readonly toggleRef: RefObject<HTMLElement | null>;
    readonly openAtPointer: (event: ReactMouseEvent) => void;
    readonly openAtButton: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    readonly close: (returnFocus: boolean) => void;
}

export function useContextMenu(): ContextMenuController {
    const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);
    const origin = useRef<HTMLElement | null>(null);
    const toggleRef = useRef<HTMLElement | null>(null);

    const close = useCallback((returnFocus: boolean) => {
        setAnchor(null);
        const element = origin.current;
        origin.current = null;
        toggleRef.current = null;
        if (returnFocus && element !== null) {
            const focusable = element.closest<HTMLElement>('[tabindex], button, a[href]') ?? element;
            focusable.focus();
        }
    }, []);

    return {
        anchor,
        open: anchor !== null,
        toggleRef,
        openAtPointer: useCallback((event: ReactMouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            origin.current = event.currentTarget as HTMLElement;
            toggleRef.current = null;
            setAnchor({ x: event.clientX, y: event.clientY, align: 'left' });
        }, []),
        openAtButton: useCallback(
            (event: ReactMouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                const button = event.currentTarget;
                // Второй клик по той же кнопке закрывает: mousedown по ней меню не трогает,
                // так что тумблер целиком отрабатывает здесь.
                if (toggleRef.current === button) {
                    close(true);
                    return;
                }
                origin.current = button;
                toggleRef.current = button;
                const box = button.getBoundingClientRect();
                setAnchor({ x: box.right, y: box.bottom + GAP, align: 'right' });
            },
            [close],
        ),
        close,
    };
}

/** Файл, каким его видит меню: путь и обе хостовые ссылки. */
export interface FileMenuTarget {
    readonly path: string;
    readonly hostFileUrl: string | null;
    readonly blameUrl: string | null;
}

export interface FileContextMenuProps {
    readonly file: FileMenuTarget;
    readonly viewed: boolean;
    /** Почему пункт отметки выключен; `null` — включён. */
    readonly viewedDisabledReason?: string | null;
    readonly onToggleViewed: () => void;
    /**
     * Комментарий к файлу без строки: у карточки-картинки строк нет, а сказать про неё
     * что-то надо. Без обработчика пункта в меню нет вовсе.
     */
    readonly onCommentFile?: (() => void) | undefined;
    readonly anchor: ContextMenuAnchor;
    readonly onClose: (returnFocus: boolean) => void;
    readonly toggleRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Меню одного файла: путь и ссылки в буфер, файл в вебе Аркадии, отметка просмотра. Отмечать
 * можно только в активной итерации, поэтому в режиме чтения последний пункт выключен
 * с той же причиной, что коробка прочитанности.
 */
export function FileContextMenu({
    file,
    viewed,
    viewedDisabledReason = null,
    onToggleViewed,
    onCommentFile,
    anchor,
    onClose,
    toggleRef,
}: FileContextMenuProps) {
    const t = useT();
    const reviewHost = useReviewHost();
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();

    const copy = async (text: string): Promise<string | null> => {
        const outcome = await copyText(text);
        if (outcome === 'unavailable') {
            return t('selection.clipboardUnavailable');
        }
        return outcome === 'failed' ? t('selection.copyFailed') : null;
    };

    const items: ContextMenuItem[] = [
        {
            id: 'copy-path',
            label: t('file.menu.copyPath'),
            onSelect: () => copy(file.path),
        },
        {
            id: 'copy-link',
            label: t('file.menu.copyLink'),
            disabled: file.hostFileUrl === null,
            title: file.hostFileUrl === null ? t('file.menu.copyLinkUnavailable') : undefined,
            onSelect: () => copy(file.hostFileUrl ?? ''),
        },
        {
            id: 'blame',
            label: fileWebActionLabel(reviewHost, t),
            disabled: file.blameUrl === null,
            title: file.blameUrl === null ? t('file.menu.copyLinkUnavailable') : undefined,
            onSelect: () => {
                if (file.blameUrl !== null) {
                    window.open(file.blameUrl, '_blank', 'noopener');
                }
                return null;
            },
        },
    ];

    if (onCommentFile !== undefined) {
        items.push({
            id: 'comment-file',
            label: t('file.menu.commentFile'),
            disabled: readOnly,
            title: readOnly ? readOnlyReason : undefined,
            separatorBefore: true,
            onSelect: () => {
                onCommentFile();
                return null;
            },
        });
    }

    items.push({
        id: 'viewed',
        label: viewed ? t('file.menu.unmarkViewed') : t('file.menu.markViewed'),
        disabled: readOnly || viewedDisabledReason !== null,
        title: readOnly ? readOnlyReason : (viewedDisabledReason ?? undefined),
        separatorBefore: onCommentFile === undefined,
        onSelect: () => {
            onToggleViewed();
            return null;
        },
    });

    return <ContextMenu items={items} anchor={anchor} label={file.path} onClose={onClose} toggleRef={toggleRef} />;
}
