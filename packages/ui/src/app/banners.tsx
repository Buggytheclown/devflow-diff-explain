import type { AgentNote, RouteSnapshot, UiGenerationCap, UiRoutePhase, UiRouteState } from '@sherpa/protocol';

import { AuditScopeBanner } from '../components/audit-banner.tsx';
import type { BannerSource } from '../components/banner-slot.tsx';
import { BANNER_PRIORITY } from '../components/banner-slot.tsx';
import { generationCapBannerVisible, GenerationCapBanner } from '../components/generation-cap-banner.tsx';
import { RouteLocaleBanner } from '../components/route-locale-banner.tsx';
import type { ShipVerdictEvent } from '../components/ship-verdict-banner.tsx';
import { ShipVerdictBanner } from '../components/ship-verdict-banner.tsx';
import type { FileFilter, FilterStats } from '../filters/lens-filters.js';
import type { ResolvedViewing } from '../iterations/viewing.js';
import { VIEWING_CURRENT } from '../iterations/viewing.js';
import { snapshotLocale } from '../route/generation.js';
import type { SessionStore } from '../session/session-store.js';
import {
    NotesLostBanner,
    notesLostBannerVisible,
    notesLostKey,
    ReadOnlyIterationBanner,
    RouteSecondPassBanner,
    RouteStaleBanner,
    staleBannerVisible,
} from '../views/route/iteration-banners.tsx';
import {
    GenerationFailedBanner,
    RouteActionErrorBanner,
    RouteFillingBanner,
    RouteRegeneratingBanner,
} from '../views/route/generation-card.tsx';
import { RegenerateBanner } from '../views/route/other-card.tsx';
import type { ViewId } from '../session/views.js';

import { isLocalHost } from './review-state.js';

export interface BannerSourcesOptions {
    readonly view: ViewId;
    /** Имя адаптера (`uiState.reviewHost`): у локального ревью свои слова про устаревание. */
    readonly reviewHost: string | null;
    readonly session: SessionStore;
    readonly now: number;
    readonly readOnly: boolean;
    readonly resolved: ResolvedViewing;

    readonly route: UiRouteState | null;
    readonly routePhase: UiRoutePhase | null;
    readonly generating: boolean;
    readonly cancelling: boolean;
    readonly generateAvailable: boolean;
    readonly startGeneration: () => void;
    readonly cancelGeneration: () => void;
    readonly routeActionError: string | null;
    readonly actionErrorInPlace: boolean;
    readonly openIterationWithoutRoute: (diffId: string) => void;

    readonly routeSnapshot: RouteSnapshot | null;
    readonly routeChangedStops: number;
    readonly secondPassVisible: boolean;
    readonly onDismissSecondPass: (snapshotId: string) => void;
    readonly routeUnderExplained: boolean;

    readonly lostNoteIds: readonly number[];
    readonly firstLostNote: AgentNote | undefined;
    readonly dismissedNotesLost: string | null;
    readonly onDismissNotesLost: (key: string) => void;
    readonly openNoteInChat: (note: AgentNote) => void;

    readonly shipVerdict: ShipVerdictEvent | null;
    readonly shipVerdictNow: number;
    readonly onDismissShipVerdict: () => void;

    readonly generationCap: UiGenerationCap | null;

    readonly routeLocaleVisible: boolean;
    /** Почему «Перестроить» недоступно; `undefined` — доступно. */
    readonly routeLocaleRebuildBlocked: string | undefined;
    readonly onKeepRouteLocale: () => void;

    readonly auditVisible: boolean;
    readonly auditKey: string;
    readonly pci: FileFilter | null;
    readonly pciStats: FilterStats | null;
    readonly pciPaths: readonly string[];
    readonly showAllAuditFiles: () => void;
    readonly onDismissAudit: (key: string) => void;
}

/** Слот уведомлений: все описатели баннеров вкладки в одном месте, приоритеты — в `BANNER_PRIORITY`. */
export function buildBannerSources(options: BannerSourcesOptions): readonly BannerSource[] {
    const {
        view,
        reviewHost,
        session,
        now,
        readOnly,
        resolved,
        route,
        routePhase,
        generating,
        cancelling,
        generateAvailable,
        startGeneration,
        cancelGeneration,
        routeActionError,
        actionErrorInPlace,
        openIterationWithoutRoute,
        routeSnapshot,
        routeChangedStops,
        secondPassVisible,
        onDismissSecondPass,
        routeUnderExplained,
        lostNoteIds,
        firstLostNote,
        dismissedNotesLost,
        onDismissNotesLost,
        openNoteInChat,
        shipVerdict,
        shipVerdictNow,
        onDismissShipVerdict,
        generationCap,
        routeLocaleVisible,
        routeLocaleRebuildBlocked,
        onKeepRouteLocale,
        auditVisible,
        auditKey,
        pci,
        pciStats,
        pciPaths,
        showAllAuditFiles,
        onDismissAudit,
    } = options;

    return [
        {
            id: 'generation-failed',
            priority: BANNER_PRIORITY.generationFailed,
            // Без снапшота на вкладке маршрута та же причина стоит полноэкранной красной карточкой.
            active: () => routePhase === 'failed' && (view !== 'route' || route?.snapshot != null),
            render: () =>
                route?.failure == null ? null : (
                    <GenerationFailedBanner
                        message={route.failure.message}
                        rebuilding={route.snapshot !== null}
                        retrying={generating}
                        onRetry={startGeneration}
                    />
                ),
        },
        {
            id: 'route-action-error',
            priority: BANNER_PRIORITY.routeActionError,
            active: () => routeActionError !== null && !actionErrorInPlace,
            render: () =>
                routeActionError === null ? null : <RouteActionErrorBanner message={routeActionError} />,
        },
        {
            id: 'route-regenerating',
            priority: BANNER_PRIORITY.routeRegenerating,
            active: () => view === 'route' && routePhase === 'reading' && route?.snapshot != null,
            render: () => <RouteRegeneratingBanner cancelling={cancelling} onCancel={cancelGeneration} />,
        },
        {
            id: 'route-stale',
            priority: BANNER_PRIORITY.routeStale,
            active: () => staleBannerVisible(routePhase, route?.stale ?? null, route?.snapshot ?? null, readOnly),
            render: () =>
                route?.stale == null || route.snapshot == null ? null : (
                    <RouteStaleBanner
                        stale={route.stale}
                        stops={route.snapshot.stops}
                        localHost={isLocalHost(reviewHost)}
                        onRegenerate={startGeneration}
                        onOpenDiffWithoutRoute={openIterationWithoutRoute}
                    />
                ),
        },
        {
            id: 'read-only-iteration',
            priority: BANNER_PRIORITY.readOnlyIteration,
            active: () => readOnly && resolved.label !== null,
            render: () =>
                resolved.label === null ? null : (
                    <ReadOnlyIterationBanner
                        label={resolved.label}
                        createdAt={resolved.createdAt}
                        now={now}
                        gone={resolved.gone}
                        localHost={isLocalHost(reviewHost)}
                        onCurrent={() => {
                            session.setViewing(VIEWING_CURRENT);
                        }}
                    />
                ),
        },
        {
            id: 'route-second-pass',
            priority: BANNER_PRIORITY.routeSecondPass,
            active: () => secondPassVisible,
            render: () =>
                routeSnapshot === null ? null : (
                    <RouteSecondPassBanner
                        commit={routeSnapshot.commit}
                        carried={routeSnapshot.carried}
                        changedStops={routeChangedStops}
                        onShowNew={() => {
                            session.setRouteFilter('new');
                        }}
                        onDismiss={() => {
                            onDismissSecondPass(routeSnapshot.snapshotId);
                        }}
                    />
                ),
        },
        {
            id: 'route-under-explained',
            priority: BANNER_PRIORITY.routeUnderExplained,
            active: () => view === 'route' && routeUnderExplained,
            render: () => <RegenerateBanner {...(generateAvailable ? { onGenerate: startGeneration } : {})} />,
        },
        {
            id: 'route-filling',
            priority: BANNER_PRIORITY.routeFilling,
            active: () => view === 'route' && routePhase === 'filling' && route?.snapshot != null,
            render: () =>
                route?.snapshot == null ? null : (
                    <RouteFillingBanner
                        snapshot={route.snapshot}
                        onReadDiff={() => {
                            session.setView('diff');
                        }}
                    />
                ),
        },
        {
            id: 'notes-lost',
            priority: BANNER_PRIORITY.notesLost,
            active: () => notesLostBannerVisible(routePhase, lostNoteIds, dismissedNotesLost, readOnly),
            render: () =>
                firstLostNote === undefined ? null : (
                    <NotesLostBanner
                        count={lostNoteIds.length}
                        onShow={() => {
                            openNoteInChat(firstLostNote);
                        }}
                        onDismiss={() => {
                            onDismissNotesLost(notesLostKey(lostNoteIds));
                        }}
                    />
                ),
        },
        {
            id: 'ship-verdict',
            priority: BANNER_PRIORITY.shipVerdict,
            active: () => shipVerdict !== null,
            render: () =>
                shipVerdict === null ? null : (
                    <ShipVerdictBanner
                        event={shipVerdict}
                        now={shipVerdictNow}
                        onDismiss={onDismissShipVerdict}
                    />
                ),
        },
        {
            id: 'generation-cap',
            priority: BANNER_PRIORITY.generationCap,
            active: () => generationCapBannerVisible(generationCap),
            render: () => (generationCap === null ? null : <GenerationCapBanner cap={generationCap} />),
        },
        {
            id: 'route-locale-mismatch',
            priority: BANNER_PRIORITY.routeLocaleMismatch,
            active: () => routeLocaleVisible,
            render: () =>
                route?.snapshot == null ? null : (
                    <RouteLocaleBanner
                        routeLocale={snapshotLocale(route.snapshot.provenance)}
                        {...(routeLocaleRebuildBlocked === undefined
                            ? {}
                            : { rebuildDisabledReason: routeLocaleRebuildBlocked })}
                        onRebuild={startGeneration}
                        onKeep={onKeepRouteLocale}
                    />
                ),
        },
        {
            id: 'audit-scope',
            priority: BANNER_PRIORITY.auditScope,
            active: () => auditVisible && pci !== null && pciStats !== null,
            render: () =>
                pci === null || pciStats === null ? null : (
                    <AuditScopeBanner
                        filter={pci}
                        stats={pciStats}
                        paths={pciPaths}
                        onShowAll={showAllAuditFiles}
                        onDismiss={() => {
                            onDismissAudit(auditKey);
                        }}
                    />
                ),
        },
    ];
}
