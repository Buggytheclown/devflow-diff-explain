import type { FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { createContext, useContext } from 'react';

export type PaletteNavigationTarget =
    | { readonly kind: 'file'; readonly fileId: string }
    | { readonly kind: 'line'; readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number };

export interface PaletteNavigation {
    readonly id: number;
    readonly target: PaletteNavigationTarget;
}

export interface PaletteDiffSource {
    readonly files: readonly FileDiff[];
    readonly activeFileId: string | null;
    /** Текущие модели с раскрытым контекстом; читаются в момент поискового запроса. */
    readonly searchModels: () => ReadonlyMap<string, DiffFileModel>;
    readonly goToFile: (fileId: string) => void;
    readonly goToLine: (fileId: string, side: 'old' | 'new', line: number) => void;
    readonly toggleDiffMode: () => void;
}

export const PaletteDiffSourceContext = createContext<PaletteDiffSource | null>(null);

export function PaletteDiffSourceProvider({ value, children }: { value: PaletteDiffSource; children: ReactNode }) {
    return <PaletteDiffSourceContext value={value}>{children}</PaletteDiffSourceContext>;
}

export function usePaletteDiffSource(): PaletteDiffSource | null {
    return useContext(PaletteDiffSourceContext);
}
