import type { FileContent, FileDiff } from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { FileContextMenu, useContextMenu } from '../components/context-menu.tsx';
import { useDelayedPending } from '../components/use-delayed-pending.js';
import { ViewedToggle } from '../components/viewed-toggle.tsx';
import type { DiffFileModel } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';
import { useFormat, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { FileReadState } from '../progress/read-state.js';
import { readStateTooltip } from '../progress/read-state.js';
import { useBlobLoader } from './blob-loader.tsx';
import type { ContextExpandRequest, ContextExpandResult, GapExpandResult } from './context-expansion.js';
import type { LinePosition } from './diff-rows.tsx';
import { DiffRows } from './diff-rows.tsx';
import { gutterDigits } from './gutter.js';
import { MarkdownReview } from './markdown-review.tsx';
import type { ImageBodyState } from './image-card.tsx';
import { ImageBody } from './image-card.tsx';
import type { FileExpansion } from './expand.js';
import {
    expandFileContext,
    gapExpansionDelta,
    gapKeyOf,
    remainingHiddenChanged,
    remainingHiddenLines,
} from './expand.js';
import type { LineKey, LineRange, LineSelection } from './selection.js';
import { lineSide, parseLineKey } from './selection.js';
import type { DiffMode, FileCollapseReason } from './store.js';

/**
 * Карточка файла (docs/design/README.md §1 «Right column: one card per hunk», §10): липкая шапка с именем,
 * путём, счётчиками и действиями, дальше строки диффа или однострочный нотис.
 *
 * Карточка ничего не грузит сама: модель, содержимое и состояние приезжают пропсами, наружу
 * уходят намерения (`FileCardActions`). Так одна и та же карточка работает и на живых ручках,
 * и в галерее состояний на фикстурах.
 */

/** Выше этого порога файл открывается свёрнутым (docs/design/SPEC-elements.md §2.13). */
export const COLLAPSE_THRESHOLD = 2000;

/**
 * Рисует ли `FileCard` вместо строк сводку свёрнутой карточки. Повторяет порядок её веток: нотис
 * провала разбора стоит раньше свёртки по размеру, и тогда сводки с маркерами нет.
 */
export function showsCollapsedSummary(
    collapseReason: FileCollapseReason | null,
    sizeCollapsed: boolean,
    parseError: string | null,
    model: DiffFileModel | null,
): boolean {
    return collapseReason !== null || (sizeCollapsed && !(parseError !== null && model === null));
}

/**
 * «Свернуть все / развернуть все» треды файла (docs/design/SPEC-changes-2026-09-20.md §3):
 * кнопка появляется при двух и более тредах, счётчика рядом с ней нет — его заменили маркеры.
 */
export interface ThreadsCollapse {
    /** Есть что сворачивать: хоть один тред файла раскрыт и в нём не пишут ответ. */
    readonly canCollapse: boolean;
    readonly onToggle: () => void;
}

/**
 * Инлайн-подсказка под шапкой (docs/design/SPEC-elements.md §1.2: никаких модалок); null — говорить нечего.
 * `retry` рисует рядом «повторить» и сам обновляет подсказку своим результатом.
 */
export interface FeedbackHint {
    readonly text: string;
    readonly retry?: () => Promise<Feedback>;
}
export type Feedback = string | FeedbackHint | null;

export interface FileCardActions {
    /** Отметка «просмотрено»: оптимистичная, ответ — жалоба на сорвавшуюся запись. */
    readonly onViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    /** Раскрытие одной перемычки или всего файла; ответ несёт итоговое content/expansion после lazy-fetch. */
    readonly onExpand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
    /** Повторить разбор патча после провала воркера. */
    readonly onRetryParse: (fileId: string) => void;
    /** Тогл ручной/read/generated свёртки карточки файла. */
    readonly onToggleCollapse?: ((fileId: string) => void) | undefined;
    readonly onOpenFile: (fileId: string) => void;
    readonly onShowWhitespace: (fileId: string) => void;
    readonly onToggleMarkdown: (fileId: string) => void;
    readonly onSelectStart: (fileId: string, key: LineKey, side: 'old' | 'new', extend: boolean) => void;
    readonly onSelectText?: ((selection: LineSelection) => void) | undefined;
    readonly onClearSelection?: (() => void) | undefined;
    readonly onSelectExtend: (fileId: string, key: LineKey, side: 'old' | 'new') => void;
    readonly onCommentLine?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    /** Комментарий к файлу без строки: пункт меню есть только у карточек-картинок. */
    readonly onCommentFile?: ((fileId: string) => void) | undefined;
    readonly onLineFocus?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
}

export interface FileCardProps {
    readonly file: FileDiff;
    /** null — дифф файла ещё разбирается воркером. */
    readonly model: DiffFileModel | null;
    /** Разбор патча сорвался: текст — причина, показывается вместо строк диффа. */
    readonly parseError?: string | null;
    readonly mode: DiffMode;
    /** `undefined` — содержимое ещё не запрашивали, `null` — его у файла нет. */
    readonly content: FileContent | null | undefined;
    /** Хост умеет отдавать содержимое файлов (`capabilities.fileContent`). */
    readonly contentAvailable: boolean;
    /** Почему содержимого нет, если оно недоступно; по умолчанию — про хост без `fileContent`. */
    readonly noContentReason?: string | undefined;
    readonly expansion: FileExpansion;
    /** Прогресс чтения файла (docs/design/SPEC-elements.md §2.12): состояние коробки и тултип с числами. */
    readonly read: FileReadState;
    /** Почему отметить «просмотрено» сейчас нельзя; `null` — можно. */
    readonly viewedDisabledReason?: string | null;
    /** Причина свёртки по docs/design/SPEC-elements.md §2.9; null — ручной/read/generated слой раскрыт. */
    readonly collapseReason?: FileCollapseReason | null;
    /** Тогл ручной/read/generated свёртки; без него шапка не реагирует на клик. */
    readonly onToggleCollapse?: (() => void) | undefined;
    /** Ревьюер открыл файл вручную вопреки свёртке по размеру. */
    readonly opened: boolean;
    readonly showWhitespace: boolean;
    /** Markdown-файл показан документом, а не кодом. */
    readonly markdown: boolean;
    /** Карточка осталась на экране вопреки фильтру (docs/design/SPEC-elements.md §2.7). */
    readonly keptInView?: boolean;
    /**
     * Сколько места занять скелетону «дифф разбирается…»: оценка тела карточки от списка.
     * Без неё виртуализатор мерил бы неразобранный файл в одну строку текста, и приход модели
     * растил бы карточку в разы — вместе со всем списком под ней.
     */
    readonly loadingMinHeight?: number | undefined;
    /** Стартовая подсказка: так галерея рисует состояние сорвавшейся записи без клика. */
    readonly initialHint?: Feedback;
    /** Только галерея: детерминированный кадр ошибки первой перемычки. */
    readonly initialGapError?: boolean;
    /** Только галерея: стартовый режим карточки-картинки. */
    readonly initialImage?: ImageBodyState | undefined;
    /**
     * Пост-обработка модели перед рендером — после раскрытия контекста. Маршрут обрезает
     * ею модель якорями остановки, поэтому «Expand context» продолжает работать: раскрытие
     * идёт по полной модели, а срез считается от неё.
     */
    readonly transform?: (model: DiffFileModel) => DiffFileModel;
    /** Уже посчитанная модель рендера для потребителей, которым она нужна снаружи карточки. */
    readonly shownModel?: DiffFileModel | null;
    /** Счётчики шапки вместо файловых: на маршруте карточка показывает числа своей остановки. */
    readonly counts?: { readonly additions: number; readonly deletions: number };
    readonly selection: LineSelection | null;
    /** Бейдж маршрута в шапке (docs/design/README.md §10): «объяснено в 02 · …» или штриховка. */
    readonly routeBadge?: ReactNode;
    /** Полосы непокрытых диапазонов, которым не досталось строки: свод под шапкой. */
    readonly routeStrips?: ReactNode;
    readonly threadsUnderHeader?: ReactNode;
    readonly focusedThreadRange?: LineRange | null;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly renderLineMarker?: ((positions: readonly LinePosition[]) => ReactNode) | undefined;
    /** Маркеры тредов свёрнутой карточки: стопкой на кромке у строки-сводки (`useCardThreads`). */
    readonly collapsedMarkers?: ReactNode;
    /** «Свернуть все / развернуть все» в шапке: есть, только когда тредов в файле ≥ 2. */
    readonly threadsCollapse?: ThreadsCollapse | null;
    readonly actions: FileCardActions;
}

/**
 * Первая карточка, дошедшая до строк, ставит метку — от неё перф-спека меряет время до первого
 * кадра диффа. Флаг модульный: метка нужна одна на страницу, а не одна на карточку.
 */
let firstDiffFrameMarked = false;

function markFirstDiffFrame(): void {
    if (firstDiffFrameMarked || typeof performance === 'undefined' || typeof performance.mark !== 'function') {
        return;
    }
    firstDiffFrameMarked = true;
    performance.mark('devflow-diff-explain:first-diff-frame');
}

/** Ровно та модель, которую `FileCard` передаёт строкам диффа. */
export function shownFileModel(
    model: DiffFileModel | null,
    content: FileContent | null,
    expansion: FileExpansion,
    transform?: (model: DiffFileModel) => DiffFileModel,
): DiffFileModel | null {
    if (model === null) {
        return null;
    }
    const expanded = expandFileContext(model, content, expansion);
    return transform === undefined ? expanded : transform(expanded);
}

export const FileCard = memo(function FileCard(props: FileCardProps) {
    const {
        file,
        model,
        parseError = null,
        mode,
        content,
        contentAvailable,
        noContentReason,
        expansion,
        read,
        viewedDisabledReason = null,
        collapseReason = null,
        onToggleCollapse,
        opened,
        showWhitespace,
        markdown,
        keptInView = false,
        loadingMinHeight,
        initialHint = null,
        initialGapError = false,
        initialImage,
        transform,
        shownModel,
        counts,
        selection,
        routeBadge = null,
        routeStrips = null,
        threadsUnderHeader = null,
        focusedThreadRange = null,
        renderAfterLine,
        renderLineMarker,
        collapsedMarkers = null,
        threadsCollapse = null,
        actions,
    } = props;
    const t = useT();
    const { count } = useFormat();
    // Хост без `capabilities.blobs` транспорта не даёт: тогда картинка остаётся обычным нотисом.
    const loadBlob = useBlobLoader();
    const image = file.image;
    const showImage = image !== null && loadBlob !== null;
    const [hint, setHint] = useState<Feedback>(initialHint);
    const [announcement, setAnnouncement] = useState('');
    const menu = useContextMenu();
    const markdownFile = /\.(?:md|markdown|mdown)$/i.test(file.path);

    // Модель с уже раскрытым контекстом: расширение — чистая функция от исходной модели.
    const shown = useMemo(
        () => (shownModel === undefined ? shownFileModel(model, content ?? null, expansion, transform) : shownModel),
        [content, expansion, model, shownModel, transform],
    );
    const digits = useMemo(() => gutterDigits(shown), [shown]);

    const changed =
        counts === undefined
            ? (model?.additions ?? file.additions) + (model?.deletions ?? file.deletions)
            : counts.additions + counts.deletions;
    const sizeCollapsed = !opened && changed > COLLAPSE_THRESHOLD;

    const rowsRendered = collapseReason === null && !sizeCollapsed && shown?.content.kind === 'text';
    useEffect(() => {
        if (rowsRendered) {
            markFirstDiffFrame();
        }
    }, [rowsRendered]);

    const run = (action: Promise<Feedback>): void => {
        void action.then(setHint, (error: unknown) => {
            setHint(error instanceof Error ? error.message : String(error));
        });
    };
    const onShowWhitespace = useCallback(() => {
        actions.onShowWhitespace(file.fileId);
    }, [actions, file.fileId]);
    const onSelectStart = useCallback(
        (key: LineKey, side: 'old' | 'new', extend: boolean) => {
            actions.onSelectStart(file.fileId, key, side, extend);
        },
        [actions, file.fileId],
    );
    const onSelectExtend = useCallback(
        (key: LineKey, side: 'old' | 'new') => {
            actions.onSelectExtend(file.fileId, key, side);
        },
        [actions, file.fileId],
    );
    const onCommentLine = useCallback(
        (side: 'old' | 'new', line: number) => {
            actions.onCommentLine?.(file.fileId, side, line);
        },
        [actions, file.fileId],
    );
    const onLineFocus = useCallback(
        (side: 'old' | 'new', line: number) => {
            actions.onLineFocus?.(file.fileId, side, line);
        },
        [actions, file.fileId],
    );
    const onExpandContext = useCallback(
        async (request: ContextExpandRequest): Promise<GapExpandResult> => {
            const result = await actions.onExpand(file.fileId, request);
            if (result.feedback !== null || request.kind !== 'gap' || model === null) {
                return { feedback: result.feedback, loaded: 0, hidden: 0, hiddenChanged: 0 };
            }

            const beforeExpanded = expandFileContext(model, result.content, expansion);
            const afterExpanded = expandFileContext(model, result.content, result.expansion);
            const beforeShown = transform === undefined ? beforeExpanded : transform(beforeExpanded);
            const afterShown = transform === undefined ? afterExpanded : transform(afterExpanded);
            return {
                feedback: null,
                ...gapExpansionDelta(beforeShown, afterShown, result.content, request.gapKey),
            };
        },
        [actions, expansion, file.fileId, model, transform],
    );
    const onContextExpanded = useCallback(
        (loaded: number, hidden: number, hiddenChanged: number) => {
            setAnnouncement(expansionAnnouncement(loaded, hidden, hiddenChanged, t));
        },
        [t],
    );

    // Строки диффа — и обычное тело карточки, и режим «Текст» карточки-картинки (svg).
    const body = (
        <Body
            model={shown}
            mode={mode}
            content={content ?? null}
            contextAvailable={contentAvailable && content !== null}
            loadingMinHeight={loadingMinHeight}
            selection={selection}
            focusedThreadRange={focusedThreadRange}
            showWhitespace={showWhitespace}
            onShowWhitespace={onShowWhitespace}
            onSelectStart={onSelectStart}
            onSelectExtend={onSelectExtend}
            renderAfterLine={renderAfterLine}
            renderLineMarker={renderLineMarker}
            onCommentLine={onCommentLine}
            onLineFocus={onLineFocus}
            onLineBlur={actions.onLineBlur}
            onExpandContext={onExpandContext}
            onContextExpanded={onContextExpanded}
            initialGapError={initialGapError}
        />
    );

    return (
        <article
            className={`file-card${file.generated ? ' file-card--generated' : ''}`}
            id={`file-${file.fileId}`}
            data-file={file.fileId}
            style={{ '--gutter-digits': digits } as CSSProperties}
        >
            {/* Рамка, фон и скругление живут на внутренней обёртке: внешний бокс отдаёт левые
                14px под маркеры тредов, которые парят на кромке карточки (§3). */}
            <div className="file-card__frame">
                <header
                    className={`file-card__header${onToggleCollapse === undefined ? '' : ' file-card__header--collapsible'}`}
                    // Вне tab-порядка, но фокус принимает: сюда возвращается фокус, когда меню,
                    // открытое правым кликом по шапке, закрыли клавиатурой.
                    tabIndex={-1}
                    onClick={(event) => {
                        const target = event.target;
                        if (
                            onToggleCollapse === undefined ||
                            !(target instanceof Element) ||
                            target.closest('button, a, .route-badge') !== null ||
                            window.getSelection()?.isCollapsed === false
                        ) {
                            return;
                        }
                        onToggleCollapse();
                    }}
                    onContextMenu={menu.openAtPointer}
                >
                    <FileName file={file} />
                    <ConflictBadge file={file} />
                    <span className="file-card__counts">
                        <span className="file-card__add">
                            +{count(counts?.additions ?? model?.additions ?? file.additions)}
                        </span>
                        <span className="file-card__del">
                            −{count(counts?.deletions ?? model?.deletions ?? file.deletions)}
                        </span>
                    </span>
                    {routeBadge}
                    {threadsCollapse === null ? null : (
                        <button
                            type="button"
                            className="ctl ctl--quiet file-card__threads-collapse"
                            onClick={threadsCollapse.onToggle}
                        >
                            {t(threadsCollapse.canCollapse ? 'thread.collapseAll' : 'thread.expandAll')}
                        </button>
                    )}
                    {markdownFile && shown?.content.kind === 'text' ? (
                        <button type="button" className="ctl ctl--ghost ctl--compact file-card__header-action" aria-pressed={markdown} onClick={() => { actions.onToggleMarkdown(file.fileId); }}>
                            {t(markdown ? 'markdown.code' : 'markdown.preview')}
                        </button>
                    ) : null}

                    {/* Ссылка на blame уехала в меню («Открыть в Аркануме» / «на GitHub»): в шапке от неё осталась «⋯». */}
                    <span className="file-card__actions">
                        <button
                            type="button"
                            className="ctl ctl--ghost ctl--compact file-card__header-action"
                            aria-haspopup="menu"
                            aria-expanded={menu.open}
                            aria-label={t('file.menu.more')}
                            onClick={menu.openAtButton}
                        >
                            ⋯
                        </button>
                    </span>

                    <ExpandButton
                        model={shown}
                        content={content}
                        contentAvailable={contentAvailable}
                        noContentReason={noContentReason}
                        onExpand={(gapKeys) => {
                            run(
                                actions
                                    .onExpand(file.fileId, { kind: 'file', gapKeys })
                                    .then((result) => result.feedback),
                            );
                        }}
                    />

                    {/* Тултип тогла всегда несёт числа прогресса (docs/design/SPEC-elements.md §2.12): «частично» видно
                        в них и в индикаторах дерева и чипов, а не в самой кнопке. */}
                    <ViewedToggle
                        className="file-card__viewed"
                        viewed={read.state === 'read'}
                        disabled={viewedDisabledReason !== null}
                        title={viewedDisabledReason ?? readStateTooltip(t, read)}
                        onToggle={(viewed) => {
                            run(actions.onViewed(file.fileId, viewed));
                        }}
                    />
                </header>

                {menu.anchor === null ? null : (
                    <FileContextMenu
                        file={file}
                        viewed={read.state === 'read'}
                        viewedDisabledReason={viewedDisabledReason}
                        onToggleViewed={() => {
                            run(actions.onViewed(file.fileId, read.state !== 'read'));
                        }}
                        anchor={menu.anchor}
                        onClose={menu.close}
                        toggleRef={menu.toggleRef}
                        {...(showImage && actions.onCommentFile !== undefined
                            ? {
                                  onCommentFile: () => {
                                      actions.onCommentFile?.(file.fileId);
                                  },
                              }
                            : {})}
                    />
                )}

                {collapseReason === null ? routeStrips : null}

                {threadsUnderHeader}

                {keptInView ? (
                    <p className="file-card__kept">{t('diff.file.kept')}</p>
                ) : null}

                {hint === null ? null : (
                    <p className="file-card__hint" role="status">
                        {typeof hint === 'string' ? hint : hint.text}
                        {typeof hint !== 'string' && hint.retry !== undefined ? (
                            <>
                                {' · '}
                                <button
                                    type="button"
                                    className="ctl ctl--link-muted file-card__action"
                                    onClick={() => {
                                        const retry = hint.retry;
                                        if (retry !== undefined) {
                                            setHint(null);
                                            run(retry());
                                        }
                                    }}
                                >
                                    {t('diff.file.retry')}
                                </button>
                            </>
                        ) : null}
                    </p>
                )}

                {collapseReason === null ? <Notices model={shown} file={file} hideBinary={showImage} /> : null}

                {collapseReason !== null ? (
                    <CollapsedRow markers={collapsedMarkers}>
                        <CollapsedFileSummary
                            file={file}
                            counts={counts}
                            reason={collapseReason}
                            onExpand={() => {
                                onToggleCollapse?.();
                            }}
                        />
                    </CollapsedRow>
                ) : parseError !== null && model === null ? (
                    <p className="file-card__notice">
                        {t('diff.file.parseFailed', parseError)}
                        <button
                            type="button"
                            className="ctl ctl--link-muted file-card__action"
                            onClick={() => {
                                actions.onRetryParse(file.fileId);
                            }}
                        >
                            {t('diff.file.retryParse')}
                        </button>
                    </p>
                ) : sizeCollapsed ? (
                    <CollapsedRow markers={collapsedMarkers}>
                        <button
                            type="button"
                            className="file-card__collapsed"
                            onClick={() => {
                                actions.onOpenFile(file.fileId);
                            }}
                        >
                            {t('diff.file.sizeCollapsed', changed)}
                        </button>
                    </CollapsedRow>
                ) : image !== null && loadBlob !== null ? (
                    // Ключ по файлу: режим и масштаб — состояние карточки, и при переезде списка
                    // на другой файл они обязаны начаться заново.
                    <ImageBody
                        key={file.fileId}
                        file={file}
                        image={image}
                        loadBlob={loadBlob}
                        textBody={file.patch === null ? null : body}
                        initial={initialImage}
                    />
                ) : markdown && shown?.content.kind === 'text' ? (
                    <MarkdownReview model={shown} selection={selection} focusedThreadRange={focusedThreadRange} onSelect={actions.onSelectText} onClearSelection={actions.onClearSelection} renderAfterLine={renderAfterLine} />
                ) : (
                    body
                )}
                <span className="visually-hidden" aria-live="polite">
                    {announcement}
                </span>
            </div>
        </article>
    );
});

/**
 * Строка-сводка свёрнутой карточки с маркерами тредов на кромке. Маркеры — соседи кнопки сводки,
 * а не её дети: клик по маркеру переключает тред и файл не разворачивает.
 */
function CollapsedRow({ markers, children }: { markers: ReactNode; children: ReactNode }) {
    if (markers === null || markers === undefined) {
        return children;
    }
    return (
        <div className="file-card__collapsed-row">
            <div className="file-card__collapsed-markers">{markers}</div>
            {children}
        </div>
    );
}

function CollapsedFileSummary({
    file,
    counts,
    reason,
    onExpand,
}: {
    file: FileDiff;
    counts: FileCardProps['counts'];
    reason: FileCollapseReason;
    onExpand: () => void;
}) {
    const t = useT();
    const { count } = useFormat();
    const text = t(
        reason === 'viewed'
            ? 'diff.file.collapsed.viewed'
            : reason === 'manual'
              ? 'diff.file.collapsed.manual'
              : 'diff.file.collapsed.generated',
    );
    return (
        <button type="button" className="file-card__collapsed file-card__collapsed--file" onClick={onExpand}>
            <span className="file-card__collapsed-mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            <span className="file-card__add">+{count(counts?.additions ?? file.additions)}</span>
            <span className="file-card__del">−{count(counts?.deletions ?? file.deletions)}</span>
            <span>· {text}</span>
            <span className="file-card__collapsed-spacer" />
            <span className="file-card__collapsed-hint">{t('diff.file.collapsed.hint')}</span>
        </button>
    );
}

/**
 * Шапка карточки: имя файла и путь до него. Разделены, потому что режутся по-разному —
 * каталоги слева и первыми, имя с конца и только когда места не осталось (`diff-view.css`).
 * Старый путь переименования разложен так же: его каталоги уступают место раньше его имени.
 */
function FileName({ file }: { file: FileDiff }) {
    const { dir, name } = splitPath(file.path);
    const oldPath = file.oldPath !== null && file.oldPath !== file.path ? file.oldPath : null;
    const old = oldPath === null ? null : splitPath(oldPath);

    return (
        <span className="file-card__title">
            <span className={`file-card__name${file.changeType === 'delete' ? ' file-card__name--deleted' : ''}`}>
                <bdi>{name}</bdi>
            </span>
            <span className="file-card__path" title={oldPath === null ? file.path : `${oldPath} → ${file.path}`}>
                {/* `bdi` изолирует содержимое от rtl-обрезки: каталоги читаются в обычном порядке. */}
                {old === null ? null : (
                    <>
                        {old.dir === '' ? null : (
                            <span className="file-card__old-path file-card__path-dir">
                                <bdi>{old.dir}</bdi>
                            </span>
                        )}
                        <span className="file-card__old-path file-card__path-name">
                            <bdi>{old.dir === '' ? old.name : `/${old.name}`}</bdi>
                        </span>
                        <span className="file-card__path-arrow">→</span>
                    </>
                )}
                {dir === '' ? null : (
                    <span className="file-card__path-dir">
                        <bdi>{dir}</bdi>
                    </span>
                )}
            </span>
        </span>
    );
}

/**
 * Путь, разложенный на цепочку каталогов и последний сегмент (docs/design/SPEC-elements.md §1.2).
 * Разделитель не входит ни в одну из частей: в шапке имя и каталоги стоят порознь, а у старого
 * пути слэш дописывается к имени — так на краю левой обрезки каталогов не остаётся нейтрального
 * символа, который сбил бы порядок.
 */
function splitPath(path: string): { readonly dir: string; readonly name: string } {
    const cut = path.lastIndexOf('/');
    return cut === -1 ? { dir: '', name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

/**
 * Слот разбора файла (docs/design/SPEC-elements.md §3): место под тело карточки занято сразу, поэтому приземление
 * диффа раскладку не двигает, а подпись загорается только если разбор пережил 200 мс —
 * на быстром файле мигать нечем.
 */
function ParsingSlot({ minHeight }: { minHeight?: number | undefined }) {
    const t = useT();
    const shown = useDelayedPending(true);
    return (
        <div className="file-card__loading" style={minHeight === undefined ? undefined : { minHeight }}>
            {shown ? t('diff.body.parsing') : null}
        </div>
    );
}

/**
 * Бейдж конфликта (docs/design/SPEC-elements.md §2.14, §4.1): файл не смёржен, и это не свойство диффа, а условие
 * работы — маршрут его не покрывает, а разрешают конфликт в хосте. Других бейджей статуса
 * у шапки нет: add/delete/rename читаются из имени и счётчиков.
 */
function ConflictBadge({ file }: { file: FileDiff }) {
    const t = useT();
    if (file.changeType !== 'conflict') {
        return null;
    }
    return <span className="file-card__badge file-card__badge--conflict">{t('file.conflict')}</span>;
}


/**
 * Объявление aria-live после догрузки контекста в пропуске.
 * Пару «догружено N, скрыто H» Полного диффа не трогаем: там `hiddenChanged` всегда 0.
 * На срезе маршрута «скрыто 0» было бы враньём — изменённые строки чужих остановок называем отдельно.
 */
export function expansionAnnouncement(
    loaded: number,
    hidden: number,
    hiddenChanged: number,
    t: Translate,
): string {
    const parts = [t('diff.expand.loaded', loaded)];
    if (hidden > 0 || hiddenChanged === 0) {
        parts.push(t('diff.expand.hidden', hidden));
    }
    if (hiddenChanged > 0) {
        parts.push(t('diff.elsewhere', hiddenChanged));
    }
    return parts.join(', ');
}

/** Единственная кнопка шапки раскрывает файл целиком; шаг 20 живёт на перемычках. */
function ExpandButton({
    model,
    content,
    contentAvailable,
    noContentReason,
    onExpand,
}: {
    model: DiffFileModel | null;
    content: FileContent | null | undefined;
    contentAvailable: boolean;
    noContentReason: string | undefined;
    onExpand: (gapKeys: readonly string[]) => void;
}) {
    const t = useT();
    const gapKeys =
        model?.content.kind === 'text'
            ? model.content.blocks.filter((block) => block.kind === 'gap').map((gap) => gapKeyOf(gap))
            : [];
    // Изменённые строки чужих остановок кнопка раскрыть не может, поэтому она остаётся выключенной,
    // но и «весь файл на экране» про них говорить нельзя.
    const hiddenChanged = model === null ? 0 : remainingHiddenChanged(model);
    const disabledReason = !contentAvailable
        ? (noContentReason ?? t('diff.expand.noContent'))
        : model === null
          ? t('diff.expand.parsing')
          : content === null
            ? t('diff.expand.noFileContent')
            : remainingHiddenLines(model, content ?? null) !== 0
              ? null
              : hiddenChanged > 0
                ? t('diff.expand.allShownElsewhere', t('diff.elsewhere', hiddenChanged))
                : t('diff.expand.allShown');

    return (
        <span className="file-card__expand">
            <button
                type="button"
                className="ctl ctl--ghost ctl--compact file-card__header-action"
                disabled={disabledReason !== null}
                title={disabledReason ?? t('diff.expand.showWholeFile')}
                onClick={() => {
                    onExpand(gapKeys);
                }}
            >
                {t('diff.expand.openFile')}
            </button>
        </span>
    );
}

/**
 * Однострочные нотисы docs/design/SPEC-elements.md §2.14: binary, смена режима, только пробелы.
 * `hideBinary` — карточка показывает саму картинку, и нотис «двоичный файл не показан» ей врал бы; остальные
 * нотисы (смена прав, битый патч) нужны и там.
 */
function Notices({ model, file, hideBinary = false }: { model: DiffFileModel | null; file: FileDiff; hideBinary?: boolean }) {
    const t = useT();
    if (model === null) {
        return null;
    }

    return (
        <>
            {model.content.kind === 'binary' && !hideBinary ? (
                <p className="file-card__notice">{t('diff.notice.binary')}</p>
            ) : null}
            {model.modeChange === null ? null : (
                <p className="file-card__notice">
                    {t('diff.notice.mode', model.modeChange.from, model.modeChange.to)}
                </p>
            )}
            {model.content.kind === 'none' && model.modeChange === null && !file.binary ? (
                <p className="file-card__notice">{t('diff.notice.noText')}</p>
            ) : null}
            {model.malformed ? <p className="file-card__notice">{t('diff.notice.malformed')}</p> : null}
        </>
    );
}

interface BodyProps {
    readonly model: DiffFileModel | null;
    readonly mode: DiffMode;
    readonly content: FileContent | null;
    readonly contextAvailable: boolean;
    readonly loadingMinHeight?: number | undefined;
    readonly selection: LineSelection | null;
    readonly focusedThreadRange: LineRange | null;
    readonly showWhitespace: boolean;
    readonly onShowWhitespace: () => void;
    readonly onSelectStart: (key: LineKey, side: 'old' | 'new', extend: boolean) => void;
    readonly onSelectExtend: (key: LineKey, side: 'old' | 'new') => void;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly renderLineMarker?: ((positions: readonly LinePosition[]) => ReactNode) | undefined;
    readonly onCommentLine?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onExpandContext: (request: ContextExpandRequest) => Promise<GapExpandResult>;
    readonly onContextExpanded: (loaded: number, hidden: number, hiddenChanged: number) => void;
    readonly initialGapError: boolean;
}

function Body(props: BodyProps) {
    const t = useT();
    const { model, mode, content, selection, showWhitespace, onShowWhitespace } = props;

    if (model === null) {
        return <ParsingSlot minHeight={props.loadingMinHeight} />;
    }
    if (model.content.kind !== 'text') {
        return null;
    }
    if (model.whitespaceOnly && !showWhitespace) {
        return (
            <button type="button" className="file-card__notice file-card__notice--button" onClick={onShowWhitespace}>
                {t('diff.body.whitespaceOnly')}
            </button>
        );
    }

    return (
        <div
            className="file-card__body"
            onMouseDown={(event) => {
                // Протяжка начинается с гуттера: в коде мышь оставлена нативному выделению текста.
                const target = event.target as HTMLElement;
                if (target.closest('.diff-row__comment') !== null) {
                    return;
                }
                const keyed = target.closest<HTMLElement>('[data-key]');
                const key = parseLineKey(keyed?.getAttribute('data-key'));
                if (key === null) {
                    return;
                }
                if (target.closest('.diff-row__code') !== null && !event.shiftKey) {
                    return;
                }
                const side = keyed?.dataset.side === 'old' || keyed?.dataset.side === 'new' ? keyed.dataset.side : lineSide(key);
                event.preventDefault();
                props.onSelectStart(key, side, event.shiftKey);
            }}
            onMouseOver={(event) => {
                // Расширяет только начатую в гаттере протяжку — за это отвечает `dragSelection` стора.
                if (event.buttons !== 1) {
                    return;
                }
                const keyed = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
                const key = parseLineKey(keyed?.getAttribute('data-key'));
                if (key !== null) {
                    const side =
                        keyed?.dataset.side === 'old' || keyed?.dataset.side === 'new' ? keyed.dataset.side : lineSide(key);
                    props.onSelectExtend(key, side);
                }
            }}
        >
            <DiffRows
                model={model}
                mode={mode}
                content={content}
                selection={selection}
                focusedThreadRange={props.focusedThreadRange}
                renderAfterLine={props.renderAfterLine}
                renderLineMarker={props.renderLineMarker}
                onCommentLine={props.onCommentLine}
                onLineFocus={props.onLineFocus}
                onLineBlur={props.onLineBlur}
                onExpandContext={props.onExpandContext}
                onContextExpanded={props.onContextExpanded}
                initialGapError={props.initialGapError}
                contextAvailable={props.contextAvailable}
            />
        </div>
    );
}
