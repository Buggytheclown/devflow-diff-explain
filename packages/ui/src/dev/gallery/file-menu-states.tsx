import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { ReviewHostProvider } from '../../app/review-host-context.tsx';
import type { ContextMenuAnchor } from '../../components/context-menu.tsx';
import { FileContextMenu } from '../../components/context-menu.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import { useT } from '../../i18n/index.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import { readStateOf } from '../../progress/read-state.js';
import { FilePanel } from '../../tree/file-panel.tsx';

/**
 * Контекстное меню файла (docs/design/SPEC-elements.md §2.11) в обоих местах вызова. Меню в галерее открыто
 * сразу — состояние контролируемое, без клавиатуры и без кликов: `useEscapeLayer` вне провайдера
 * реестра ничего не регистрирует, и кадр остаётся детерминированным.
 */

const MEDIUM = fixtureIteration('medium');

const FILE: FileDiff = (() => {
    const file = MEDIUM.diff.files.find((candidate) => candidate.blameUrl !== null && candidate.hostFileUrl !== null);
    if (file === undefined) {
        throw new Error('фикстуре medium нужен файл с обеими ссылками хоста');
    }
    return file;
})();

/** Хост без веб-ссылки на файл: пункт «Скопировать ссылку» остаётся в меню выключенным. */
const NO_LINK: FileDiff = { ...FILE, hostFileUrl: null, blameUrl: null };

const CARD_ANCHOR: ContextMenuAnchor = { x: 900, y: 190, align: 'right' };
const TREE_ANCHOR: ContextMenuAnchor = { x: 330, y: 230, align: 'left' };

const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: () => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onToggleMarkdown: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

/** Меню из шапки карточки просмотренного файла: доступны все четыре пункта. */
function CardMenu() {
    return (
        <ReviewHostProvider value="arcanum">
            <FileCard
                file={FILE}
                model={parseFileDiff(toParseRequest(FILE))}
                mode="unified"
                content={null}
                contentAvailable={false}
                expansion={new Map()}
                read={readStateOf({ file: { ...FILE, viewed: true }, record: null })}
                opened
                showWhitespace={false}
                markdown={false}
                selection={null}
                actions={ACTIONS}
            />
            <FileContextMenu
                file={FILE}
                viewed
                onToggleViewed={() => undefined}
                anchor={CARD_ANCHOR}
                onClose={() => undefined}
            />
        </ReviewHostProvider>
    );
}

function Tree({ activeFileId }: { activeFileId: string }) {
    const t = useT();
    const files = MEDIUM.diff.files;
    const filters = buildFileFilters({ files, ownership: MEDIUM.ownership, extra: MEDIUM.extraLenses, t });
    return (
        <div className="gallery__viewport">
            <FilePanel
                files={files}
                filters={filters}
                activeFilter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                pciFileIds={new Set()}
                mineFileIds={new Set()}
                readState={new Map()}
                route={null}
                activeFileId={activeFileId}
                onOpenFile={() => undefined}
                onToggleViewed={() => undefined}
                writeError={null}
                outline={null}
                onOpenHunk={() => undefined}
            />
        </div>
    );
}

/** Меню из строки дерева у файла, которому хост не дал ни одной ссылки. */
function TreeMenu() {
    return (
        <ReviewHostProvider value="arcanum">
            <Tree activeFileId={NO_LINK.fileId} />
            <FileContextMenu
                file={NO_LINK}
                viewed={false}
                onToggleViewed={() => undefined}
                anchor={TREE_ANCHOR}
                onClose={() => undefined}
            />
        </ReviewHostProvider>
    );
}

/** Прошлая итерация: отмечать просмотренным нельзя, пункт выключен с причиной. */
function ReadOnlyMenu() {
    return (
        <ReadOnlyIterationProvider readOnly>
            <Tree activeFileId={FILE.fileId} />
            <FileContextMenu
                file={FILE}
                viewed={false}
                onToggleViewed={() => undefined}
                anchor={TREE_ANCHOR}
                onClose={() => undefined}
            />
        </ReadOnlyIterationProvider>
    );
}

export const FILE_MENU_STATES: readonly {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}[] = [
    {
        id: 'file-menu-card',
        title: 'меню из шапки карточки: все пункты доступны',
        render: () => <CardMenu />,
    },
    {
        id: 'file-menu-tree',
        title: 'меню из дерева: файл без ссылок хоста',
        render: () => <TreeMenu />,
    },
    {
        id: 'file-menu-read-only',
        title: 'меню в прошлой итерации: отметка выключена',
        render: () => <ReadOnlyMenu />,
    },
];
