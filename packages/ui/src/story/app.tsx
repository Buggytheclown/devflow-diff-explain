import type { ChatExplanation, CodeLocation, PrDiff, UiChatAskAnchor, UiChatResponse, UiRouteState } from '@sherpa/protocol';
import { explanationText } from '@sherpa/protocol';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';

import { askReviewChat, cancelReviewChat, cancelTask, fillRouteStop, fetchReviewChat, fetchReviewRoute, generateReviewRoute, retryReviewChat } from '../api.js';
import type { AppProps } from '../app.tsx';
import { reconnectCommand } from '../components/reconnect-command.js';
import { ChatPanel } from '../components/chat-panel.tsx';
import '../diff-view/diff-view.css';
import { useLocale } from '../i18n/index.js';
import { storyCopy, guidedCopy } from '../i18n/story.js';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import { createStoryData } from './data.js';
import { EvidenceSource } from './evidence.tsx';
import { ReadFile } from './read-file.tsx';
import { GuidedDocument } from './guided-document.tsx';
import { StoryDocument } from './story-document.tsx';
import { useReadingSession } from './use-reading-session.js';
export { SelectionBar } from './selection-bar.tsx';
export { StoryDocument } from './story-document.tsx';
import './story.css';

const EMPTY_CHAT: UiChatResponse = { exchanges: [], notes: [], chatRevision: 0 };
const noop = (): void => undefined;

export function App({ store, session, token }: AppProps) {
    const locale = useLocale();
    const t = storyCopy[locale];
    const settings = useUiSettingsStore();
    const preferences = useUiSettings();
    const stream = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const ui = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const [route, setRoute] = useState<UiRouteState | null>(null);
    const [diff, setDiff] = useState<PrDiff | null>(null);
    const [chat, setChat] = useState<UiChatResponse>(EMPTY_CHAT);
    const [error, setError] = useState<string | null>(null);
    const [chatError, setChatError] = useState<string | null>(null);
    const [fileId, setFileId] = useState<string | null>(null);
    const [diffVersion, setDiffVersion] = useState<string | null>(null);
    const showDiff = ui.view === 'diff';
    const [guideReturn, setGuideReturn] = useState<{ snapshotId: string; page: string } | null>(null);
    const [guidePosition, setGuidePosition] = useState<{ snapshotId: string; page: string } | null>(null);
    const [query, setQuery] = useState('');
    const [draft, setDraft] = useState('');
    const [contextTitle, setContextTitle] = useState('');
    const [navigationEpoch, setNavigationEpoch] = useState(0);
    const [navigation, setNavigation] = useState<(CodeLocation & { diffId: string }) | null>(null);
    const [filesOpen, setFilesOpen] = useState(false);
    const [anchor, setAnchor] = useState<UiChatAskAnchor | null>(null);
    const [explanation, setExplanation] = useState<ChatExplanation | undefined>();
    const [focus, setFocus] = useState(0);
    const [data] = useState(() => createStoryData(token));
    const snapshot = route?.snapshot?.presentation === 'story' ? route.snapshot : null;
    const guidePage = guidePosition !== null && guidePosition.snapshotId === snapshot?.snapshotId ? guidePosition.page : 'intro';
    const guided = snapshot !== null && (snapshot.storyContractVersion ?? 0) >= 3;
    const gt = guidedCopy[locale];
    const intro = !showDiff && guided && guidePage === 'intro';
    const guideResume = useRef<{ snapshotId: string; page: string } | null>(null);
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
            if (alive) { beforeRoute(); setRoute(response.route); setError(null); }
        }, (reason: unknown) => { if (alive) setError(String(reason)); });
        return () => { alive = false; };
    }, [token, stream.routeRevision, active]);
    useEffect(() => {
        if (diffVersion !== null) return;
        let alive = true;
        void data.diff(active ?? null).then((value) => {
            if (alive) { setDiff(value); setDiffVersion(value.diffId); setError(null); }
        }, (reason: unknown) => { if (alive) setError(String(reason)); });
        return () => { alive = false; };
    }, [data, diffVersion, active]);
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
    const openChat = (sectionId?: string, selected?: UiChatAskAnchor): void => {
        if (sectionId !== undefined || selected !== undefined || explanation === undefined) {
            setExplanation(capture(sectionId));
            setAnchor(selected ?? null);
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
            reading.setOrigin({ storyKey, sectionId: sectionId ?? memory.position?.address.split(':')[0] ?? 'intro', focus: memory.focus });
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
                data.updateFile(value.diffId, file.fileId, { selected: { ...location, diffId: value.diffId, fileId: file.fileId } });
            }
            if (page !== 'intro') guideResume.current = { snapshotId: snapshot.snapshotId, page };
            setGuideReturn(remember ? { snapshotId: snapshot.snapshotId, page: guidePage } : null);
            setDiff(value); setDiffVersion(value.diffId); setGuidePosition({ snapshotId: snapshot.snapshotId, page }); setFilesOpen(false); setError(null);
            setNavigation(location === undefined ? null : { ...location, diffId: value.diffId }); setNavigationEpoch(epoch);
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
            if (location !== undefined) data.updateFile(value.diffId, file.fileId, { selected: { ...location, diffId: value.diffId, fileId: file.fileId } });
            data.updateView(value.diffId, { fileId: file.fileId });
            setDiff(value); setDiffVersion(value.diffId); setFileId(file.fileId); setQuery(memory.query); setNavigation(location === undefined ? null : { ...location, diffId: value.diffId });
            setFilesOpen(false); setError(null); setNavigationEpoch(epoch); closeOverlay(); session.setView('diff');
            const target = `diff:${value.diffId}:${file.fileId}`;
            if (location === undefined) reading.restore(target, epoch);
            else reading.code(target, epoch, location);
        } catch (reason) { if (reading.isCurrent(epoch)) { setError(String(reason)); reading.cancel(); } }
    };
    const openCode = (location: CodeLocation, diffId: string): void => { if (guided && diffId === snapshot.diffId) void goGuide('intro', location, true); else void goDiff(diffId, undefined, location); };
    const backToStory = (): void => {
        const epoch = reading.begin();
        const point = reading.origin;
        session.setView('route'); closeOverlay(); setFilesOpen(false);
        if (guideScope !== null) reading.restore(guideScope, epoch, point?.storyKey === storyKey ? point.focus : null);
        reading.setOrigin(null);
    };
    const generate = (): void => {
        setError(null);
        void generateReviewRoute(token, locale).catch((reason: unknown) => { setError(String(reason)); });
    };
    const files = diff?.files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase())) ?? [];
    return <div className={`story-app${ui.chatOpen ? ' story-app--chat' : ''}${intro ? ' story-app--intro' : ''}`}>
        <header className="story-topbar">
            <strong><span aria-hidden="true">◆</span> Devflow</strong>
            <span className="story-pr-key">{stream.state?.prKey ?? ''}</span>
            <nav aria-label={t.contents}>
                {guided ? <><button className="ctl" aria-current={intro ? 'page' : undefined} onClick={() => { void goGuide('intro'); }}>{gt.description}</button>
                    <button className="ctl" aria-current={!showDiff && !intro ? 'page' : undefined} onClick={() => { void goGuide(guideResume.current?.snapshotId === snapshot.snapshotId ? guideResume.current.page : snapshot.tourOrder[0] ?? 'intro'); }}>{gt.blocks}</button></>
                    : <button className="ctl" aria-current={!showDiff ? 'page' : undefined} onClick={backToStory}>{showDiff && reading.origin !== null ? t.returnTo : t.story}</button>}
                <button className="ctl" aria-current={showDiff ? 'page' : undefined} onClick={() => { void goDiff(diffVersion ?? snapshot?.diffId ?? active ?? null); }}>{guided ? gt.allChanges : t.diff}</button>
            {showDiff || guided ? <button className="ctl story-files-toggle" aria-expanded={filesOpen} onClick={() => { setFilesOpen((value) => !value); }}>{filesOpen ? t.closeFiles : t.files}</button> : null}
            </nav>
            <div className="story-settings">
                <select aria-label={t.language} value={locale} onChange={(event) => { settings.update({ locale: event.target.value === 'ru' ? 'ru' : 'en' }); }}><option value="ru">RU</option><option value="en">EN</option></select>
                <select aria-label={t.theme} onChange={(event) => { settings.update({ theme: event.target.value === 'auto' ? 'auto' : event.target.value === 'light' ? 'light' : 'dark' }); }} value={preferences.theme}><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select>
                <button className="ctl story-style-toggle" aria-pressed={preferences.arcanum} onClick={() => { reading.preserve(); settings.update({ arcanum: !preferences.arcanum }); }}>{gt.arcanum}</button>
                <button className="ctl" onClick={() => { openChat(); }}>{t.chat}</button>
            </div>
        </header>
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
            {showDiff && reading.origin !== null ? <button className="ctl story-return" onClick={backToStory}>{t.returnTo} · {reading.origin.sectionId === 'intro' ? t.introduction : snapshot?.stops.find((stop) => stop.id === reading.origin?.sectionId)?.title ?? t.introduction}</button> : null}
            {showDiff && diffVersion !== active && active !== undefined ? <p><button className="ctl" onClick={() => { void goDiff(active); }}>{t.newDiff}</button></p> : null}
            {!showDiff && snapshot !== null && (snapshot.storyContractVersion ?? 0) < 3 && route?.stale == null ? <p className="story-notice">{snapshot.storyContractVersion === 2 ? gt.older : t.legacy} <button className="ctl" disabled={generating || !connected} onClick={generate}>{t.refresh}</button></p> : null}
            {snapshot === null ? null : <p className="story-provenance">{(showDiff ? diff?.headCommit ?? snapshot.commit : snapshot.commit).slice(0, 12)} · {snapshot.provenance.harness} · {snapshot.provenance.model}</p>}
            {error === null ? null : <p role="alert" className="story-notice">{error}</p>}
            {route?.stale == null ? null : <div className="story-notice">{t.stale} <button className="ctl" disabled={generating || !connected} onClick={generate}>{t.refresh}</button></div>}
            {!connected ? <p className="story-notice">{t.offline}</p> : null}
            {stream.state?.generationCap?.truncated ? <p className="story-notice">{t.incomplete}</p> : null}
            {generating ? <div role="status" className="story-notice">{route.phase === 'reading' ? t.planning : t.writing} <button className="ctl" onClick={() => { void Promise.all(tasks.filter((task) => task.type.startsWith('route.') && (task.status === 'queued' || task.status === 'leased')).map((task) => cancelTask(token, task.id))); }}>{t.cancel}</button></div> : null}
            {route?.failure == null ? null : <p role="alert" className="story-notice">{route.failure.message} <button className="ctl" onClick={generate} disabled={!connected}>{t.retry}</button></p>}
            {showDiff ? (diff === null ? <p data-reading-wait>{t.loading}</p> : selectedFile === null ? <p>{t.noFiles}</p>
                : <ReadFile key={`${diff.diffId}:${selectedFile.fileId}:${String(navigationEpoch)}`} file={selectedFile} diffId={diff.diffId} data={data} token={token} current={diff.diffId === active} navigation={navigation ?? undefined} onAsk={(selected) => { openChat(undefined, selected); }} onLayout={layout} onMediaLayout={reading.relayout} />)
                : snapshot === null ? generating ? null : <div><p>{t.empty}</p><button className="ctl ctl--primary" disabled={!connected} onClick={generate}>{t.generate}</button></div>
                    : guided ? <GuidedDocument snapshot={snapshot} page={guidePage} onVisit={(page, remember) => { void goGuide(page, undefined, remember); }} onBack={guideReturn?.snapshotId === snapshot.snapshotId ? () => { void goGuide(guideReturn.page); } : undefined} returnLabel={guideReturn?.page === 'intro' ? gt.description : snapshot.stops.find((stop) => stop.id === guideReturn?.page)?.title ?? t.returnTo} onAsk={openChat} onRetry={(id) => { const stop = snapshot.stops.find((entry) => entry.id === id); if (stop !== undefined) void fillRouteStop(token, { snapshotId: snapshot.snapshotId, planIndex: stop.planIndex }).catch((reason: unknown) => { setError(String(reason)); }); }}
                        renderDescription={<StoryDocument snapshot={{ ...snapshot, stops: [], tourOrder: [] }} onAsk={openChat} expanded={reading.expanded} onToggle={reading.toggle} renderSource={(source, sectionId, index) =>
                            <EvidenceSource key={`${sectionId}:${String(index)}`} source={source} diffId={snapshot.diffId} data={data} token={token} focusId={`source:${sectionId}:${String(index)}`} onLayout={layout} onMediaLayout={reading.relayout} onAsk={(selected) => { openChat(sectionId, selected); }} onOpen={(id, location) => { void goGuide(`file:${id}`, location, true); }} />
                        } />}
                        renderFile={(id) => { const file = diff?.diffId === snapshot.diffId ? diff.files.find((entry) => entry.fileId === id) : undefined; const explanation = snapshot.stops.flatMap((stop) => stop.guidedFiles ?? []).find((entry) => entry.fileId === id); return file === undefined ? <p data-reading-wait>{t.loading}</p> : <ReadFile key={`${snapshot.diffId}:${id}:${String(navigationEpoch)}`} file={file} diffId={snapshot.diffId} data={data} token={token} current={snapshot.diffId === active} navigation={navigation ?? undefined} annotations={explanation?.annotations} onAsk={(selected) => { openChat(`file:${id}`, selected); }} onLayout={layout} onMediaLayout={reading.relayout} />; }} />
                    : <StoryDocument snapshot={snapshot} onAsk={openChat} expanded={reading.expanded} onToggle={reading.toggle} renderSource={(source, sectionId, index) =>
                        <EvidenceSource key={`${sectionId}:${String(index)}`} source={source} diffId={snapshot.diffId} data={data} token={token} focusId={`source:${sectionId}:${String(index)}`} onLayout={layout} onMediaLayout={reading.relayout}
                            onAsk={(selected) => { openChat(sectionId, selected); }} onOpen={(id, location) => { void goDiff(snapshot.diffId, id, location, sectionId); }} />
                    } />}

        </main>
        {ui.chatOpen ? <aside className="story-chat">
            <div className="story-chat-context">{t.pinned}{contextTitle === '' ? '' : ` · ${contextTitle}`} · {(explanation?.commit ?? diff?.headCommit ?? '').slice(0, 12)}
                <button className="ctl" onClick={() => { setExplanation(capture()); setContextTitle(''); if (anchor?.diffId !== viewedDiffId) setAnchor(null); }}>{t.refreshContext}</button>
                {explanation?.sectionId === undefined ? null : <button className="ctl" onClick={() => { setExplanation(capture()); setContextTitle(''); }}>{t.clear}</button>}
            </div>
            <ChatPanel composerText={draft} onComposerTextChange={setDraft} worker={worker} tasks={tasks} exchanges={chat.exchanges.filter((exchange) => exchange.explanation?.diffId === (explanation?.diffId ?? viewedDiffId))} notes={[]} loading={false} error={chatError}
                reconnectCommand={reconnectCommand(stream.state?.prKey ?? '')} anchor={anchor} focusRequest={focus} scrollRequest={null} onScrollRequestHandled={noop}
                onClose={() => { reading.preserve(); session.setChatOpen(false); }} onRemoveAnchor={() => { setAnchor(null); }} viewDiffId={viewedDiffId}
                onAsk={async (text, selected) => {
                    const pinned = explanation ?? capture();
                    if (pinned === undefined) throw new Error(t.loading);
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
