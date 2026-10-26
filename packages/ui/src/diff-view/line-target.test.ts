// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { findAgentNote, findLineRow, flashAgentNote, flashRow, lineAt } from './line-target.js';

/**
 * Поиск строки в разметке карточки. Главное здесь — сторона: номер 41 новой стороны и номер 41
 * старой это разные строки, и в одном ханке они встречаются вместе.
 */

/** Карточка с обеими сторонами на одном номере: удалённая 41 и добавленная 41. */
function card(): HTMLElement {
    const element = document.createElement('div');
    element.innerHTML = `
        <div class="diff-row" id="ctx"><span data-key="c40:39">context</span></div>
        <div class="diff-row" id="del"><span data-key="d41">removed</span></div>
        <div class="diff-row" id="add"><span data-key="a41">added</span></div>
        <div class="diff-row" id="both"><span data-key="c41:43">context both sides</span></div>
    `;
    return element;
}

describe('строка диффа по номеру и стороне', () => {
    it('новая сторона находит добавленную, старая — удалённую, а не соседку с тем же номером', () => {
        expect(findLineRow(card(), 'new', 41)?.id).toBe('add');
        expect(findLineRow(card(), 'old', 41)?.id).toBe('del');
    });

    it('изменённой строки нет — берётся неизменённая с этим номером на своей стороне', () => {
        // 43 стоит новой стороной у контекста `c41:43`, 40 — старой у `c40:39`.
        expect(findLineRow(card(), 'new', 43)?.id).toBe('both');
        expect(findLineRow(card(), 'old', 40)?.id).toBe('ctx');
        // Тот же контекст с чужой стороны не подходит: 43 старой стороны в карточке нет.
        expect(findLineRow(card(), 'old', 43)).toBeNull();
        expect(findLineRow(card(), 'new', 40)).toBeNull();
    });

    it('строки нет вовсе — null, а не первая попавшаяся', () => {
        expect(findLineRow(card(), 'new', 999)).toBeNull();
    });
});

describe('флеш строки', () => {
    it('ставит класс подсветки и снимает его по концу анимации', () => {
        const row = card().querySelector<HTMLElement>('#add');
        if (row === null) {
            throw new Error('в карточке должна быть добавленная строка');
        }

        flashRow(row);
        expect(row.classList.contains('diff-row--palette-target')).toBe(true);

        row.dispatchEvent(new Event('animationend'));
        expect(row.classList.contains('diff-row--palette-target')).toBe(false);
    });
});

describe('фокус заметки', () => {
    it('находит заметку по id, фокусирует и снимает подсветку по концу анимации', () => {
        const root = document.createElement('div');
        root.innerHTML = '<article data-note="31" tabindex="-1"></article>';
        document.body.append(root);
        const note = findAgentNote(root, 31);
        if (note === null) {
            throw new Error('заметка должна находиться по data-note');
        }

        flashAgentNote(note);
        expect(document.activeElement).toBe(note);
        expect(note.classList.contains('agent-note--target')).toBe(true);

        note.dispatchEvent(new Event('animationend'));
        expect(note.classList.contains('agent-note--target')).toBe(false);
        root.remove();
    });
});


/** Карточка файла: unified-ряды несут ключ на самом ряду, split-ячейки — ещё и свою сторону. */
function fileCard(): HTMLElement {
    const element = document.createElement('article');
    element.dataset.file = 'checkout';
    element.innerHTML = `
        <div class="diff-row" data-key="a41" tabindex="0"><code class="diff-row__code">added</code></div>
        <div class="diff-row" data-key="d17" tabindex="0"><code class="diff-row__code">removed</code></div>
        <div class="diff-row" data-key="c40:39" tabindex="0"><code class="diff-row__code">context</code></div>
        <div class="diff-row diff-row--pair">
            <code class="diff-row__code" data-key="c40:39" data-side="old" id="split-old">context</code>
            <code class="diff-row__code" data-key="c40:39" data-side="new" id="split-new">context</code>
        </div>
    `;
    return element;
}

function at(card: HTMLElement, selector: string): ReturnType<typeof lineAt> {
    const element = card.querySelector(selector);
    if (element === null) {
        throw new Error(`в карточке нет ${selector}`);
    }
    return lineAt(element);
}

describe('строка под элементом', () => {
    it('unified: `a` — новая сторона, `d` — старая, `c` — новая, как её считает сам ряд', () => {
        const card = fileCard();

        expect(at(card, '[data-key="a41"] code')).toEqual({ fileId: 'checkout', side: 'new', line: 41 });
        expect(at(card, '[data-key="d17"] code')).toEqual({ fileId: 'checkout', side: 'old', line: 17 });
        expect(at(card, '.diff-row[data-key="c40:39"]')).toEqual({ fileId: 'checkout', side: 'new', line: 39 });
    });

    it('split: сторону берёт `data-side` ячейки', () => {
        const card = fileCard();

        expect(at(card, '#split-old')).toEqual({ fileId: 'checkout', side: 'old', line: 40 });
        expect(at(card, '#split-new')).toEqual({ fileId: 'checkout', side: 'new', line: 39 });
    });

    it('элемент вне строки или вне карточки — null', () => {
        const card = fileCard();
        const loose = document.createElement('div');
        loose.innerHTML = '<span data-key="a41"></span>';

        expect(lineAt(card)).toBeNull();
        expect(lineAt(null)).toBeNull();
        expect(lineAt(loose.querySelector('span'))).toBeNull();
    });

    it('в атрибуте не ключ строки — null, а не строка с номером NaN', () => {
        const card = fileCard();
        const alien = document.createElement('span');
        alien.dataset.key = 'gap:12';
        card.append(alien);

        expect(lineAt(alien)).toBeNull();
    });
});
