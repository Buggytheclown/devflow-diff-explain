import type { Locale } from '@sherpa/protocol';

/**
 * Стоп-лист голоса для текстов маршрута, которые читает ревьюер.
 *
 * Отклоняется только однозначное: эмодзи и фразы-заполнители из фиксированного списка —
 * по ним ложных срабатываний не бывает, поэтому жёсткий отказ честен. Всё вкусовое
 * («меньше воды», превосходные степени) остаётся методичкой: «дальнейший» и «ближайший»
 * не отличить от превосходной степени без морфологии, а ложное срабатывание сжигает
 * попытку модели на стилевой придирке.
 *
 * Список фраз — на локаль генерации: чужеязычная фраза в тексте нарушением не считается,
 * иначе английская цитата в русском абзаце ловилась бы стоп-листом. Правила против транслита
 * («коалесинг») в коде нет и на `ru`: без морфологии его не отличить от нормального слова,
 * он живёт методичкой.
 */

const BANNED_PHRASES: Record<Locale, readonly string[]> = {
    ru: [
        'важно отметить',
        'стоит отметить',
        'важно понимать',
        'стоит понимать',
        'как мы видим',
        'нельзя не отметить',
    ],
    en: [
        'it is worth noting',
        "it's worth noting",
        'it is important to note',
        "it's important to note",
        'it should be noted',
        'as we can see',
        'it is important to understand',
        'needless to say',
    ],
};

const EMOJI = /\p{Extended_Pictographic}/u;

/** Ошибки голоса одного текстового поля; `at` — путь до поля в JSON модели. */
export function voiceErrors(at: string, text: string | null | undefined, locale: Locale): string[] {
    if (text === null || text === undefined) {
        return [];
    }
    const errors: string[] = [];
    const lower = text.toLowerCase();
    for (const phrase of BANNED_PHRASES[locale]) {
        if (lower.includes(phrase)) {
            errors.push(
                `${at}: drop the filler phrase "${phrase}" and state the fact directly (see Voice in the methodology).`,
            );
        }
    }
    if (EMOJI.test(text)) {
        errors.push(`${at}: contains emoji — route texts are plain prose (see Voice in the methodology).`);
    }
    return errors;
}

/** Стоп-фразы локали для методички: промпт обязан называть ровно то, что отвергает сервер. */
export function bannedPhrases(locale: Locale): readonly string[] {
    return BANNED_PHRASES[locale];
}

/** Кавычки цитаты на языке текста: русская «ёлочка» в английской методичке читается как сор. */
export function quoted(locale: Locale): (phrase: string) => string {
    return locale === 'ru' ? (phrase) => `«${phrase}»` : (phrase) => `"${phrase}"`;
}
