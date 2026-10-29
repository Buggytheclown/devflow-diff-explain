import type { ReactNode } from 'react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useLocale, useT } from '../i18n/index.js';
import { storyCopy } from '../i18n/story.js';
import { buildFileTree, treeFiles } from './file-tree-model.js';
import type { FileTreeNode, TreeFile } from './file-tree-model.js';
import { ExplanationGlyph, FileGlyph } from './file-glyph.js';

export function FileTree({ files, activeFileId, onVisit, directoryControl }: {
    files: readonly TreeFile[]; activeFileId: string | null; onVisit: (fileId: string) => void;
    directoryControl?: { defaultOpen: boolean; toggled: ReadonlySet<string>; onToggle: (path: string) => void };
}) {
    const t = useT();
    const status = storyCopy[useLocale()].changeTypes;
    const root = useRef<HTMLUListElement | null>(null);
    const nodes = useMemo(() => buildFileTree(files), [files]);
    useLayoutEffect(() => {
        if (directoryControl !== undefined) return;
        // Скролл к файлу раскрывает его каталоги, но не забирает фокус из кода или чата.
        const selected = root.current?.querySelector('[aria-current="page"]');
        let directory = selected?.closest('details');
        while (directory != null && root.current?.contains(directory)) {
            directory.open = true; directory = directory.parentElement?.closest('details');
        }
    }, [activeFileId, directoryControl]);
    const render = (node: FileTreeNode): ReactNode => {
        if (node.kind === 'file') {
            const file = node.file;
            return <li key={file.fileId} data-tree-file={file.fileId}><button type="button" className="ctl story-nav-file" aria-label={file.path} aria-description={`${file.changeType === undefined ? '' : `${status[file.changeType]}. `}${t('files.changes', file.additions, file.deletions)}. ${t('files.explanations', file.explanations)}`} title={file.path} aria-current={activeFileId === file.fileId ? 'page' : undefined} onClick={() => { onVisit(file.fileId); }}>
                <FileGlyph changeType={file.changeType} /><span className="story-tree-name">{file.path.split('/').at(-1)}</span>
                <span className="story-tree-stats"><span className="story-file-added">+{file.additions ?? '—'}</span><span className="story-file-deleted">−{file.deletions ?? '—'}</span></span>
                <span className="story-tree-explanations" title={t('files.explanations', file.explanations)}>{file.explanations === 0 ? null : <><ExplanationGlyph /><span>{file.explanations}</span></>}</span>
            </button></li>;
        }
        const descendants = treeFiles(node);
        const added = descendants.every((file) => file.changeType === 'add');
        const key = `${node.path}:${descendants[0]?.fileId ?? ''}`;
        const open = directoryControl === undefined ? true : directoryControl.defaultOpen !== directoryControl.toggled.has(key);
        return <li key={key}><details open={open} data-directory={node.path}><summary title={node.path} onClick={directoryControl === undefined ? undefined : (event) => { event.preventDefault(); directoryControl.onToggle(key); }}><span className="story-tree-chevron" aria-hidden="true">›</span><FileGlyph directory changeType={added ? 'add' : undefined} /><span className="story-tree-name">{node.label}</span></summary><ul>{node.children.map(render)}</ul></details></li>;
    };
    return <ul className="story-file-tree" ref={root}>{nodes.map(render)}</ul>;
}
