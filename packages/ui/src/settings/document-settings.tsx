import type { UiSettings } from '@sherpa/protocol';
import { useLayoutEffect, useSyncExternalStore } from 'react';

import { useUiSettings } from './context.tsx';

/** Фактическая тема: в неё разрешается режим `auto` из настроек. */
type ColorScheme = Exclude<UiSettings['theme'], 'auto'>;
export type ResolvedTheme = ColorScheme | `arcanum-${ColorScheme}`;

/** Тот же запрос читает встроенный скрипт сервера (`packages/server/src/ui-document.ts`). */
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** Начальное оформление стора совпадает с первым HTML, даже если GET настроек не ответит. */
export function readDocumentAppearance(root: HTMLElement): Partial<UiSettings> {
    const initial: Partial<UiSettings> = {};
    const theme = root.getAttribute('data-theme');
    const textSize = root.getAttribute('data-textsize');
    if (theme === 'arcanum-dark' || theme === 'arcanum-light') {
        initial.theme = theme === 'arcanum-dark' ? 'dark' : 'light';
        initial.arcanum = true;
    } else if (theme === 'dark' || theme === 'light') {
        initial.theme = theme;
        initial.arcanum = false;
    }
    if (textSize === 'm' || textSize === 'l') {
        initial.textSize = textSize;
    }
    return initial;
}

/**
 * Атрибуты `<html>`, зависящие от настроек: тема охватывает фон страницы, нативные контролы и
 * порталы диалогов, размер текста — корневой `font-size`, от которого считается вся rem-шкала.
 * В `data-theme` всегда резолвленная тема: про `auto` CSS не знает. Те же атрибуты сервер
 * подставляет в отдаваемый `index.html`, чтобы первый кадр не перекрашивался.
 *
 * Начальный стор уже совпадает с первым HTML благодаря readDocumentAppearance. Синхронизация
 * работает и до GET, чтобы явный выбор сразу применялся при медленной или недоступной ручке.
 * Тема HTML `light` ещё может означать Auto: поздний ответ уточнит режим выбора.
 */
export function DocumentSettingsSync() {
    const theme = useResolvedTheme();
    const { textSize } = useUiSettings();
    useLayoutEffect(() => setDocumentAttribute('data-theme', theme), [theme]);
    useLayoutEffect(
        () => setDocumentAttribute('data-textsize', textSize),
        [textSize],
    );
    return null;
}

/** Тема, которую ревьюер видит на экране: явный выбор либо системная в режиме `auto`. */
export function useResolvedTheme(): ResolvedTheme {
    const { theme, arcanum } = useUiSettings();
    const system = useSyncExternalStore(subscribeToSystemTheme, systemTheme, serverSystemTheme);
    const scheme = theme === 'auto' ? system : theme;
    return arcanum ? `arcanum-${scheme}` : scheme;
}

/** Ставит атрибут на `<html>`; возвращает восстановление прежнего значения. */
function setDocumentAttribute(name: string, value: string): () => void {
    const root = document.documentElement;
    const previous = root.getAttribute(name);
    root.setAttribute(name, value);
    return () => {
        if (previous === null) {
            root.removeAttribute(name);
        } else {
            root.setAttribute(name, previous);
        }
    };
}

/** Системная тема; без `matchMedia` остаётся тёмная — она же умолчание токенов. */
function systemTheme(): ColorScheme {
    const media = darkSchemeMedia();
    return media === null || media.matches ? 'dark' : 'light';
}

/**
 * Рендер без окна (`renderToStaticMarkup` в тестах галереи): системную тему спросить не у кого,
 * остаётся тёмная — как и в `index.html`, где на режиме `auto` атрибута нет и работает умолчание
 * токенов.
 */
function serverSystemTheme(): ColorScheme {
    return 'dark';
}

/** Смена системной темы применяется без перезагрузки, поэтому подписка живёт всё время. */
function subscribeToSystemTheme(listener: () => void): () => void {
    const media = darkSchemeMedia();
    if (media === null) {
        return () => undefined;
    }
    media.addEventListener('change', listener);
    return () => {
        media.removeEventListener('change', listener);
    };
}

/** `null` — `matchMedia` в этом окружении нет (тесты компонентов вне jsdom). */
function darkSchemeMedia(): MediaQueryList | null {
    return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;
}
