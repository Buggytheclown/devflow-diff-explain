import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import { useMemo } from 'react';

import { useT } from '../../i18n/index.js';
import type { ReviewCompletion } from '../../components/review-action-bar.tsx';
import { ReviewComplete } from '../../components/review-complete.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { buildCoverageStrip } from '../../route/coverage-model.js';
import { buildRouteModel, stopSeenRanges } from '../../route/route-model.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { CoverageStrip } from '../../views/route/coverage-strip.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Состояния полосы покрытия и прогресса остановок. Всё считается из фикстуры `medium`
 * синхронно: числа полосы — те же 860 / 196 / 327 / 305 / 32, что в тестах модели.
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

function models(): Map<string, ReturnType<typeof parseFileDiff>> {
    return new Map(DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]));
}

function routeModel() {
    return buildRouteModel({ snapshot: readySnapshot(), files: DATA.diff.files, models: models() });
}

/** Полоса на числах фикстуры: тот же вход, что у вью маршрута. */
function StripState({ full = false, loading = false }: { full?: boolean; loading?: boolean }) {
    const t = useT();
    const model = useMemo(() => {
        const built = routeModel();
        const totals = full
            ? {
                  ...built.totals,
                  covered: built.totals.changed,
                  uncovered: 0,
                  // Непокрытое переехало в low: сумма тиров обязана сойтись со знаменателем.
                  byTier: {
                      ...built.totals.byTier,
                      low: built.totals.byTier.low + built.totals.byTier.other,
                      other: 0,
                  },
              }
            : built.totals;
        return buildCoverageStrip({ totals, entries: built.entries, t });
    }, [full, t]);

    return (
        <div className="gallery__viewport">
            <div style={{ padding: '30px', maxWidth: '1100px' }}>
                <CoverageStrip
                    model={loading ? null : model}
                    loading={loading ? { kind: 'plan', ready: 3, total: 7 } : null}
                    viewedStops={loading ? 0 : 3}
                    totalStops={7}
                />
            </div>
        </div>
    );
}

/**
 * Маршрут с частично просмотренными остановками: seen-диапазоны отмеченных стопов уже лежат
 * в прогрессе, поэтому в чипах видны и `read`, и `partial`.
 */
function ViewedRouteState({ stopIds, auto = false }: { stopIds: readonly string[]; auto?: boolean }) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all' } }), []);
    const parsed = useMemo(() => models(), []);
    const progress = useMemo<UiFileProgress[]>(() => {
        const built = buildRouteModel({ snapshot: readySnapshot(), files: DATA.diff.files, models: parsed });
        const byFile = new Map<string, UiFileProgress>();
        // Автоотметка живёт на переходе «не покрыто → покрыто» (baseline первого снимка её не
        // запускает), поэтому витрина `auto` оставляет последний файл остановки недочитанным:
        // отметь его «Просмотрено» — остановка отметится, свернётся и прокрутит к следующей.
        const skipped = new Set<string>();
        for (const entry of built.entries) {
            if (!stopIds.includes(entry.view.stop.id)) {
                continue;
            }
            const lastFile = entry.kind === 'stop' ? entry.view.files.at(-1) : undefined;
            if (auto && lastFile !== undefined) {
                skipped.add(lastFile.fileId);
            }
            for (const range of stopSeenRanges(entry)) {
                if (skipped.has(range.fileId)) {
                    continue;
                }
                const record = byFile.get(range.fileId) ?? { fileId: range.fileId, viewed: null, seenRanges: [] };
                byFile.set(range.fileId, {
                    ...record,
                    seenRanges: [...record.seenRanges, { side: range.side, start: range.start, end: range.end }],
                });
            }
        }
        return [...byFile.values()];
    }, [auto, parsed, stopIds]);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files, progress });
        for (const [fileId, model] of parsed) {
            created.setModel(fileId, model);
        }
        return created;
    }, [parsed, progress]);
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
                initialStopViewed={auto ? [] : stopIds}
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

const ROUTE_COMPLETION: ReviewCompletion = {
    verdict: 'ship',
    prId: DATA.pr.id,
    headCommit: DATA.diff.headCommit,
    hostName: 'FixtureHost',
    reviewHost: 'fixture',
    publishedComments: 2,
    publishedReplies: 1,
    progress: { filesSeen: 18, filesTotal: 18, linesSeen: 862, linesTotal: 862, percentSeen: 100 },
    // Строки прогресса — счётчики патча (862), непокрытое маршрутом — статистика покрытия (32).
    route: { stopsTotal: 7, stopsViewed: 7, otherViewed: true, uncoveredLines: 32 },
    openThreads: 0,
    firstOpenThreadId: null,
};

export const ROUTE_COVERAGE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'coverage-strip-ready',
        title: 'полоса покрытия: 860 строк, тиры 196/327/305, непокрыто 32',
        render: () => <StripState />,
    },
    {
        id: 'coverage-strip-full',
        title: 'полоса покрытия: 100% объяснено (штриховки и третьей клаузы нет)',
        render: () => <StripState full />,
    },
    {
        id: 'coverage-strip-loading',
        title: 'полоса покрытия: маршрут генерится — «покрытие известно после плана»',
        render: () => <StripState loading />,
    },
    {
        id: 'route-partially-viewed',
        title: 'маршрут: две остановки просмотрены, в чипах появились партиалы',
        render: () => <ViewedRouteState stopIds={['s01', 's03']} />,
    },
    {
        id: 'route-auto-viewed',
        title: 'маршрут: последний файл остановки не дочитан — отметка файла автоматически свернёт её',
        render: () => <ViewedRouteState stopIds={['s01']} auto />,
    },
    {
        id: 'review-complete-route',
        title: 'Review complete со строками маршрута',
        render: () => (
            <div className="gallery__viewport">
                <ReviewComplete
                    completion={ROUTE_COMPLETION}
                    onOpenThread={() => undefined}
                    onOpenFullDiff={() => undefined}
                />
            </div>
        ),
    },
];
