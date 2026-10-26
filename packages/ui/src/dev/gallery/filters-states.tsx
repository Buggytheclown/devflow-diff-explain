import { fixtureIteration } from '@sherpa/fixtures';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { FilterSelect } from '../../components/filter-select.tsx';
import type { FileFilter } from '../../filters/lens-filters.js';
import {
    buildFileFilters,
    filterFiles,
    findFilter,
    MINE_FILTER_ID,
    selectFilter,
} from '../../filters/lens-filters.js';
import { createT } from '../../i18n/index.js';
import { readStateOf } from '../../progress/read-state.js';
import { FilePanel } from '../../tree/file-panel.tsx';

const EDGE = fixtureIteration('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
// Фикстура модульного уровня: галерея переключает язык рендером, а этим подписям хватает русских.
const FILTERS = buildFileFilters({
    files: FILES,
    ownership: EDGE.ownership,
    extra: fixtureIteration('large').extraLenses,
    t: createT('ru'),
});
// У хоста нет ownership, чужие линзы пусты, машинных файлов нет — остаётся один «Все».
const SINGLE_FILTER = buildFileFilters({ files: FILES, ownership: null, extra: [], t: createT('ru') });
const READ_STATE = new Map(FILES.map((file) => [file.fileId, readStateOf({ file, record: null })]));

export interface FilterGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const FILTER_STATES: readonly FilterGalleryState[] = [
    {
        id: 'filters-zero-lenses',
        title: 'нулевые линзы скрыты, «Мои» выключен',
        render: () => <FiltersState filters={FILTERS} />,
    },
    {
        id: 'filters-single',
        title: 'единственный фильтр «Все»: ряда чипов в панели нет, селект остаётся',
        render: () => <FiltersState filters={SINGLE_FILTER} />,
    },
];

function FiltersState({ filters }: { filters: readonly FileFilter[] }) {
    const [filterId, setFilterId] = useState('all');
    const active = selectFilter(filters, filterId);
    const selectRoot = useRef<HTMLDivElement | null>(null);

    // Витрина сразу показывает состав выпадающего списка, а не требует отдельного клика.
    useEffect(() => {
        const button = selectRoot.current?.querySelector<HTMLButtonElement>('.filter-select__button');
        if (button?.getAttribute('aria-expanded') !== 'true') {
            button?.click();
        }
    }, []);

    return (
        <div className="gallery__viewport gallery-zero-filters">
            <FilePanel
                files={filterFiles(FILES, active)}
                filters={filters}
                activeFilter={active}
                onFilter={setFilterId}
                pciFileIds={new Set()}
                mineFileIds={findFilter(filters, MINE_FILTER_ID)?.fileIds ?? null}
                readState={READ_STATE}
                route={null}
                activeFileId={null}
                onOpenFile={() => undefined}
                onToggleViewed={() => undefined}
                writeError={null}
                outline={null}
                onOpenHunk={() => undefined}
            />
            <section className="gallery-zero-filters__select" ref={selectRoot}>
                <h2>Селект фильтра</h2>
                <FilterSelect filters={filters} active={active} onSelect={setFilterId} />
            </section>
        </div>
    );
}
