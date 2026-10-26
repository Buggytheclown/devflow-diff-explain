import type { UiStopProgress } from '@sherpa/protocol';

/**
 * Отметки «просмотрено» на остановках маршрута (docs/design/README.md, State model: `viewed {stopId→bool}`).
 * Персист — серверный: истина приезжает ручкой прогресса, стор держит её снимок и оптимистичный
 * слой поверх, как `DiffViewStore` держит записи файлов.
 *
 * Стор живёт вне React-дерева (паттерн остальных сторов UI): подписка плюс `useSyncExternalStore`.
 */

export interface StopProgressStore {
    readonly subscribe: (listener: () => void) => () => void;
    /** Отметки остановок; отсутствие ключа — «не просмотрена». */
    readonly getSnapshot: () => ReadonlyMap<string, boolean>;
    readonly isViewed: (stopId: string) => boolean;
    /** Оптимистичная отметка — отклик контрола не ждёт сети. */
    readonly setViewed: (stopId: string, viewed: boolean) => void;
    /** Откат сорвавшейся записи: `null` — записи не было вовсе. */
    readonly restore: (stopId: string, viewed: boolean | null) => void;
    /** Серверный снимок целиком (уже слитый с незастанными записями). */
    readonly setAll: (records: readonly UiStopProgress[]) => void;
}

export function createStopProgressStore(initial: readonly UiStopProgress[] = []): StopProgressStore {
    const listeners = new Set<() => void>();
    let snapshot: ReadonlyMap<string, boolean> = new Map(
        initial.map((record) => [record.stopId, record.viewed]),
    );

    const update = (next: ReadonlyMap<string, boolean>): void => {
        snapshot = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        isViewed: (stopId) => snapshot.get(stopId) === true,
        setViewed: (stopId, viewed) => {
            if (snapshot.get(stopId) === viewed) {
                return;
            }
            update(new Map(snapshot).set(stopId, viewed));
        },
        restore: (stopId, viewed) => {
            if (viewed === null) {
                if (!snapshot.has(stopId)) {
                    return;
                }
                const next = new Map(snapshot);
                next.delete(stopId);
                update(next);
                return;
            }
            if (snapshot.get(stopId) === viewed) {
                return;
            }
            update(new Map(snapshot).set(stopId, viewed));
        },
        setAll: (records) => {
            update(new Map(records.map((record) => [record.stopId, record.viewed])));
        },
    };
}
