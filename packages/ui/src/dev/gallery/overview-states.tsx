import { fixtureIteration } from '@sherpa/fixtures';
import type { Lens, PrMeta, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { useT } from '../../i18n/index.js';
import { agentPillView } from '../../components/agent-pill-view.js';
import { AuditScopeBanner } from '../../components/audit-banner.tsx';
import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { AgentPill } from '../../components/top-bar.tsx';
import { buildFileFilters, filterFiles, filterStats, findFilter, PCI_FILTER_ID } from '../../filters/lens-filters.js';
import { createSessionStore } from '../../session/session-store.js';
import { RouteActionErrorBanner } from '../../views/route/generation-card.tsx';
import { ViewFrame } from '../../views/view-frames.tsx';

const DATA = fixtureIteration('medium');
const PR_KEY = 'fixture-medium';
const DISCONNECTED = {
    kind: 'disconnected',
    workerId: 'w-fixture',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-24T10:30:00.000Z',
    lastSeenAt: '2026-08-24T11:59:00.000Z',
} as const;

const UNAVAILABLE_OWNERSHIP: Lens = {
    ...(DATA.ownership ?? {
        id: 'mine',
        label: 'My files',
        paths: [],
        zones: null,
    }),
    available: false,
    paths: [],
    note: 'Не удалось определить вашу зону по CODEOWNERS.',
    zones: DATA.ownership?.zones?.map((zone) => ({ ...zone, mine: false })) ?? null,
};

const PREFIX_FALLBACK_OWNERSHIP: Lens | null =
    DATA.ownership === null ? null : { ...DATA.ownership, zones: null };

export interface OverviewGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const OVERVIEW_STATES: readonly OverviewGalleryState[] = [
    {
        id: 'route-no-route',
        group: 'Overview и Route',
        title: 'Route: маршрута ещё нет',
        render: () => <ViewState view="route" />,
    },
    {
        id: 'overview-ownership',
        group: 'Overview и Route',
        title: 'Overview: ownership доступен',
        render: () => <ViewState view="overview" />,
    },
    {
        id: 'overview-ownership-unavailable',
        group: 'Overview и Route',
        title: 'Overview: зона недоступна',
        render: () => (
            <ViewState view="overview" lenses={{ ownership: UNAVAILABLE_OWNERSHIP, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }} />
        ),
    },
    {
        id: 'overview-ownership-prefix-fallback',
        group: 'Overview и Route',
        title: 'Overview: без зон — запасной разбор по префиксу',
        render: () => (
            <ViewState
                view="overview"
                lenses={{ ownership: PREFIX_FALLBACK_OWNERSHIP, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
            />
        ),
    },
    {
        id: 'overview-checks-failed',
        group: 'Overview и Route',
        title: 'Overview: проверки провалены',
        render: () => <ViewState view="overview" pr={{ ...DATA.pr, checks: 'failed' }} />,
    },
    {
        id: 'overview-checks-pending',
        group: 'Overview и Route',
        title: 'Overview: проверки идут',
        render: () => <ViewState view="overview" pr={{ ...DATA.pr, checks: 'pending' }} />,
    },
    {
        id: 'overview-checks-unknown',
        group: 'Overview и Route',
        title: 'Overview: статус проверок неизвестен',
        render: () => <ViewState view="overview" pr={{ ...DATA.pr, checks: null }} />,
    },
    {
        id: 'overview-pr-meta-pending',
        group: 'Overview и Route',
        title: 'Overview: мета PR ещё не доехала',
        render: () => <ViewState view="overview" pr={null} />,
    },
    {
        id: 'banner-two-notices',
        group: 'Баннеры',
        title: 'два баннера и «+1 уведомление»',
        render: () => <BannerState />,
    },
    {
        id: 'agent-reconnect-popover',
        group: 'Индикатор агента',
        title: 'reconnect-поповер',
        render: () => <AgentReconnectState />,
    },
];

function ViewState({
    view,
    lenses = { ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' },
    pr = DATA.pr,
}: {
    view: 'overview' | 'route';
    lenses?: UiReviewLensesResponse;
    pr?: PrMeta | null;
}) {
    const session = useMemo(() => createSessionStore({ initial: { view, filter: 'all' } }), [view]);
    return (
        <div className="gallery__viewport">
            <ViewFrame
                view={view}
                prKey={PR_KEY}
                session={session}
                pr={pr}
                diff={DATA.diff}
                lenses={lenses}
                threads={DATA.threads}
                reviewHostAvailable
                // Тот же фиксированный «сейчас» держит детерминированным и относительное
                // время в шапке PR, и время комментариев.
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            />
        </div>
    );
}

/** Слот с двумя активными источниками: наверху провал действия, аудит-скоуп — под «+1». */
function AgentReconnectState() {
    const t = useT();
    return (
        <div className="gallery__viewport gallery-agent-popover">
            <AgentPill
                view={agentPillView(DISCONNECTED, [], t)}
                reconnectCommand={reconnectCommand(PR_KEY)}
                defaultOpen
            />
        </div>
    );
}

function BannerState() {
    const t = useT();
    const filters = buildFileFilters({
        files: DATA.diff.files,
        ownership: DATA.ownership,
        extra: DATA.extraLenses,
        t,
    });
    const pci = findFilter(filters, PCI_FILTER_ID);
    if (pci === null) {
        return null;
    }
    const stats = filterStats(DATA.diff.files, pci);
    const paths = filterFiles(DATA.diff.files, pci).map((file) => file.path);
    const sources: readonly BannerSource[] = [
        {
            id: 'route-action-error',
            priority: 350,
            active: () => true,
            render: () => (
                <RouteActionErrorBanner message="У этого PR нет хост-адаптера: маршрут строить не по чему." />
            ),
        },
        {
            id: 'audit-scope',
            priority: 100,
            active: () => true,
            render: () => (
                <AuditScopeBanner
                    filter={pci}
                    stats={stats}
                    paths={paths}
                    onShowAll={() => undefined}
                    onDismiss={() => undefined}
                />
            ),
        },
    ];
    return (
        <div className="gallery__viewport">
            <BannerSlot sources={sources} />
        </div>
    );
}
