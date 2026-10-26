import type { PrDiff, PrMeta, Thread, UiReviewLensesResponse, UiRouteState } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useState, useSyncExternalStore } from 'react';

import { CommandBox } from '../components/command-box.tsx';
import { PrHeader, prHeaderCounts } from '../components/pr-header.tsx';
import { reconnectCommand } from '../components/reconnect-command.js';
import { buildFileFilters, findFilter, PCI_FILTER_ID } from '../filters/lens-filters.js';
import { shortCommit, useFormat, useLocale, useT } from '../i18n/index.js';
import type { SnapshotMenu } from '../iterations/snapshot-picker.tsx';
import { SnapshotsCard } from '../iterations/snapshot-picker.tsx';
import type { SessionStore } from '../session/session-store.js';
import type { ComposerTransport } from '../threads/composer.js';
import { createComposerTransport } from '../threads/transport.js';
import { persistentThreadStore } from '../threads/persistent-store.js';
import { createThreadStore } from '../threads/store.js';
import type { ThreadStore } from '../threads/store.js';
import type { StopLink } from '../markdown/markdown.tsx';
import { StopMarkdown } from '../markdown/markdown.tsx';
import { provenanceLine } from '../route/generation.js';
import type { OtherStopFacts } from '../route/other-stop.js';
import type { ViewId } from '../session/views.js';
import type { OwnershipKind, OwnershipSegment } from './overview-model.js';
import { ownershipSummary } from './overview-model.js';
import { OverviewDiscussion } from './overview-discussion.tsx';
import { GenerationCard } from './route/generation-card.tsx';
import './view-frames.css';

/**
 * Что Overview знает о генерации маршрута (docs/design/README.md §6–7, docs/design/SPEC-elements.md §3). Ручки приезжают из App:
 * вью их не зовёт сама, чтобы рисоваться в галерее без сервера.
 */
export interface RouteGenerationProps {
    readonly route: UiRouteState | null;
    /** Что известно о «Прочем» снапшота (`otherStopVisible`); без этого число остановок не называется. */
    readonly other?: OtherStopFacts;
    /** Задача идёт дольше минуты: строка «всё ещё работаю» с отменой (docs/design/SPEC-elements.md §3). */
    readonly longRunning?: boolean;
    readonly cancelling?: boolean;
    readonly retrying?: boolean;
    /** Провал самой ручки (сеть, сервер), а не генерации. */
    readonly actionError?: string | null;
    readonly onRetry?: () => void;
    readonly onCancel?: () => void;
}

export interface ViewFrameProps {
    readonly view: ViewId;
    readonly token?: string;
    readonly prKey: string;
    readonly session: SessionStore;
    /** Мета PR из снапшота; null — хоста нет или мета ещё не доехала: шапка тогда не рисуется. */
    readonly pr?: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly threads: readonly Thread[] | null;
    readonly reviewHostAvailable: boolean;
    readonly diffLoading?: boolean;
    readonly lensesLoading?: boolean;
    readonly threadsLoading?: boolean;
    readonly diffError?: string | null;
    readonly lensesError?: string | null;
    readonly threadsError?: string | null;
    readonly threadNow?: number;
    readonly threadStore?: ThreadStore;
    readonly generation?: RouteGenerationProps;
    /** Снапшоты и итерации для карточки Обзора (docs/design/README.md §6); без них карточки нет. */
    readonly picker?: Omit<SnapshotMenu, 'initialOpen'>;
    /** Правый край шапки PR: индикатор снапшота (docs/design/README.md §1). */
    readonly headerAside?: ReactNode;
    /**
     * Открыть модалку комментариев к PR из карточки обсуждения (docs/design/SPEC-additions-2026-08-26.md §1e п.5).
     * Аргумент — возврат фокуса на кнопку, откуда открыли.
     */
    readonly onWritePrComment?: (returnFocus: () => void) => void;
    /** Переход к остановке маршрута по ссылке `#stop-N` из summary. */
    readonly onJumpToStop?: (stopId: string) => void;
    /** Переход к файлу полного диффа по ссылке `#file-<path>` из summary. */
    readonly onOpenFile?: (fileId: string) => void;
}

/**
 * Вью без готового маршрута: приглашение (или объяснение малого PR) на вкладке Route
 * и Overview с генеративными состояниями Summary и карточки генерации.
 */
export function ViewFrame(props: ViewFrameProps) {
    if (props.view === 'route') {
        const openDiff = (): void => {
            props.session.setView('diff');
        };
        return props.generation?.route?.smallPr === true ? (
            <SmallPrRoute onReadDiff={openDiff} />
        ) : (
            <RouteInvitation prKey={props.prKey} onReadDiff={openDiff} />
        );
    }
    if (props.view === 'overview') {
        return <OverviewView {...props} />;
    }
    return <FullDiffFrame />;
}

function FullDiffFrame() {
    const t = useT();
    return (
        <main className="view-frame" id="view-diff">
            <h1 className="view-frame__title">{t('view.diff')}</h1>
        </main>
    );
}

export function RouteInvitation({ prKey, onReadDiff }: { prKey: string; onReadDiff: () => void }) {
    const t = useT();
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.route')}</div>
                <h1 className="invitation-card__title">{t('route.invitation.title')}</h1>
                <p className="invitation-card__text">{t('route.invitation.text')}</p>
                <CommandBox
                    command={reconnectCommand(prKey)}
                    hint={t('command.hint')}
                    actionLabel={t('command.copy')}
                />
                <button type="button" className="ctl ctl--primary invitation-card__primary" onClick={onReadDiff}>
                    {t('route.readFullDiff')}
                </button>
            </section>
        </main>
    );
}

/**
 * Выбрана итерация, для которой маршрута не строили: вкладка объясняет это и уводит
 * в читалку. Перестраивать маршрут отсюда нельзя — маршрут строится для активной итерации.
 */
export function IterationWithoutRoute({
    commit,
    slice = null,
    onReadDiff,
}: {
    commit: string | null;
    /** Вкладка смотрит срез между итерациями: маршрута для него не бывает вовсе. */
    slice?: { readonly baseCommit: string; readonly headCommit: string } | null;
    onReadDiff: () => void;
}) {
    const t = useT();
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.route')}</div>
                <h1 className="invitation-card__title">
                    {slice === null ? t('route.iteration.title') : t('route.slice.title')}
                </h1>
                <p className="invitation-card__text">
                    {slice !== null
                        ? t('route.slice.text')
                        : commit === null
                          ? t('route.iteration.text')
                          : t('route.iteration.textCommit', shortCommit(commit))}
                </p>
                <button type="button" className="ctl ctl--primary invitation-card__primary" onClick={onReadDiff}>
                    {slice === null ? t('route.readFullDiff') : t('route.toFullDiff')}
                </button>
            </section>
        </main>
    );
}

/**
 * Обзор в срезе между итерациями: зоны ответственности, треды и прогресс считаются
 * по `fileId` итерации, у среза они из другого пространства имён — и таких данных для него
 * не заказывают вовсе. Вместо карточек, которые соврали бы пустотой, — объяснение и выход.
 */
export function SliceWithoutOverview({
    slice,
    onReadDiff,
}: {
    slice: { readonly baseCommit: string; readonly headCommit: string };
    onReadDiff: () => void;
}) {
    const t = useT();
    return (
        <main className="route-empty" id="view-overview">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.overview')}</div>
                <h1 className="invitation-card__title">{t('overview.slice.title')}</h1>
                <p className="invitation-card__text">
                    {t('overview.slice.text', shortCommit(slice.baseCommit), shortCommit(slice.headCommit))}
                </p>
                <button type="button" className="ctl ctl--primary invitation-card__primary" onClick={onReadDiff}>
                    {t('route.toFullDiff')}
                </button>
            </section>
        </main>
    );
}

/**
 * PR ниже порога маршрута (docs/design/SPEC-elements.md §4.1): таб остаётся кликабельным и объясняет, почему маршрута
 * нет. Порог называется словами — его значение живёт в конфиге сервера и UI его не знает.
 */
export function SmallPrRoute({ onReadDiff }: { onReadDiff: () => void }) {
    const t = useT();
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.route')}</div>
                <h1 className="invitation-card__title">{t('route.smallPr.title')}</h1>
                <p className="invitation-card__text">{t('route.smallPr.text')}</p>
                <button type="button" className="ctl ctl--primary invitation-card__primary" onClick={onReadDiff}>
                    {t('route.readFullDiff')}
                </button>
            </section>
        </main>
    );
}

export function OverviewView({
    token,
    prKey,
    session,
    pr = null,
    diff,
    lenses,
    threads,
    reviewHostAvailable,
    diffLoading = false,
    lensesLoading = false,
    threadsLoading = false,
    diffError = null,
    lensesError = null,
    threadsError = null,
    threadNow,
    threadStore: suppliedThreadStore,
    generation,
    picker,
    headerAside,
    onWritePrComment,
    onJumpToStop,
    onOpenFile,
}: ViewFrameProps) {
    const t = useT();
    const [segment, setSegment] = useState<OwnershipSegment>('all');
    const sourceThreads = threads ?? EMPTY_THREADS;
    const fileIds = useMemo(() => new Set(diff?.files.map((file) => file.fileId) ?? []), [diff]);
    const localThreadStore = useMemo(() => createThreadStore(sourceThreads, fileIds), [fileIds, sourceThreads]);
    const persistentStore = useMemo(
        () =>
            diff === null
                ? localThreadStore
                : persistentThreadStore(prKey, diff.diffId, sourceThreads, fileIds),
        [diff, fileIds, localThreadStore, prKey, sourceThreads],
    );
    // В приложении App передаёт общий persistent-стор; Overview только подписывается на него.
    const threadStore = suppliedThreadStore ?? persistentStore;

    // Третьим аргументом — тот же снимок: сторы изоморфны, и вью рисуется статически в тестах.
    const threadSnapshot = useSyncExternalStore(
        threadStore.subscribe,
        threadStore.getSnapshot,
        threadStore.getSnapshot,
    );
    const transport = useMemo<ComposerTransport>(
        () => (token === undefined ? EMPTY_THREAD_TRANSPORT : createComposerTransport(token)),
        [token],
    );
    const [now] = useState(() => threadNow ?? Date.now());
    // Чип аудит-скоупа в шапке: тот же набор линз, что питает фильтры полного диффа.
    const pci = useMemo(
        () =>
            diff === null || lenses === null
                ? null
                : findFilter(
                      buildFileFilters({ files: diff.files, ownership: lenses.ownership, extra: lenses.extra, t }),
                      PCI_FILTER_ID,
                  ),
        [diff, lenses, t],
    );

    const openDiff = (): void => {
        session.setView('diff');
    };
    const openRoute = (): void => {
        session.setView('route');
    };
    const route = generation?.route ?? null;
    /** Ссылка из summary: номер плана и путь сводятся к id остановки и файла; ссылка в никуда молчит. */
    const openSummaryLink = (link: StopLink): void => {
        if (link.kind === 'stop') {
            const stop = route?.snapshot?.stops.find((candidate) => candidate.planIndex === link.planIndex);
            if (stop !== undefined) {
                onJumpToStop?.(stop.id);
            }
            return;
        }
        const file = diff?.files.find((candidate) => candidate.path === link.path);
        if (file !== undefined) {
            onOpenFile?.(file.fileId);
        }
    };

    // Пустой PR (docs/design/SPEC-elements.md §4.1): карточки Обзора соврали бы пустотой — зон, обсуждений и прогресса
    // здесь не по чему считать. Панель действий живёт уровнем выше, шип остаётся доступен.
    if (diff !== null && diff.files.length === 0) {
        return (
            <main className="route-empty" id="view-overview">
                <section className="invitation-card">
                    <div className="invitation-card__eyebrow">{t('view.overview')}</div>
                    <h1 className="invitation-card__title">{t('emptyPr.title')}</h1>
                    <p className="invitation-card__text">{t('emptyPr.text')}</p>
                </section>
            </main>
        );
    }

    return (
        <main className="overview" id="view-overview">
            {pr === null ? null : (
                <PrHeader
                    variant="overview"
                    pr={pr}
                    counts={diff === null ? null : prHeaderCounts(diff)}
                    pci={pci}
                    now={now}
                    {...(headerAside === undefined ? {} : { aside: headerAside })}
                />
            )}
            <div className="overview__grid">
                <div className="overview__main">
                    <SummaryCard prKey={prKey} route={route} onReadDiff={openDiff} onOpenLink={openSummaryLink} />
                    <OwnershipCard
                        diff={diff}
                        ownership={lenses?.ownership ?? null}
                        hostAvailable={reviewHostAvailable}
                        zoneSource={lenses?.ownershipSource ?? null}
                        diffLoading={diffLoading}
                        lensesLoading={lensesLoading}
                        diffError={diffError}
                        lensesError={lensesError}
                        segment={segment}
                        onSegment={setSegment}
                        onOpenDiff={openDiff}
                    />
                </div>
                <aside className="overview__rail">
                    {route === null ? null : (
                        <GenerationCard
                            route={route}
                            {...(generation?.other === undefined ? {} : { other: generation.other })}
                            diffFiles={diff?.files.length ?? null}
                            longRunning={generation?.longRunning ?? false}
                            cancelling={generation?.cancelling ?? false}
                            retrying={generation?.retrying ?? false}
                            actionError={generation?.actionError ?? null}
                            onOpenRoute={openRoute}
                            onOpenDiff={openDiff}
                            onRetry={generation?.onRetry ?? NOOP}
                            onCancel={generation?.onCancel ?? NOOP}
                        />
                    )}
                    <OverviewDiscussion
                        threads={reviewHostAvailable && threads !== null ? threadSnapshot.threads : null}
                        fileIds={fileIds}
                        session={session}
                        store={threadStore}
                        transport={transport}
                        now={now}
                        loading={reviewHostAvailable && threadsLoading}
                        error={threadsError}
                        commentIssues={pr?.capabilities.commentIssues ?? false}
                        onWritePrComment={onWritePrComment}
                    />
                    {picker === undefined ? null : (
                        <OverviewCard title={t('overview.snapshots')}>
                            <SnapshotsCard {...picker} />
                        </OverviewCard>
                    )}
                </aside>
            </div>
        </main>
    );
}

/**
 * Карточка «Кратко» (docs/design/README.md §6–7). Summary приезжает целиком со скелетом — токен-стриминга
 * в петле нет, поэтому каретки в фазе чтения нет, а есть скелетон-бары фиксированной
 * высоты: приземление текста не двигает раскладку (docs/design/SPEC-elements.md §3).
 * Текст написан словарём описания остановки и рисуется так же: абзацы, список, код, ссылки.
 */
function SummaryCard({
    prKey,
    route,
    onReadDiff,
    onOpenLink,
}: {
    prKey: string;
    route: UiRouteState | null;
    onReadDiff: () => void;
    onOpenLink: (link: StopLink) => void;
}) {
    const t = useT();
    const uiLocale = useLocale();
    const snapshot = route?.snapshot ?? null;
    if (snapshot !== null) {
        return (
            <OverviewCard title={t('overview.summary')}>
                <div className="overview-card__text md-blocks">
                    <StopMarkdown text={snapshot.summary} onOpenLink={onOpenLink} />
                </div>
                <p className="summary-card__provenance">{provenanceLine(snapshot, t, uiLocale)}</p>
            </OverviewCard>
        );
    }

    if (route?.phase === 'reading') {
        return (
            <OverviewCard title={t('overview.summary')}>
                <div className="summary-skeleton" role="status" aria-label={t('overview.summary.loading')}>
                    {SUMMARY_SKELETON.map((row, index) => (
                        <div key={`${row}-${String(index)}`} className={`summary-skeleton__line is-${row}`} />
                    ))}
                </div>
            </OverviewCard>
        );
    }

    if (route?.phase === 'failed') {
        return (
            <OverviewCard title={t('overview.summary')}>
                <p className="overview-card__lead">{t('overview.summary.failed.lead')}</p>
                <p className="overview-card__text">{t('overview.summary.failed.text')}</p>
            </OverviewCard>
        );
    }

    if (route?.smallPr === true) {
        return (
            <OverviewCard title={t('overview.summary')}>
                <p className="overview-card__lead">{t('overview.summary.smallPr.lead')}</p>
                <p className="overview-card__text">{t('overview.summary.smallPr.text')}</p>
                <button type="button" className="ctl ctl--primary invitation-card__primary" onClick={onReadDiff}>
                    {t('route.readFullDiff')}
                </button>
            </OverviewCard>
        );
    }

    return (
        <OverviewCard title={t('overview.summary')}>
            <p className="overview-card__lead">{t('overview.summary.noRoute.lead')}</p>
            <p className="overview-card__text">{t('overview.summary.noRoute.text')}</p>
            <CommandBox command={reconnectCommand(prKey)} hint={t('command.hint')} actionLabel={t('command.copy')} />
        </OverviewCard>
    );
}

/** Ширины скелетон-баров: последняя строка абзаца короче — иначе блок читается как таблица. */
const SUMMARY_SKELETON = ['wide', 'wide', 'wide', 'short', 'wide', 'wide', 'mid'] as const;

function OwnershipCard({
    diff,
    ownership,
    hostAvailable,
    zoneSource,
    diffLoading,
    lensesLoading,
    diffError,
    lensesError,
    segment,
    onSegment,
    onOpenDiff,
}: {
    diff: PrDiff | null;
    ownership: UiReviewLensesResponse['ownership'];
    hostAvailable: boolean;
    /** `UiReviewLensesResponse.ownershipSource`; null — линз нет. */
    zoneSource: string | null;
    diffLoading: boolean;
    lensesLoading: boolean;
    diffError: string | null;
    lensesError: string | null;
    segment: OwnershipSegment;
    onSegment: (segment: OwnershipSegment) => void;
    onOpenDiff: () => void;
}) {
    const t = useT();
    const format = useFormat();
    const files = diff?.files ?? EMPTY_FILES;
    const fallbackNote = hostAvailable
        ? (lensesError ?? t('overview.ownership.noZone'))
        : t('overview.ownership.noHost');
    const summary = ownershipSummary(files, ownership, segment, t, fallbackNote, zoneSource);

    const title = t('overview.ownership.title');
    const header =
        diff !== null && (ownership !== null || !lensesLoading) ? (
            <div className="ownership-card__toolbar">
                <div className="ownership-card__toolbar-row">
                    <h2 className="overview-card__title">{title}</h2>
                    <div className="ownership-card__header">
                        {summary.available && zoneSource !== null
                            ? t(
                                  'overview.ownership.stats',
                                  zoneSource,
                                  summary.mineFiles,
                                  summary.totalFiles,
                                  summary.mineLines,
                                  summary.totalLines,
                              )
                            : t('overview.ownership.statsUnavailable', zoneSource)}
                    </div>
                    <div className="ownership-card__toolbar-spacer" />
                    <div className="ownership-segments ctl-tabs" aria-label={t('overview.ownership.segments')}>
                        <button
                            type="button"
                            className={`ctl ctl--tab${segment === 'mine' ? ' is-active' : ''}`}
                            aria-pressed={segment === 'mine'}
                            disabled={!summary.available}
                            title={summary.available ? undefined : (summary.note ?? undefined)}
                            onClick={() => {
                                onSegment('mine');
                            }}
                        >
                            {t('overview.ownership.mine', summary.mineFiles)}
                        </button>
                        <button
                            type="button"
                            className={`ctl ctl--tab${segment === 'all' ? ' is-active' : ''}`}
                            aria-pressed={segment === 'all'}
                            onClick={() => {
                                onSegment('all');
                            }}
                        >
                            {t('overview.ownership.all', summary.totalFiles)}
                        </button>
                    </div>
                </div>
                {summary.note === null ? null : <div className="ownership-card__note">{summary.note}</div>}
            </div>
        ) : undefined;

    return (
        <OverviewCard title={title} header={header} className="ownership-card">
            {diff === null && diffLoading ? (
                <p className="overview-card__empty">{t('overview.diff.loading')}</p>
            ) : diff === null ? (
                <p className="overview-card__empty">{diffError ?? t('overview.diff.unavailable')}</p>
            ) : ownership === null && lensesLoading ? (
                <p className="overview-card__empty">{t('overview.ownership.loading')}</p>
            ) : (
                <div className="ownership-list">
                    {summary.groups.map((group) => (
                        <button
                            key={`${group.path}:${group.owner ?? ''}:${group.ownership ?? ''}`}
                            type="button"
                            className="ownership-row"
                            onClick={onOpenDiff}
                        >
                            <span className="ownership-row__main">
                                <span className="ownership-row__path">{group.path}</span>
                                {group.ownership === null ? null : (
                                    <OwnershipChip kind={group.ownership} owner={group.owner} />
                                )}
                                <span className="ownership-row__spacer" />
                                <span className="ownership-row__stats">
                                    {t('overview.ownership.rowStats', group.files, group.lines)}
                                </span>
                                <span className="ownership-row__add">+{format.count(group.additions)}</span>
                                <span className="ownership-row__del">−{format.count(group.deletions)}</span>
                            </span>
                            <span className="ownership-row__note">{group.note}</span>
                        </button>
                    ))}
                </div>
            )}
        </OverviewCard>
    );
}

function OwnershipChip({ kind, owner }: { kind: OwnershipKind; owner: string | null }) {
    const t = useT();
    // Владелец из a.yaml — имя зоны у хоста, оно не переводится и подставляется как есть.
    const label =
        kind === 'mine'
            ? owner === null
                ? t('overview.ownership.chip.mine')
                : t('overview.ownership.chip.mineOwner', owner)
            : kind === 'other'
              ? (owner ?? t('overview.ownership.chip.other'))
              : kind === 'generated'
                ? t('overview.ownership.chip.generated')
                : t('overview.ownership.chip.mixed');
    return <span className={`ownership-chip ownership-chip--${kind}`}>{label}</span>;
}

function OverviewCard({
    title,
    header,
    className = '',
    children,
}: {
    title: string;
    header?: ReactNode;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section className={`overview-card${className === '' ? '' : ` ${className}`}`}>
            {header ?? <h2 className="overview-card__title">{title}</h2>}
            {children}
        </section>
    );
}

const NOOP = (): void => undefined;
const EMPTY_FILES: PrDiff['files'] = [];
const EMPTY_THREADS: readonly Thread[] = [];
const GALLERY_WRITE = 'Sherpa gallery: writing drafts is not available';
const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error(GALLERY_WRITE)),
    update: () => Promise.reject(new Error(GALLERY_WRITE)),
    delete: () => Promise.reject(new Error(GALLERY_WRITE)),
};
