// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { jumpTarget } from './scroll.js';

/**
 * Лесенка целей прыжка (docs/design/SPEC-elements.md §2.9): секция → карточка → строка. Ступень важнее самого элемента —
 * по ней вызывающий решает, доехал прыжок или искать дальше. Промежуточная ступень обязана быть
 * настоящей целью прокрутки: остановка, чьи карточки отложены ленивым рендером, дорисовывает их,
 * только побывав на экране, и везёт её туда как раз этот прыжок.
 */

function container(markup: string): HTMLElement {
    const element = document.createElement('div');
    element.innerHTML = markup;
    return element;
}

const FULL = container(`
    <div data-stop="s01"><article data-file="f1"><div class="diff-row" data-key="a12">x</div></article></div>
    <div data-stop="s04"><article data-file="f9"></article></div>
`);

/** Остановка на экране ещё не побывала: карточек в ней нет, есть только сама секция. */
const LAZY = container('<div data-stop="s01"></div>');

describe('цель прыжка', () => {
    it('без файла целью остаётся секция остановки', () => {
        expect(jumpTarget(FULL, 's01', null, null, null)).toEqual({
            step: 'section',
            element: FULL.querySelector('[data-stop="s01"]'),
        });
    });

    it('карточка файла — своя ступень, когда строку не просили', () => {
        expect(jumpTarget(FULL, 's01', 'f1', null, null)?.step).toBe('card');
    });

    it('строка найдена — последняя ступень', () => {
        const target = jumpTarget(FULL, 's01', 'f1', 12, 'new');

        expect(target?.step).toBe('row');
        expect(target?.element.dataset.key).toBe('a12');
    });

    it('строки в срезе карточки нет — доезжаем хотя бы до файла', () => {
        expect(jumpTarget(FULL, 's01', 'f1', 999, 'new')?.step).toBe('card');
    });

    it('карточка ещё не отрисована — целью становится секция, а не пустота', () => {
        // Ровно случай ленивого рендера: не будь этой ступени, прыжок замер бы навсегда —
        // карточки появятся, только когда остановка окажется на экране.
        expect(jumpTarget(LAZY, 's01', 'f1', 12, 'new')).toEqual({
            step: 'section',
            element: LAZY.querySelector('[data-stop="s01"]'),
        });
    });

    it('чужая карточка не считается своей: файл ищется внутри секции остановки', () => {
        expect(jumpTarget(FULL, 's04', 'f1', null, null)?.step).toBe('section');
    });

    it('секции нет вовсе — цели нет, и вызывающий это различает', () => {
        expect(jumpTarget(FULL, 'нет-такой-остановки', null, null, null)).toBeNull();
    });
});
