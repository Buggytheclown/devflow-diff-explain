/**
 * Глоб-диалект Java NIO (`FileSystems.getDefault().getPathMatcher("glob:…")`) — тот самый, которым
 * сервер Арканума считает `subpaths` правил ревью. Порт `sun.nio.fs.Globs.toUnixRegexPattern`
 * символ в символ, чтобы края вели себя как у Арканума, а не как у привычного gitignore:
 *
 * - `**` пересекает `/`, `*` и `?` — нет;
 * - `[a-z]`, `[!abc]`, `[^…]` — класс символов, разделитель имён в класс не попадает;
 * - `{a,b}` — альтернативы, вложенные группы запрещены;
 * - `\` экранирует следующий символ (в том числе запятую и сам `\`);
 * - шаблон всегда сопоставляется с путём целиком.
 */

/** `Globs.regexMetaChars`: перед этими символами Java ставит `\`, отдавая их регулярке. */
const REGEX_META_CHARS = '.^$+{[]|()';

/** `Globs.globMetaChars`: то, что экранирование `\` обязано превратить в литерал. */
const GLOB_META_CHARS = '\\*?[{';

/** Шаблон не разобрался: у Арканума такое правило помечено `invalid_paths_glob_pattern`. */
export class GlobSyntaxError extends Error {
    constructor(pattern: string, reason: string) {
        super(`глоб \`${pattern}\`: ${reason}`);
        this.name = 'GlobSyntaxError';
    }
}

/** Компилирует глоб в регулярку, сопоставляемую с путём целиком. */
export function compileGlob(pattern: string): RegExp {
    return new RegExp(toRegexSource(pattern));
}

function toRegexSource(glob: string): string {
    let inGroup = false;
    let regex = '^';
    let i = 0;

    while (i < glob.length) {
        const char = glob.charAt(i);
        i += 1;

        switch (char) {
            case '\\': {
                if (i === glob.length) {
                    throw new GlobSyntaxError(glob, 'экранировать нечего — `\\` в конце шаблона');
                }
                const escaped = glob.charAt(i);
                i += 1;
                regex += isMeta(escaped) ? `\\${escaped}` : escaped;
                break;
            }
            case '[': {
                const parsed = readCharacterClass(glob, i);
                regex += `(?![/])[${parsed.body}]`;
                i = parsed.next;
                break;
            }
            case '{':
                if (inGroup) {
                    throw new GlobSyntaxError(glob, 'вложенные группы `{}` запрещены');
                }
                regex += '(?:(?:';
                inGroup = true;
                break;
            case '}':
                if (inGroup) {
                    regex += '))';
                    inGroup = false;
                } else {
                    regex += '\\}';
                }
                break;
            case ',':
                regex += inGroup ? ')|(?:' : ',';
                break;
            case '*':
                if (glob.charAt(i) === '*') {
                    // Две звезды пересекают разделитель имён, одна — нет.
                    regex += '.*';
                    i += 1;
                } else {
                    regex += '[^/]*';
                }
                break;
            case '?':
                regex += '[^/]';
                break;
            default:
                regex += REGEX_META_CHARS.includes(char) ? `\\${char}` : char;
        }
    }

    if (inGroup) {
        throw new GlobSyntaxError(glob, 'группа `{` не закрыта');
    }
    return `${regex}$`;
}

/**
 * Класс символов `[…]` от позиции сразу за открывающей скобкой. Отдаёт тело класса для регулярки
 * JS: разделитель имён отсекается снаружи (`(?![/])`), а не пересечением классов, как в Java.
 */
function readCharacterClass(glob: string, from: number): { body: string; next: number } {
    let i = from;
    let body = '';

    if (glob.charAt(i) === '^') {
        // Каретка в начале класса у Java — литерал, а не отрицание.
        body += '\\^';
        i += 1;
    } else {
        if (glob.charAt(i) === '!') {
            body += '^';
            i += 1;
        }
        if (glob.charAt(i) === '-') {
            body += '-';
            i += 1;
        }
    }

    let closed = false;
    let hasRangeStart = false;
    let last = '';
    while (i < glob.length) {
        const char = glob.charAt(i);
        i += 1;
        if (char === ']') {
            closed = true;
            break;
        }
        if (char === '/') {
            throw new GlobSyntaxError(glob, 'разделитель `/` внутри класса символов');
        }
        if (char === '\\' || char === '[' || (char === '&' && glob.charAt(i) === '&')) {
            body += '\\';
        }
        body += char;

        if (char === '-') {
            if (!hasRangeStart) {
                throw new GlobSyntaxError(glob, 'у диапазона нет левой границы');
            }
            const upper = i < glob.length ? glob.charAt(i) : '';
            i += 1;
            if (upper === '' || upper === ']') {
                closed = upper === ']';
                break;
            }
            if (upper < last) {
                throw new GlobSyntaxError(glob, 'перевёрнутый диапазон');
            }
            body += upper;
            hasRangeStart = false;
        } else {
            hasRangeStart = true;
            last = char;
        }
    }

    if (!closed) {
        throw new GlobSyntaxError(glob, 'класс символов не закрыт');
    }
    return { body, next: i };
}

function isMeta(char: string): boolean {
    return GLOB_META_CHARS.includes(char) || REGEX_META_CHARS.includes(char);
}
