import { useRef } from 'react';

import { translateKey, useT } from '../i18n/index.js';
import type { ViewId } from '../session/views.js';
import { VIEWS } from '../session/views.js';

/**
 * Сегмент-контрол вью (docs/design/README.md §0, docs/design/SPEC-elements.md §2.1, §4.4).
 * Табы никогда не disabled — даже когда маршрута нет, таб «Маршрут» открывается и показывает
 * своё состояние.
 *
 * Клавиатура: ←/→ ходят по табам, когда фокус внутри контрола; 1/2/3 — глобальные команды
 * из реестра шорткатов, здесь их нет.
 */
export interface ViewTabsProps {
    readonly view: ViewId;
    readonly onSelect: (view: ViewId) => void;
}

export function ViewTabs({ view, onSelect }: ViewTabsProps) {
    const t = useT();
    const buttons = useRef(new Map<ViewId, HTMLButtonElement>());

    const step = (delta: number): void => {
        const index = VIEWS.findIndex((item) => item.id === view);
        const next = VIEWS[(index + delta + VIEWS.length) % VIEWS.length];
        if (next === undefined) {
            return;
        }
        onSelect(next.id);
        buttons.current.get(next.id)?.focus();
    };

    return (
        <div className="view-tabs ctl-tabs" role="tablist" aria-label={t('view.tabs')}>
            {VIEWS.map((item) => (
                <button
                    key={item.id}
                    ref={(element) => {
                        if (element === null) {
                            buttons.current.delete(item.id);
                        } else {
                            buttons.current.set(item.id, element);
                        }
                    }}
                    type="button"
                    role="tab"
                    className={`view-tabs__tab ctl ctl--tab${item.id === view ? ' is-active' : ''}`}
                    aria-selected={item.id === view}
                    // Цель шага 07 тура первого захода.
                    {...(item.id === 'diff' ? { 'data-tour': 'fulldiff' } : {})}
                    // Ролевая табуляция: в контрол входят Tab'ом один раз, дальше — стрелками.
                    tabIndex={item.id === view ? 0 : -1}
                    onClick={() => {
                        onSelect(item.id);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft') {
                            event.preventDefault();
                            step(-1);
                        } else if (event.key === 'ArrowRight') {
                            event.preventDefault();
                            step(1);
                        }
                    }}
                >
                    {translateKey(t, item.label)}
                </button>
            ))}
        </div>
    );
}
