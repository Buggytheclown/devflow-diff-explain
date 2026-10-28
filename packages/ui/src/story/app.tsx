import type { ChatExplanation, CodeLocation, PrDiff, RouteSnapshot, UiChatAskAnchor, UiChatResponse, UiRouteState } from '@sherpa/protocol';
import { explanationText } from '@sherpa/protocol';
import { useEffect, useEffectEvent, useRef, useReducer, useState, useSyncExternalStore } from 'react';

import { askReviewChat, cancelReviewChat, cancelRouteGeneration, fillRouteStop, fetchReviewChat, fetchReviewRoute, generateReviewRoute, retryReviewChat, retryRouteDiagram } from '../api.js';
import type { Store } from '../store.js';
import type { StorySession } from './session.js';
import { reconnectCommand } from '../components/reconnect-command.js';
import { ChatPanel } from '../components/chat-panel.tsx';
import '../diff-view/diff-view.css';
import { useLocale } from '../i18n/index.js';
import { storyCopy, guidedCopy, preparationCopy } from '../i18n/story.js';
import { createStoryData } from './data.js';
import { EvidenceSource } from './evidence.tsx';
import { ReadFile } from './read-file.tsx';
import { GuidedDocument } from './guided-document.tsx';
import { StoryDocument } from './story-document.tsx';
import { useReadingSession } from './use-reading-session.js';
import { initialNavigation, visitReader } from './navigation.js';
import { OverviewSkeleton, Preparation } from './preparation.tsx';
import { readReader, writeCache } from './reading-cache.js';
import './story.css';

export { StoryDocument } from './story-document.tsx';

const EMPTY_CHAT: UiChatResponse = { exchanges: [], notes: [], chatRevision: 0 };
const noop = (): void => undefined;

export function App({ store, session, token }: { store: Store; session: StorySession; token: string }) {
    const locale = useLocale();
    const t = storyCopy[locale];
    const pt = preparationCopy[locale];
    const stream = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const ui = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const [route, setRoute] = useState<UiRouteState | null>(null);
    const routeLoaded = route !== null;
    const [diff, setDiff] = useState<PrDiff | null>(null);
    const [chat, setChat] = useState<UiChatResponse>(EMPTY_CHAT);
    const [error, setError] = useState<string | null>(null);
    const [chatError, setChatError] = useState<string | null>(null);
    const [cached] = useState(readReader);
    const [reader, visit] = useReducer(visitReader, cached?.navigation ?? initialNavigation);
    const [selectedSnapshotId, selectSnapshot] = useState<string | null>(cached?.snapshotId ?? null);
    const [snapshots, setSnapshots] = useState(() => new Map<string, RouteSnapshot>());
    const { guide: guidePosition, returnTo: guideReturn, resume: guideResume, location: navigation, epoch: navigationEpoch } = reader;
    const diffVersion = diff?.diffId ?? null;
    const showDiff = ui.view === 'diff';
    const [query, setQuery] = useState('');
    const [draft, setDraft] = useState(cached?.draft ?? '');
    const [contextTitle, setContextTitle] = useState(cached?.contextTitle ?? '');
    const [filesOpen, setFilesOpen] = useState(false);
    const [anchor, setAnchor] = useState<UiChatAskAnchor | null>(cached?.anchor ?? null);
    const [anchorText, setAnchorText] = useState<string | null>(cached?.anchorText ?? cached?.anchor?.selectedText ?? null);
    const [explanation, setExplanation] = useState<ChatExplanation | undefined>(cached?.explanation);
    const [focus, setFocus] = useState(0);
    const [data] = useState(() => createStoryData(token));
    const fileId = reader.address?.kind === 'diff' ? reader.address.fileId : diff === null ? null : data.view(diff.diffId).fileId;
    const chosenId = selectedSnapshotId ?? route?.snapshot?.snapshotId;
    const snapshot = (chosenId === undefined ? null : snapshots.get(chosenId)) ?? null;
    const guidePage = guidePosition !== null && guidePosition.snapshotId === snapshot?.snapshotId ? guidePosition.page : 'intro';
    const guided = snapshot !== null && (snapshot.storyContractVersion ?? 0) >= 3;
    const gt = guidedCopy[locale];
    const intro = !showDiff && (snapshot === null || guided && guidePage === 'intro');
    const guideFileId = !showDiff && guided && guidePage.startsWith('file:') ? guidePage.slice(5) : null;
    const guideScope = storyScope(snapshot?.snapshotId, stream.state?.prKey ?? '', guided ? guidePage : 'intro');
    const active = stream.state?.iterations.find((iteration) => iteration.status === 'active')?.diffId;
    const viewedDiffId = (showDiff ? diffVersion ?? active : snapshot?.diffId) ?? active ?? null;
    const worker = stream.state?.worker ?? { kind: 'never' as const };
    const connected = worker.kind === 'connected';
    const tasks = stream.state?.tasks ?? [];
    const generating = route?.phase === 'reading' || route?.phase === 'filling';
    const selectedFile = diff?.files.find((file) => file.fileId === (guideFileId ?? fileId)) ?? diff?.files[0] ?? null;
    const storyKey = snapshot === null ? null : `story:${stream.state?.prKey ?? ''}:${snapshot.snapshotId}`;
    const scope = showDiff ? `diff:${diff?.diffId ?? ''}:${selectedFile?.fileId ?? ''}` : guideScope ?? 'empty';
    const readingRoot = useRef<HTMLElement | null>(null);
    const reading = useReadingSession(readingRoot, scope, storyKey);
    const layout = (): void => { if (!reading.isPending()) reading.preserve(); reading.ready(); };
    const beforeRoute = useEffectEvent(() => { reading.preserve(); });
    useEffect(() => store.subscribe(() => { beforeRoute(); }), [store]);
    useEffect(() => () => { data.close(); }, [data]);
    useEffect(() => {
        let alive = true;
        void fetchReviewRoute(token).then((response) => {
            if (alive) { beforeRoute(); setRoute(response.route); const next = response.route.snapshot;
                if (next?.presentation === 'story') { setSnapshots((value) => new Map(value).set(next.snapshotId, next)); selectSnapshot((value) => value ?? next.snapshotId); }
                setError(null); }
        }, (reason: unknown) => { if (alive) setError(String(reason)); });
        return () => { alive = false; };
    }, [token, stream.routeRevision, active]);
    useEffect(() => {
        if (!routeLoaded || selectedSnapshotId === null || snapshots.has(selectedSnapshotId)) return;
        let alive = true;
        void fetchReviewRoute(token, selectedSnapshotId).then(({ route: saved }) => {
            if (alive && saved.snapshot !== null) { const value = saved.snapshot; setSnapshots((entries) => new Map(entries).set(value.snapshotId, value)); }
        }, (reason: unknown) => { if (alive) { setError(String(reason)); selectSnapshot(null); } });
        return () => { alive = false; };
    }, [selectedSnapshotId, snapshots, token, routeLoaded]);
    useEffect(() => { if (cached?.chatOpen === true) session.setChatOpen(true); }, [cached?.chatOpen, session]);
    useEffect(() => { writeCache('reader', { snapshotId: selectedSnapshotId, navigation: reader, draft, anchor, anchorText, explanation, contextTitle, chatOpen: ui.chatOpen }); }, [selectedSnapshotId, reader, draft, anchor, anchorText, explanation, contextTitle, ui.chatOpen]);
    useEffect(() => {
        const target = showDiff && reader.address?.kind === 'diff' ? reader.address.diffId : snapshot?.diffId ?? active ?? null;
        if (diffVersion !== null && (target === null || target === diffVersion)) return;
        let alive = true;
        void data.diff(target).then((value) => {
            if (alive) { setDiff(value); setError(null); }
        }, (reason: unknown) => { if (alive) setError(String(reason)); });
        return () => { alive = false; };
    }, [data, diffVersion, active, snapshot?.diffId, showDiff, reader.address]);
    useEffect(() => {
        let alive = true;
        void fetchReviewChat(token).then((value) => { if (alive) { setChat(value); setChatError(null); } },
            (reason: unknown) => { if (alive) setChatError(String(reason)); });
        return () => { alive = false; };
    }, [token, stream.chatRevision]);

    const capture = (sectionId?: string): ChatExplanation | undefined => snapshot === null || (showDiff && diff?.diffId !== snapshot.diffId) ? (diff === null ? undefined : { snapshotId: null, diffId: diff.diffId, commit: diff.headCommit, text: '' }) : ({
        snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, commit: snapshot.commit,
        ...(sectionId === undefined ? {} : { sectionId }), text: explanationText(snapshot, sectionId),
    });
    const selectCode = (selected: UiChatAskAnchor, text: string | null, sectionId?: string): void => {
        reading.preserve();
        if (anchor?.diffId !== undefined) data.updateFile(anchor.diffId, anchor.fileId, { highlight: null });
        setAnchor(selected); setAnchorText(text);
        setExplanation(capture(sectionId)); setContextTitle(selected.path);
    };
    const removeSelection = (): void => {
        reading.preserve();
        if (anchor?.diffId !== undefined) data.updateFile(anchor.diffId, anchor.fileId, { highlight: null });
        window.getSelection()?.removeAllRanges();
        setAnchor(null); setAnchorText(null);
    };
    const openChat = (sectionId?: string): void => {
        if (anchor === null && (sectionId !== undefined || explanation === undefined)) {
            setExplanation(capture(sectionId));
            setContextTitle(sectionId === 'intro' ? t.introduction : snapshot?.stops.flatMap((stop) => stop.guidedFiles ?? []).find((file) => `file:${file.fileId}` === sectionId)?.path ?? snapshot?.stops.find((stop) => stop.id === sectionId)?.title ?? '');
        }
        reading.preserve(); session.setChatOpen(true);
        setFocus((value) => value + 1);
    };
    const closeOverlay = (): void => { if (window.matchMedia('(max-width: 1100px)').matches) session.setChatOpen(false); };
    const leave = (sectionId?: string): number => {
        const epoch = reading.begin();
        if (!showDiff && storyKey !== null) {
            const memory = reading.saved(storyKey);
            reading.setOrigin({ storyKey, sectionId: sectionId ?? (guided ? guidePage : memory.position?.address.split(':')[0] ?? 'intro'), focus: memory.focus });
        }
        return epoch;
    };
    const goGuide = async (page: string, location?: CodeLocation, remember = false): Promise<void> => {
        if (snapshot === null) return;
        const epoch = reading.begin();
        try {
            const value = await data.diff(snapshot.diffId);
            if (!reading.isCurrent(epoch)) return;
            if (location !== undefined) {
                const file = value.files.find((entry) => (location.side === 'old' ? entry.oldPath ?? entry.path : entry.path) === location.path);
                if (file === undefined) throw new Error(t.unavailable);
                page = `file:${file.fileId}`;
                data.updateFile(value.diffId, file.fileId, { highlight: { ...location, diffId: value.diffId, fileId: file.fileId } });
            }
            setDiff(value); setFilesOpen(false); setError(null);
            visit({ kind: 'guide', address: { kind: 'guide', snapshotId: snapshot.snapshotId, page }, remember, epoch, location: location === undefined ? null : { ...location, diffId: value.diffId } });
            session.setView('route'); closeOverlay();
            const target = storyScope(snapshot.snapshotId, stream.state?.prKey ?? '', page) ?? 'empty';
            if (location === undefined) reading.restore(target, epoch, 'guide-heading'); else reading.code(target, epoch, location);
        } catch (reason) { if (reading.isCurrent(epoch)) { setError(String(reason)); reading.cancel(); } }
    };
    const goDiff = async (version: string | null, id?: string, location?: CodeLocation, sectionId?: string): Promise<void> => {
        if (guided && sectionId !== undefined && version === snapshot.diffId && location !== undefined) { await goGuide('intro', location); return; }
        const epoch = leave(sectionId);
        try {
            const value = await data.diff(version);
            if (!reading.isCurrent(epoch)) return;
            const memory = data.view(value.diffId);
            const file = location === undefined ? value.files.find((entry) => entry.fileId === (id ?? memory.fileId)) ?? value.files[0]
                : value.files.find((entry) => (location.side === 'old' ? entry.oldPath ?? entry.path : entry.path) === location.path);
            if (file === undefined) throw new Error(t.unavailable);
            if (location !== undefined) data.updateFile(value.diffId, file.fileId, { highlight: { ...location, diffId: value.diffId, fileId: file.fileId } });
            data.updateView(value.diffId, { fileId: file.fileId });
            setDiff(value); setQuery(memory.query); visit({ kind: 'diff', address: { kind: 'diff', diffId: value.diffId, fileId: file.fileId }, epoch, location: location === undefined ? null : { ...location, diffId: value.diffId } });
            setFilesOpen(false); setError(null); closeOverlay(); session.setView('diff');
            const target = `diff:${value.diffId}:${file.fileId}`;
            if (location === undefined) reading.restore(target, epoch);
            else reading.code(target, epoch, location);
        } catch (reason) { if (reading.isCurrent(epoch)) { setError(String(reason)); reading.cancel(); } }
    };
    const openCode = (location: CodeLocation, diffId: string): void => { if (guided && diffId === snapshot.diffId) void goGuide('intro', location, true); else void goDiff(diffId, undefined, location); };
    const backToStory = (): void => {
        const epoch = reading.begin();
        const point = reading.origin;
        visit({ kind: 'return', epoch });
        session.setView('route'); closeOverlay(); setFilesOpen(false);
        if (guideScope !== null) reading.restore(guideScope, epoch, point?.storyKey === storyKey ? point.focus : null);
        reading.setOrigin(null);
    };
    const generate = (): void => {
        setError(null);
        void generateReviewRoute(token, locale).catch((reason: unknown) => { setError(String(reason)); });
    };
    const files = diff?.files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase())) ?? [];
    return <div data-preparing={connected && generating && route.generation?.status !== 'cancelled'} className={`story-app${ui.chatOpen ? ' story-app--chat' : ''}${intro ? ' story-app--intro' : ''}`}>
        <header className="story-topbar">
            <strong><span aria-hidden="true">◆</span> Devflow</strong>
            <span className="story-pr-key">{stream.state?.prKey ?? ''}</span>
            <nav aria-label={t.contents}>
                {guided || snapshot === null ? <><button className="ctl" disabled={snapshot === null} aria-current={intro ? 'page' : undefined} onClick={() => { void goGuide('intro'); }}>{gt.description}</button>
                    <button className="ctl" disabled={snapshot === null} aria-current={!showDiff && !intro ? 'page' : undefined} onClick={() => { void goGuide(guideResume?.snapshotId === snapshot?.snapshotId ? guideResume?.page ?? 'intro' : snapshot?.tourOrder[0] ?? 'intro'); }}>{gt.blocks}</button></>
                    : <button className="ctl" aria-current={!showDiff ? 'page' : undefined} onClick={backToStory}>{showDiff && reading.origin !== null ? t.returnTo : t.story}</button>}
                <button className="ctl" aria-current={showDiff ? 'page' : undefined} onClick={() => { void goDiff(diffVersion ?? snapshot?.diffId ?? active ?? null); }}>{guided ? gt.allChanges : t.diff}</button>
            {showDiff || guided ? <button className="ctl story-files-toggle" aria-expanded={filesOpen} onClick={() => { setFilesOpen((value) => !value); }}>{filesOpen ? t.closeFiles : t.files}</button> : null}
            </nav>
            <div className="story-settings">
                <button className="ctl" onClick={() => { openChat(); }}>{t.chat}</button>
            </div>
        </header>
        <Preparation route={route} connected={connected} displayedId={snapshot?.snapshotId}
            onCancel={route?.generation === undefined ? undefined : () => { const id = route.generation?.id; if (id !== undefined) void cancelRouteGeneration(token, id).catch((reason: unknown) => { setError(String(reason)); }); }}
            onOpenLatest={route?.snapshot == null ? undefined : () => { const latest = route.snapshot; if (latest === null) return; const epoch = reading.begin(); selectSnapshot(latest.snapshotId); visit({ kind: 'guide', address: { kind: 'guide', snapshotId: latest.snapshotId, page: 'intro' }, epoch, location: null, remember: false }); reading.restore(storyScope(latest.snapshotId, stream.state?.prKey ?? '', 'intro') ?? 'empty', epoch, 'intro'); session.setView('route'); }} />
        <aside className={`story-nav${filesOpen ? ' story-nav--open' : ''}`} aria-label={t.contents} hidden={intro && !filesOpen}>
            {showDiff ? <><input aria-label={t.fileSearch} placeholder={t.fileSearch} value={query} onChange={(event) => { setQuery(event.target.value); if (diff !== null) data.updateView(diff.diffId, { query: event.target.value }); }} />
                {files.map((file) => <button className="ctl" key={file.fileId} aria-current={selectedFile?.fileId === file.fileId ? 'page' : undefined} onClick={() => { void goDiff(diffVersion, file.fileId); }}>{file.path}</button>)}
                {files.length === 0 ? <p>{diff?.files.length === 0 ? t.noFiles : t.noMatch}</p> : null}</>
                : guided ? <><button className="ctl" aria-current={guidePage === 'intro' ? 'page' : undefined} onClick={() => { void goGuide('intro'); }}>{gt.description}</button>{snapshot.tourOrder.map((id, index) => { const stop = snapshot.stops.find((entry) => entry.id === id); return stop === undefined ? null : <div className="story-nav-block" key={id}><button className="ctl" aria-current={guidePage === id ? 'page' : undefined} onClick={() => { void goGuide(id); }}>{index + 1}. {stop.title}</button>{stop.guidedFiles?.map((file) => <button className="ctl story-nav-file" key={file.fileId} aria-label={file.path} title={file.path} aria-current={guidePage === `file:${file.fileId}` ? 'page' : undefined} onClick={() => { void goGuide(`file:${file.fileId}`); }}><span>{file.path.split('/').at(-1)}</span><small>{file.path.slice(0, Math.max(0, file.path.lastIndexOf('/')))}</small></button>)}</div>; })}</> : <><p>{t.contents}</p>{snapshot?.tourOrder.map((id) => {
                    const stop = snapshot.stops.find((entry) => entry.id === id);
                    return stop === undefined ? null : <a key={id} href={`#section-${id}`} onClick={(event) => { event.preventDefault(); reading.cancel(); document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth' }); }}>{stop.title}</a>;
                })}</>}
        </aside>
        <main ref={readingRoot} data-reading-scope={scope} className={`story-main${showDiff || guideFileId !== null ? ' story-main--diff' : ''}`}>
            <h1>{stream.state?.pr?.title ?? stream.state?.prKey ?? t.loading}</h1>
            {!showDiff && (guidePage === 'intro' || snapshot === null) ? <p className="story-pr-metadata">{stream.state?.pr == null ? null : <><a href={stream.state.pr.url} target="_blank" rel="noreferrer">{stream.state.prKey}</a> · {stream.state.pr.author.displayName ?? stream.state.pr.author.login} · {stream.state.pr.fromBranch} → {stream.state.pr.toBranch} · {stream.state.pr.statusLabel || stream.state.pr.state}</>}{diff === null || (snapshot !== null && diff.diffId !== snapshot.diffId) ? null : <> · {diff.files.length} {pt.fileCount} · +{diff.files.reduce((sum, file) => sum + file.additions, 0)} / −{diff.files.reduce((sum, file) => sum + file.deletions, 0)}</>}</p> : null}
            {showDiff && reading.origin !== null ? <button className="ctl story-return" onClick={backToStory}>{t.returnTo} · {reading.origin.sectionId === 'intro' ? t.introduction : snapshot?.stops.flatMap((stop) => stop.guidedFiles ?? []).find((file) => `file:${file.fileId}` === reading.origin?.sectionId)?.path ?? snapshot?.stops.find((stop) => stop.id === reading.origin?.sectionId)?.title ?? t.introduction}</button> : null}
            {showDiff && diffVersion !== active && active !== undefined ? <p><button className="ctl" onClick={() => { void goDiff(active); }}>{t.newDiff}</button></p> : null}
            {!showDiff && snapshot !== null && (snapshot.storyContractVersion ?? 0) < 5 && route?.stale == null ? <p className="story-notice">{snapshot.storyContractVersion === undefined ? t.legacy : pt.legacy} <button className="ctl" disabled={generating || !connected} onClick={generate}>{t.refresh}</button></p> : null}
            {snapshot === null ? null : <p className="story-provenance">{(showDiff ? diff?.headCommit ?? snapshot.commit : snapshot.commit).slice(0, 12)} · {snapshot.provenance.harness} · {snapshot.provenance.model}</p>}
            {error === null ? null : <p role="alert" className="story-notice">{error}</p>}
            {route?.stale == null ? null : <div className="story-notice">{t.stale} <button className="ctl" disabled={generating || !connected} onClick={generate}>{t.refresh}</button></div>}
            {!connected ? <p className="story-notice">{t.offline}</p> : null}
            {stream.state?.generationCap?.truncated && snapshot?.snapshotId === route?.snapshot?.snapshotId ? <p className="story-notice">{t.incomplete}</p> : null}
            {route?.failure == null ? null : <p role="alert" className="story-notice">{route.failure.message} <button className="ctl" onClick={generate} disabled={!connected}>{t.retry}</button></p>}
            {showDiff ? (diff === null ? <p data-reading-wait>{t.loading}</p> : selectedFile === null ? <p>{t.noFiles}</p>
                : <ReadFile key={`${diff.diffId}:${selectedFile.fileId}:${String(navigationEpoch)}`} file={selectedFile} diffId={diff.diffId} data={data} token={token} current={diff.diffId === active} navigation={navigation ?? undefined} anchor={anchor} onSelect={(selected, text) => { selectCode(selected, text); }} onLayout={layout} onMediaLayout={reading.relayout} />)
                : snapshot === null ? <>{!generating ? <div><p>{t.empty}</p><button className="ctl ctl--primary" disabled={!connected} onClick={generate}>{t.generate}</button></div> : null}<OverviewSkeleton /></>
                    : guided ? <GuidedDocument snapshot={snapshot} page={guidePage} onVisit={(page, remember) => { void goGuide(page, undefined, remember); }} onBack={guideReturn?.snapshotId === snapshot.snapshotId ? () => { void goGuide(guideReturn.page); } : undefined} returnLabel={guideReturn?.page === 'intro' ? gt.description : snapshot.stops.find((stop) => stop.id === guideReturn?.page)?.title ?? t.returnTo} onAsk={openChat} onRetry={(id) => { const stop = snapshot.stops.find((entry) => entry.id === id); if (stop !== undefined) void fillRouteStop(token, { snapshotId: snapshot.snapshotId, planIndex: stop.planIndex }).catch((reason: unknown) => { setError(String(reason)); }); }}
                        connected={connected} onRetryDiagram={route?.phase === 'reading' || snapshot.snapshotId !== route?.snapshot?.snapshotId ? undefined : () => { void retryRouteDiagram(token, snapshot.snapshotId).catch((reason: unknown) => { setError(String(reason)); }); }}
                        onDiagramFailure={route?.phase === 'reading' || snapshot.snapshotId !== route?.snapshot?.snapshotId ? undefined : () => { void retryRouteDiagram(token, snapshot.snapshotId, true).catch((reason: unknown) => { setError(String(reason)); }); }}
                        renderDescription={<StoryDocument snapshot={{ ...snapshot, stops: [], tourOrder: [] }} onAsk={openChat} expanded={reading.expanded} onToggle={reading.toggle} onOpenSource={(source) => { void goGuide(`file:${source.fileId}`, source.kind === 'lines' ? source : undefined, true); }} renderSource={(source, sectionId, index) =>
                            <EvidenceSource key={`${sectionId}:${String(index)}`} source={source} diffId={snapshot.diffId} data={data} token={token} focusId={`source:${sectionId}:${String(index)}`} onLayout={layout} onMediaLayout={reading.relayout} anchor={anchor} onSelect={(selected, text) => { selectCode(selected, text, sectionId); }} onOpen={(id, location) => { void goGuide(`file:${id}`, location, true); }} />
                        } />}
                        renderFile={(id) => { const file = diff?.diffId === snapshot.diffId ? diff.files.find((entry) => entry.fileId === id) : undefined; const explanation = snapshot.stops.flatMap((stop) => stop.guidedFiles ?? []).find((entry) => entry.fileId === id); return file === undefined ? <p data-reading-wait>{t.loading}</p> : <ReadFile key={`${snapshot.diffId}:${id}:${String(navigationEpoch)}`} file={file} diffId={snapshot.diffId} data={data} token={token} current={snapshot.diffId === active} navigation={navigation ?? undefined} annotations={explanation?.annotations} anchor={anchor} onSelect={(selected, text) => { selectCode(selected, text, `file:${id}`); }} onLayout={layout} onMediaLayout={reading.relayout} />; }} />
                    : <StoryDocument snapshot={snapshot} onAsk={openChat} expanded={reading.expanded} onToggle={reading.toggle} renderSource={(source, sectionId, index) =>
                        <EvidenceSource key={`${sectionId}:${String(index)}`} source={source} diffId={snapshot.diffId} data={data} token={token} focusId={`source:${sectionId}:${String(index)}`} onLayout={layout} onMediaLayout={reading.relayout}
                            anchor={anchor} onSelect={(selected, text) => { selectCode(selected, text, sectionId); }} onOpen={(id, location) => { void goDiff(snapshot.diffId, id, location, sectionId); }} />
                    } />}

        </main>
        {ui.chatOpen ? <aside className="story-chat">
            <div className="story-chat-context">{t.pinned}{contextTitle === '' ? '' : ` · ${contextTitle}`} · {(explanation?.commit ?? diff?.headCommit ?? '').slice(0, 12)}
                <button className="ctl" onClick={() => { setExplanation(capture()); setContextTitle(''); if (anchor?.diffId !== viewedDiffId) removeSelection(); }}>{t.refreshContext}</button>
                {explanation?.sectionId === undefined ? null : <button className="ctl" onClick={() => { removeSelection(); setExplanation(capture()); setContextTitle(''); }}>{t.clear}</button>}
            </div>
            <ChatPanel composerText={draft} onComposerTextChange={setDraft} worker={worker} tasks={tasks} exchanges={chat.exchanges.filter((exchange) => exchange.explanation?.diffId === (explanation?.diffId ?? viewedDiffId))} notes={[]} loading={false} error={chatError}
                reconnectCommand={reconnectCommand(stream.state?.prKey ?? '')} anchor={anchor} anchorText={anchorText} focusRequest={focus} scrollRequest={null} onScrollRequestHandled={noop}
                onClose={() => { reading.preserve(); session.setChatOpen(false); }} onRemoveAnchor={removeSelection} viewDiffId={viewedDiffId}
                onAsk={async (text, selected) => {
                    const pinned = explanation ?? capture();
                    if (pinned === undefined) throw new Error(t.loading);
                    if (selected !== undefined && anchorText === null) throw new Error(t.unavailable);
                    const answer = await askReviewChat(token, text, selected, locale, pinned);
                    setChat((value) => ({ ...value, exchanges: [...value.exchanges.filter((entry) => entry.id !== answer.id), answer] }));
                    return answer;
                }}
                onCancel={async (id) => { await cancelReviewChat(token, id); setChat(await fetchReviewChat(token)); }}
                onRetry={async (id) => { await retryReviewChat(token, id); setChat(await fetchReviewChat(token)); }}
                onNavigate={(selected) => { openCode(selected, selected.diffId); }} onNavigateCode={openCode} onNavigateToNote={noop} suggestions={false} />
        </aside> : null}
    </div>;
}

function storyScope(snapshotId: string | undefined, prKey: string, page: string): string | null {
    return snapshotId === undefined ? null : `story:${prKey}:${snapshotId}${page === 'intro' ? '' : `:${page}`}`;
}
