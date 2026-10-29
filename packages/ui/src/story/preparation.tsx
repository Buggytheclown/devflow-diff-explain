import type { UiRouteState } from '@sherpa/protocol';
import { preparationProgress } from '@sherpa/protocol';
import { useLocale } from '../i18n/index.js';
import { preparationCopy } from '../i18n/story.js';

export function Skeleton({ label, diagram = false }: { label: string; diagram?: boolean }) {
    return <div className={`story-skeleton${diagram ? ' story-skeleton--diagram' : ''}`} role="status"><p>{label}</p><div aria-hidden="true"><i /><i /><i /></div></div>;
}

export function OverviewSkeleton() {
    const t = preparationCopy[useLocale()];
    return <article className="story-overview"><div className="story-overview-content"><h2>{t.overviewTitle}</h2><Skeleton label={t.overviewPending} /><h3>{t.diagramTitle}</h3><Skeleton diagram label={t.diagramPending} /></div></article>;
}

export function Preparation({ route, connected, displayedId, onOpenLatest, onCancel }: {
    route: UiRouteState | null; connected: boolean; displayedId?: string | undefined;
    onOpenLatest?: (() => void) | undefined; onCancel?: (() => void) | undefined;
}) {
    const t = preparationCopy[useLocale()];
    const p = preparationProgress(route ?? { phase: 'none', snapshot: null });
    const working = p.status === 'planning' || p.status === 'preparing';
    const previous = displayedId !== undefined && route?.generation !== undefined && displayedId !== p.snapshotId;
    const latestId = route?.snapshot?.snapshotId;
    const ready = p.status === 'ready';
    return <section className={`story-preparation${ready ? ' story-preparation--ready' : ''}`} aria-label={t.title} data-generation={p.id}>
        {ready ? <details className="story-preparation-complete"><summary>✓ {t.ready}</summary><div className="story-preparation-popover">
            <code>{p.commit?.slice(0, 12)}</code><p>{t.blocks}: {p.blocks.ready}/{p.blocks.total} · {t.files}: {p.files.ready}/{p.files.total}</p>
            <div role="progressbar" aria-label={t.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={100}>{p.completed}/{p.total} · 100%</div>
        </div></details> : <><div className="story-preparation-heading"><strong>{t[p.status]}</strong><span>{p.total === null ? null : `${String(p.completed)}/${String(p.total)} · ${String(p.percent)}%`}</span><code title={`${t.revision}: ${p.commit ?? ''}`}>{p.commit?.slice(0, 12)}</code>
            {working && onCancel !== undefined ? <button className="ctl" onClick={onCancel}>{t.cancel}</button> : null}
            {previous ? <span className="story-previous">{t.previous}</span> : null}
            {previous && latestId !== undefined && latestId !== displayedId && onOpenLatest !== undefined ? <button className="ctl" onClick={onOpenLatest}>{t.latest}</button> : null}
        </div>
        <div className="story-progress" role="progressbar" aria-label={t.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent ?? undefined} aria-valuetext={p.total === null ? t[p.status] : `${String(p.completed)}/${String(p.total)} ${t.units}`}><span style={{ width: `${String(p.percent ?? 0)}%` }} /></div>
        <p>{working && !connected ? t.offline : p.status === 'legacy' ? t.legacyDetails : p.total === null ? t.stage : `${t.description}: ${t.done} · ${t.diagram}: ${p.flow === 'ready' ? t.done : p.flow === 'pending' ? t.pending : t[p.flow]} · ${t.blocks}: ${String(p.blocks.ready)}/${String(p.blocks.total)} · ${t.files}: ${String(p.files.ready)}/${String(p.files.total)}`}</p>
        </>}
        {ready && previous ? <span className="story-previous">{t.previous}{onOpenLatest === undefined ? null : <button className="ctl" onClick={onOpenLatest}>{t.latest}</button>}</span> : null}
        {p.total !== null && p.completed < p.total && !working ? <details><summary>{t.missing}: {p.total - p.completed}</summary><ul>{p.flow === 'unavailable' || p.flow === 'pending' ? <li>{t.diagram}</li> : null}{route?.snapshot?.stops.filter((block) => block.paragraph === null || block.guidedFiles?.some((file) => file.explanation === null)).map((block) => <li key={block.id}>{block.title}{block.paragraph === null ? ` · ${t.blocks}: ${t.pending}` : ''}<ul>{block.guidedFiles?.filter((file) => file.explanation === null).map((file) => <li key={file.fileId}>{file.path}{file.failure == null ? '' : ` — ${file.failure}`}</li>)}</ul></li>)}</ul></details> : null}
    </section>;
}
