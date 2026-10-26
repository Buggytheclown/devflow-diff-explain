import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, UiSnapshotSummary } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BANNER_PRIORITY, BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import { SnapshotPill } from '../../iterations/snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from '../../iterations/viewing.js';
import { pickerRows, VIEWING_CURRENT } from '../../iterations/viewing.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { ReadOnlyIterationBanner } from '../../views/route/iteration-banners.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import { ViewFrame } from '../../views/view-frames.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Пикер снапшотов и режим чтения прошлой итерации. Снапшотов у фикстуры один, поэтому
 * список и статусы собраны здесь поверх готового снапшота `medium`; форма — из контракта итераций.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

const OLD_COMMIT = '5c1d0aa8b7e6f4302d9c8b7a6f5e4d3c2b1a0999';
const GONE_COMMIT = 'b0d3f77a1c8e4562d0a9b8c7f6e5d4c3b2a10088';
const PR_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';
const PR_DIFF_ID = '182801';

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
}

const CURRENT = readySnapshot();

function summary(patch: Partial<UiSnapshotSummary>): UiSnapshotSummary {
    return {
        snapshotId: CURRENT.snapshotId,
        diffId: CURRENT.diffId,
        commit: CURRENT.commit,
        baseCommit: CURRENT.baseCommit,
        createdAt: CURRENT.createdAt,
        provenance: CURRENT.provenance,
        previousSnapshotId: null,
        status: 'current',
        ...patch,
    };
}

/** Ушедший коммит, прошлый снапшот и текущий — в порядке появления. */
const SNAPSHOTS: readonly UiSnapshotSummary[] = [
    summary({
        snapshotId: 'route-medium-b0d3f77',
        diffId: '182798',
        commit: GONE_COMMIT,
        createdAt: '2026-08-29T09:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'opus-5', locale: null },
        status: 'gone',
    }),
    summary({
        snapshotId: 'route-medium-5c1d0aa',
        diffId: '182799',
        commit: OLD_COMMIT,
        createdAt: '2026-08-31T06:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'opus-5', locale: null },
        status: 'stale',
    }),
    summary({ createdAt: '2026-08-31T11:00:00.000Z', previousSnapshotId: 'route-medium-5c1d0aa' }),
];

/** Активная итерация, на которой маршрута ещё нет (автор запушил, маршрут не перестраивали). */
const ITERATIONS: readonly Iteration[] = [
    {
        diffId: PR_DIFF_ID,
        baseCommit: CURRENT.baseCommit,
        headCommit: PR_COMMIT,
        createdAt: '2026-08-31T11:40:00.000Z',
        status: 'active',
    },
];

/** Последний снапшот построен до пуша, поэтому в меню он «устарел», как и в индикаторе. */
const ROWS = pickerRows({
    snapshots: SNAPSHOTS,
    iterations: ITERATIONS,
    activeIteration: { diffId: PR_DIFF_ID, commit: PR_COMMIT },
});

/** Маршрут построен на активной итерации: последний снапшот «текущий». */
const FRESH_ROWS = pickerRows({
    snapshots: SNAPSHOTS,
    iterations: [],
    activeIteration: { diffId: CURRENT.diffId, commit: CURRENT.commit },
});

/**
 * Локальное ревью: итерации помечены суффиксом к одному и тому же коммиту рабочего дерева,
 * и семь первых символов у всех совпадают — меню обязано различать их хвостом.
 */
const LOCAL_HEAD = '6630996aa1b2c3d4e5f60718293a4b5c6d7e8f90';
const LOCAL_ITERATIONS: readonly Iteration[] = [
    {
        diffId: 'local-1',
        baseCommit: CURRENT.baseCommit,
        headCommit: `${LOCAL_HEAD}+1a2b3c4d`,
        createdAt: '2026-08-31T06:00:00.000Z',
        status: 'gone',
    },
    {
        diffId: 'local-2',
        baseCommit: CURRENT.baseCommit,
        headCommit: `${LOCAL_HEAD}+5e6f7a8b`,
        createdAt: '2026-08-31T09:00:00.000Z',
        status: 'previous',
    },
    {
        diffId: 'local-3',
        baseCommit: CURRENT.baseCommit,
        headCommit: LOCAL_HEAD,
        createdAt: '2026-08-31T11:40:00.000Z',
        status: 'active',
    },
];

const LOCAL_ROWS = pickerRows({ snapshots: [], iterations: LOCAL_ITERATIONS, activeIteration: null });

function pill(label: ViewingLabel, viewing: Viewing, initialOpen = false, localHost = false) {
    return (
        <SnapshotPill
            label={label}
            localHost={localHost}
            menu={{ rows: ROWS, viewing, now: GALLERY_NOW, localHost, onSelect: () => undefined, initialOpen }}
        />
    );
}

/** Пикер локального ревью раскрытым: сюда смотрят на порядок строк и на короткие идентификаторы. */
function LocalPickerState() {
    return (
        <div className="gallery__viewport">
            <div className="pr-header">
                <SnapshotPill
                    label={{ kind: 'diff', commit: LOCAL_HEAD, status: 'noRoute' }}
                    localHost
                    menu={{
                        rows: LOCAL_ROWS,
                        viewing: VIEWING_CURRENT,
                        now: GALLERY_NOW,
                        localHost: true,
                        onSelect: () => undefined,
                        initialOpen: true,
                    }}
                />
            </div>
        </div>
    );
}

interface ReadingStateProps {
    readonly label: ViewingLabel;
    readonly viewing: Viewing;
    readonly createdAt: string | null;
    readonly gone?: boolean;
    /** Локальное ревью: у ушедшей итерации свои слова — PR здесь нет. */
    readonly localHost?: boolean;
    readonly menuOpen?: boolean;
    readonly readOnly?: boolean;
}

/** Вкладка маршрута под пикером: те же источники баннеров и та же лестница, что в App. */
function ReadingState({
    label,
    viewing,
    createdAt,
    gone = false,
    localHost = false,
    menuOpen = false,
    readOnly = true,
}: ReadingStateProps) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all', viewing } }), [viewing]);
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
    const banners: readonly BannerSource[] = [
        {
            id: 'read-only-iteration',
            priority: BANNER_PRIORITY.readOnlyIteration,
            active: () => readOnly,
            render: () => (
                <ReadOnlyIterationBanner
                    label={label}
                    createdAt={createdAt}
                    now={GALLERY_NOW}
                    gone={gone}
                    localHost={localHost}
                    onCurrent={() => undefined}
                />
            ),
        },
    ];

    return (
        <ReadOnlyIterationProvider readOnly={readOnly}>
            <div className="gallery__viewport">
                <BannerSlot sources={banners} />
                <RouteWorkspace
                    pr={DATA.pr}
                    diff={DATA.diff}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                    snapshot={CURRENT}
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    threadNow={GALLERY_NOW}
                    headerAside={pill(label, viewing, menuOpen, localHost)}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={(fileId) => {
                        const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                        return Promise.resolve(file === undefined ? null : fileContentOf(file));
                    }}
                    onSetViewed={() => Promise.resolve(0)}
                    onSetStopViewed={() => Promise.resolve(0)}
                    onSetStopFileViewed={() => Promise.resolve(0)}
                    onOpenThread={() => undefined}
                />
            </div>
        </ReadOnlyIterationProvider>
    );
}

/** Обзор с карточкой «Снапшоты» в правом рельсе (docs/design/README.md §6). */
function OverviewSnapshotsState() {
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
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                threads={DATA.threads}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                reviewHostAvailable
                picker={{ rows: FRESH_ROWS, viewing: VIEWING_CURRENT, now: GALLERY_NOW, onSelect: () => undefined }}
            />
        </div>
    );
}

const OLD_LABEL: ViewingLabel = { kind: 'snapshot', commit: OLD_COMMIT, status: 'stale' };
const GONE_LABEL: ViewingLabel = { kind: 'snapshot', commit: GONE_COMMIT, status: 'gone' };
/** Текущий снапшот, от которого ушла активная итерация: индикатор считает это по `route.stale`. */
const CURRENT_LABEL: ViewingLabel = { kind: 'snapshot', commit: CURRENT.commit, status: 'stale' };

export const ITERATION_SNAPSHOT_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-snapshot-picker',
        title: 'меню пикера: активная итерация без маршрута первой, дальше устаревшие снапшоты прошлых',
        render: () => (
            <ReadingState
                label={CURRENT_LABEL}
                viewing={VIEWING_CURRENT}
                createdAt={CURRENT.createdAt}
                menuOpen
                readOnly={false}
            />
        ),
    },
    {
        id: 'iterations-old-snapshot-readonly',
        title: 'прошлый снапшот: баннер чтения, выключенные отметки и композер',
        render: () => (
            <ReadingState
                label={OLD_LABEL}
                viewing={{ kind: 'snapshot', snapshotId: 'route-medium-5c1d0aa' }}
                createdAt="2026-08-31T06:00:00.000Z"
            />
        ),
    },
    {
        id: 'iterations-snapshot-gone-readonly',
        title: 'снапшот ушедшего коммита: «коммита больше нет в PR»',
        render: () => (
            <ReadingState
                label={GONE_LABEL}
                viewing={{ kind: 'snapshot', snapshotId: 'route-medium-b0d3f77' }}
                createdAt="2026-08-29T09:00:00.000Z"
                gone
            />
        ),
    },
    {
        id: 'iterations-snapshot-gone-readonly-local',
        title: 'локальное ревью, ушедшая итерация: «состояния дерева больше нет в истории»',
        render: () => (
            <ReadingState
                label={GONE_LABEL}
                viewing={{ kind: 'snapshot', snapshotId: 'route-medium-b0d3f77' }}
                createdAt="2026-08-29T09:00:00.000Z"
                gone
                localHost
            />
        ),
    },
    {
        id: 'iterations-overview-snapshots-card',
        title: 'Обзор: карточка «Снапшоты» с провенансом',
        render: () => <OverviewSnapshotsState />,
    },
    {
        id: 'iterations-picker-local-host',
        title: 'меню пикера локального ревью: одинаковые коммиты различаются хвостом',
        render: () => <LocalPickerState />,
    },
];
