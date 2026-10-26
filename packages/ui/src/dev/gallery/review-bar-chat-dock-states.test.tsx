import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { REVIEW_BAR_CHAT_DOCK_STATES } from './review-bar-chat-dock-states.tsx';

function markup(id: string): string {
    const state = REVIEW_BAR_CHAT_DOCK_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея панели действий рядом с чатом', () => {
    it('регистрирует кадры панели', () => {
        expect(REVIEW_BAR_CHAT_DOCK_STATES.map((state) => state.id)).toEqual([
            'review-bar-chat-docked',
            'review-bar-chat-overlay',
            'review-bar-issue-drafts',
        ]);
    });

    it('пристыкованный кадр держит панель действий и чат без скрима', () => {
        const html = markup('review-bar-chat-docked');

        expect(html).toContain('review-action-bar');
        expect(html).toContain('gallery-dock-chat');
        expect(html).not.toContain('gallery-dock-scrim');
    });

    it('кадр со счётчиком issue держит хвост у черновиков и открытое меню шипа', () => {
        const html = markup('review-bar-issue-drafts');

        expect(html).toContain('· 2 issues');
        expect(html).toContain('review-action-menu');
    });

    it('оверлейный кадр добавляет скрим над панелью', () => {
        const html = markup('review-bar-chat-overlay');

        expect(html).toContain('gallery-dock-scrim');
        expect(html).toContain('gallery-dock-chat--overlay');
        expect(html).toContain('review-action-bar');
    });
});
