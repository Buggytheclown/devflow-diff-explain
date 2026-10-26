import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import type { RouteGalleryState } from './route-states.tsx';
import { asFetched } from './fetched.js';

/**
 * Маршрут на полях полного диффа (docs/design/README.md §10): бейджи в дереве и в шапках карточек,
 * футер-нота с вычисленными числами фикстуры (38 строк в 4 файлах) и штрихованные полосы
 * непокрытых диапазонов. Второе состояние — тот же ридер без маршрута: полей нет вовсе.
 */

const DATA = asFetched(fixtureIteration('medium'));
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
}

/**
 * `paths` сужает дифф до нужных файлов: до карточки частично покрытого файла иначе пришлось бы
 * скроллить, а состояние галереи обязано быть одним и тем же кадром.
 */
function MarginState({ route = true, paths }: { route?: boolean; paths?: readonly string[] }) {
    const diff = useMemo(
        () =>
            paths === undefined
                ? DATA.diff
                : { ...DATA.diff, files: DATA.diff.files.filter((file) => paths.includes(file.path)) },
        [paths],
    );
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: diff.files });
        for (const file of diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [diff]);
    const threadStore = useMemo(
        () => createThreadStore([], new Set(diff.files.map((file) => file.fileId))),
        [diff],
    );

    return (
        <div className="gallery__viewport">
            <DiffWorkspace
                pr={DATA.pr}
                diff={diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                prKey="fixture-medium"
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
                {...(route ? { routeSnapshot: readySnapshot() } : {})}
                onJumpToStop={() => {
                    // В галерее вкладки маршрута нет: переход некуда доводить.
                }}
            />
        </div>
    );
}

export const ROUTE_BADGE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'diff-route-badges',
        title: 'полный дифф с маршрутом: бейджи дерева, футер-нота, поля карточек',
        render: () => <MarginState />,
    },
    {
        id: 'diff-route-hatched',
        title: 'частично покрытый файл: штрихованные полосы непокрытых диапазонов',
        render: () => (
            <MarginState
                paths={[
                    'services/orders/src/payments/generated/psp-schema.ts',
                    '.github/CODEOWNERS',
                ]}
            />
        ),
    },
    {
        id: 'diff-route-none',
        title: 'полный дифф без маршрута: полей нет вовсе',
        render: () => <MarginState route={false} />,
    },
];
