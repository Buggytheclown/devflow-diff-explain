import { findLineRow } from '../../diff-view/line-target.js';

/**
 * Прокрутка внутри маршрута (docs/design/README.md §Interactions & behaviour): клик по чипу файла ведёт
 * к его карточке за ~320ms с отступом −150px от верха цели. Именно `scrollTop` контейнера,
 * а не `scrollIntoView`: у последнего ни длительности, ни отступа, ни отмены.
 */

/** Отступ от верхней кромки: цель не должна прилипать к липкому тулбару. */
export const JUMP_OFFSET = 150;

/** docs/design/README.md §Design tokens, «Motion»: jump scroll ~320ms ease-in-out cubic. */
export const JUMP_DURATION = 320;

/** ease-in-out cubic — тот же профиль, что у `--motion-jump-ease`. */
export function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Куда прокрутить контейнер, чтобы цель встала на `JUMP_OFFSET` ниже его верхней кромки. */
export function targetScrollTop(container: HTMLElement, target: HTMLElement): number {
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = container.scrollTop + delta - JUMP_OFFSET;
    return Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
}

/** `CSS.escape` есть не везде (тесты без DOM) — селектор всё равно должен собраться. */
export function cssEscape(value: string): string {
    return typeof CSS === 'undefined' ? value.replace(/["\\]/g, '\\$&') : CSS.escape(value);
}

/** Ступени прыжка: до какой добрались, к той и подтянута прокрутка. */
export type JumpStep = 'none' | 'section' | 'card' | 'row';
export const JUMP_STEPS: Record<JumpStep, number> = { none: 0, section: 1, card: 2, row: 3 };

export interface JumpTarget {
    readonly step: Exclude<JumpStep, 'none'>;
    readonly element: HTMLElement;
}

/**
 * Лучшая доступная цель прыжка в текущей разметке: строка → карточка файла → секция остановки.
 * `null` — даже секции ещё нет (остановка спрятана фильтром и вот-вот вернётся).
 *
 * Ступень возвращается вместе с элементом, потому что она нужна вызывающему: пока это не `row`,
 * цель промежуточная и поиск продолжается, но прокрутка обязана ехать уже к ней. Иначе прыжок
 * в остановку, чьи карточки отложены ленивым рендером, вставал бы намертво: карточки
 * дорисовываются, только когда остановка попадает на экран, а туда её везёт как раз этот прыжок.
 */
export function jumpTarget(
    container: ParentNode,
    stopId: string,
    fileId: string | null,
    line: number | null,
    side: 'old' | 'new' | null,
): JumpTarget | null {
    const section = container.querySelector<HTMLElement>(`[data-stop="${cssEscape(stopId)}"]`);
    if (section === null) {
        return null;
    }
    if (fileId === null) {
        return { step: 'section', element: section };
    }
    const card = section.querySelector<HTMLElement>(`[data-file="${cssEscape(fileId)}"]`);
    if (card === null) {
        return { step: 'section', element: section };
    }
    // Строки может не быть в срезе карточки, а у якоря — стороны: цель тогда сама карточка,
    // прыжок обязан довезти хотя бы до файла.
    const row = line === null || side === null ? null : findLineRow(card, side, line);
    return row === null ? { step: 'card', element: card } : { step: 'row', element: row };
}

/** Секция остановки в координатах вьюпорта — ровно то, что нужно выбору якоря. */
export interface StopBox {
    readonly stopId: string;
    readonly top: number;
    readonly bottom: number;
}

/** Якорь прокрутки: остановка и её смещение от верхней кромки контейнера. */
export interface StopAnchor {
    readonly stopId: string;
    readonly offset: number;
}

/**
 * Верхняя видимая остановка. `line` — нижняя кромка липкого тулбара: остановка, чей хвост
 * целиком под ним, ревьюеру не видна и якорем быть не может (docs/design/SPEC-elements.md §2.5). Смещение при этом
 * считается от кромки контейнера `containerTop` — восстановление возвращает остановку ровно
 * туда, где её читали, даже если она начинается под тулбаром.
 */
export function pickTopStop(containerTop: number, line: number, boxes: Iterable<StopBox>): StopAnchor | null {
    for (const box of boxes) {
        if (box.bottom > line) {
            return { stopId: box.stopId, offset: box.top - containerTop };
        }
    }
    return null;
}

/** Возвращает отмену: конкурирующий переход не должен тянуть контейнер в две стороны. */
export function animateScrollTo(container: HTMLElement, to: number, duration = JUMP_DURATION): () => void {
    const from = container.scrollTop;
    if (Math.abs(to - from) < 1 || duration <= 0) {
        container.scrollTop = to;
        return () => undefined;
    }

    const started = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
        const progress = Math.min((now - started) / duration, 1);
        container.scrollTop = from + (to - from) * easeInOutCubic(progress);
        if (progress < 1) {
            frame = requestAnimationFrame(step);
        }
    });

    return () => {
        cancelAnimationFrame(frame);
    };
}
