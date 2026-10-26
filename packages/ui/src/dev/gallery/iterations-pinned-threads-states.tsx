import { fileContentOf, fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Thread } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import { ThreadPinProvider } from '../../iterations/thread-pin.tsx';
import type { IterationLayout } from '../../threads/model.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import type { RouteGalleryState } from './route-states.tsx';
import { asFetched } from './fetched.js';

/**
 * Треды, приколотые к прошлому коммиту: чип «закреплён за 9f3c1ab», действие
 * «Показать на старом коммите» и группа «на файлах, которых больше нет в PR» (docs/design/SPEC-elements.md §2.17).
 * Оба состояния — на фикстуре `medium`: v2 активная, v1 её прошлая итерация.
 */

const V1 = asFetched(fixtureIteration('medium', 0));
const V2 = asFetched(fixtureIteration('medium', 1));
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

/** Тред, чей якорь пуш задел: в v2 он устарел, в v1 стоит у своих строк. */
const OUTDATED_THREAD_ID = threadIdBy((thread) => thread.outdated && thread.anchor !== null);

function threadIdBy(match: (thread: Thread) => boolean): string {
    const found = V2.threads.find(match);
    if (found === undefined) {
        throw new Error('фикстуре medium нужен тред, устаревший после второго пуша');
    }
    return found.id;
}

function fileIdsOf(files: readonly FileDiff[]): Set<string> {
    return new Set(files.map((file) => file.fileId));
}

interface PinnedStateProps {
    /** Итерация, дифф которой нарисован; треды всегда приезжают для активной (v2). */
    readonly diff: typeof V1.diff;
    readonly readOnly?: boolean;
    readonly outsideOpen?: boolean;
}

function PinnedState({ diff, readOnly = false, outsideOpen = false }: PinnedStateProps) {
    // Боты видны: тред на ушедшем из PR файле в фикстуре — от бота ревью.
    const session = useMemo(
        () =>
            createSessionStore({
                initial: { view: 'diff', filter: 'all' },
            }),
        [],
    );
    const layout = useMemo<IterationLayout | null>(
        () =>
            diff.diffId === V2.diff.diffId
                ? null
                : { diffId: diff.diffId, fileIdByPath: new Map(diff.files.map((file) => [file.path, file.fileId])) },
        [diff],
    );
    const threadStore = useMemo(
        () => createThreadStore(V2.threads, fileIdsOf(diff.files), layout),
        [diff, layout],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: diff.files });
        for (const file of diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [diff]);

    return (
        <ReadOnlyIterationProvider readOnly={readOnly}>
            <ThreadPinProvider
                value={{
                    activeDiffId: V2.diff.diffId,
                    viewingDiffId: diff.diffId,
                    openAtPin: () => undefined,
                }}
            >
                <div className="gallery__viewport">
                    <DiffWorkspace
                        pr={V2.pr}
                        diff={diff}
                        threads={V2.threads}
                        threadStore={threadStore}
                        lenses={{ ownership: V2.ownership, extra: V2.extraLenses, ownershipSource: 'CODEOWNERS' }}
                        prKey="fixture-medium"
                        session={session}
                        store={store}
                        threadNow={GALLERY_NOW}
                        initialThreadId={OUTDATED_THREAD_ID}
                        outsideThreadsOpen={outsideOpen}
                        parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                        loadContent={(fileId) => {
                            const file = diff.files.find((candidate) => candidate.fileId === fileId);
                            return Promise.resolve(file === undefined ? null : fileContentOf(file));
                        }}
                        onSetViewed={() => Promise.resolve(0)}
                    />
                </div>
            </ThreadPinProvider>
        </ReadOnlyIterationProvider>
    );
}

export const ITERATION_PINNED_THREAD_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-thread-pinned',
        title: 'активная итерация: чип пина, «Показать на старом коммите», файлы, которых больше нет',
        render: () => <PinnedState diff={V2.diff} outsideOpen />,
    },
    {
        id: 'iterations-thread-pinned-old',
        title: 'прошлая итерация в режиме чтения: тред стоит у своих строк',
        render: () => <PinnedState diff={V1.diff} readOnly />,
    },
];
