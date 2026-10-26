import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { OtherStopFacts } from '../../route/other-stop.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import {
    GenerationFailedBanner,
    RouteActionErrorBanner,
    RouteFillingBanner,
} from '../../views/route/generation-card.tsx';
import { RouteFailedView, RouteReadingView } from '../../views/route/route-generating.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import { ViewFrame } from '../../views/view-frames.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Генеративные состояния: Overview фаз A/B, частично заполненный маршрут, провал
 * генерации и малый PR. Данные — состояния `routeFixtures('medium').states` и `('small')`;
 * ручек нет, часы фиксированы — открытие состояния даёт один и тот же кадр.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

function routeState(
    name: 'medium' | 'small',
    phase: 'reading' | 'filling' | 'failed' | 'none' | 'ready',
): UiRouteState {
    const state = routeFixtures(name)?.states[phase] ?? null;
    if (state === null) {
        throw new Error(`фикстуре ${name} нужно состояние маршрута ${phase}`);
    }
    return state;
}

/** Непокрытое фикстуры `medium` по готовому маршруту: в приложении его считает App фоновым разбором. */
const MEDIUM_UNCOVERED: OtherStopFacts = { uncovered: 38, conflictFiles: 0 };

function OverviewState({
    route,
    longRunning = false,
    other,
}: {
    route: UiRouteState;
    longRunning?: boolean;
    other?: OtherStopFacts;
}) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'overview', filter: 'all' } }), []);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <div className="gallery__viewport">
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={session}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                threads={DATA.threads}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                reviewHostAvailable
                generation={other === undefined ? { route, longRunning } : { route, longRunning, other }}
            />
        </div>
    );
}

function RouteFillingState({ agentStopped = false }: { agentStopped?: boolean }) {
    const snapshot = routeState('medium', 'filling').snapshot;
    if (snapshot === null) {
        throw new Error('фикстурному состоянию filling нужен частичный снапшот');
    }
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
    const banners = useMemo<BannerSource[]>(
        () => [
            {
                id: 'route-filling',
                priority: 150,
                active: () => true,
                render: () => <RouteFillingBanner snapshot={snapshot} onReadDiff={NOOP} />,
            },
        ],
        [snapshot],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                snapshot={snapshot}
                agentStopped={agentStopped}
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

/** Малый PR: та же фикстура `small`, но целиком — от ноты в шапке до пустого таба маршрута. */
function SmallPrDiffState() {
    const data = useMemo(() => fixtureIteration('small'), []);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: data.diff.files });
        for (const file of data.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [data.diff.files]);
    const threadStore = useMemo(
        () => createThreadStore([], new Set(data.diff.files.map((file) => file.fileId))),
        [data.diff.files],
    );

    return (
        <div className="gallery__viewport">
            <DiffWorkspace
                pr={data.pr}
                diff={data.diff}
                threadStore={threadStore}
                lenses={{ ownership: data.ownership, extra: data.extraLenses, ownershipSource: 'CODEOWNERS' }}
                prKey="fixture-small"
                session={session}
                store={store}
                threadNow={GALLERY_NOW}
                smallPr
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = data.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

function SmallPrRouteState() {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all' } }), []);

    return (
        <div className="gallery__viewport">
            <ViewFrame
                view="route"
                prKey="fixture-small"
                session={session}
                diff={null}
                lenses={null}
                threads={null}
                reviewHostAvailable
                generation={{ route: routeState('small', 'none') }}
            />
        </div>
    );
}

function FailedBannerState() {
    const route = routeState('medium', 'failed');
    const banners = useMemo<BannerSource[]>(
        () => [
            {
                id: 'generation-failed',
                priority: 400,
                active: () => true,
                render: () =>
                    route.failure === null ? null : (
                        <GenerationFailedBanner message={route.failure.message} onRetry={NOOP} />
                    ),
            },
        ],
        [route.failure],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
        </div>
    );
}

/** Ручка не отработала там, где карточки под причину нет: «Построить маршрут» из палитры. */
function ActionErrorBannerState() {
    const banners = useMemo<BannerSource[]>(
        () => [
            {
                id: 'route-action-error',
                priority: 350,
                active: () => true,
                render: () => (
                    <RouteActionErrorBanner message="У этого PR нет хост-адаптера: маршрут строить не по чему." />
                ),
            },
        ],
        [],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
        </div>
    );
}

function FailedRouteState() {
    const failure = routeState('medium', 'failed').failure;
    if (failure === null) {
        throw new Error('фикстурному состоянию failed нужна причина провала');
    }
    return (
        <div className="gallery__viewport">
            {/* Сырой вывод раскрыт: кадр галереи обязан показывать и моно-блок. */}
            <RouteFailedView failure={failure} initialRawShown onRetry={NOOP} onOpenDiff={NOOP} />
        </div>
    );
}

const NOOP = (): void => undefined;

export const ROUTE_GENERATION_STATES: readonly RouteGalleryState[] = [
    {
        id: 'overview-reading',
        title: 'Overview фаза A: скелетон Summary, спиннер, три строки прогресса',
        render: () => <OverviewState route={routeState('medium', 'reading')} />,
    },
    {
        id: 'overview-reading-long',
        title: 'Overview фаза A дольше минуты: «всё ещё работаю» с отменой',
        render: () => <OverviewState route={routeState('medium', 'reading')} longRunning />,
    },
    {
        id: 'overview-filling',
        title: 'Overview фаза B: сегмент-бар, план-лист, счётчик от снапшота',
        render: () => <OverviewState route={routeState('medium', 'filling')} />,
    },
    {
        id: 'overview-ready',
        title: 'Overview: маршрут готов — список остановок и «Открыть маршрут»',
        render: () => <OverviewState route={routeState('medium', 'ready')} other={MEDIUM_UNCOVERED} />,
    },
    {
        id: 'overview-ready-all-placed',
        title: 'Overview: маршрут готов, модель разместила все строки — «Прочего» нет',
        render: () => <OverviewState route={routeState('medium', 'ready')} other={{ uncovered: 0, conflictFiles: 0 }} />,
    },
    {
        id: 'overview-ready-counting',
        title: 'Overview: маршрут готов, дифф ещё разбирается — число остановок не названо, «Прочего» пока нет',
        render: () => <OverviewState route={routeState('medium', 'ready')} other={{ uncovered: null, conflictFiles: 0 }} />,
    },
    {
        id: 'overview-failed',
        title: 'Overview: компактная красная карточка провала',
        render: () => <OverviewState route={routeState('medium', 'failed')} />,
    },
    {
        id: 'route-reading',
        title: 'Маршрут в фазе чтения: три безномерных плейсхолдера «— / ?»',
        render: () => <RouteReadingView onOpenDiff={NOOP} />,
    },
    {
        id: 'route-filling',
        title: 'Маршрут частично заполнен: скелетоны в слотах плана + баннер',
        render: () => <RouteFillingState />,
    },
    {
        id: 'route-agent-died',
        title: 'Агент умер посреди генерации: заполненное помечено',
        render: () => <RouteFillingState agentStopped />,
    },
    {
        id: 'route-failed',
        title: 'Generation failed: причина, повтор и сырой вывод',
        render: () => <FailedRouteState />,
    },
    {
        id: 'banner-generation-failed',
        title: 'Баннер провала генерации (вне вкладки маршрута)',
        render: () => <FailedBannerState />,
    },
    {
        id: 'banner-route-action-error',
        title: 'Ручка генерации не отработала: причина в слоте баннеров',
        render: () => <ActionErrorBannerState />,
    },
    {
        id: 'route-small',
        title: 'Малый PR: объяснение на вкладке маршрута',
        render: () => <SmallPrRouteState />,
    },
    {
        id: 'diff-small-note',
        title: 'Малый PR: тихая нота в шапке полного диффа',
        render: () => <SmallPrDiffState />,
    },
];
