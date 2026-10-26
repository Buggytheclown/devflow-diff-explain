import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Поведенческий дайджест тестов на стопе s04 фикстуры: 12 принятых утверждений,
 * два отброшенных валидатором, два `uncovered` в футере. Тест-код спрятан по умолчанию;
 * состояние тогла приезжает сессией, поэтому кадр детерминированный.
 *
 * Маршрут рисуется целиком, а не одной карточкой: числа полосы покрытия и «Прочего» обязаны
 * сходиться с фикстурой, а урезанный снапшот показал бы 20% объяснённого.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');
/** Дайджест-остановка фикстуры; тур и триаж на неё не влияют. */
const DIGEST_STOP = 's04';

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
}

/** Производное состояние: утверждения s04 ведут в s01, файлы самой дайджест-остановки прежние. */
function digestOutsideStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    const target = snapshot.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (target === undefined) {
        throw new Error('у остановки s01 нужен якорь для производного снапшота');
    }
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id !== DIGEST_STOP
                ? stop
                : {
                      ...stop,
                      tests: stop.tests.map((claim) =>
                          claim.kind === 'uncovered'
                              ? claim
                              : {
                                    ...claim,
                                    anchor: { fileId: target.fileId, path: target.path, line: target.start },
                                },
                      ),
                  },
        ),
    };
}

function DigestState({
    snapshot = readySnapshot(),
    stops = EMPTY_STOPS,
    viewed = false,
}: {
    snapshot?: RouteSnapshot;
    stops?: StopsState;
    viewed?: boolean;
}) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter: 'all', stops } }),
        [stops],
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
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                initialStopViewed={viewed ? [DIGEST_STOP] : []}
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

export const ROUTE_DIGEST_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-digest-hidden',
        title: 'дайджест тестов: 12 утверждений, тест-код скрыт, 2 отброшено',
        render: () => <DigestState />,
    },
    {
        id: 'route-digest-shown',
        title: 'дайджест: тест-код раскрыт настоящими карточками файлов',
        render: () => <DigestState stops={{ ...EMPTY_STOPS, testCode: new Set([DIGEST_STOP]) }} />,
    },
    {
        id: 'route-digest-viewed',
        title: 'дайджест просмотрен: свёртка в строку-сводку с утверждениями',
        render: () => <DigestState viewed />,
    },
    {
        id: 'route-digest-outside-stop',
        title: 'дайджест: прятать нечего — строка-ссылка вместо кнопки',
        render: () => <DigestState snapshot={digestOutsideStopSnapshot()} />,
    },
];
