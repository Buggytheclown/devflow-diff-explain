/**
 * Поиск цели перехода в разметке и её показ: строка диффа, заметка агента, композер.
 * Одна реализация на переходы к строке — из командной палитры в полном диффе и по якорю
 * утверждения дайджеста на маршруте (docs/design/README.md §2). Ключ строки печатает `lineKey` — здесь он
 * только читается.
 */

import { lineKeyNumbers, lineSide, parseLineKey } from './selection.js';

/** Классы подсветки после перехода; анимации задают стили строк и заметок. */
const ROW_FLASH = 'diff-row--palette-target';
const NOTE_FLASH = 'agent-note--target';

/**
 * Строка карточки по номеру своей стороны: изменённая (`a{n}` / `d{n}`), иначе — неизменённая,
 * у которой этот номер стоит на нужной стороне (`c{old}:{new}`). Сторона обязательна: номер 41
 * новой стороны и номер 41 старой — разные строки, и без стороны переход к удалённой строке
 * перехватывала бы добавленная. `null` — строки в этой карточке нет.
 */
export function findLineRow(card: ParentNode, side: 'old' | 'new', line: number): HTMLElement | null {
    const number = String(line);
    const exact = side === 'new' ? `[data-key="a${number}"]` : `[data-key="d${number}"]`;
    const context = side === 'new' ? `[data-key^="c"][data-key$=":${number}"]` : `[data-key^="c${number}:"]`;
    const cell = card.querySelector<HTMLElement>(exact) ?? card.querySelector<HTMLElement>(context);
    return cell === null ? null : (cell.closest<HTMLElement>('.diff-row, .markdown-review__block') ?? cell);
}

/** Адрес строки в разметке: файл карточки и номер на своей стороне. */
export interface LineAddress {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly line: number;
}

/**
 * Обратная к `findLineRow`: какая строка нарисована под этим элементом. Нужна командам
 * «под курсором» — мышь даёт элемент, а команде нужен адрес. `null` — элемент не в строке
 * диффа или не в карточке файла.
 *
 * Сторону в split даёт `data-side` ячейки; в unified его нет, и сторона выводится из ключа
 * (`lineSide`) — так же, как её считают выделение и сам ряд.
 */
export function lineAt(element: Element | null | undefined): LineAddress | null {
    const cell = element?.closest<HTMLElement>('[data-key]') ?? null;
    const fileId = cell?.closest<HTMLElement>('[data-file]')?.dataset.file;
    const key = parseLineKey(cell?.dataset.key);
    if (key === null || fileId === undefined) {
        return null;
    }
    const numbers = lineKeyNumbers(key);
    if (numbers === null) {
        return null;
    }
    const dataSide = cell?.dataset.side;
    const side = dataSide === 'old' || dataSide === 'new' ? dataSide : lineSide(key);
    const line = side === 'old' ? numbers.old : numbers.new;
    return line === null ? null : { fileId, side, line };
}

/** Флеш строки: класс снимается по концу анимации, чтобы повторный переход её перезапустил. */
export function flashRow(row: HTMLElement): void {
    flash(row, ROW_FLASH);
}

export function findAgentNote(root: ParentNode, noteId: number | string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-note="${String(noteId)}"]`);
}

/** Подсветка развёрнутой заметки после перехода из чата. */
export function flashAgentNote(note: HTMLElement): void {
    flash(note, NOTE_FLASH);
    note.focus({ preventScroll: true });
}

/** Композер по ключу открытия; `null` — его карточки сейчас нет в разметке. */
export function findComposer(root: ParentNode, key: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-composer-key="${CSS.escape(key)}"]`);
}

/** Фокус в поле композера: в markdown-раскладке это textarea, в визуальной — ProseMirror. */
export function focusComposerInput(composer: HTMLElement): void {
    composer.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus({ preventScroll: true });
}

/**
 * Показывает цель, как только она появляется в разметке: пробует в следующем кадре, а пока
 * узла нет — на каждую мутацию документа, но не дольше таймаута. `reveal` возвращает `false`,
 * пока показывать нечего. Результат — отмена ожидания (для очистки эффекта).
 */
export function revealWhenReady(reveal: () => boolean, timeoutMs: number): () => void {
    let observer: MutationObserver | null = null;
    let frame: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
        observer?.disconnect();
        observer = null;
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }
    };
    const attempt = (): boolean => {
        if (!reveal()) {
            return false;
        }
        stop();
        return true;
    };

    frame = requestAnimationFrame(() => {
        frame = null;
        if (attempt()) {
            return;
        }
        observer = new MutationObserver(() => {
            attempt();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        timeout = setTimeout(stop, timeoutMs);
    });
    return stop;
}

function flash(element: HTMLElement, className: string): void {
    element.classList.remove(className);
    // Перезапуск анимации: без принудительного пересчёта повторный переход к той же цели молчит.
    void element.offsetWidth;
    element.classList.add(className);
    element.addEventListener(
        'animationend',
        () => {
            element.classList.remove(className);
        },
        { once: true },
    );
}
