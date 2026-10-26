import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UPDATE_TOAST_STATES } from './update-toast-states.tsx';

function markup(id: string): string {
    const state = UPDATE_TOAST_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея тоста обновления', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(UPDATE_TOAST_STATES.map((state) => state.id)).toEqual([
            'update-toast-arc-checkout',
            'update-toast-copy',
            'update-toast-how',
            'update-toast-no-motion',
            'update-top-bar-dot',
        ]);
    });

    it('тост называет обе версии, «что нового» и обе команды футера', () => {
        const html = markup('update-toast-arc-checkout');

        expect(html).toContain('Обновление');
        expect(html).toContain('Шерпа 0.5.0 доступна');
        expect(html).toContain('у вас 0.4.0');
        expect(html).toContain('Тост обновления, читшит');
        expect(html).toContain('Как обновить');
        expect(html).toContain('Не напоминать про 0.5.0');
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-live="polite"');
    });

    it('раскрытое «Как обновить» у чекаута показывает arc pull', () => {
        const html = markup('update-toast-how');

        expect(html).toContain('arc pull');
        expect(html).toContain('Скопировать');
        expect(html).not.toContain('Скопируйте каталог заново');
    });

    it('у копии команды нет — только каталог и ссылка на README', () => {
        const copy = markup('update-toast-copy');
        expect(copy).not.toContain('arc pull');

        // Блок «Как обновить» у копии тот же, но раскрывается кликом: в статичной разметке его нет.
        expect(copy).toContain('Как обновить');
    });

    it('модификатор без анимации есть только у своего состояния', () => {
        expect(markup('update-toast-no-motion')).toContain('update-toast--no-motion');
        expect(markup('update-toast-arc-checkout')).not.toContain('update-toast--no-motion');
    });

    it('версия в топбаре становится кнопкой с точкой и подписью для скринридера', () => {
        const html = markup('update-top-bar-dot');

        expect(html).toContain('top-bar__version--update');
        expect(html).toContain('top-bar__version-dot');
        expect(html).toContain('aria-label="Доступна версия 0.5.0"');
    });
});
