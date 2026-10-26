import type { FileContent, FileDiff } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DiffFileModel } from '../../diff/model.js';
import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import { expandContext } from '../../diff-view/context-expansion.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { useT } from '../../i18n/index.js';

export interface RouteParseOptions {
    readonly files: readonly FileDiff[];
    readonly store: DiffViewStore;
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** Хост отдаёт содержимое файлов: без него перемычки раскрываются только внутри патча. */
    readonly contentAvailable: boolean;
}

export interface RouteParse {
    readonly parseErrors: ReadonlyMap<string, string>;
    readonly failedFiles: ReadonlySet<string>;
    readonly requestParse: (fileIds: readonly string[]) => void;
    readonly retryParse: (fileIds: readonly string[]) => void;
    readonly retryFailed: () => void;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
}

/**
 * Разбор патчей маршрута: заказ по файлам, повтор сорвавшегося и раскрытие перемычек. Модели
 * складываются в общий стор диффа, поэтому разобранное полным диффом маршрут не разбирает заново.
 */
export function useRouteParse({ files, store, parse, loadContent, contentAvailable }: RouteParseOptions): RouteParse {
    const t = useT();
    // Файлы, разбор которых сорвался: модели у них не будет, пока ревьюер не попросит повтор,
    // и незаконченными их числа считать нельзя — иначе «Прочее» ждало бы вечно.
    const [parseErrors, setParseErrors] = useState<ReadonlyMap<string, string>>(new Map());
    const failedFiles = useMemo(() => new Set(parseErrors.keys()), [parseErrors]);

    // Разбор патчей: файлы остановки заказываются, когда та побывала на экране; остальное —
    // фоном после первого кадра, иначе «Прочее» и счётчики не с чего было бы считать.
    const requested = useRef(new Set<string>());
    const requestParse = useCallback(
        (fileIds: readonly string[]) => {
            for (const fileId of fileIds) {
                const file = files.find((candidate) => candidate.fileId === fileId);
                // Модель уже в общем сторе (её разобрал полный дифф или галерея) — повторять незачем.
                if (file === undefined || requested.current.has(fileId) || store.getSnapshot().models.has(fileId)) {
                    continue;
                }
                requested.current.add(fileId);
                void parse(file).then(
                    (parsed) => {
                        store.setModel(fileId, parsed);
                    },
                    (error: unknown) => {
                        setParseErrors((previous) =>
                            new Map(previous).set(fileId, error instanceof Error ? error.message : String(error)),
                        );
                    },
                );
            }
        },
        [files, parse, store],
    );
    useEffect(() => {
        const timer = setTimeout(() => {
            requestParse(files.map((file) => file.fileId));
        }, BACKGROUND_PARSE_DELAY);
        return () => {
            clearTimeout(timer);
        };
    }, [files, requestParse]);
    const retryParse = useCallback(
        (fileIds: readonly string[]) => {
            for (const fileId of fileIds) {
                requested.current.delete(fileId);
            }
            setParseErrors((previous) => {
                const next = new Map(previous);
                for (const fileId of fileIds) {
                    next.delete(fileId);
                }
                return next;
            });
            requestParse(fileIds);
        },
        [requestParse],
    );
    const retryFailed = useCallback(() => {
        retryParse([...failedFiles]);
    }, [failedFiles, retryParse]);
    const expand = useCallback(
        (fileId: string, request: ContextExpandRequest): Promise<ContextExpandResult> =>
            expandContext({
                store,
                fileId,
                request,
                contentAvailable,
                loadContent,
                t,
            }),
        [contentAvailable, loadContent, store, t],
    );

    return { parseErrors, failedFiles, requestParse, retryParse, retryFailed, expand };
}

const BACKGROUND_PARSE_DELAY = 300;
