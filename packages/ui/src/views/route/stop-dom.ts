import type { StopBox } from './scroll.js';
import { cssEscape } from './scroll.js';

/**
 * Что маршрут читает из собственной разметки: геометрия секций и карточек файлов. Состав здесь
 * всегда актуальный — линза, свёртки и ленивый рендер уже учтены тем, что нарисовано.
 */

/** Секции остановок в порядке разметки; ленивo — выбор якоря обрывает обмер на первой видимой. */
export function* stopBoxes(container: HTMLElement): Generator<StopBox> {
    for (const section of container.querySelectorAll<HTMLElement>('[data-stop]')) {
        const stopId = section.dataset.stop;
        if (stopId !== undefined) {
            const rect = section.getBoundingClientRect();
            yield { stopId, top: rect.top, bottom: rect.bottom };
        }
    }
}

/**
 * Верхняя карточка файла на экране и остановка, которой она принадлежит. Читаемое начинается под
 * липким тулбаром — карточка, целиком ушедшая под него, верхней не считается.
 */
export function topFileCard(container: HTMLElement): { readonly stopId: string; readonly fileId: string } | null {
    const top = container.getBoundingClientRect().top;
    const toolbar = container.querySelector<HTMLElement>('.route-toolbar');
    const line = toolbar === null ? top : Math.max(top, toolbar.getBoundingClientRect().bottom);
    for (const card of container.querySelectorAll<HTMLElement>('.file-card[data-file]')) {
        if (card.getBoundingClientRect().bottom <= line) {
            continue;
        }
        const stopId = card.closest<HTMLElement>('[data-stop]')?.dataset.stop;
        const fileId = card.dataset.file;
        return stopId === undefined || fileId === undefined ? null : { stopId, fileId };
    }
    return null;
}

/**
 * Следующая карточка той же остановки: ближайшая ниже развёрнутая, а если ниже все свёрнуты —
 * просто следующая (то же правило, что у `nextFileToAdvance` в полном диффе). Состав карточек
 * берётся из разметки — линза в ней уже учтена; свёрнутую выдаёт заглушка вместо тела.
 */
export function nextCardInStop(container: HTMLElement, stopId: string, fileId: string): string | null {
    const section = container.querySelector<HTMLElement>(`[data-stop="${cssEscape(stopId)}"]`);
    if (section === null) {
        return null;
    }
    const cards = [...section.querySelectorAll<HTMLElement>('.file-card[data-file]')];
    const index = cards.findIndex((card) => card.dataset.file === fileId);
    if (index < 0) {
        return null;
    }
    const rest = cards.slice(index + 1);
    const next = rest.find((card) => card.querySelector('.file-card__collapsed--file') === null) ?? rest[0];
    return next?.dataset.file ?? null;
}
