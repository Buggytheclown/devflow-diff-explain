import { useLocale } from '../i18n/index.js';
import { flowCopy } from '../i18n/story.js';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SavedSource } from '@sherpa/protocol';
import { fetchSavedSource } from '../api.js';
import { readToken } from '../fragment.js';

export function SavedSourceView({ id, token }: { id: string; token: string }) {
    return <LoadedSource key={`${id}:${token}`} id={id} token={token} />;
}

function LoadedSource({ id, token }: { id: string; token: string }) {
    const t = flowCopy[useLocale()];
    const [source, setSource] = useState<SavedSource | null>(null);
    const [error, setError] = useState('');
    const [full, setFull] = useState<string | null>(null);
    const [loadingFull, setLoadingFull] = useState(false);
    useEffect(() => { let live = true; void fetchSavedSource(token, id).then((value) => { if (live) setSource(value); }, () => { if (live) setError(t.savedSourceError); }); return () => { live = false; }; }, [id, token, t.savedSourceError]);
    if (error !== '') return <p role="alert">{error}</p>;
    if (source === null) return <p>{t.savedSourceLoading}</p>;
    return <SavedSourceContent source={source} full={full} loadingFull={loadingFull} onReadFull={() => {
        setLoadingFull(true);
        void fetch(`/api/snapshot/source?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } }).then(async (response) => {
            if (!response.ok) throw new Error(t.savedSourceError);
            setFull(await response.text());
        }).catch(() => { setError(t.savedSourceError); }).finally(() => { setLoadingFull(false); });
    }} />;
}

export function SavedSourceContent({ source, full = null, loadingFull = false, onReadFull }: {
    source: SavedSource; full?: string | null; loadingFull?: boolean; onReadFull: () => void;
}) {
    const t = flowCopy[useLocale()];
    return <section className="story-source"><header className="story-saved-source-header"><code>{source.path} · {source.revision} · {source.side === 'old' ? t.sourceBefore : t.sourceAfter}</code>
        {source.fullFile && full === null ? <button className="ctl" disabled={loadingFull} onClick={onReadFull}>{t.fullSource}</button> : null}</header>
        {source.origin === undefined ? null : <p><a href={source.origin.url} target="_blank" rel="noreferrer">{t.originalDocument}</a> · {source.origin.capturedAt} · {source.origin.scope}</p>}
        <pre className="md-pre">{(full ?? source.text).split('\n').map((line, index) => <span key={index} style={{ display: 'block' }}><span aria-hidden="true">{(full === null ? source.start : 1) + index} </span>{line}</span>)}</pre>
    </section>;
}
export function SavedSourceLink({ href, children }: { href: string; children: ReactNode }) {
    const t = flowCopy[useLocale()];
    const id = /^#source\?id=([a-f0-9]{64})$/.exec(href)?.[1];
    const [open, setOpen] = useState(false);
    if (id === undefined) return <>{children}</>;
    return <><a href={href} className="md-link" onClick={(event) => { event.preventDefault(); setOpen(true); }}>{children}</a>
        {open ? createPortal(<dialog open aria-label={t.savedSourceTitle} style={{ position: 'fixed', inset: '8vh 5vw', width: '90vw', maxHeight: '84vh', overflow: 'auto', background: 'var(--surface-panel)', color: 'var(--text-primary)', zIndex: 1000 }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
            <button className="ctl" autoFocus onClick={() => { setOpen(false); }}>{t.closeSource}</button><SavedSourceView id={id} token={readToken(window.location.hash) ?? ''} />
        </dialog>, document.body) : null}</>;
}
