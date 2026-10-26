import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo, useState } from 'react';

import { useT } from '../../i18n/index.js';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import type { RoutePreset } from '../../session/session-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { CoverageStrip } from '../../views/route/coverage-strip.tsx';
import { RouteToolbar } from '../../views/route/route-toolbar.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Пресет полного тура: порядок карточек задаёт `tourOrder` снапшота, номера остановок
 * остаются план-фиксированными. Плюс выключенный переключатель — как он выглядит, пока маршрута
 * ещё нет (docs/design/SPEC-elements.md §2.5).
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
}

/** Маршрут в выбранном пресете: переключатель живой, состояние живёт в сессии галереи. */
function PresetRouteState({ preset }: { preset: RoutePreset }) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter: 'all', preset } }),
        [preset],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files });
        for (const file of DATA.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, []);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <div className="gallery__viewport">
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                snapshot={readySnapshot()}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
                onSetStopFileViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

/** Тулбар без маршрута: переключатель выключен и объясняет себя `title` (docs/design/SPEC-elements.md §2.5). */
function DisabledPresetState() {
    const t = useT();
    const [preset, setPreset] = useState<RoutePreset>('triage');
    const store = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const filters = useMemo(
        () => buildFileFilters({ files: DATA.diff.files, ownership: DATA.ownership, extra: DATA.extraLenses, t }),
        [t],
    );

    return (
        <div className="gallery__viewport">
            <RouteToolbar
                store={store}
                preset={preset}
                onPreset={setPreset}
                presetDisabled
                filters={filters}
                filter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                strip={<CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 7 }} />}
            />
        </div>
    );
}

export const ROUTE_PRESET_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-tour',
        title: 'полный тур: порядок по tourOrder, номера остановок план-фиксированные',
        render: () => <PresetRouteState preset="tour" />,
    },
    {
        id: 'route-preset-disabled',
        title: 'переключатель пресета выключен: маршрута ещё нет',
        render: () => <DisabledPresetState />,
    },
];
