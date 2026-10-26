import type { Verdict } from '@sherpa/protocol';

import { draftDestinationOf } from '../app/review-state.js';
import type { Translate } from '../i18n/index.js';
import { shortCommit, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { ReviewCompletion } from './review-action-bar.tsx';
import { unreachableVerdict } from './review-action-model.js';
import './review-complete.css';

export interface ReviewCompleteProps {
    readonly completion: ReviewCompletion;
    readonly onOpenThread: (threadId: string) => void;
    readonly onOpenFullDiff: () => void;
}

/** Сессионный итог публикации: не персистится и исчезает при следующей навигации. */
export function ReviewComplete({ completion, onOpenThread, onOpenFullDiff }: ReviewCompleteProps) {
    const t = useT();
    const commit = shortCommit(completion.headCommit);
    const replies = completion.publishedReplies;
    return (
        <main className="review-complete">
            <section className="review-complete__card" aria-labelledby="review-complete-title">
                <header className="review-complete__header">
                    <span className="review-complete__check" aria-hidden="true">
                        <Icon name="check" size={14} />
                    </span>
                    <h1 id="review-complete-title">
                        {verdictTitle(completion.verdict, t)} · PR {completion.prId}
                    </h1>
                    <span className="review-complete__provenance">
                        {verdictProvenance(completion.verdict, commit, t)}
                    </span>
                </header>

                <div className="review-complete__delivery">
                    <span>{t('complete.batch', completion.publishedComments)}</span>
                    <span>{deliveryText(completion, t)}</span>
                </div>

                <dl className="review-complete__counters">
                    {completion.route === null ? (
                        <Counter
                            label={t('complete.filesSeen')}
                            value={t(
                                'complete.filesSeen.value',
                                completion.progress.filesSeen,
                                completion.progress.filesTotal,
                            )}
                        />
                    ) : (
                        <Counter label={t('complete.stopsViewed')} value={stopsValue(completion.route, t)} />
                    )}
                    <Counter
                        label={t('complete.diffSeen')}
                        value={t(
                            'complete.diffSeen.value',
                            completion.progress.percentSeen,
                            completion.progress.linesTotal,
                        )}
                    />
                    {/*
                      «Of that, read outside the route» (docs/design/README.md §13) — часть уже увиденного, поэтому
                      строка держится на отметке «Прочего»: она и означает, что непокрытые диапазоны
                      прочитаны сырым диффом. Без неё число говорило бы только о модели маршрута.
                    */}
                    <ReadOutsideRoute route={completion.route} />
                    <Counter
                        label={t('complete.published')}
                        value={t('complete.published.value', completion.publishedComments, replies)}
                    />
                    <Counter
                        label={snapshotLabel(completion.verdict, t)}
                        value={`${commit} · PR head ${commit}`}
                    />
                </dl>

                {completion.openThreads > 0 && completion.firstOpenThreadId !== null ? (
                    <footer className="review-complete__open-threads">
                        <span>{openThreadsText(completion.verdict, completion.openThreads, t)}</span>
                        <button
                            type="button"
                            className="ctl ctl--ghost"
                            onClick={() => {
                                if (completion.firstOpenThreadId !== null) {
                                    onOpenThread(completion.firstOpenThreadId);
                                }
                            }}
                        >
                            {t('complete.openThread')}
                        </button>
                    </footer>
                ) : null}

                <div className="review-complete__actions">
                    <button type="button" className="ctl ctl--ghost" onClick={onOpenFullDiff}>
                        {t('route.toFullDiff')}
                    </button>
                </div>
            </section>
        </main>
    );
}

/** Куда уехали комментарии: у локального ревью раунд уходит задачей агенту в этой же сессии. */
function deliveryText(completion: ReviewCompletion, t: Translate): string {
    switch (draftDestinationOf(completion.reviewHost)) {
        case 'agent':
            return t('complete.handedToAgent');
        case 'pr':
            return t('complete.deliveredTo', completion.hostName);
    }
}

/** «7 из 7 · Прочее прочитано сырым диффом» (docs/design/README.md §13): вторая клауза — только когда так и есть. */
function stopsValue(route: NonNullable<ReviewCompletion['route']>, t: Translate): string {
    const counted = t('complete.stopsViewed.value', route.stopsViewed, route.stopsTotal);
    return route.otherViewed ? t('complete.stopsViewed.other', counted) : counted;
}

/** Строка «Из них прочитано вне маршрута»: только когда «Прочее» действительно отмечено. */
function ReadOutsideRoute({ route }: { route: ReviewCompletion['route'] }) {
    const t = useT();
    const lines = route?.otherViewed === true ? (route.uncoveredLines ?? 0) : 0;
    if (lines === 0) {
        return null;
    }
    return <Counter label={t('complete.outsideRoute')} value={t('complete.outsideRoute.value', lines)} />;
}

function Counter({ label, value }: { label: string; value: string }) {
    return (
        <div className="review-complete__counter">
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function verdictTitle(verdict: Verdict, t: Translate): string {
    switch (verdict) {
        case 'comment':
            return t('complete.verdict.comment');
        case 'ship':
            return t('complete.verdict.shipped');
        case 'sticky_ship':
            return t('ship.mode.sticky');
        case 'request_changes':
            return t('complete.verdict.requestChanges');
        default:
            return unreachableVerdict(verdict);
    }
}

/** Без вердикта ревьюер ничего не подписывал — снапшот только просмотрен. */
function snapshotLabel(verdict: Verdict, t: Translate): string {
    switch (verdict) {
        case 'comment':
            return t('complete.snapshot.reviewed');
        case 'ship':
        case 'sticky_ship':
        case 'request_changes':
            return t('complete.snapshot');
        default:
            return unreachableVerdict(verdict);
    }
}

/** «Шипу это не мешает» — только когда шип был. */
function openThreadsText(verdict: Verdict, threads: number, t: Translate): string {
    switch (verdict) {
        case 'ship':
        case 'sticky_ship':
            return t('complete.openThreads.shipped', threads);
        case 'comment':
        case 'request_changes':
            return t('complete.openThreads', threads);
        default:
            return unreachableVerdict(verdict);
    }
}

function verdictProvenance(verdict: Verdict, commit: string, t: Translate): string {
    switch (verdict) {
        case 'comment':
            return `comment · ${commit}`;
        case 'ship':
            return `ship · ${commit}`;
        case 'sticky_ship':
            return t('complete.sticky', commit);
        case 'request_changes':
            return `request changes · ${commit}`;
        default:
            return unreachableVerdict(verdict);
    }
}
