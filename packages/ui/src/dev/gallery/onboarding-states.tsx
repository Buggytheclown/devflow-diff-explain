import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, Thread, WorkerStatus } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ChatPanel } from '../../components/chat-panel.tsx';
import { ViewTabs } from '../../components/view-tabs.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { TourStepId } from '../../onboarding/index.js';
import { TourLayer, TourScaffold, tourSteps } from '../../onboarding/index.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteReadingView } from '../../views/route/route-generating.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import { RouteInvitation } from '../../views/view-frames.tsx';
import { FixtureReviewActionBar } from './review-completion-states.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Тур первого захода. Кадр состояния несёт настоящие цели `data-tour` — табы,
 * маршрут фикстуры `medium`, панель агента и панель действий, — поэтому кольцо и карточка
 * считаются от той же геометрии, что в приложении, и состояние детерминированно.
 *
 * Персиста и клавиатуры здесь нет: слой получает шаг пропсами, переходы пустые.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'gallery-worker',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-31T09:00:00.000Z',
    lastSeenAt: '2026-08-31T11:59:00.000Z',
};

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
}

function RouteUnderTour() {
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
    );
}

/** Панель агента — цель шага 06; в приложении её открывает сам шаг. */
function ChatUnderTour() {
    return (
        <ChatPanel
            worker={CONNECTED}
            tasks={[]}
            exchanges={[]}
            notes={[]}
            loading={false}
            error={null}
            reconnectCommand="/sherpa fixture-medium"
            anchor={null}
            focusRequest={0}
            scrollRequest={null}
            onScrollRequestHandled={NOOP}
            onClose={NOOP}
            onRemoveAnchor={NOOP}
            onAsk={() => Promise.reject(new Error('галерея не спрашивает агента'))}
            onCancel={() => Promise.resolve()}
            onRetry={() => Promise.resolve()}
            onNavigate={NOOP}
            onNavigateToNote={NOOP}
            now={GALLERY_NOW}
        />
    );
}

/**
 * Кадр состояния: табы вью и панель действий стоят всегда — они цели шагов 07 и 08,
 * а в приложении они на экране в любом шаге.
 */
function TourFrame({
    stepId,
    withChat = true,
    chatOpen = false,
    children,
}: {
    stepId: TourStepId;
    /** `false` — агент не подключён: шаг про чат выпал, счётчик стал `/ 07` (§5). */
    withChat?: boolean;
    chatOpen?: boolean;
    children: ReactNode;
}) {
    const steps = tourSteps(withChat);
    const index = steps.findIndex((step) => step.id === stepId);
    const step = steps[index];
    if (step === undefined) {
        throw new Error(`шага ${stepId} нет в этом проходе тура`);
    }

    return (
        <div className="gallery__viewport tour-gallery">
            <div className="tour-gallery__tabs">
                <ViewTabs view="route" onSelect={NOOP} />
            </div>
            <div className="tour-gallery__body">
                {children}
                {chatOpen ? <ChatUnderTour /> : null}
            </div>
            <FixtureReviewActionBar threads={NO_THREADS} />
            <TourLayer
                step={step}
                index={index}
                total={steps.length}
                epoch={`gallery:${stepId}`}
                onNext={NOOP}
                onBack={NOOP}
                onSkip={NOOP}
            />
        </div>
    );
}

const NOOP = (): void => undefined;
const NO_THREADS: readonly Thread[] = [];

export const ONBOARDING_STATES: readonly RouteGalleryState[] = [
    {
        id: 'tour-step-01-narrative',
        title: 'шаг 01: колонка повествования первой остановки',
        render: () => (
            <TourFrame stepId="narrative">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-02-fold',
        title: 'шаг 02: первая свёртка low-остановки',
        render: () => (
            <TourFrame stepId="fold">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-03-stopdiff',
        title: 'шаг 03: колонка диффа первой остановки',
        render: () => (
            <TourFrame stepId="stopdiff">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-04-progress',
        title: 'шаг 04: счётчик просмотренных остановок',
        render: () => (
            <TourFrame stepId="progress">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-05-presets',
        title: 'шаг 05: тумблер Триаж / Полный тур',
        render: () => (
            <TourFrame stepId="presets">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-06-chat',
        title: 'шаг 06: панель агента — единственный шаг, меняющий состояние',
        render: () => (
            <TourFrame stepId="chat" chatOpen>
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-07-fulldiff',
        title: 'шаг 07: таб «Полный дифф» (вью не переключается)',
        render: () => (
            <TourFrame stepId="fulldiff">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-08-ship',
        title: 'шаг 08: панель действий, primary — «Начать ревью»',
        render: () => (
            <TourFrame stepId="ship">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-offline-counter',
        title: 'без агента: шаг про чат выпал, счётчик / 07',
        render: () => (
            <TourFrame stepId="fulldiff" withChat={false}>
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-fallback-missing',
        title: 'цели шага нет в DOM: кольца нет, карточка по центру низа',
        render: () => (
            <TourFrame stepId="narrative">
                <RouteInvitation prKey="fixture-medium" onReadDiff={NOOP} />
            </TourFrame>
        ),
    },
    {
        id: 'tour-scaffold-reading',
        title: 'каркас тура поверх скелета генерации: шаг 01 на заглушке',
        render: () => (
            <TourFrame stepId="narrative">
                <RouteReadingView onOpenDiff={NOOP} />
                <TourScaffold />
            </TourFrame>
        ),
    },
    {
        id: 'tour-scaffold-progress',
        title: 'каркас поверх скелета: шаг 04 обводит полосу каркаса, а не полосу под ним',
        render: () => (
            <TourFrame stepId="progress">
                <RouteReadingView onOpenDiff={NOOP} />
                <TourScaffold />
            </TourFrame>
        ),
    },
    {
        id: 'tour-scaffold-invitation',
        title: 'каркас тура поверх приглашения: шаг 03 на колонке диффа заглушки',
        render: () => (
            <TourFrame stepId="stopdiff">
                <RouteInvitation prKey="fixture-medium" onReadDiff={NOOP} />
                <TourScaffold />
            </TourFrame>
        ),
    },
];
