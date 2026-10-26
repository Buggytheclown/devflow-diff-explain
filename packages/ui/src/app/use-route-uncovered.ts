import type { FileDiff, PrDiff, RouteSnapshot } from '@sherpa/protocol';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { DiffViewStore } from '../diff-view/store.js';
import { snapshotFilling } from '../route/other-stop.js';
import { routeUncoveredLines } from '../route/route-model.js';

export interface RouteUncoveredOptions {
    readonly diff: PrDiff | null;
    readonly store: DiffViewStore | null;
    /** Живой снапшот маршрута. */
    readonly snapshot: RouteSnapshot | null;
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
}

/**
 * Непокрытое достроенного маршрута для всего, что живёт вне вью маршрута: Обзора, палитры,
 * тура, панели действий. Без него они не знали бы, есть ли «Прочее», пока ревьюер не откроет
 * маршрут. Дифф разбирается фоном в общий стор; `null` — пока разбор не закончен или маршрут строится.
 */
export function useRouteUncovered({ diff, store, snapshot, parse }: RouteUncoveredOptions): number | null {
    const settled = snapshot !== null && !snapshotFilling(snapshot);
    // Провал разбора — тоже итог: его строки не считаются, иначе число ждало бы вечно.
    const [failedState, setFailedState] = useState<{ store: DiffViewStore; ids: ReadonlySet<string> } | null>(null);
    const failed = failedState !== null && failedState.store === store ? failedState.ids : EMPTY_IDS;

    useEffect(() => {
        if (!settled || diff === null || store === null) {
            return;
        }
        const timer = setTimeout(() => {
            for (const file of diff.files) {
                if (file.changeType === 'conflict' || store.getSnapshot().models.has(file.fileId)) {
                    continue;
                }
                parseSafely(parse, file).then(
                    (model) => {
                        store.setModel(file.fileId, model);
                    },
                    () => {
                        setFailedState((previous) => ({
                            store,
                            ids: new Set(previous?.store === store ? previous.ids : EMPTY_IDS).add(file.fileId),
                        }));
                    },
                );
            }
        }, BACKGROUND_PARSE_DELAY);
        return () => {
            clearTimeout(timer);
        };
    }, [diff, parse, settled, store]);

    const read = useMemo(
        () =>
            !settled || diff === null || store === null
                ? readNothing
                : uncoveredReader({ store, snapshot, files: diff.files, failed }),
        [diff, failed, settled, snapshot, store],
    );
    return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}

/**
 * Чтение непокрытого для `useSyncExternalStore`. Стор обновляется на каждое выделение и отметку,
 * а пересчёт нужен, только когда сменились модели.
 */
function uncoveredReader({
    store,
    snapshot,
    files,
    failed,
}: {
    store: DiffViewStore;
    snapshot: RouteSnapshot;
    files: readonly FileDiff[];
    failed: ReadonlySet<string>;
}): () => number | null {
    let models: ReadonlyMap<string, DiffFileModel> | null = null;
    let value: number | null = null;
    return () => {
        const current = store.getSnapshot().models;
        if (current !== models) {
            models = current;
            value = routeUncoveredLines({ snapshot, files, models: current, failed });
        }
        return value;
    };
}

/** Воркер может не подняться синхронно (нет `Worker`): такой провал — тот же провал разбора. */
function parseSafely(parse: (file: FileDiff) => Promise<DiffFileModel>, file: FileDiff): Promise<DiffFileModel> {
    try {
        return parse(file);
    } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
const BACKGROUND_PARSE_DELAY = 300;
const readNothing = (): null => null;
const noSubscribe = (): (() => void) => () => undefined;
