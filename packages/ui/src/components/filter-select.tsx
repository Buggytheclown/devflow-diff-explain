import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { FileFilter } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import './filter-select.css';

/**
 * Селект фильтра файлов (docs/design/SPEC-elements.md §2.7, docs/design/README.md §Filters):
 * кнопка «лейбл + счётчик» и выпадающий список на 250px с иконкой у активного.
 *
 * Клавиатура целиком по спецификации: ↓ открывает, ↑/↓ ходят, ⏎ выбирает, Esc и клик мимо закрывают
 * с возвратом фокуса на кнопку. Выключенные пункты остаются достижимы стрелками — иначе
 * причину «почему нельзя» негде прочитать, — но не выбираются.
 */

export interface FilterSelectProps {
    readonly filters: readonly FileFilter[];
    readonly active: FileFilter;
    readonly onSelect: (id: string) => void;
}

export function FilterSelect({ filters, active, onSelect }: FilterSelectProps) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [cursor, setCursor] = useState(0);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const listId = useId();

    const close = useCallback((returnFocus: boolean): void => {
        setOpen(false);
        if (returnFocus) {
            buttonRef.current?.focus();
        }
    }, []);

    const openAt = (): void => {
        setCursor(Math.max(0, filters.indexOf(active)));
        setOpen(true);
    };

    // Клик мимо закрывает список с возвратом фокуса на кнопку (docs/design/SPEC-elements.md §2.7). Фокус на кнопке
    // — временный: если ревьюер кликнул по чему-то фокусируемому, браузер тут же уведёт его
    // туда; зато клавиатура не остаётся ни на чём.
    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: MouseEvent): void => {
            const { target } = event;
            const inside = target instanceof Node && rootRef.current?.contains(target) === true;
            if (!inside) {
                close(true);
            }
        };
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [close, open]);

    useEscapeLayer('popover', () => {
        close(true);
    }, open);

    // Фокус уезжает на список: `aria-activedescendant` двигает выделение внутри него,
    // так стрелки не гоняют фокус по десяти кнопкам.
    useEffect(() => {
        if (open) {
            listRef.current?.focus();
        }
    }, [open]);

    const choose = (index: number): void => {
        const filter = filters[index];
        if (filter?.available !== true) {
            return;
        }
        onSelect(filter.id);
        close(true);
    };

    return (
        <div className="filter-select" ref={rootRef}>
            <button
                type="button"
                ref={buttonRef}
                className={`ctl ctl--chip filter-select__button${active.fileIds === null ? '' : ' is-on'}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    if (open) {
                        close(false);
                    } else {
                        openAt();
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && !open) {
                        event.preventDefault();
                        openAt();
                    }
                }}
            >
                {active.label}
                <span className="filter-select__count">{active.count}</span>
                <span className="filter-select__caret" aria-hidden="true">
                    <Icon name="chev-down" size={13} />
                </span>
            </button>

            {open ? (
                <div
                    className="filter-select__menu"
                    role="listbox"
                    ref={listRef}
                    tabIndex={-1}
                    aria-label={t('tree.filter.placeholder')}
                    aria-activedescendant={`${listId}-${String(cursor)}`}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setCursor((index) => Math.min(index + 1, filters.length - 1));
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setCursor((index) => Math.max(index - 1, 0));
                        } else if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            choose(cursor);
                        } else if (event.key === 'Tab') {
                            close(false);
                        }
                    }}
                >
                    {filters.map((filter, index) => (
                        <div
                            key={filter.id}
                            id={`${listId}-${String(index)}`}
                            role="option"
                            aria-selected={filter.id === active.id}
                            aria-disabled={!filter.available}
                            title={filter.available ? undefined : (filter.note ?? t('tree.filter.unavailable'))}
                            className={`filter-select__option${index === cursor ? ' is-cursor' : ''}`}
                            onMouseEnter={() => {
                                setCursor(index);
                            }}
                            onClick={() => {
                                choose(index);
                            }}
                        >
                            <span className="filter-select__tick" aria-hidden="true">
                                {filter.id === active.id ? <Icon name="check" size={13} /> : null}
                            </span>
                            <span className="filter-select__label">{filter.label}</span>
                            <span className="filter-select__count">{filter.count}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
