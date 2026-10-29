import type { FileChangeType } from '@sherpa/protocol';

export interface TreeFile {
    fileId: string; path: string; changeType?: FileChangeType | undefined;
    additions: number | null; deletions: number | null; explanations: number;
}
export type FileTreeNode = { kind: 'file'; file: TreeFile } | {
    kind: 'directory'; path: string; label: string; children: FileTreeNode[];
};

/** Группируем соседние пути, сохраняя порядок рассказа даже при возврате в прежний каталог. */
export function buildFileTree(files: readonly TreeFile[]): FileTreeNode[] {
    const roots: FileTreeNode[] = [];
    for (const file of files) {
        const parts = file.path.split('/');
        let children = roots;
        for (let index = 0; index < parts.length - 1; index++) {
            const path = parts.slice(0, index + 1).join('/');
            let node = children.at(-1);
            if (node?.kind !== 'directory' || node.path !== path) {
                node = { kind: 'directory', path, label: parts[index] ?? '', children: [] };
                children.push(node);
            }
            children = node.children;
        }
        children.push({ kind: 'file', file });
    }
    const compact = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.map((node) => {
        if (node.kind === 'file') return node;
        let current = node;
        while (current.children.length === 1 && current.children[0]?.kind === 'directory') {
            const child = current.children[0];
            current = { ...child, label: `${current.label}/${child.label}` };
        }
        return { ...current, children: compact(current.children) };
    });
    return compact(roots);
}

export function treeFiles(node: FileTreeNode): TreeFile[] {
    return node.kind === 'file' ? [node.file] : node.children.flatMap(treeFiles);
}
