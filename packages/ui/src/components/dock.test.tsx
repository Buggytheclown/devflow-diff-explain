// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAT_DOCK_CLASS, CHAT_DOCK_MEDIA, chatOverlaysContent, useChatDock } from './dock.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.documentElement.classList.remove(CHAT_DOCK_CLASS);
});

function render(chatOpen: boolean): (next: boolean) => void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draw = (open: boolean): void => {
        act(() => {
            root.render(<Probe chatOpen={open} />);
        });
    };
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    draw(chatOpen);
    return draw;
}

function Probe({ chatOpen }: { chatOpen: boolean }) {
    useChatDock(chatOpen);
    return null;
}

describe('класс стыковки чата', () => {
    it('стоит на корне документа, пока чат открыт', () => {
        const draw = render(true);
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(true);

        draw(false);
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(false);
    });

    it('уходит вместе с приложением', () => {
        render(true);
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(true);

        const unmount = mounted.pop();
        unmount?.();
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(false);
    });
});

describe('оверлейный режим чата', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ниже точки стыковки чат накрывает контент', () => {
        stubDockMedia(false);
        expect(chatOverlaysContent(true)).toBe(true);
    });

    it('выше точки стыковки чат стоит колонкой', () => {
        stubDockMedia(true);
        expect(chatOverlaysContent(true)).toBe(false);
    });

    it('закрытый чат ничего не накрывает', () => {
        stubDockMedia(false);
        expect(chatOverlaysContent(false)).toBe(false);
    });

    it('спрашивает ровно тот медиазапрос, что стоит в CSS панели', () => {
        const matchMedia = stubDockMedia(true);
        chatOverlaysContent(true);
        expect(matchMedia).toHaveBeenCalledWith(CHAT_DOCK_MEDIA);
    });
});

/** jsdom своего `matchMedia` не считает — точку стыковки задаём вручную. */
function stubDockMedia(docked: boolean) {
    const matchMedia = vi.fn((query: string) => ({ matches: docked, media: query }));
    vi.stubGlobal('matchMedia', matchMedia);
    return matchMedia;
}
