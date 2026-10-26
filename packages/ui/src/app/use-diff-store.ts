import type { FileDiff, PrDiff } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { fetchBlob } from '../api.js';
import type { DiffClient } from '../diff/client.js';
import { createDiffClient } from '../diff/client.js';
import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import type { BlobLoader } from '../diff-view/blob-loader.tsx';
import type { DiffViewStore } from '../diff-view/store.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { collapsedFromMap, collapsedToMap } from '../pr-state/pr-state-store.js';
import { usePrStateStore } from '../pr-state/context.tsx';
import { useUiSettingsStore } from '../settings/context.tsx';

export interface DiffStoreOptions {
    readonly diff: PrDiff | null;
    readonly prKey: string | null;
    readonly blobsAvailable: boolean;
    readonly token: string;
}

export interface DiffStoreResult {
    readonly diffStore: DiffViewStore | null;
    readonly loadBlob: BlobLoader | null;
    /**
     * Разбор патча текущего диффа. Воркер один на приложение: его делят вью и фоновый подсчёт
     * «Прочего», и файл, заказанный дважды, разбирается один раз.
     */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
}

/**
 * Стор диффа открытой вкладки: пересоздаётся под новый дифф и держит двустороннюю связь
 * с настройками (режим диффа) и состоянием PR (свёрнутость карточек).
 */
export function useDiffStore({ diff, prKey, blobsAvailable, token }: DiffStoreOptions): DiffStoreResult {
    const settings = useUiSettingsStore();
    const prState = usePrStateStore();
    const loadBlob = useMemo(
        () => (blobsAvailable ? (blobId: string) => fetchBlob(token, blobId) : null),
        [blobsAvailable, token],
    );
    const diffStore = useMemo(
        () =>
            diff === null || prKey === null
                ? null
                : createDiffViewStore({
                      files: diff.files,
                      // Снимок берётся один раз при создании стора: опоздавший ответ ручки
                      // не пересоздаёт стор под ревьюером.
                      collapsed: collapsedToMap(prState.getSnapshot().diffCollapsed),
                      // Режим диффа глобальный: он приезжает с сервера и уезжает туда же.
                      diffMode: settings.getSnapshot().diffMode,
                      onDiffModeChange: (mode) => {
                          settings.update({ diffMode: mode });
                      },
                  }),
        [diff, prKey, prState, settings],
    );
    // Настройки могли доехать позже создания стора (или смениться в другом вью) — подтягиваем.
    useEffect(() => {
        if (diffStore === null) {
            return;
        }
        const sync = (): void => {
            diffStore.setDiffMode(settings.getSnapshot().diffMode);
        };
        sync();
        return settings.subscribe(sync);
    }, [diffStore, settings]);
    // Свёрнутость карточек могла доехать позже создания стора (boot-GET опоздал за таймаут) —
    // заливаем её тем же способом, что и режим диффа, не пересоздавая стор. Без этого стор
    // остался бы с пустой картой и первая же ручная свёртка стёрла бы серверную: патч заменяет
    // поле целиком.
    useEffect(() => {
        if (diffStore === null) {
            return;
        }
        const sync = (): void => {
            diffStore.setCollapsePreferences(collapsedToMap(prState.getSnapshot().diffCollapsed));
        };
        sync();
        return prState.subscribe(sync);
    }, [diffStore, prState]);
    // Пишем только на реальную смену предпочтений: прочие обновления стора (режим, прогресс,
    // модели файлов) к свёрнутости не относятся и запроса не заслуживают.
    useEffect(() => {
        if (diffStore === null) {
            return;
        }
        let collapsePreferences = diffStore.getSnapshot().collapsePreferences;
        return diffStore.subscribe(() => {
            const next = diffStore.getSnapshot().collapsePreferences;
            if (next === collapsePreferences) {
                return;
            }
            collapsePreferences = next;
            prState.update({ diffCollapsed: collapsedFromMap(collapsePreferences) });
        });
    }, [diffStore, prState]);

    const clientRef = useRef<DiffClient | null>(null);
    // Ссылка, а не `useMemo`: закрытый клиент не воскресает, а StrictMode монтирует App дважды.
    useEffect(
        () => () => {
            clientRef.current?.close();
            clientRef.current = null;
        },
        [],
    );
    const diffId = diff?.diffId ?? '';
    const parse = useCallback(
        (file: FileDiff) => {
            clientRef.current ??= createDiffClient();
            return clientRef.current.parseFile(diffId, toParseRequest(file));
        },
        [diffId],
    );

    return { diffStore, loadBlob, parse };
}
