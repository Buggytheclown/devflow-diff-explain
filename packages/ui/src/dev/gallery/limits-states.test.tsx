import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LIMIT_STATES } from './limits-states.tsx';

// Виртуализатор дерева меряет раскладку, которой в статическом рендере нет: без мока строк ноль.
vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 26,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 26,
                size: 26,
                end: (index + 1) * 26,
                lane: 0,
            })),
        scrollToIndex: () => undefined,
    }),
}));

function markup(id: string): string {
    const state = LIMIT_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея лимитов и деградаций', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(LIMIT_STATES.map((state) => state.id)).toEqual([
            'conflict-file-card',
            'conflict-file-tree',
            'conflict-stop-notice',
            'conflict-other-card',
            'generation-cap-toolbar',
            'generation-cap-banner',
            'empty-pr-full-diff',
            'empty-pr-overview',
        ]);
    });

    it('карточка конфликтного файла несёт бейдж, обычная — нет', () => {
        const html = markup('conflict-file-card');

        expect(html).toContain('file-card__badge--conflict');
        expect(html).toContain('>conflict</span>');
        expect(html).toContain('services/orders/src/domain/order.ts');
    });

    it('в дереве конфликт помечен своим тегом ровно один раз', () => {
        const html = markup('conflict-file-tree');
        const tags = html.split('file-tree__tag--conflict').length - 1;

        expect(tags).toBe(1);
    });

    it('остановка на конфликтном файле зовёт в хост, а не на перегенерацию', () => {
        const html = markup('conflict-stop-notice');

        expect(html).toContain('route-conflicts');
        expect(html).toContain('в конфликте: разрешить его можно только вне Шерпы');
        expect(html).not.toContain('которых в диффе больше нет');
    });

    it('«Прочее» ради одних конфликтов не печатает нулей и не даёт кнопок', () => {
        const html = markup('conflict-other-card');

        expect(html).toContain('Без остановки не осталось ни одной изменённой строки');
        expect(html).toContain('2 файла с конфликтами');
        expect(html).not.toContain('route-other__actions');
        expect(html).not.toContain('Открыть 0');
    });

    it('тулбар маршрута говорит, чем ограничен план', () => {
        const html = markup('generation-cap-toolbar');

        expect(html).toContain('route-toolbar__cap');
        expect(html).toContain('план покрывает 120 файлов из 505; 380 машинных — одной остановкой');
    });

    it('баннер капа объясняет неполный дифф и не предлагает кнопок', () => {
        const html = markup('generation-cap-banner');

        expect(html).toContain('Маршрут построен не по всему диффу');
        expect(html).not.toContain('<button');
    });

    it('пустой PR говорит одно и то же на обоих вью', () => {
        expect(markup('empty-pr-full-diff')).toContain('Нечего ревьюить');
        expect(markup('empty-pr-overview')).toContain('Нечего ревьюить');
        expect(markup('empty-pr-overview')).not.toContain('ownership-card');
    });
});
