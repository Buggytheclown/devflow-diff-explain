import { useSyncExternalStore } from 'react';

import type { DiffViewStore } from '../diff-view/store.js';
import type { FileFilter } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { FilterSelect } from './filter-select.tsx';
import './toolbar-controls.css';

/** Общий правый кластер тулбаров маршрута и полного диффа в порядке docs/design/README.md §1. */
export function ToolbarRightCluster({
    store,
    filters,
    filter,
    onFilter,
    authorLens = null,
}: {
    readonly store: DiffViewStore;
    readonly filters: readonly FileFilter[];
    readonly filter: FileFilter;
    readonly onFilter: (id: string) => void;
    /** Линза по автору из карточки обсуждения; `null` — линзы нет, чипа тоже. */
    readonly authorLens?: AuthorLens | null;
}) {
    return (
        <div className="toolbar-right-cluster">
            <DiffModeToggle store={store} />
            <FilterSelect filters={filters} active={filter} onSelect={onFilter} />
            {authorLens === null ? null : <AuthorLensChip lens={authorLens} />}
        </div>
    );
}

/** Треды одного участника: линзу ставит карточка обсуждения, снимает — этот чип. */
export interface AuthorLens {
    readonly name: string;
    readonly onClear: () => void;
}

function AuthorLensChip({ lens }: { lens: AuthorLens }) {
    const t = useT();
    return (
        <button
            type="button"
            className="ctl ctl--chip thread-chip thread-chip--author is-on"
            title={t('overview.discussion.lens.clear', lens.name)}
            onClick={lens.onClear}
        >
            {t('overview.discussion.lens.chip', lens.name)}
            <Icon name="cross" size={9} />
        </button>
    );
}

/**
 * Тумблер режима диффа — «deliberately quiet» (docs/design/README.md §1), глобальный на все вью
 * (docs/design/SPEC-elements.md §2.6).
 */
export function DiffModeToggle({ store }: { store: DiffViewStore }) {
    const t = useT();
    const { diffMode, splitAvailable, effectiveMode } = useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot,
    );

    // Ниже 1100px выбирать нечего (docs/design/SPEC-elements.md §2.6), а подпись всегда называет режим,
    // в котором дифф нарисован прямо сейчас, — не отложенный выбор пользователя.
    return (
        <button
            type="button"
            className="ctl ctl--quiet diff-mode-toggle"
            disabled={!splitAvailable}
            title={splitAvailable ? undefined : t('toolbar.splitUnavailable')}
            onClick={() => {
                store.setDiffMode(diffMode === 'unified' ? 'split' : 'unified');
            }}
        >
            <Icon name="swap" size={14} />
            {effectiveMode === 'unified' ? t('toolbar.mode.unified') : t('toolbar.mode.split')}
        </button>
    );
}
