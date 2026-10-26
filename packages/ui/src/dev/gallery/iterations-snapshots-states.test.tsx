import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ITERATION_SNAPSHOT_STATES } from './iterations-snapshots-states.tsx';

function markup(id: string): string {
    const state = ITERATION_SNAPSHOT_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея снапшотов итераций', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(ITERATION_SNAPSHOT_STATES.map((state) => state.id)).toEqual([
            'iterations-snapshot-picker',
            'iterations-old-snapshot-readonly',
            'iterations-snapshot-gone-readonly',
            'iterations-snapshot-gone-readonly-local',
            'iterations-overview-snapshots-card',
            'iterations-picker-local-host',
        ]);
    });

    it('меню пикера начинается с активной итерации, снапшоты идут следом', () => {
        const html = markup('iterations-snapshot-picker');

        expect(html).toContain('Снапшоты и итерации');
        expect(html).toContain('9f3c1ab');
        expect(html).toContain('5c1d0aa');
        expect(html).toContain('коммита больше нет в PR');
        expect(html).toContain('a71d4e2 · активная итерация · без маршрута');
        // Строка активной итерации стоит выше снапшотов прошлых заходов.
        expect(html.indexOf('a71d4e2 · активная итерация')).toBeLessThan(html.indexOf('5c1d0aa · 6 ч назад'));
        // Модель снапшота видна в строке, полный провенанс — в подсказке.
        expect(html).toContain('5c1d0aa · 6 ч назад · opus-5 · устарел');
        expect(html).toContain('claude-code · opus-5 · 5c1d0aa8b7e6f4302d9c8b7a6f5e4d3c2b1a0999');
        // Текущий снапшот отмечен даже без параметра в адресе.
        expect(html).toContain('data-snapshot="route-medium-9f3c1ab" class="snapshot-picker__row is-cursor"');
        // Последний снапшот построен до пуша: строка меню говорит то же, что индикатор.
        expect(html).toContain('снапшот 9f3c1ab · устарел');
        expect(html).toContain('9f3c1ab · 1 ч назад · claude-opus-5 · устарел');
        expect(html).not.toContain('текущий');
        expect(html).not.toContain('только чтение');
    });

    it('прошлый снапшот: баннер чтения, индикатор «устарел» и выключенные отметки', () => {
        const html = markup('iterations-old-snapshot-readonly');

        expect(html).toContain('Вы смотрите снапшот');
        expect(html).toContain('только чтение');
        expect(html).toContain('К текущему');
        expect(html).toContain('снапшот 5c1d0aa · устарел');
        expect(html).toContain('title="только в активной итерации"');
        expect(html).toContain('disabled=""');
    });

    it('снапшот ушедшего коммита добавляет к баннеру пропажу коммита', () => {
        const html = markup('iterations-snapshot-gone-readonly');

        expect(html).toContain('только чтение · коммита больше нет в PR');
        expect(html).toContain('снапшот b0d3f77 · коммита больше нет в PR');
    });

    it('локальное ревью: ушедшая итерация в баннере чтения — про историю дерева, не про PR', () => {
        const html = markup('iterations-snapshot-gone-readonly-local');

        expect(html).toContain('только чтение · состояния дерева больше нет в истории');
        expect(html).toContain('снапшот b0d3f77 · состояния дерева больше нет в истории');
        expect(html).not.toContain('коммита больше нет в PR');
    });

    it('локальное ревью: строки различаются хвостом коммита, а ушедшая — своими словами', () => {
        const html = markup('iterations-picker-local-host');

        expect(html).toContain('6630996…8f90 · активная итерация · без маршрута');
        expect(html).toContain('6630996…7a8b');
        expect(html).toContain('6630996…3c4d');
        expect(html).toContain('состояния дерева больше нет в истории');
        expect(html).not.toContain('коммита больше нет в PR');
    });

    it('на Обзоре карточка «Снапшоты» несёт провенанс каждого снапшота', () => {
        const html = markup('iterations-overview-snapshots-card');

        expect(html).toContain('Снапшоты');
        // В строке — короткий коммит (docs/design/README.md §13), в подсказке — полный.
        expect(html).toContain('claude-code · claude-opus-5 · 9f3c1ab<');
        expect(html).toContain('title="claude-code · claude-opus-5 · 9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316"');
        expect(html).toContain('9f3c1ab · 1 ч назад · claude-opus-5 · текущий');
    });
});
