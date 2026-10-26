import type {
    AgentNote,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    UiChatAskAnchor,
    UiGenerationCap,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
} from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    fetchFileContent,
    setReviewThreadResolved,
} from '../../api.js';
import type { DiffClient } from '../../diff/client.js';
import { createDiffClient } from '../../diff/client.js';
import type { DiffFileModel } from '../../diff/model.js';
import { toParseRequest } from '../../diff/model.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { readFragmentParam } from '../../fragment.js';
import { useT } from '../../i18n/index.js';
import { readSelectionLink } from '../../selection-link.js';
import type { ProgressWriter } from '../../progress/progress-writer.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import type { RouteSummary } from '../../route/route-summary.js';
import type { SessionStore } from '../../session/session-store.js';
import { createComposerTransport, createPublishedCommentTransport } from '../../threads/transport.js';
import type { ThreadStore } from '../../threads/store.js';
import {
    EMPTY_DELETE_NOTE,
    EMPTY_NOTES,
    EMPTY_OPEN_NOTE,
    RouteWorkspace,
} from './route-workspace.tsx';

/**
 * Вью «Маршрут», пресет триажа (docs/design/README.md §1–2): шапка PR с индикатором снапшота, липкий тулбар
 * и грид остановок — липкая левая колонка с рассказом и правая с реальным диффом, обрезанным
 * якорями остановки.
 *
 * Расщепление как у полного диффа: `RouteView` держит живые ручки — воркер разбора, транспорт
 * тредов, переходы из палитры и из фрагмента адреса, — а всё рисование живёт в `RouteWorkspace`
 * (`route-workspace.tsx`) на чистых пропсах, потому оно и рисуется в галерее состояний. Сторы
 * (дифф, треды, прогресс) приезжают из App теми же экземплярами, что у полного диффа: отметки,
 * черновики и режим диффа обязаны совпадать между вью (docs/product.md §3, принцип 5).
 */

export interface RouteViewProps {
    readonly token: string;
    readonly session: SessionStore;
    readonly pr: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly diffError: string | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly lensesError: string | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly progressError: string | null;
    readonly progressWriter: ProgressWriter | null;
    readonly stopProgress: StopProgressStore | null;
    readonly store: DiffViewStore | null;
    /** Общий разборщик приложения; без него вью поднимает свой воркер (галерея, тесты). */
    readonly parse?: (file: FileDiff) => Promise<DiffFileModel>;
    readonly threadStore: ThreadStore | null;
    readonly snapshot: RouteSnapshot;
    readonly agentConnected: boolean;
    readonly onAskSelection: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange: (anchor: UiChatAskAnchor | null) => void;
    /**
     * Подставить вопрос в композер чата (docs/design/README.md §2): «Прочее» просит агента разложить
     * непокрытые диапазоны. Вопрос не отправляется — его дочитывает и шлёт ревьюер.
     */
    readonly onComposeQuestion?: (text: string) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    readonly selectionNavigationRequest?: number;
    /** Агент отвалился посреди генерации: заполненные остановки получают пометку (docs/design/SPEC-elements.md §4.4). */
    readonly agentStopped?: boolean;
    /** Переход из палитры: растёт `id`, вью доводит прокрутку к остановке. */
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    /** Непокрытого больше порога: App поднимает баннер «стоит перегенерировать» (docs/design/SPEC-elements.md §4.3). */
    readonly onUnderExplained?: (value: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    /** Числа маршрута наружу: их считает только вью, а нужны они панели действий и итогу. */
    readonly onRouteSummary?: (summary: RouteSummary) => void;
    /** Открыть тред по id: ссылки из блока «почему изменилась остановка» (docs/design/README.md §1 п.4). */
    readonly onOpenThread?: (threadId: string) => void;
    /** Правый край шапки: пикер снапшотов из App; без него — статичный индикатор снапшота. */
    readonly headerAside?: ReactNode;
    /** Кап генерации из состояния сервера (docs/design/SPEC-elements.md §4.1): строка под полосой покрытия. */
    readonly generationCap?: UiGenerationCap | null;
}

export function RouteView({
    token,
    session,
    pr,
    diff,
    diffError,
    lenses,
    lensesError,
    progress,
    progressError,
    progressWriter,
    stopProgress,
    store,
    parse: sharedParse,
    threadStore,
    snapshot,
    agentConnected,
    onAskSelection,
    isSelectionPending,
    onSelectionAnchorChange,
    onComposeQuestion,
    notes = EMPTY_NOTES,
    onOpenNoteInChat = EMPTY_OPEN_NOTE,
    onDeleteNote = EMPTY_DELETE_NOTE,
    selectionNavigationRequest = 0,
    agentStopped = false,
    navigation = null,
    onUnderExplained,
    onFillStop,
    onRouteSummary,
    onOpenThread,
    headerAside,
    generationCap = null,
}: RouteViewProps) {
    const t = useT();
    const clientRef = useRef<DiffClient | null>(null);
    // Свой воркер — только без общего разборщика App, как в полном диффе; модели кешируются в общем сторе.
    useEffect(
        () => () => {
            clientRef.current?.close();
            clientRef.current = null;
        },
        [],
    );

    const diffId = diff?.diffId ?? null;
    const ownParse = useCallback(
        (file: FileDiff) => {
            clientRef.current ??= createDiffClient();
            return clientRef.current.parseFile(diffId ?? '', toParseRequest(file));
        },
        [diffId],
    );
    const parse = sharedParse ?? ownParse;
    const loadContent = useCallback((fileId: string) => fetchFileContent(token, fileId), [token]);
    const threadTransport = useMemo(() => createComposerTransport(token), [token]);
    const publishedTransport = useMemo(() => createPublishedCommentTransport(token), [token]);
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    // Два источника перехода к остановке — палитра и параметр `stop` во фрагменте (ссылка,
    // скопированная из шапки остановки). Счётчик один: вью различает переходы по растущему id.
    const [target, setTarget] = useState<{ id: number; stopId: string } | null>(null);
    const [selectionTarget, setSelectionTarget] = useState(() => readSelectionLink(window.location.hash));
    const targetId = useRef(0);
    const jumpTo = useCallback((stopId: string) => {
        targetId.current += 1;
        setTarget({ id: targetId.current, stopId });
    }, []);
    const fragmentStop = useRef<string | null>(null);
    useEffect(() => {
        const read = (): void => {
            setSelectionTarget(readSelectionLink(window.location.hash));
            const stopId = readFragmentParam(window.location.hash, 'stop');
            if (stopId === null || stopId === fragmentStop.current) {
                return;
            }
            fragmentStop.current = stopId;
            jumpTo(stopId);
        };
        read();
        window.addEventListener('hashchange', read);
        return () => {
            window.removeEventListener('hashchange', read);
        };
    }, [jumpTo]);
    const requestedSelectionTarget = useMemo(
        () => (selectionNavigationRequest === 0 ? selectionTarget : readSelectionLink(window.location.hash)),
        [selectionNavigationRequest, selectionTarget],
    );
    const paletteJump = useRef<number | null>(null);
    useEffect(() => {
        if (navigation === null || paletteJump.current === navigation.id) {
            return;
        }
        paletteJump.current = navigation.id;
        jumpTo(navigation.stopId);
    }, [jumpTo, navigation]);
    if (
        diffError !== null ||
        lensesError !== null ||
        (progress === null && progressError !== null) ||
        pr === null ||
        diff === null ||
        lenses === null ||
        progressWriter === null ||
        stopProgress === null ||
        store === null ||
        threadStore === null
    ) {
        return (
            <main className="route route--status" id="view-route">
                <p className="route__status">{diffError ?? lensesError ?? progressError ?? t('route.loading')}</p>
            </main>
        );
    }

    return (
        <RouteWorkspace
            pr={pr}
            diff={diff}
            lenses={lenses}
            snapshot={snapshot}
            agentStopped={agentStopped}
            session={session}
            store={store}
            threadStore={threadStore}
            progressWriter={progressWriter}
            stopProgress={stopProgress}
            progressLoaded={progress !== null}
            parse={parse}
            loadContent={loadContent}
            threadTransport={threadTransport}
            publishedTransport={publishedTransport}
            onResolveThread={resolveThread}
            navigation={target}
            initialSelectionTarget={requestedSelectionTarget}
            selectionNavigationRequest={selectionNavigationRequest}
            agentConnected={agentConnected}
            onAskSelection={onAskSelection}
            isSelectionPending={isSelectionPending}
            onSelectionAnchorChange={onSelectionAnchorChange}
            {...(onComposeQuestion === undefined ? {} : { onComposeQuestion })}
            notes={notes}
            onOpenNoteInChat={onOpenNoteInChat}
            onDeleteNote={onDeleteNote}
            {...(onUnderExplained === undefined ? {} : { onUnderExplained })}
            {...(onFillStop === undefined ? {} : { onFillStop })}
            {...(onRouteSummary === undefined ? {} : { onRouteSummary })}
            {...(onOpenThread === undefined ? {} : { onOpenThread })}
            {...(headerAside === undefined ? {} : { headerAside })}
            generationCap={generationCap}
        />
    );
}
