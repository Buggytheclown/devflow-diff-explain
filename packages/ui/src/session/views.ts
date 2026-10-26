/**
 * Три вью PR-воркспейса (docs/design/README.md §0, docs/design/SPEC-elements.md §2.1).
 * Порядок в `VIEWS` — порядок табов и порядок клавиш 1/2/3.
 */

import type { MessageKey } from '../i18n/ru.js';

export type ViewId = 'overview' | 'route' | 'diff';

export interface ViewDescriptor {
    readonly id: ViewId;
    /** Ключ подписи таба в словаре. */
    readonly label: MessageKey;
    /** Ключ подписи одноимённой команды палитры («Вью «Обзор»»). */
    readonly command: MessageKey;
}

export const VIEWS: readonly ViewDescriptor[] = [
    { id: 'overview', label: 'view.overview', command: 'shortcut.view.overview' },
    { id: 'route', label: 'view.route', command: 'shortcut.view.route' },
    { id: 'diff', label: 'view.diff', command: 'shortcut.view.diff' },
];

/** Обзор — навсегда: при открытии маршрут ещё не готов, смотреть нечего. */
export const DEFAULT_VIEW: ViewId = 'overview';

/** `null` — строка не является идентификатором вью (мусор в URL). */
export function parseViewId(value: string | null): ViewId | null {
    return VIEWS.find((view) => view.id === value)?.id ?? null;
}
