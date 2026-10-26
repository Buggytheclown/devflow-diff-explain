import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ROUTE_LONG_PATH_STATES } from './route-long-paths-states.tsx';

/** Чипы файлов на длинных путях (docs/design/SPEC-elements.md §1.2, §2.11). */

function markup(id: string): string {
    const state = ROUTE_LONG_PATH_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

/**
 * Подсказки путей именно из чипов файлов: те же пути лежат в тултипах карточек файлов справа,
 * поэтому поиск по одной подстроке `title="…"` проверял бы чужой элемент.
 */
function chipPathTitles(html: string): string[] {
    return [...html.matchAll(/<span\b[^>]*\bclass="route-chip__path"[^>]*>/g)]
        .map((tag) => /\btitle="([^"]*)"/.exec(tag[0])?.[1])
        .filter((title): title is string => title !== undefined);
}

describe('галерея чипов файлов на длинных путях', () => {
    it('регистрирует ровно те id, которые заводит задача', () => {
        expect(ROUTE_LONG_PATH_STATES.map((state) => state.id)).toEqual([
            'route-chips-deep-path',
            'route-chips-long-name',
            'route-chips-mixed',
        ]);
    });

    it('глубокий путь: каталог целиком в тултипе, имя в чипе не тронуто', () => {
        const html = markup('route-chips-deep-path');

        expect(chipPathTitles(html)).toContain(
            'services/orders/src/infra/platform/time/providers/generated/v3/internal/adapters/legacy/system/clock.ts',
        );
        expect(html).toContain('<span class="route-chip__name">clock.ts</span>');
        expect(html).toContain(
            '<bdi>services/orders/src/infra/platform/time/providers/generated/v3/internal/adapters/legacy/system</bdi>',
        );
    });

    it('длинное имя: каталог короткий, имя чипа — по-прежнему полное имя файла', () => {
        const html = markup('route-chips-long-name');

        expect(html).toContain(
            '<span class="route-chip__name">edit-window-expiration-policy-compatibility-adapter.factory.ts</span>',
        );
        expect(chipPathTitles(html)).toContain(
            'services/orders/src/domain/edit-window-expiration-policy-compatibility-adapter.factory.ts',
        );
    });

    it('смешанная остановка: длинные пути рядом с обычными, раскрывашки «ещё N» нет', () => {
        const html = markup('route-chips-mixed');

        expect(chipPathTitles(html)).toContain(
            'services/orders/src/api/internal/generated/v3/handlers/compatibility/legacy/adapters/rest/handlers.ts',
        );
        expect(html).toContain('<span class="route-chip__name">handlers.ts</span>');
        // Обычный путь той же остановки остался как в фикстуре.
        expect(chipPathTitles(html)).toContain('services/orders/src/api/schemas.ts');
        expect(html).not.toContain('route-chips__more');
    });
});
