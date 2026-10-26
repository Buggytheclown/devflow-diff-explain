import type { PrDiff } from '@sherpa/protocol';

import { withTreeOrder } from '../../tree/file-order.js';

/** Фикстура в том виде, в каком её видит приложение: `fetchReviewDiff` отдаёт дифф в порядке дерева. */
export function asFetched<T extends { readonly diff: PrDiff }>(data: T): T {
    return { ...data, diff: withTreeOrder(data.diff) };
}
