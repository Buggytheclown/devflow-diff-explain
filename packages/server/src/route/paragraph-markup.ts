import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';
import type { StopViolation } from '@sherpa/protocol/markdown';
import { parseStop } from '@sherpa/protocol/markdown';

/**
 * Словарь разметки описания остановки (`docs/spec.md`) — третье,
 * урезанное подмножество markdown: абзацы (разделитель — пустая строка), список `- `, `* ` или `1. `
 * до четырёх пунктов без вложенности, инлайн-код, жирный, ссылки. Тем же словарём пишется summary PR,
 * но без бюджета длины.
 *
 * Разбор тот же, что у рендера в UI (`@sherpa/protocol/markdown`, профиль `stop`), проверка — по
 * белому списку: всё, чего нет в словаре, — нарушение. Бюджет считается по видимому тексту.
 *
 * Нарушение — жёсткая ошибка: секция (или скелет — для summary) уходит на перегенерацию целиком,
 * как и при любом другом невалидном результате. UI текст не режет и не троеточит.
 */

/** Сколько пунктов влезает в список описания. */
const MAX_LIST_ITEMS = 4;

/** Порядок ключей — порядок вывода ошибок. */
const VIOLATION_TEXT: Readonly<Record<StopViolation, string>> = {
    heading: 'uses a heading',
    code: 'uses a code block',
    table: 'uses a table',
    image: 'uses an image',
    quote: 'uses a block quote',
    'nested-list': 'uses a nested list item',
    'list-marker': 'uses a list marker other than `- `, `* ` and `1. `',
    'list-paragraphs': 'puts more than one paragraph into a list item',
    italic: 'uses italics',
    strike: 'uses strikethrough',
    rule: 'uses a horizontal rule',
    link: 'links to an address other than http(s), `#stop-<planIndex>` or `#file-<path>`',
    'link-definition': 'uses a link reference definition `[label]: url`; write links inline as [text](url)',
    markup: 'uses markup outside the allowed set',
};

const ALLOWED = 'allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url)';

/**
 * Ошибки разметки описания одной остановки; `at` — путь до поля в JSON модели,
 * `planIndex` — номер остановки, которым ревьюер и модель её называют.
 */
export function paragraphMarkupErrors(at: string, planIndex: number, text: string): string[] {
    return markupErrors(at, `paragraph of stop ${String(planIndex)}`, text, STOP_PARAGRAPH_MAX_CHARS);
}

/**
 * Ошибки разметки текста по словарю описания; `subject` — как текст назван в сообщении модели,
 * `maxChars` — бюджет видимого текста, без него длина не проверяется.
 */
export function markupErrors(at: string, subject: string, text: string, maxChars?: number): string[] {
    const errors: string[] = [];
    const markup = parseStop(text);

    if (markup.visibleChars === 0) {
        errors.push(`${at}: ${subject} has no visible text: the reviewer would see an empty description.`);
    }
    if (maxChars !== undefined && markup.visibleChars > maxChars) {
        errors.push(
            `${at}: ${subject} is ${String(markup.visibleChars)} chars, limit is ${String(maxChars)}. Cut it down, do not split it across stops.`,
        );
    }
    for (const violation of Object.keys(VIOLATION_TEXT) as StopViolation[]) {
        if (markup.violations.has(violation)) {
            errors.push(`${at}: ${subject} ${VIOLATION_TEXT[violation]}; ${ALLOWED}.`);
        }
    }
    if (markup.longestList > MAX_LIST_ITEMS) {
        errors.push(
            `${at}: ${subject} has a list of ${String(markup.longestList)} items, at most ${String(MAX_LIST_ITEMS)} are allowed. A list is for enumerating like things; move the rest into the prose.`,
        );
    }
    return errors;
}
