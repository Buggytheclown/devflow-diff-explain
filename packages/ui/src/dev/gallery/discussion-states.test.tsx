import { GALLERY_AVATAR_PHOTOS } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DISCUSSION_STATES } from './discussion-states.tsx';

/** Три состояния карточки «Обсуждение» по чек-листу docs/design/SPEC-additions-2026-08-26.md §1e. */

function markup(id: string): string {
    const state = DISCUSSION_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея карточки «Обсуждение»', () => {
    it('регистрирует ровно те id, которые заводит задача', () => {
        expect(DISCUSSION_STATES.map((state) => state.id)).toEqual([
            'discussion-empty',
            'discussion-people',
            'discussion-scale',
            'discussion-outside-open',
            'discussion-avatars',
        ]);
    });

    it('пусто: приглашение вместо списка, чипов и свёртки', () => {
        const html = markup('discussion-empty');

        expect(html).toContain('Ни одного треда — обсуждение начинается у кода.');
        expect(html).not.toContain('thread-chip');
        expect(html).not.toContain('discussion-card__outside-toggle');
        expect(html).toContain('Написать к PR');
    });

    it('только люди: строки участников со счётчиками, тел тредов в карточке нет', () => {
        const html = markup('discussion-people');

        expect(html).toContain('discussion-participant__name');
        expect(html).not.toContain('discussion-thread__body');
        expect(html).toContain('aria-expanded="false"');
    });

    it('масштаб 86/83: шапка честная, строк шесть, остальные за «ещё N»', () => {
        const html = markup('discussion-scale');
        const rows = html.split('discussion-participant__name-line').length - 1;

        expect(html).toContain('86 тредов');
        expect(rows).toBe(6);
        expect(html).toContain('ещё 3 участника');
        // Боты — строки со счётчиком, но не участники: их тела карточка не показывает никогда.
        expect(html).toContain('>bot</span>');
        expect(html).not.toContain('discussion-thread__body');
    });

    it('«вне диффа» раскрыто: длинная ссылка, блок кода и композер ответа в колонке 360px', () => {
        const html = markup('discussion-outside-open');

        expect(html).toContain('aria-expanded="true"');
        // Два треда людей вне диффа: ушедший файл с блоком кода и ссылкой, уровень PR с ответами.
        expect(html.split('class="discussion-thread"').length - 1).toBe(2);
        expect(html).toContain('<pre class="md-pre"');
        expect(html).toContain('edit-window.ts#L118-L146');
        // Композер открыт у треда уровня PR — вместе с ним видны уже написанные ответы.
        expect(html).toContain('2 ответа');
        expect(html).toContain('Описание дополнил');
        // Бот-тредов вне диффа не бывает: тела ботов не показываются даже в раскрытой свёртке.
        expect(html).not.toContain('Возможная утечка контекста');
        expect(html).toContain('thread-composer');
    });

    it('фото: у людей и у бота — в строках и в тредах вне диффа', () => {
        const html = markup('discussion-avatars');

        // Три человека и бот в списке, два треда людей вне диффа; битое фото откатывается уже в браузере.
        expect(html.split('class="avatar__photo"').length - 1).toBe(6);
        expect(html).toContain(GALLERY_AVATAR_PHOTOS[0]);
        expect(html).toContain(GALLERY_AVATAR_PHOTOS[2]);
    });
});
