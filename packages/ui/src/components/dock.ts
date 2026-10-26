import { useEffect } from 'react';

/**
 * Класс открытого чата на корне документа. По нему CSS считает `--dock-right` (ширина
 * пристыкованного справа чата при ≥1280) и убирает плавающую панель действий под скрим,
 * когда чат работает оверлеем (<1280). Сами `--dock-left`/`--dock-right` объявлены в
 * `components/review-action-bar.css` — их видно только там, где подключены стили панели.
 */
export const CHAT_DOCK_CLASS = 'is-chat-docked';

/**
 * Точка стыковки чата. Дубль медиазапроса из `components/review-action-bar.css`: слои и
 * ширины считает CSS, а JS по тому же условию решает, доступны ли терминальные действия.
 */
export const CHAT_DOCK_MEDIA = '(min-width: 1280px)';

/**
 * Чат накрывает контент оверлеем, а не стоит колонкой справа: панель действий уходит под его
 * скрим, и её команды на это время выключены — композер вопроса и Ship одновременно не нужны.
 * Читается в момент нажатия, поэтому слушателя ширины окна здесь нет.
 */
export function chatOverlaysContent(chatOpen: boolean): boolean {
    return chatOpen && !window.matchMedia(CHAT_DOCK_MEDIA).matches;
}

/**
 * Держит класс стыковки чата на корне документа, пока чат открыт. Ширины считает CSS
 * медиазапросом — слушателя ширины окна здесь нет намеренно.
 */
export function useChatDock(chatOpen: boolean): void {
    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle(CHAT_DOCK_CLASS, chatOpen);
        return () => {
            root.classList.remove(CHAT_DOCK_CLASS);
        };
    }, [chatOpen]);
}
