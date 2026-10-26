import type { RouteStopChange, Thread } from '@sherpa/protocol';
import type { ReactNode, RefObject } from 'react';

import { ViewedToggle } from '../../components/viewed-toggle.tsx';
import type { MessageKey, Translate } from '../../i18n/index.js';
import { useFormat, useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../../iterations/read-only.tsx';
import { stripInlineCode } from '@sherpa/protocol/markdown';
import type { StopLink } from '../../markdown/markdown.tsx';
import { Markdown, StopMarkdown } from '../../markdown/markdown.tsx';
import type { RouteStopView } from '../../route/route-model.js';

/**
 * Остановка маршрута (docs/design/README.md §1): грид из липкой левой колонки и колонки диффа.
 * Левая колонка — тир-линейка, план-номер, бейдж, счётчик комментариев, отметка, заголовок,
 * абзац, связка и чипы файлов; правая приезжает пропсом `diff` — её собирает вью.
 *
 * Компонент ничего не грузит и ничего не считает: всё приезжает пропсами, поэтому та же
 * карточка рисуется в галерее состояний на фикстурах.
 */

export interface StopCardProps {
    readonly view: RouteStopView;
    readonly stopCount: number;
    readonly comments: number;
    readonly viewed: boolean;
    readonly onViewed: (viewed: boolean) => void;
    /** Файлы остановки ещё разбираются: отметить нечем — диапазоны не посчитаны. */
    readonly pending?: boolean;
    /** У части файлов разбор сорвался: диапазонов по ним не будет, пока его не повторили. */
    readonly parseFailed?: boolean;
    /** Агент умер посреди генерации: заполненное читается с тихой пометкой (docs/design/SPEC-elements.md §4.4). */
    readonly filledBeforeStop?: boolean;
    /** Значение сорвавшейся записи отметки: рядом с контролом встаёт «не сохранилось · повторить». */
    readonly failedViewed?: boolean | null;
    /** Остановка подсвечена наведением на сегмент полосы покрытия (docs/design/SPEC-elements.md §2.4). */
    readonly marked?: boolean;
    /** Пометка «оставлен на экране — вне текущего фильтра» (docs/design/SPEC-elements.md §2.7). */
    readonly keptInView?: boolean;
    /** Точечное дозаполнение слота, в котором агент остановился раньше (docs/design/SPEC-elements.md §4.3). */
    readonly onFillStop?: (planIndex: number) => void;
    /** Переход по внутренней ссылке описания: к другой остановке или к файлу диффа. */
    readonly onOpenLink?: (link: StopLink) => void;
    readonly chips: ReactNode;
    readonly diff: ReactNode;
    /** Колонка диффа наружу: вью меряет её высоту, чтобы держать место снятой с DOM колонки. */
    readonly diffRef?: RefObject<HTMLDivElement | null>;
    /** Флеш акцентной линии над колонкой диффа после прыжка к файлу (docs/design/README.md §Interactions & behaviour). */
    readonly flash?: boolean;
    /** Треды-причины из `change.threadIds`, уже сведённые к ссылкам (неизвестные id отброшены). */
    readonly changeThreads?: readonly StopChangeThread[];
    readonly onOpenThread?: (threadId: string) => void;
    /**
     * Цели шагов тура первого захода: колонка повествования — `narrative`, колонка
     * диффа — `stopdiff`. Ставятся на первой остановке маршрута и на заглушке каркаса тура.
     */
    readonly tourAnchors?: boolean;
}

/** Ссылка на тред-причину в блоке «почему изменилась остановка» (docs/design/README.md §1 п.4). */
export interface StopChangeThread {
    readonly id: string;
    readonly label: string;
}

/**
 * Ссылки на треды-причины: тред без якорной позиции — «тред к PR», неизвестный id — ссылки нет
 * (валидатор секций такие уже вырезает, но вью не полагается на чужую чистку).
 */
export function stopChangeThreads(
    change: RouteStopChange | null,
    threads: ReadonlyMap<string, Thread>,
    t: Translate,
): readonly StopChangeThread[] {
    if (change === null) {
        return EMPTY_CHANGE_THREADS;
    }
    const links: StopChangeThread[] = [];
    for (const id of change.threadIds) {
        const thread = threads.get(id);
        if (thread === undefined) {
            continue;
        }
        const line = thread.anchor?.position?.line ?? null;
        links.push({ id, label: line === null ? t('route.stop.thread.pr') : t('route.stop.thread.line', line) });
    }
    return links;
}

const EMPTY_CHANGE_THREADS: readonly StopChangeThread[] = [];

/** Бейдж классификации стопа относительно прошлого захода (docs/design/README.md §1 п.1). */
const CHANGE_BADGE: Readonly<Record<RouteStopChange['kind'], MessageKey>> = {
    changed: 'route.stop.change.changed',
    new: 'route.stop.change.new',
};

export function StopCard({
    view,
    stopCount,
    comments,
    viewed,
    onViewed,
    pending = false,
    parseFailed = false,
    filledBeforeStop = false,
    failedViewed = null,
    marked = false,
    keptInView = false,
    onFillStop,
    onOpenLink,
    chips,
    diff,
    diffRef,
    flash = false,
    changeThreads = EMPTY_CHANGE_THREADS,
    onOpenThread,
    tourAnchors = false,
}: StopCardProps) {
    const t = useT();
    const { count } = useFormat();
    // Дозаполнение пишет в снапшот — только в активной итерации.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const { stop } = view;
    const tier = stop.tier;
    const unfilled = stop.status !== 'ready';

    return (
        <section
            className={`route-stop route-stop--${tier}${unfilled ? ' route-stop--unfilled' : ''}${viewed ? ' is-viewed' : ''}${marked ? ' is-marked' : ''}`}
            id={`stop-${stop.id}`}
            {...(stop.change === null ? {} : { 'data-stop-change': stop.change.kind })}
            role="region"
            aria-label={t('route.stop.aria', view.planLabel, stopCount, stripInlineCode(stop.title))}
        >
            <div className="route-stop__side" {...(tourAnchors ? { 'data-tour': 'narrative' } : {})}>
                <div className="route-stop__head">
                    <span className={`route-stop__rule route-stop__rule--${tier}`} aria-hidden="true" />
                    <span className="route-stop__number">
                        {view.planLabel} / {String(stopCount)}
                    </span>
                    {tier === 'high' ? <span className="route-stop__badge">high</span> : null}
                    {stop.status === 'ready' ? null : (
                        <span className="route-stop__badge route-stop__badge--queued">
                            {t(statusBadge(stop.status))}
                        </span>
                    )}
                    {/* Бейдж классификации виден всегда, когда она есть, — не только под фильтром. */}
                    {stop.change === null ? null : (
                        <span className={`route-stop__badge route-stop__badge--${stop.change.kind}`}>
                            {t(CHANGE_BADGE[stop.change.kind])}
                        </span>
                    )}
                    <span className="route-stop__spacer" />
                    {comments === 0 ? null : (
                        <span className="route-stop__comments" title={t('route.stop.commentsTitle', comments)}>
                            <span className="route-stop__comments-box" aria-hidden="true" />
                            {count(comments)}
                        </span>
                    )}
                    <StopViewedToggle
                        viewed={viewed}
                        pending={pending}
                        parseFailed={parseFailed}
                        unfilled={unfilled}
                        failedViewed={failedViewed}
                        onViewed={onViewed}
                    />
                </div>

                <h2 className="route-stop__title">
                    <Markdown text={stop.title} profile="route" />
                </h2>

                {filledBeforeStop && !unfilled ? (
                    <p className="route-stop__filled-before">{t('route.stop.filledBefore')}</p>
                ) : null}

                {stop.paragraph === null ? (
                    <p className="route-stop__note">
                        {t(unfilledNote(stop.status))}
                        {stop.status !== 'failed' || onFillStop === undefined ? null : (
                            <button
                                type="button"
                                className="ctl ctl--link-muted route-stop__regenerate"
                                disabled={readOnly}
                                {...(readOnly ? { title: readOnlyReason } : {})}
                                onClick={() => {
                                    onFillStop(stop.planIndex);
                                }}
                            >
                                {t('route.stop.fill')}
                            </button>
                        )}
                    </p>
                ) : (
                    <div className="route-stop__paragraph md-blocks">
                        <StopMarkdown
                            text={stop.paragraph}
                            {...(onOpenLink === undefined ? {} : { onOpenLink })}
                        />
                    </div>
                )}

                {stop.change?.reason == null ? null : (
                    <StopChangeReason
                        reason={stop.change.reason}
                        threads={changeThreads}
                        {...(onOpenThread === undefined ? {} : { onOpenThread })}
                    />
                )}

                {stop.bridge === null ? null : (
                    <p className="route-stop__bridge">
                        <Markdown text={stop.bridge} profile="route" />
                    </p>
                )}

                {/*
                 * Пометки валидатора видны только на незаполненной остановке, где они объясняют
                 * пустой слот. У заполненной их место дороже пользы: отброшенный якорь ревьюер
                 * всё равно не переставит, а недостача покрытия видна в полосе и в «Прочем».
                 */}
                {!unfilled || stop.validationNotes.length === 0 ? null : (
                    <ul className="route-stop__validation">
                        {stop.validationNotes.map((note) => (
                            <li key={note}>
                                <Markdown text={note} profile="route" />
                            </li>
                        ))}
                    </ul>
                )}

                {keptInView ? <p className="route-stop__kept">{t('route.stop.kept')}</p> : null}

                {chips}
            </div>

            <div className="route-stop__diff" ref={diffRef} {...(tourAnchors ? { 'data-tour': 'stopdiff' } : {})}>
                {flash ? <div className="route-stop__flash" aria-hidden="true" /> : null}
                {diff}
            </div>
        </section>
    );
}

/**
 * Отметка «просмотрено» остановки: тот же контрол, что у карточки файла (docs/design/SPEC-elements.md §2.10),
 * а рядом — жалоба на сорвавшуюся запись с повтором ровно того же действия.
 *
 * Пока диапазоны остановки не посчитаны, поставить отметку нельзя: на сервер ушёл бы пустой
 * набор, и файлы остались бы непрочитанными. То же и у незаполненной остановки — диапазонов
 * у неё нет вовсе, и у остановки с файлом, разбор которого сорвался: его диапазоны молча
 * не уехали бы. Снять отметку можно всегда — диапазоны для этого не нужны.
 */
export function StopViewedToggle({
    viewed,
    pending = false,
    parseFailed = false,
    unfilled = false,
    failedViewed,
    onViewed,
}: {
    viewed: boolean;
    pending?: boolean;
    parseFailed?: boolean;
    unfilled?: boolean;
    failedViewed: boolean | null;
    onViewed: (viewed: boolean) => void;
}) {
    const t = useT();
    const disabled = (pending || parseFailed || unfilled) && !viewed;
    const reason = unfilled
        ? t('route.stop.viewed.unfilled')
        : parseFailed
          ? t('route.stop.viewed.parseFailed')
          : t('route.stop.viewed.pending');
    return (
        <>
            {failedViewed === null ? null : (
                <span className="route-stop__viewed-error" role="status">
                    {t('route.stop.notSaved')}
                    <button
                        type="button"
                        onClick={() => {
                            onViewed(failedViewed);
                        }}
                    >
                        {t('route.stop.retry')}
                    </button>
                </span>
            )}
            <ViewedToggle
                className="route-stop__viewed"
                variant="toggle"
                viewed={viewed}
                disabled={disabled}
                title={disabled ? reason : undefined}
                onToggle={onViewed}
            />
        </>
    );
}

/**
 * «Почему изменилась остановка» (docs/design/README.md §1 п.4): объяснение модели под абзацем, а под ним —
 * ссылки на треды, которые она назвала причиной. Без обработчика ссылки остаются текстом:
 * открывать тред умеет только вью, знающая про фрагмент адреса.
 */
function StopChangeReason({
    reason,
    threads,
    onOpenThread,
}: {
    reason: string;
    threads: readonly StopChangeThread[];
    onOpenThread?: (threadId: string) => void;
}) {
    const t = useT();
    return (
        <div className="route-stop__change">
            <div className="route-stop__change-label">{t('route.stop.changeLabel')}</div>
            <div className="route-stop__change-body">
                <Markdown text={reason} profile="route" />
            </div>
            {threads.length === 0 || onOpenThread === undefined ? null : (
                <div className="route-stop__change-threads">
                    {threads.map((thread) => (
                        <button
                            key={thread.id}
                            type="button"
                            className="ctl ctl--link-muted route-stop__change-thread"
                            onClick={() => {
                                onOpenThread(thread.id);
                            }}
                        >
                            {thread.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Свёрнутая карточка low-стопа (docs/design/README.md §2). Подпись со счётчиком строк собирает вью: у заглушки
 * каркаса тура считать нечего, и выдумывать числа она не имеет права.
 */
export function CollapsedStop({
    label,
    dataTour,
    onExpand,
}: {
    label: string;
    /** Цель шага тура первого захода: `fold-<stopId>`. */
    dataTour?: string;
    onExpand: () => void;
}) {
    const t = useT();
    return (
        <button
            type="button"
            className="route-collapsed"
            {...(dataTour === undefined ? {} : { 'data-tour': dataTour })}
            onClick={onExpand}
        >
            <span className="route-collapsed__mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            {label}
            <span className="route-stop__spacer" />
            <span className="route-collapsed__hint">{t('route.collapsed.hint')}</span>
        </button>
    );
}

/**
 * Свёртка просмотренной остановки: строка-сводка, раскрывается кликом (docs/design/SPEC-elements.md §2.9).
 * У дайджест-остановки сводка называет ещё и утверждения: тест-код ревьюер читал не построчно,
 * и «N файлов · M строк» без них соврало бы про то, что он на самом деле принял (docs/design/README.md §2).
 */
export function ViewedSummary({
    lines,
    files,
    assertions = 0,
    onExpand,
}: {
    lines: number;
    files: number;
    assertions?: number;
    onExpand: () => void;
}) {
    const t = useT();
    return (
        <button type="button" className="route-collapsed route-collapsed--viewed" onClick={onExpand}>
            <span className="route-collapsed__mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            {assertions === 0
                ? t('route.viewedSummary', files, lines)
                : t('route.viewedSummary.assertions', assertions, files, lines)}
        </button>
    );
}

/** Дашед-карточка вместо пустоты: у остановки нет ни одного ханка (docs/design/SPEC-elements.md §2.9). */
export function EmptyStop({ text }: { text: string }) {
    return <div className="route-collapsed route-collapsed--empty">{text}</div>;
}

/**
 * Шиммер-скелетон в колонке диффа: остановка ждёт заполнения (docs/design/README.md §8, docs/design/SPEC-elements.md §3).
 * Высота фиксирована и близка к реальной карточке — приземление содержимого не двигает
 * раскладку соседей.
 */
export function StopSkeleton() {
    return (
        <div className="route-skeleton-card" aria-hidden="true">
            <div className="route-skeleton-card__head" />
            <div className="route-skeleton-card__body">
                {SKELETON_ROWS.map((row, index) => (
                    <div
                        key={`${row}-${String(index)}`}
                        className={`route-skeleton-card__row route-skeleton-card__row--${row}`}
                    />
                ))}
            </div>
        </div>
    );
}

const SKELETON_ROWS = ['wide', 'mid', 'wide', 'short', 'mid', 'wide'] as const;

/**
 * Дрейф якорей: остановка указывает на строки, которых в диффе больше нет (docs/design/SPEC-elements.md §2.9).
 * `partial` — уцелела часть якорей, нотис стоит над их карточками.
 */
export function AnchorDrift({ paths, partial = false }: { paths: readonly string[]; partial?: boolean }) {
    const t = useT();
    return (
        <div className="route-drift" role="note">
            <p className="route-drift__text">{partial ? t('route.drift.partial') : t('route.drift')}</p>
            {paths.length === 0 ? null : (
                <ul className="route-drift__paths">
                    {paths.map((path) => (
                        <li key={path}>{path}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Якоря остановки попали в конфликтные файлы (docs/design/SPEC-elements.md §4.1): строки в диффе есть, но файл вне
 * покрытия маршрута — читать и отмечать его здесь нечего, разрешают конфликт в хосте.
 * Это не дрейф: звать на перегенерацию было бы враньём.
 */
export function StopConflicts({ paths }: { paths: readonly string[] }) {
    const t = useT();
    return (
        <div className="route-conflicts" role="note">
            <p className="route-conflicts__text">{t('route.stop.conflicts', paths.length)}</p>
            <ul className="route-conflicts__paths">
                {paths.map((path) => (
                    <li key={path}>{path}</li>
                ))}
            </ul>
        </div>
    );
}

function statusBadge(status: RouteStopView['stop']['status']): MessageKey {
    return status === 'failed'
        ? 'route.gen.plan.failed'
        : status === 'filling'
          ? 'route.gen.plan.filling'
          : 'route.gen.plan.queued';
}

function unfilledNote(status: RouteStopView['stop']['status']): MessageKey {
    return status === 'failed' ? 'route.stop.unfilled.failed' : 'route.stop.unfilled.queued';
}
