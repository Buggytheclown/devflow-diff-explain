import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { FileDiff, RouteStop, UiGenerationCap } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { GenerationCapBanner } from '../../components/generation-cap-banner.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import { useT } from '../../i18n/index.js';
import { readStateOf } from '../../progress/read-state.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { FilePanel } from '../../tree/file-panel.tsx';
import { EmptyPrNotice } from '../../views/full-diff.tsx';
import { CoverageStrip } from '../../views/route/coverage-strip.tsx';
import { OtherCard } from '../../views/route/other-card.tsx';
import { RouteToolbar } from '../../views/route/route-toolbar.tsx';
import { StopConflicts } from '../../views/route/stop-card.tsx';
import { ViewFrame } from '../../views/view-frames.tsx';

/**
 * Лимиты и деградации (docs/design/SPEC-elements.md §3, §4.1): конфликтный файл, кап генерации и пустой PR.
 * Данные — фикстуры `edge` и `medium`; сервера в галерее нет и не нужно.
 */

const EDGE = fixtureIteration('edge');
const MEDIUM = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-09-02T12:00:00.000Z');

const CONFLICT: FileDiff = (() => {
    const file = EDGE.diff.files.find((candidate) => candidate.changeType === 'conflict');
    if (file === undefined) {
        throw new Error('фикстуре edge нужен файл с конфликтом');
    }
    return file;
})();

const OTHER_STOP: RouteStop = (() => {
    const stop = routeFixtures('medium')?.states.ready?.snapshot?.stops.find((candidate) => candidate.tier === 'other');
    if (stop === undefined) {
        throw new Error('фикстуре medium нужна остановка «Прочее»');
    }
    return stop;
})();

/** docs/design/SPEC-elements.md §4.1 дословно: 500 файлов, из них 120 покрыты планом, 380 машинных — одной остановкой. */
const CAP: UiGenerationCap = { filesCovered: 120, filesTotal: 505, machineFiles: 380, truncated: true };

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

function ConflictCard() {
    return (
        <FileCard
            file={CONFLICT}
            model={parseFileDiff(toParseRequest(CONFLICT))}
            mode="unified"
            content={null}
            contentAvailable={false}
            expansion={new Map()}
            read={readStateOf({ file: CONFLICT, record: null })}
            opened
            showWhitespace={false}
            markdown={false}
            selection={null}
            actions={ACTIONS}
        />
    );
}

function ConflictTree() {
    const t = useT();
    const files = EDGE.diff.files;
    const filters = buildFileFilters({ files, ownership: EDGE.ownership, extra: EDGE.extraLenses, t });
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
                activeFileId={CONFLICT.fileId}
                onOpenFile={() => undefined}
                onToggleViewed={() => undefined}
                writeError={null}
                outline={null}
                onOpenHunk={() => undefined}
            />
        </div>
    );
}

/** Остановка, чьи якоря ушли в конфликтный файл: нотис вместо карточек и вместо дрейфа. */
function ConflictStop() {
    return <StopConflicts paths={[CONFLICT.path]} />;
}

/** «Прочее», которое держат одни конфликты: непокрытого нет, читать и раскладывать нечего. */
function ConflictsOnlyOther() {
    return (
        <OtherCard
            view={{ stop: OTHER_STOP, planLabel: '07', files: [], lines: 0, conflictFiles: 2 }}
            stopCount={7}
            opened={false}
            onOpen={() => undefined}
            diff={null}
            pending={false}
            onAskToPlace={() => undefined}
            agentConnected
            onViewed={() => undefined}
        />
    );
}

function CappedToolbar() {
    const t = useT();
    const files = MEDIUM.diff.files;
    const filters = buildFileFilters({ files, ownership: MEDIUM.ownership, extra: MEDIUM.extraLenses, t });
    return (
        <RouteToolbar
            store={createDiffViewStore({ files })}
            preset="triage"
            onPreset={() => undefined}
            filters={filters}
            filter={selectFilter(filters, 'all')}
            onFilter={() => undefined}
            generationCap={CAP}
            strip={
                <CoverageStrip
                    model={null}
                    loading={{ kind: 'diff', ready: 120, total: 505 }}
                    viewedStops={0}
                    totalStops={7}
                />
            }
        />
    );
}

function EmptyOverview() {
    return (
        <ViewFrame
            view="overview"
            prKey="fixture-empty"
            session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
            pr={MEDIUM.pr}
            diff={{ ...MEDIUM.diff, files: [] }}
            lenses={{ ownership: null, extra: [], ownershipSource: null }}
            threads={[]}
            threadStore={createThreadStore([], new Set())}
            threadNow={GALLERY_NOW}
            reviewHostAvailable
        />
    );
}

export const LIMIT_STATES: readonly {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}[] = [
    {
        id: 'conflict-file-card',
        title: 'конфликтный файл: бейдж в шапке карточки',
        render: () => <ConflictCard />,
    },
    {
        id: 'conflict-file-tree',
        title: 'конфликтный файл: тег в дереве',
        render: () => <ConflictTree />,
    },
    {
        id: 'conflict-stop-notice',
        title: 'конфликтный файл: нотис остановки вместо карточек',
        render: () => <ConflictStop />,
    },
    {
        id: 'conflict-other-card',
        title: 'конфликтный файл: «Прочее» держат одни конфликты',
        render: () => <ConflictsOnlyOther />,
    },
    {
        id: 'generation-cap-toolbar',
        title: 'кап генерации: строка под полосой покрытия',
        render: () => <CappedToolbar />,
    },
    {
        id: 'generation-cap-banner',
        title: 'кап генерации: баннер про непокрытые файлы',
        render: () => <GenerationCapBanner cap={CAP} />,
    },
    {
        id: 'empty-pr-full-diff',
        title: 'пустой PR: полный дифф',
        render: () => <EmptyPrNotice />,
    },
    {
        id: 'empty-pr-overview',
        title: 'пустой PR: обзор',
        render: () => <EmptyOverview />,
    },
];
