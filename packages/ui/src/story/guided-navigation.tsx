import type { PrDiff, RouteSnapshot } from '@sherpa/protocol';
import { useLocale } from '../i18n/index.js';
import { guidedCopy } from '../i18n/story.js';
import { FileTree } from './file-tree.js';
import type { TreeFile } from './file-tree-model.js';

export function GuidedNavigation({ snapshot, diff, page, onVisit }: {
    snapshot: RouteSnapshot; diff: PrDiff | null; page: string; onVisit: (page: string) => void;
}) {
    const t = guidedCopy[useLocale()];
    const actual = new Map(diff?.diffId === snapshot.diffId ? diff.files.map((file) => [file.fileId, file]) : []);
    return <><button className="ctl story-nav-overview" onClick={() => { onVisit('intro'); }}>{t.description}</button>{snapshot.tourOrder.map((id, index) => {
        const block = snapshot.stops.find((entry) => entry.id === id);
        if (block === undefined) return null;
        const files: TreeFile[] = (block.guidedFiles ?? []).map((file) => ({
            fileId: file.fileId, path: file.path, changeType: actual.get(file.fileId)?.changeType,
            additions: actual.get(file.fileId)?.additions ?? null, deletions: actual.get(file.fileId)?.deletions ?? null,
            explanations: (file.explanation === null ? 0 : 1) + file.annotations.length,
        }));
        return <section className="story-nav-block" key={id} aria-label={block.title}>
            <h3><button className="ctl" aria-current={page === id ? 'page' : undefined} onClick={() => { onVisit(id); }}>{index + 1}. {block.title}</button></h3>
            <FileTree files={files} activeFileId={page.startsWith('file:') ? page.slice(5) : null} onVisit={(fileId) => { onVisit(`file:${fileId}`); }} />
        </section>;
    })}</>;
}
