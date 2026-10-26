import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ROUTE_LOCALE_STATES } from './route-locale-states.tsx';

function markup(id: string): string {
    const state = ROUTE_LOCALE_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея языка маршрута', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(ROUTE_LOCALE_STATES.map((state) => state.id)).toEqual([
            'route-locale-en-route-ru-ui',
            'route-locale-rebuild-unavailable',
            'route-locale-legacy-snapshot-en-ui',
        ]);
    });

    it('английский маршрут на русской вкладке: язык в индикаторе и вопрос в плашке', () => {
        const html = markup('route-locale-en-route-ru-ui');

        expect(html).toContain('claude-code · claude-opus-5');
        expect(html).toContain('· английский');
        expect(html).toContain('Маршрут построен на английском — перестроить на русском?');
        expect(html).toContain('Перестроить на русском');
        expect(html).toContain('Оставить');
        expect(html).not.toContain('disabled');
    });

    it('недоступная перестройка: кнопка гаснет и объясняет причину', () => {
        const html = markup('route-locale-rebuild-unavailable');

        expect(html).toContain('disabled=""');
        expect(html).toContain('Пока маршрут заполняется, перестроить его нельзя.');
    });

    it('снапшот без языка на английской вкладке трактуется как русский', () => {
        const html = markup('route-locale-legacy-snapshot-en-ui');

        expect(html).toContain('· Russian');
        expect(html).toContain('The route was built in Russian — rebuild it in English?');
        expect(html).toContain('Rebuild in English');
    });
});
