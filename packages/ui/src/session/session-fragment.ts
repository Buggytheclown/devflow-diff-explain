import { filterFragmentValue } from '../filters/lens-filters.js';
import type { Viewing } from '../iterations/viewing.js';
import { viewingFragmentPatch } from '../iterations/viewing.js';
import type { SessionState } from './session-store.js';
import { DEFAULT_PRESET, DEFAULT_ROUTE_FILTER } from './session-store.js';

/**
 * Что состояние сессии пишет во фрагмент адреса. Умолчания в адрес не попадают: пресет и
 * фильтр маршрута видны в URL, только когда их меняли.
 *
 * `fragment` — ключи, заданные вызовом явно («показать на старом коммите» задаёт
 * `thread`): они важнее снятия якорей чужого диффа из `viewingFragmentPatch`.
 */
export function sessionFragmentPatch(
    state: SessionState,
    previousViewing: Viewing,
    fragment?: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string | null>> {
    return {
        view: state.view,
        filter: filterFragmentValue(state.filter),
        preset: state.preset === DEFAULT_PRESET ? null : state.preset,
        routeFilter: state.routeFilter === DEFAULT_ROUTE_FILTER ? null : state.routeFilter,
        ...viewingFragmentPatch(state.viewing, previousViewing),
        ...fragment,
    };
}
