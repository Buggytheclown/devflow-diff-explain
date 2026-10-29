import type { FileChangeType } from '@sherpa/protocol';

/** Буквенные статусы принадлежат шапкам диффа; дерево различает изменения только иконками. */
export function FileGlyph({ changeType, directory = false }: { changeType?: FileChangeType | undefined; directory?: boolean }) {
    return <svg className="story-file-glyph" data-change={changeType} data-kind={directory ? 'directory' : 'file'} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {directory ? <><path d="M3 8V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v2" /><path d="M2 10h20l-3 10H2Z" /></> : <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" />{changeType === 'add' || changeType === 'modify' ? <path d="M8 15h8m-4-4v8" /> : changeType === 'delete' ? <path d="M8 15h8" /> : <path d="m10 12-3 3 3 3m4-6 3 3-3 3" />}</>}
    </svg>;
}

export function ExplanationGlyph() {
    return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="M21 11a8 8 0 0 1-8 8h-3l-5 3v-5a8 8 0 0 1-2-6 9 9 0 0 1 18 0Z" /></svg>;
}
