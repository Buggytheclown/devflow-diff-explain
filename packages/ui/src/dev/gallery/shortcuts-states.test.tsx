import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SHORTCUT_STATES } from './shortcuts-states.tsx';

function markup(id: string): string {
    const state = SHORTCUT_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея горячих клавиш', () => {
    it('регистрирует читшит в трёх областях', () => {
        expect(SHORTCUT_STATES.map((state) => state.id)).toEqual([
            'cheatsheet-overview',
            'cheatsheet-route',
            'cheatsheet-full-diff',
        ]);
    });

    it('на Обзоре показаны только глобальные команды', () => {
        const html = markup('cheatsheet-overview');

        expect(html).toContain('⌘K');
        expect(html).toContain('G затем O');
        expect(html).not.toContain('Следующая остановка');
        expect(html).not.toContain('Следующий файл');
        // Пустых разделов нет: команд «Комментарии» вне вью не бывает.
        expect(html).not.toContain('Комментарии');
    });

    it('на Маршруте появляются остановки, файлов полного диффа нет', () => {
        const html = markup('cheatsheet-route');

        expect(html).toContain('Следующая остановка');
        expect(html).toContain('Фильтр «что нового с прошлого захода»');
        expect(html).toContain('Комментарии');
        expect(html).not.toContain('Следующий файл');
    });

    it('на Полном диффе появляются файлы, остановок нет', () => {
        const html = markup('cheatsheet-full-diff');

        expect(html).toContain('Следующий файл');
        expect(html).toContain('Отметить файл просмотренным');
        expect(html).not.toContain('Следующая остановка');
    });

    it('⌘K — первая строка «Навигации» во всех областях', () => {
        for (const id of SHORTCUT_STATES.map((state) => state.id)) {
            const html = markup(id);
            expect(html.indexOf('⌘K')).toBeLessThan(html.indexOf('Вью «Обзор»'));
        }
    });
});
