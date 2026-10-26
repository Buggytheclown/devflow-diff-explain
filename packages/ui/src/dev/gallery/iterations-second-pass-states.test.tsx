import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createT } from '../../i18n/index.js';
import { CHANGE_CHIP_LABEL } from '../../views/route/route-toolbar.tsx';
import { ITERATION_SECOND_PASS_STATES } from './iterations-second-pass-states.tsx';

function markup(id: string): string {
    const state = ITERATION_SECOND_PASS_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея второго захода', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(ITERATION_SECOND_PASS_STATES.map((state) => state.id)).toEqual([
            'iterations-stale-banner',
            'iterations-stale-banner-local',
            'iterations-second-pass-banner',
            'iterations-second-pass-zero-carry',
            'iterations-filter-new',
            'iterations-stop-changed',
            'iterations-stop-new',
            'iterations-why-changed',
        ]);
    });

    it('stale-баннер называет оба коммита, число итераций и затронутые остановки', () => {
        const html = markup('iterations-stale-banner');

        expect(html).toContain('Маршрут построен для');
        expect(html).toContain('9f3c1ab');
        expect(html).toContain('a71d4e2');
        expect(html).toContain('2 новые итерации');
        expect(html).toContain('затронуты остановки 02, 03 и 06');
        expect(html).toContain('Перестроить маршрут');
    });

    it('в локальном ревью stale-баннер говорит про рабочее дерево, а не про PR', () => {
        const html = markup('iterations-stale-banner-local');

        expect(html).toContain('рабочее дерево уже на');
        expect(html).not.toContain('PR уже на');
        // Итерации локального ревью различимы по первым символам отпечатка диффа.
        expect(html).toContain('6c1f9a3');
        expect(html).toContain('a3d52f8');
    });

    it('баннер второго захода печатает перенос прогресса и предлагает фильтр', () => {
        const html = markup('iterations-second-pass-banner');

        expect(html).toContain('Маршрут перестроен для');
        expect(html).toContain('Просмотренными остались 3 остановки из 6.');
        expect(html).toContain('Изменились 3 остановки; комментарии на изменившихся диапазонах');
        expect(html).toContain('Что нового с прошлого захода');
    });

    it('нулевой перенос называет причину и не выдаёт её за «ничего не изменилось»', () => {
        const html = markup('iterations-second-pass-zero-carry');

        expect(html).toContain(
            'Отметки просмотра с прошлого захода были, но целиком просмотренной не осталась ни одна остановка.',
        );
        expect(html).toContain('Изменились 3 остановки;');
        expect(html).not.toContain('Изменений в остановках нет');
    });

    it('фильтр «что нового» оставляет три остановки и рисует чип', () => {
        const html = markup('iterations-filter-new');

        expect(html).toContain(createT('ru')(CHANGE_CHIP_LABEL));
        expect([...html.matchAll(/data-stop="/g)]).toHaveLength(3);
        // Номера план-фиксированные: знаменатель остаётся полным набором слотов.
        expect(html).toContain('02 / 7');
    });

    it('бейджи классификации видны без фильтра', () => {
        expect(markup('iterations-stop-changed')).toContain('изменилась');
        expect(markup('iterations-stop-new')).toContain('новая');
    });

    it('блок «почему изменилась остановка» несёт лейбл и ссылку на тред', () => {
        const html = markup('iterations-why-changed');

        expect(html).toContain('почему изменилась остановка');
        expect(html).toContain('тред у строки 33');
    });
});
