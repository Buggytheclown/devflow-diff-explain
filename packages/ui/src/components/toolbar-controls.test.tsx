// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { ToolbarRightCluster } from './toolbar-controls.tsx';
import { createT } from '../i18n/index.js';

const t = createT('ru');

const DATA = fixtureIteration('medium');

describe('правый кластер тулбара', () => {
    it('фиксирует общий состав и порядок для маршрута и полного диффа', () => {
        const filters = buildFileFilters({
            files: DATA.diff.files,
            ownership: DATA.ownership,
            extra: DATA.extraLenses, t,});
        const html = renderToStaticMarkup(
            <ToolbarRightCluster
                store={createDiffViewStore({ files: DATA.diff.files })}
                filters={filters}
                filter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
            />,
        );
        const host = document.createElement('div');
        host.innerHTML = html;
        const cluster = host.querySelector('.toolbar-right-cluster');
        if (cluster === null) {
            throw new Error('общий правый кластер не отрендерился');
        }

        // Фильтр «Comments from» удалён вместе с разделителем и подписью (SPEC-changes-2026-09-20 §3).
        expect([...cluster.children].map((element) => element.className)).toEqual([
            'ctl ctl--quiet diff-mode-toggle',
            'filter-select',
        ]);
    });
});
