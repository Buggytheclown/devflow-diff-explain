import type { Iteration, UiSnapshotSummary } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';

import { SnapshotPill } from '../iterations/snapshot-picker.tsx';
import type { PickerRows, ResolvedViewing } from '../iterations/viewing.js';
import { pickerRows, VIEWING_CURRENT } from '../iterations/viewing.js';
import type { SessionStore } from '../session/session-store.js';

export interface IterationPickerOptions {
    readonly session: SessionStore;
    readonly snapshots: readonly UiSnapshotSummary[];
    readonly iterations: readonly Iteration[];
    /** Активная итерация PR из фактов маршрута без параметров. */
    readonly factsDiffId: string | null;
    readonly factsCommit: string | null;
    /** Хост отдаёт срезы между итерациями: без этого Shift+клик в пикере срез не строит. */
    readonly interdiffAvailable: boolean;
    /** Локальное ревью: у ушедшей итерации свои слова — PR здесь нет. */
    readonly localHost: boolean;
    readonly resolved: ResolvedViewing;
    readonly now: number;
}

export interface IterationPickerResult {
    readonly pickerMenuRows: PickerRows;
    readonly selectViewing: SessionStore['setViewing'];
    readonly openIterationWithoutRoute: (diffId: string) => void;
    readonly sliceCommits: { readonly baseCommit: string; readonly headCommit: string } | null;
    readonly backToActiveIteration: () => void;
    readonly snapshotPill: ReactNode;
}

/** Выбор итерации: строки пикера, индикатор в шапке и переходы между итерацией, срезом и текущим. */
export function useIterationPicker({
    session,
    snapshots,
    iterations,
    factsDiffId,
    factsCommit,
    interdiffAvailable,
    localHost,
    resolved,
    now,
}: IterationPickerOptions): IterationPickerResult {
    /** Выбор итерации: и меню индикатора, и карточка Обзора берут одни и те же строки. */
    const pickerMenuRows = useMemo(
        () =>
            pickerRows({
                snapshots,
                iterations,
                activeIteration:
                    factsDiffId === null || factsCommit === null
                        ? null
                        : { diffId: factsDiffId, commit: factsCommit },
                interdiff: interdiffAvailable,
            }),
        [factsCommit, factsDiffId, interdiffAvailable, iterations, snapshots],
    );
    const selectViewing = session.setViewing;
    /** Переход из stale-баннера: активная итерация без маршрута — не режим чтения. */
    const openIterationWithoutRoute = useCallback(
        (diffId: string) => {
            session.setViewing({ kind: 'diff', diffId });
            session.setView('diff');
        },
        [session],
    );
    /** Коммиты среза для экранов Full diff: пустой срез и ошибка называют обе стороны. */
    const sliceCommits = useMemo(
        () =>
            resolved.label?.kind === 'slice'
                ? { baseCommit: resolved.label.baseCommit, headCommit: resolved.label.commit }
                : null,
        [resolved.label],
    );
    /** Выход из среза: вкладка возвращается к активной итерации и её маршруту. */
    const backToActiveIteration = useCallback(() => {
        session.setViewing(VIEWING_CURRENT);
    }, [session]);
    const snapshotPill =
        resolved.label === null ? null : (
            <SnapshotPill
                label={resolved.label}
                localHost={localHost}
                menu={{ rows: pickerMenuRows, viewing: resolved.viewing, now, localHost, onSelect: selectViewing }}
            />
        );

    return {
        pickerMenuRows,
        selectViewing,
        openIterationWithoutRoute,
        sliceCommits,
        backToActiveIteration,
        snapshotPill,
    };
}
