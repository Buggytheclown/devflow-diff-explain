import { fixtureInterdiff, fixtureIteration } from '@sherpa/fixtures';
import type { Iteration, PrDiff } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BANNER_PRIORITY, BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider, SLICE_READ_ONLY_REASON } from '../../iterations/read-only.tsx';
import { SnapshotPill } from '../../iterations/snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from '../../iterations/viewing.js';
import { pickerRows } from '../../iterations/viewing.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace, FullDiffView } from '../../views/full-diff.tsx';
import { ReadOnlyIterationBanner } from '../../views/route/iteration-banners.tsx';
import { IterationWithoutRoute, SliceWithoutOverview } from '../../views/view-frames.tsx';
import type { RouteGalleryState } from './route-states.tsx';
import { withTreeOrder } from '../../tree/file-order.js';

/**
 * Срез между итерациями: «что нового» между двумя итерациями — без маршрута, без прогресса
 * и только на чтение. Данные — интердифф v1→v2 фикстуры `medium`, тот же, что отдаёт хост
 * на `getDiff({base, head})`.
 */

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);
const V3 = fixtureIteration('medium', 2);
const SLICE: PrDiff = withTreeOrder(fixtureInterdiff('medium', 0, 1));
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

const ITERATIONS: readonly Iteration[] = [
    { ...V1.iteration, status: 'previous' },
    { ...V2.iteration, status: 'active' },
];

const ROWS = pickerRows({
    snapshots: [],
    iterations: ITERATIONS,
    activeIteration: { diffId: V2.iteration.diffId, commit: V2.iteration.headCommit },
    interdiff: true,
});

const VIEWING: Viewing = { kind: 'slice', base: V1.iteration.diffId, head: V2.iteration.diffId };
const LABEL: ViewingLabel = {
    kind: 'slice',
    commit: V2.iteration.headCommit,
    baseCommit: V1.iteration.headCommit,
    status: 'slice',
};
const SLICE_COMMITS = { baseCommit: V1.iteration.headCommit, headCommit: V2.iteration.headCommit };

function pill(initialOpen = false) {
    return (
        <SnapshotPill
            label={LABEL}
            menu={{ rows: ROWS, viewing: VIEWING, now: GALLERY_NOW, onSelect: () => undefined, initialOpen }}
        />
    );
}

const THREE_ROWS = pickerRows({
    snapshots: [],
    iterations: [
        { ...V1.iteration, status: 'previous' },
        { ...V2.iteration, status: 'previous' },
        { ...V3.iteration, status: 'active' },
    ],
    activeIteration: { diffId: V3.iteration.diffId, commit: V3.iteration.headCommit },
    interdiff: true,
});

/** Срез v1 → v3 через одну итерацию: внутренность диапазона непустая. */
const WIDE_SLICE: Viewing = { kind: 'slice', base: V1.iteration.diffId, head: V3.iteration.diffId };

/** Строки THREE_ROWS сверху вниз: v3 (активная), v2, v1. */
const V3_ROW = 0;
const V1_ROW = 2;

/**
 * Меню посреди выбора среза: Shift+клик по v1 поставил первый край, вкладка смотрит активную.
 * Курсор на самом крае — отмечен только он; курсор на v3 — превью диапазона v1 → v3.
 */
function SliceEdgePickerState({ cursor }: { cursor: number }) {
    return (
        <div className="gallery__viewport">
            <div className="pr-header">
                <SnapshotPill
                    label={{ kind: 'diff', commit: V3.iteration.headCommit, status: 'noRoute' }}
                    menu={{
                        rows: THREE_ROWS,
                        viewing: { kind: 'diff', diffId: V3.iteration.diffId },
                        now: GALLERY_NOW,
                        onSelect: () => undefined,
                        initialOpen: true,
                        initialSliceEdge: V1.iteration.diffId,
                        initialCursor: cursor,
                    }}
                />
            </div>
        </div>
    );
}

/**
 * Раскрытое меню в срезе между итерациями через одну: сверху — «Сейчас: срез …», края отмечены
 * галкой и подписями «база» и «голова», промежуточная итерация — внутренность диапазона.
 */
function SlicePickerState() {
    return (
        <div className="gallery__viewport">
            <div className="pr-header">
                <SnapshotPill
                    label={{
                        kind: 'slice',
                        commit: V3.iteration.headCommit,
                        baseCommit: V1.iteration.headCommit,
                        status: 'slice',
                    }}
                    menu={{
                        rows: THREE_ROWS,
                        viewing: WIDE_SLICE,
                        now: GALLERY_NOW,
                        onSelect: () => undefined,
                        initialOpen: true,
                    }}
                />
            </div>
        </div>
    );
}

/** Full diff среза: индикатор «срез …», режим чтения с причиной среза, ни тредов, ни заметок. */
function SliceState() {
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all', viewing: VIEWING } }), []);
    const threadStore = useMemo(() => createThreadStore([], new Set(SLICE.files.map((file) => file.fileId))), []);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: SLICE.files });
        for (const file of SLICE.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, []);

    return (
        <ReadOnlyIterationProvider readOnly reason={SLICE_READ_ONLY_REASON}>
            <div className="gallery__viewport">
                <BannerSlot sources={READ_ONLY_BANNER} />
                <DiffWorkspace
                    pr={V2.pr}
                    diff={SLICE}
                    lenses={{ ownership: null, extra: [], ownershipSource: null }}
                    prKey="fixture-medium"
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    threadNow={GALLERY_NOW}
                    slice={SLICE_COMMITS}
                    headerAside={pill()}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={() => Promise.resolve(null)}
                    onSetViewed={() => Promise.resolve(0)}
                />
            </div>
        </ReadOnlyIterationProvider>
    );
}

const READ_ONLY_BANNER: readonly BannerSource[] = [
    {
        id: 'read-only-iteration',
        priority: BANNER_PRIORITY.readOnlyIteration,
        active: () => true,
        render: () => (
            <ReadOnlyIterationBanner
                label={LABEL}
                createdAt={V1.iteration.createdAt}
                now={GALLERY_NOW}
                gone={false}
                onCurrent={() => undefined}
            />
        ),
    },
];

/** Экраны Full diff, которые рисует сама вью: пустой срез и его загрузка. */
function SliceFrameState({ diff, skeleton = false }: { diff: PrDiff | null; skeleton?: boolean }) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all', viewing: VIEWING } }), []);
    return (
        <div className="gallery__viewport">
            <FullDiffView
                token="галерея"
                prKey="fixture-medium"
                session={session}
                pr={V2.pr}
                diff={diff}
                diffError={null}
                lenses={null}
                lensesError={null}
                progress={null}
                progressError={null}
                progressWriter={null}
                store={null}
                threadStore={null}
                agentConnected={false}
                onAskSelection={() => undefined}
                isSelectionPending={() => false}
                onSelectionAnchorChange={() => undefined}
                slice={SLICE_COMMITS}
                onActiveIteration={() => undefined}
                // Галерея не ждёт 200 мс: скелетон — предмет состояния.
                skeletonDelayMs={skeleton ? 0 : SKIP_SKELETON_MS}
                headerAside={pill()}
            />
        </div>
    );
}

/** Пустому срезу скелетон не нужен: до данных он не доходит. */
const SKIP_SKELETON_MS = 200;

export const ITERATION_SLICE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-slice',
        title: 'срез между итерациями: полный дифф v1 → v2, только чтение',
        render: () => <SliceState />,
    },
    {
        id: 'iterations-slice-picker',
        title: 'меню пикера в срезе: «Сейчас: срез …», края с подписями базы и головы, диапазон между ними',
        render: () => <SlicePickerState />,
    },
    {
        id: 'iterations-slice-picker-edge',
        title: 'выбор среза: Shift+клик поставил первый край, подсказка — выбрать вторую итерацию',
        render: () => <SliceEdgePickerState cursor={V1_ROW} />,
    },
    {
        id: 'iterations-slice-picker-preview',
        title: 'выбор среза: курсор на другой итерации — превью диапазона',
        render: () => <SliceEdgePickerState cursor={V3_ROW} />,
    },
    {
        id: 'iterations-slice-route',
        title: 'срез: вкладка «Маршрут» объясняет, почему маршрута нет',
        render: () => (
            <ReadOnlyIterationProvider readOnly reason={SLICE_READ_ONLY_REASON}>
                <div className="gallery__viewport">
                    <BannerSlot sources={READ_ONLY_BANNER} />
                    <IterationWithoutRoute
                        commit={V2.iteration.headCommit}
                        slice={SLICE_COMMITS}
                        onReadDiff={() => undefined}
                    />
                </div>
            </ReadOnlyIterationProvider>
        ),
    },
    {
        id: 'iterations-slice-overview',
        title: 'срез: вкладка «Обзор» объясняет, почему карточек нет',
        render: () => (
            <ReadOnlyIterationProvider readOnly reason={SLICE_READ_ONLY_REASON}>
                <div className="gallery__viewport">
                    <BannerSlot sources={READ_ONLY_BANNER} />
                    <SliceWithoutOverview slice={SLICE_COMMITS} onReadDiff={() => undefined} />
                </div>
            </ReadOnlyIterationProvider>
        ),
    },
    {
        id: 'iterations-slice-empty',
        title: 'срез без изменений: между итерациями ничего нет',
        render: () => <SliceFrameState diff={{ ...SLICE, files: [] }} />,
    },
    {
        id: 'iterations-slice-loading',
        title: 'срез считается: три карточки-скелетона и пометка про долгий ответ хоста',
        render: () => <SliceFrameState diff={null} skeleton />,
    },
];
