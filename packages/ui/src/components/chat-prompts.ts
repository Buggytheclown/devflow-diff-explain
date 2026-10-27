import type { MessageKey, Translate } from '../i18n/index.js';

/**
 * Тексты точек входа в чат (docs/spec.md §10; docs/spec.md
 * §2.18). Вопрос всегда только подставляется в композер — отправляет его ревьюер, поэтому текст обязан читаться как его
 * собственный, а не как команда, которую он не писал.
 *
 * Чистый модуль: ни React, ни DOM. Готовую строку вопроса собирает `t` — она уезжает в поле
 * ввода, ключ туда не отдать.
 */

/** Диапазон для текста вопроса: номера строк — в терминах своей стороны диффа. */
export interface QuestionRange {
    readonly path: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

/**
 * Диапазонов в «Прочем» бывают сотни: перечислять их все — вопрос, который никто не прочитает.
 * Хвост честно называет число оставшихся, а не молчит о них.
 */
export const MAX_LISTED_RANGES = 20;

/**
 * «Прочее» → вопрос без якоря: якорь у вопроса один, а диапазонов много, поэтому они
 * перечисляются текстом. Контекст PR (патчи и план маршрута) уходит с вопросом без якоря сам.
 */
export function placeRangesQuestion(ranges: readonly QuestionRange[], t: Translate): string {
    if (ranges.length === 0) {
        return t('chat.ask.placeRanges');
    }
    const listed = ranges.slice(0, MAX_LISTED_RANGES).map((range) => rangeLabel(range, t)).join(', ');
    const rest = ranges.length - MAX_LISTED_RANGES;
    return t('chat.ask.placeRanges.listed', rest > 0 ? t('chat.ask.rangesRest', listed, rest) : listed);
}

/** Штрихованная полоса Full diff → вопрос с якорем ровно на этот диапазон (docs/spec.md). */
export function placeRangeQuestion(range: QuestionRange, t: Translate): string {
    const single = range.start === range.end;
    const removed = range.side === 'old';
    const key: MessageKey = single
        ? removed
            ? 'chat.ask.placeRange.lineRemoved'
            : 'chat.ask.placeRange.line'
        : removed
          ? 'chat.ask.placeRange.linesRemoved'
          : 'chat.ask.placeRange.lines';
    return t(key, rangeNumbers(range), range.path);
}

/** Примеры вопросов в пустом состоянии панели (docs/spec.md): клик подставляет их в композер. */
export const CHAT_EXAMPLE_QUESTIONS: readonly MessageKey[] = [
    'chat.example.risky',
    'chat.example.manual',
    'chat.example.edgeCases',
];

/**
 * Подписи «агент отключён» у всех ИИ-точек входа (docs/spec.md). Один модуль на все:
 * читалка при этом не деградирует нигде, и формулировки не должны разъезжаться.
 */
export const ASK_SELECTION_DISABLED_TITLE: MessageKey = 'chat.ask.selectionDisabled';
export const ASK_RANGES_DISABLED_TITLE: MessageKey = 'chat.ask.rangesDisabled';

/** Кнопка «разложить» маршрут не меняет: перегенерация — отдельная механика (docs/spec.md). */
export const ASK_ANSWER_IN_CHAT_NOTE: MessageKey = 'chat.ask.answerInChat';

function rangeLabel(range: QuestionRange, t: Translate): string {
    const numbers = `${range.path}:${rangeNumbers(range)}`;
    return range.side === 'old' ? t('chat.ask.rangeRemoved', numbers) : numbers;
}

function rangeNumbers(range: QuestionRange): string {
    return range.start === range.end
        ? String(range.start)
        : `${String(range.start)}–${String(range.end)}`;
}
