import { useId, useReducer } from 'react';
import type { PrDiff, RouteSnapshot } from '@sherpa/protocol';
import { useLocale } from '../i18n/index.js';
import { guidedCopy } from '../i18n/story.js';
import { FileTree } from './file-tree.js';
import type { TreeFile } from './file-tree-model.js';
import { closedBlockTree, createRouteTree, routeTreeReducer } from './route-tree-state.js';

export function GuidedNavigation({ snapshot, diff, page, onVisit, reveal = 0, onPreview }: {
    snapshot: RouteSnapshot; diff: PrDiff | null; page: string; onVisit: (page: string) => void;
    reveal?: number; onPreview?: (id: string | undefined) => void;
}) {
    const t = guidedCopy[useLocale()];
    const prefix = useId();
    const blocks = snapshot.tourOrder.flatMap((id) => snapshot.stops.filter((entry) => entry.id === id));
    const active = blocks.find((block) => block.id === page || block.guidedFiles?.some((file) => page === `file:${file.fileId}`))?.id ?? null;
    const [tree, dispatch] = useReducer(routeTreeReducer, undefined, () => createRouteTree(active, reveal));
    // Синхронизируем только вход в блок или явный переход, не каждый новый файл при скролле.
    if (tree.active !== active || tree.reveal !== reveal) dispatch({ kind: 'activate', id: active, reveal });
    const actual = new Map(diff?.diffId === snapshot.diffId ? diff.files.map((file) => [file.fileId, file]) : []);
    return <><div className="story-route-tools"><span>{t.route}</span><button className="ctl" title={t.expandAll} aria-label={t.expandAll} onClick={() => { dispatch({ kind: 'all', ids: snapshot.tourOrder, open: true }); }}><TreeControl expand /></button><button className="ctl" title={t.collapseAll} aria-label={t.collapseAll} onClick={() => { dispatch({ kind: 'all', ids: snapshot.tourOrder, open: false }); }}><TreeControl /></button></div>{blocks.map((block, index) => {
        const state = tree.blocks.get(block.id) ?? closedBlockTree;
        const id = `${prefix}-${String(index)}`;
        const files: TreeFile[] = (block.guidedFiles ?? []).map((file) => ({
            fileId: file.fileId, path: file.path, changeType: actual.get(file.fileId)?.changeType,
            additions: actual.get(file.fileId)?.additions ?? null, deletions: actual.get(file.fileId)?.deletions ?? null,
            explanations: (file.explanation === null ? 0 : 1) + file.annotations.length,
        }));
        return <section className="story-nav-block" key={block.id} aria-label={block.title} data-current-block={active === block.id || undefined} onMouseEnter={() => { onPreview?.(block.id); }} onMouseLeave={() => { onPreview?.(undefined); }}>
            <h3><button className="ctl story-block-toggle" aria-label={`${state.open ? t.collapseBlock : t.expandBlock}: ${block.title}`} aria-expanded={state.open} aria-controls={id} onClick={() => { dispatch({ kind: 'block', id: block.id }); }}><span aria-hidden="true">{state.open ? '⌄' : '›'}</span></button><button className="ctl story-block-visit" aria-current={active === block.id ? 'location' : undefined} onFocus={() => { onPreview?.(block.id); }} onBlur={() => { onPreview?.(undefined); }} onClick={() => { onVisit(block.id); }}><span>{index + 1}. {block.title}</span><small>{files.length}</small></button></h3>
            <div id={id} hidden={!state.open}><FileTree files={files} activeFileId={page.startsWith('file:') ? page.slice(5) : null} onVisit={(fileId) => { onVisit(`file:${fileId}`); }} directoryControl={{ defaultOpen: state.directoriesOpen, toggled: state.toggled, onToggle: (path) => { dispatch({ kind: 'directory', id: block.id, path }); } }} /></div>
        </section>;
    })}</>;
}

function TreeControl({ expand = false }: { expand?: boolean }) {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 8h14M5 16h14" /><path d={expand ? 'm9 4 3-3 3 3M9 20l3 3 3-3' : 'm9 2 3 3 3-3M9 22l3-3 3 3'} /></svg>;
}
