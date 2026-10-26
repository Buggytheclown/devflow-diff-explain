import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Провалившийся слот в готовом маршруте: кнопка «Дозаполнить» рендерится только
 * при `status: 'failed'` и переданном `onFillStop`, и до сих пор жила лишь в компонентном тесте.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
}

/**
 * Готовый маршрут, у которого один слот сорвался: у реального провального слота нет ни абзаца,
 * ни якорей. Остальные слоты остаются `ready` — иначе снапшот считался бы достраиваемым
 * и `onFillStop` до карточки не дошёл бы.
 */
function failedStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's01'
                ? {
                      ...stop,
                      status: 'failed' as const,
                      paragraph: null,
                      bridge: null,
                      anchors: [],
                      tests: [],
                      validationNotes: [],
                  }
                : stop,
        ),
    };
}

function FailedStopState() {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all' } }), []);
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
                snapshot={failedStopSnapshot()}
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
                onFillStop={() => undefined}
            />
        </div>
    );
}

export const ROUTE_STOP_FAILURE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-stop-failed',
        title: 'слот сорвался в готовом маршруте: нота и «Дозаполнить»',
        render: () => <FailedStopState />,
    },
];
