import type { ExpandDirection, GapKey } from './expand.js';

export type ContextExpandRequest =
    | {
          readonly kind: 'gap';
          readonly gapKey: GapKey;
          readonly direction: ExpandDirection;
          readonly amount?: number;
      }
    | { readonly kind: 'file'; readonly gapKeys?: readonly GapKey[] };

export interface GapExpandResult {
    readonly feedback: string | null;
    readonly loaded: number;
    readonly hidden: number;
    /** Остаток чужих изменённых строк за тем же ключом: раскрытие делит промежуток на куски. */
    readonly hiddenChanged: number;
}
