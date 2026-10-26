import type { RefObject } from 'react';
import { useMemo, useRef, useState } from 'react';

import { setFileViewed, setStopFileViewed, setStopViewed } from '../api.js';
import type { DiffViewStore } from '../diff-view/store.js';
import type { ProgressWriter } from '../progress/progress-writer.js';
import { createProgressWriter } from '../progress/progress-writer.js';
import type { StopProgressStore } from '../progress/stop-progress-store.js';
import { createStopProgressStore } from '../progress/stop-progress-store.js';

export interface UseProgressWriterOptions {
    readonly viewKey: string;
    readonly diffStore: DiffViewStore | null;
    readonly routeSnapshotId: string | null;
    readonly token: string;
    readonly readOnly: boolean;
}

export interface UseProgressWriterResult {
    readonly progressWriter: ProgressWriter | null;
    readonly stopProgress: StopProgressStore;
    /** Файлы, которым признак «просмотрено» снят вручную: зеркало не переигрывает их в хост. */
    readonly mirroredFileWrites: RefObject<Set<string>>;
    /** Счётчик завершённых записей: по нему перечитывается прогресс. */
    readonly progressWritesSettled: number;
}

/** Единственный на вкладку писатель прогресса: файловые отметки и отметки остановок. */
export function useProgressWriter({
    viewKey,
    diffStore,
    routeSnapshotId,
    token,
    readOnly,
}: UseProgressWriterOptions): UseProgressWriterResult {
    const [progressWritesSettled, setProgressWritesSettled] = useState(0);
    // Отметки остановок живут рядом с файловыми: ревизия прогресса у них общая, писатель — один.
    // Смена PR, хоста или выбранной итерации — другой маршрут, и прежние отметки к нему не относятся.
    const [stopProgressState, setStopProgressState] = useState(() => ({
        key: viewKey,
        store: createStopProgressStore(),
    }));
    if (stopProgressState.key !== viewKey) {
        setStopProgressState({ key: viewKey, store: createStopProgressStore() });
    }
    const stopProgress = stopProgressState.store;
    const mirroredFileWrites = useRef(new Set<string>());
    const writingProgress = useMemo<ProgressWriter | null>(
        () =>
            diffStore === null
                ? null
                : createProgressWriter({
                      initialRevision: 0,
                      read: (fileId) => diffStore.getSnapshot().progress.get(fileId) ?? null,
                      apply: (fileId, viewed) => {
                          if (viewed) {
                              mirroredFileWrites.current.delete(fileId);
                          } else {
                              mirroredFileWrites.current.add(fileId);
                          }
                          // markViewed синхронно будит подписчика зеркала: признак меняется до записи в стор.
                          diffStore.markViewed(fileId, viewed);
                      },
                      restore: diffStore.restoreProgress,
                      send: async (fileId, viewed) => {
                          try {
                              return (await setFileViewed(token, fileId, viewed)).progressRevision;
                          } catch (error) {
                              if (!viewed) {
                                  mirroredFileWrites.current.delete(fileId);
                              }
                              throw error;
                          }
                      },
                      stops: {
                          read: (stopId) => stopProgress.getSnapshot().get(stopId) ?? null,
                          apply: stopProgress.setViewed,
                          restore: stopProgress.restore,
                          send: async (stopId, viewed, ranges) => {
                              if (routeSnapshotId === null) {
                                  throw new Error('Devflow Diff Explain UI: cannot mark a stop without a route snapshot');
                              }
                              return (await setStopViewed(token, routeSnapshotId, stopId, viewed, ranges))
                                  .progressRevision;
                          },
                      },
                      stopFiles: {
                          apply: diffStore.applySeenRanges,
                          send: async (stopId, fileId, viewed, ranges) => {
                              if (routeSnapshotId === null) {
                                  throw new Error('Devflow Diff Explain UI: cannot mark a stop file without a route snapshot');
                              }
                              return (await setStopFileViewed(token, routeSnapshotId, stopId, fileId, viewed, ranges))
                                  .progressRevision;
                          },
                      },
                      onSettled: () => {
                          setProgressWritesSettled((settled) => settled + 1);
                      },
                  }),
        [diffStore, routeSnapshotId, stopProgress, token],
    );
    /**
     * В прошлой итерации писатель прогресса только перечитывает снимок: запись отклоняется
     * до оптимистичной отметки, чтобы контрол не мигал и не откатывался.
     * Сами контролы при этом выключены — сюда доходят только внутренние пути.
     */
    const progressWriter = useMemo<ProgressWriter | null>(
        () =>
            writingProgress === null || !readOnly
                ? writingProgress
                : {
                      ...writingProgress,
                      write: () => Promise.resolve(false),
                      writeStop: () => Promise.resolve(false),
                      writeStopFile: () => Promise.resolve(false),
                  },
        [readOnly, writingProgress],
    );

    return { progressWriter, stopProgress, mirroredFileWrites, progressWritesSettled };
}
