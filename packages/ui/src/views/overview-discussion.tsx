import type { Thread } from '@sherpa/protocol';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { Avatar } from '../components/avatar.tsx';
import { relativeTime, useFormat, useLocale, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { SessionStore } from '../session/session-store.js';
import { CommentComposer } from '../threads/comment-composer.tsx';
import type { ComposerTransport } from '../threads/composer.js';
import { useThreadPin } from '../iterations/thread-pin.tsx';
import { authorName, flattenThread } from '../threads/model.js';
import type { ComposerSnapshot, ThreadStore } from '../threads/store.js';
import { openReply, ThreadPinChip } from '../threads/thread-list.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import type { DiscussionParticipant } from './overview-model.js';
import { bodyNeedsExpand, discussionSummary } from './overview-model.js';
import './overview-discussion.css';

/** Больше строк участников карточка не показывает — дальше «ещё N» (docs/design/SPEC-additions-2026-08-26.md §1e п.3). */
const PARTICIPANT_ROWS = 6;

export interface OverviewDiscussionProps {
    /** `null` — тредов ещё нет: хост недоступен, идёт загрузка или она провалилась. */
    readonly threads: readonly Thread[] | null;
    /** Файлы нарисованного диффа: по ним тред относится к коду или уходит «вне диффа». */
    readonly fileIds: ReadonlySet<string>;
    readonly session: SessionStore;
    readonly store: ThreadStore;
    readonly transport: ComposerTransport;
    readonly now: number;
    readonly loading: boolean;
    readonly error: string | null;
    /** `capabilities.commentIssues` хоста: без него у ответа нет свитчера issue. */
    readonly commentIssues?: boolean;
    /** Открывает модалку комментариев к PR и возвращает фокус на кнопку при закрытии. */
    readonly onWritePrComment?: ((returnFocus: () => void) => void) | undefined;
    /** Стартовое состояние свёртки «вне диффа»: в приложении закрыта, в галерее бывает раскрытой. */
    readonly outsideOpenByDefault?: boolean | undefined;
}

/**
 * Карточка «Обсуждение» на Обзоре (docs/design/SPEC-additions-2026-08-26.md §1e): сводка и вход, а не лента. Тела
 * тредов живут у кода — в карточке разворачиваются только треды вне диффа, читать их больше
 * негде. Бот-треды схлопнуты в строку на бота и тел не показывают никогда.
 */
export function OverviewDiscussion({
    threads,
    fileIds,
    session,
    store,
    transport,
    now,
    loading,
    error,
    commentIssues = false,
    onWritePrComment,
    outsideOpenByDefault = false,
}: OverviewDiscussionProps) {
    const t = useT();
    const format = useFormat();
    const [allParticipants, setAllParticipants] = useState(false);
    const [outsideOpen, setOutsideOpen] = useState(outsideOpenByDefault);
    const writeButtonRef = useRef<HTMLButtonElement | null>(null);
    const summary = useMemo(() => discussionSummary(threads ?? EMPTY_THREADS, fileIds), [fileIds, threads]);

    const openAuthorLens = (login: string): void => {
        session.setThreadAuthor(login);
        session.setView('diff');
    };

    const footer = (
        <div className="discussion-card__footer">
            <button
                type="button"
                className="ctl ctl--link discussion-card__all"
                onClick={() => {
                    // Подпись обещает все треды: линза по участнику, поставленная строкой выше, снимается.
                    session.setThreadAuthor(null);
                    session.setView('diff');
                }}
            >
                {t('overview.discussion.allThreads')}
                <Icon name="chev-right" size={13} />
            </button>
            <span className="discussion-card__spacer" />
            <button
                ref={writeButtonRef}
                type="button"
                className="ctl ctl--ghost ctl--compact discussion-card__write"
                disabled={onWritePrComment === undefined}
                onClick={() => {
                    onWritePrComment?.(() => {
                        writeButtonRef.current?.focus();
                    });
                }}
            >
                {t('overview.discussion.writePr')}
            </button>
        </div>
    );

    if (threads === null) {
        return (
            <section className="discussion-card">
                <DiscussionHead title={t('overview.discussion')} />
                <p className="discussion-card__empty">
                    {loading ? t('overview.discussion.loading') : (error ?? t('overview.discussion.empty'))}
                </p>
                {footer}
            </section>
        );
    }

    if (summary.total === 0) {
        return (
            <section className="discussion-card">
                <DiscussionHead title={t('overview.discussion')} />
                <p className="discussion-card__empty">{t('overview.discussion.empty')}</p>
                {footer}
            </section>
        );
    }

    const shown = allParticipants ? summary.participants : summary.participants.slice(0, PARTICIPANT_ROWS);
    const rest = summary.participants.length - shown.length;

    return (
        <section className="discussion-card">
            <DiscussionHead
                title={t('overview.discussion')}
                counts={t('overview.discussion.summary', summary.total, summary.open)}
            />
            <div className="discussion-card__people">
                {shown.map((participant) => (
                    <ParticipantRow
                        key={participant.login}
                        participant={participant}
                        now={now}
                        onOpen={openAuthorLens}
                    />
                ))}
                {rest === 0 ? null : (
                    <button
                        type="button"
                        className="ctl ctl--link discussion-card__more"
                        onClick={() => {
                            setAllParticipants(true);
                        }}
                    >
                        {t('overview.discussion.more', rest)}
                    </button>
                )}
            </div>
            <div className="discussion-card__outside">
                {/* Раскрывать нечего — строка остаётся на месте, но мишенью не притворяется. */}
                {summary.outside.length === 0 ? (
                    <div className="discussion-card__outside-toggle is-static">
                        <Icon name="chev-down" size={13} className="discussion-card__outside-chev is-collapsed" />
                        {t('overview.discussion.outside')}
                        <span className="discussion-card__outside-count">{format.count(0)}</span>
                        <span className="discussion-card__spacer" />
                        <span className="discussion-card__outside-hint">
                            {t('overview.discussion.outside.empty')}
                        </span>
                    </div>
                ) : (
                    <button
                        type="button"
                        className="discussion-card__outside-toggle"
                        aria-expanded={outsideOpen}
                        onClick={() => {
                            setOutsideOpen(!outsideOpen);
                        }}
                    >
                        <Icon
                            name="chev-down"
                            size={13}
                            className={`discussion-card__outside-chev${outsideOpen ? '' : ' is-collapsed'}`}
                        />
                        {t('overview.discussion.outside')}
                        <span className="discussion-card__outside-count">{format.count(summary.outside.length)}</span>
                        <span className="discussion-card__spacer" />
                        <span className="discussion-card__outside-hint">{t('overview.discussion.outside.hint')}</span>
                    </button>
                )}
                {outsideOpen && summary.outside.length > 0 ? (
                    <div className="discussion-card__outside-list">
                        {summary.outside.map((thread) => (
                            <OutsideThreadCard
                                key={thread.id}
                                thread={thread}
                                store={store}
                                transport={transport}
                                now={now}
                                commentIssues={commentIssues}
                            />
                        ))}
                    </div>
                ) : null}
            </div>
            {footer}
        </section>
    );
}

function DiscussionHead({ title, counts }: { title: string; counts?: string }) {
    return (
        <header className="discussion-card__head">
            <h2 className="discussion-card__title">{title}</h2>
            {counts === undefined ? null : <span className="discussion-card__counts">{counts}</span>}
        </header>
    );
}

function ParticipantRow({
    participant,
    now,
    onOpen,
}: {
    participant: DiscussionParticipant;
    now: number;
    onOpen: (login: string) => void;
}) {
    const t = useT();
    const format = useFormat();
    const locale = useLocale();
    const openLabel =
        participant.open === 0
            ? t('overview.discussion.participant.none')
            : t('overview.discussion.participant.open', participant.open);
    const last =
        participant.lastActivity === null
            ? null
            : t('overview.discussion.participant.last', relativeTime(participant.lastActivity, now, locale));
    return (
        <button
            type="button"
            className="discussion-participant"
            aria-label={t('overview.discussion.participant.aria', participant.name)}
            onClick={() => {
                onOpen(participant.login);
            }}
        >
            <Avatar
                className="discussion-participant__avatar"
                name={participant.name}
                url={participant.avatarUrl}
            />
            <span className="discussion-participant__body">
                <span className="discussion-participant__name-line">
                    <span className="discussion-participant__name">{participant.name}</span>
                    {participant.bot ? <span className="discussion-participant__bot">bot</span> : null}
                </span>
                <span className="discussion-participant__sub">
                    {last === null ? openLabel : `${openLabel} · ${last}`}
                </span>
            </span>
            <span className={`discussion-participant__count${participant.open > 0 ? ' is-open' : ''}`}>
                {format.count(participant.threads)}
            </span>
            <Icon name="chev-right" size={13} className="discussion-participant__chev" />
        </button>
    );
}

/**
 * Тред вне диффа в колонке 360px: markdown разрешён, но заголовки — обычный жирный текст,
 * ссылки и блоки кода живут одной строкой с обрезкой (§1e п.4). Ответы карточка держит
 * свёрнутыми в счётчик «N ответов»: дерева, как у кода, здесь нет, но и потерять их нельзя —
 * у тредов вне диффа это единственное место, где они читаются, включая только что написанный.
 */
function OutsideThreadCard({
    thread,
    store,
    transport,
    now,
    commentIssues,
}: {
    thread: Thread;
    store: ThreadStore;
    transport: ComposerTransport;
    now: number;
    commentIssues: boolean;
}) {
    const t = useT();
    const locale = useLocale();
    const [expanded, setExpanded] = useState(false);
    const [repliesOpen, setRepliesOpen] = useState(false);
    const composer = useComposerSnapshot(store, `reply:${thread.id}`);
    // Тред с ушедшего файла бывает написан на прошлой итерации: читать его больше негде,
    // поэтому переход «показать на старом коммите» живёт и здесь (docs/design/SPEC-elements.md §2.17).
    const pinned = useThreadPin(thread);
    const clampable = bodyNeedsExpand(thread.root.body);
    const clamped = clampable && !expanded;
    const state = thread.resolved ? 'resolved' : thread.outdated ? 'outdated' : 'open';
    const where = thread.anchor?.path.split('/').at(-1) ?? 'PR';
    const replies = flattenThread(thread.root).slice(1);
    // Пока пишется ответ, уже написанные видны сами собой: иначе отвечаешь вслепую.
    const repliesShown = repliesOpen || composer !== null;
    return (
        <article className="discussion-thread">
            <div className="discussion-thread__head">
                <Avatar
                    className="discussion-thread__avatar"
                    name={authorName(thread.root)}
                    url={thread.root.author.avatarUrl}
                />
                <span className="discussion-thread__author">{authorName(thread.root)}</span>
                <span className="discussion-card__spacer" />
                <span className={`discussion-thread__state${state === 'open' ? ' is-open' : ''}`}>
                    {t(`overview.discussion.state.${state}`)}
                </span>
                {pinned === null ? null : <ThreadPinChip pinned={pinned} />}
            </div>
            <div className={`discussion-thread__body${clamped ? ' is-clamped' : ''}`}>
                <Markdown text={thread.root.body} profile="comment" />
            </div>
            {clampable ? (
                <button
                    type="button"
                    className="ctl ctl--link discussion-thread__expand"
                    aria-expanded={expanded}
                    onClick={() => {
                        setExpanded(!expanded);
                    }}
                >
                    {expanded ? t('overview.discussion.body.collapse') : t('overview.discussion.body.expand')}
                </button>
            ) : null}
            <div className="discussion-thread__foot">
                <span className="discussion-thread__meta">
                    {t('thread.meta', where, relativeTime(thread.root.createdAt, now, locale))}
                </span>
                {replies.length === 0 ? null : (
                    <button
                        type="button"
                        className="ctl ctl--link discussion-thread__replies-toggle"
                        aria-expanded={repliesShown}
                        onClick={() => {
                            setRepliesOpen(!repliesShown);
                        }}
                    >
                        {t('thread.replies', replies.length)}
                    </button>
                )}
                <span className="discussion-card__spacer" />
                {composer === null ? (
                    <button
                        type="button"
                        className="ctl ctl--ghost ctl--compact discussion-thread__reply"
                        onClick={() => {
                            // Ответ уедет в этот же список: раскрываем его сразу, иначе сохранение
                            // закроет композер и написанное будет негде увидеть.
                            setRepliesOpen(true);
                            openReply(store, thread, commentIssues);
                        }}
                    >
                        {t('overview.discussion.reply')}
                    </button>
                ) : null}
            </div>
            {repliesShown && replies.length > 0 ? (
                <div className="discussion-thread__replies">
                    {replies.map((row) => (
                        <div key={row.comment.id} className="discussion-reply">
                            <div className="discussion-reply__head">
                                <span className="discussion-reply__author">{authorName(row.comment)}</span>
                                {row.comment.draft ? (
                                    <span className="discussion-reply__draft">{t('thread.chip.draft')}</span>
                                ) : null}
                                <span className="discussion-card__spacer" />
                                <span className="discussion-reply__meta">
                                    {relativeTime(row.comment.createdAt, now, locale)}
                                </span>
                            </div>
                            <div className="discussion-thread__body">
                                <Markdown text={row.comment.body} profile="comment" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
            {composer === null ? null : (
                <CommentComposer
                    composer={composer}
                    store={store}
                    transport={transport}
                    placeholder={t('thread.reply.placeholder')}
                    inputLabel={t('thread.reply.label')}
                    closeOnSave
                />
            )}
        </article>
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const EMPTY_THREADS: readonly Thread[] = [];
