/**
 * Разбор и матчинг CODEOWNERS — чистые функции без IO (сеть живёт в `github-host.ts`).
 *
 * Семантика (`docs/research/github-api.md` §CODEOWNERS):
 * - строка — `<шаблон> <владелец>…`; `#` начинает комментарий с начала строки и после пробела;
 * - файл получает владельцев **последнего** совпавшего правила, а не всех покрывающих
 *   (в этом отличие от a.yaml Арканума, где правила складываются);
 * - шаблон без владельцев снимает владение, назначенное правилами выше;
 * - поддерживается подмножество gitignore без расширений GitHub: `!`-отрицание, классы `[a-z]`
 *   и экранированная решётка Шерпе не по зубам, такие строки игнорируются целиком — как их
 *   игнорирует и сам GitHub, помечая ошибкой; `{a,b}` — литерал, альтернатив у GitHub нет.
 *
 * Арканумный `rules/glob.ts` сюда не годится: это порт диалекта Java NIO с другими правилами
 * якорения и другим `**`.
 */

/** Одно правило файла: шаблон, его владельцы (пусто — владельца нет) и номер строки для диагностики. */
export interface CodeownersRule {
    readonly pattern: string;
    readonly owners: readonly string[];
    readonly line: number;
}

/**
 * Скомпилированный шаблон правила. Живёт рядом с правилом, а не в нём: наружу правило — это
 * ровно то, что написано в файле, а регулярка нужна только матчингу.
 */
const matchers = new WeakMap<CodeownersRule, RegExp>();

/** Метасимволы глоба; `[`/`]` сюда не входят — строки с классами отбрасываются при разборе. */
const GLOB_META = new Set(['*', '?']);

/** Метка порядка байтов в начале файла: к шаблону первой строки она не относится. */
const BOM = '\uFEFF';

/**
 * Строки файла в порядке объявления; нераспознанный синтаксис и комментарии выброшены.
 *
 * Перевод строки принимается и в виде `\r\n`, и BOM снимается: файл заводят в том числе из-под
 * Windows, а `\r` в конце строки прилип бы к логину владельца и тихо сломал бы всё правило.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
    const rules: CodeownersRule[] = [];
    const lines = (text.startsWith(BOM) ? text.slice(BOM.length) : text).split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index] ?? '';
        const tokens = splitTokens(stripComment(raw));
        const pattern = tokens[0];
        if (pattern === undefined) {
            continue;
        }
        const matcher = compilePattern(pattern);
        if (matcher === null) {
            continue;
        }
        const rule: CodeownersRule = { pattern, owners: tokens.slice(1), line: index + 1 };
        matchers.set(rule, matcher);
        rules.push(rule);
    }

    return rules;
}

/**
 * Правило, решающее владение путём, — последнее совпавшее; `null` — путь не покрыт ни одним.
 * Правило без владельцев возвращается как есть: «владельца нет» — тоже ответ.
 */
export function ownersOf(rules: readonly CodeownersRule[], path: string): CodeownersRule | null {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index];
        if (rule !== undefined && matcherOf(rule).test(path)) {
            return rule;
        }
    }
    return null;
}

/**
 * Граница зоны правила для покрытого файла — статический префикс шаблона
 * (`src/pci/**` → `src/pci`, `/apps/` → `apps`, `docs/*.md` → `docs`).
 *
 * Шаблон без ведущего `/` матчится на любой глубине, поэтому его статический префикс ищется
 * внутри самого пути: `apps/` на `deep/apps/x.ts` даёт зону `deep/apps`, а не `apps`.
 * Статического префикса нет вовсе (`*.js`, шаблон с двух звёзд) — зоной становится верхний
 * каталог файла либо сам файл в корне: пустой `path` зоны протокол запрещает.
 */
export function zonePathOf(rule: CodeownersRule, path: string): string {
    const prefix = staticPrefix(rule.pattern);
    if (prefix.length === 0) {
        return topDirOf(path);
    }

    const zone = prefix.join('/');
    if (path === zone || path.startsWith(`${zone}/`)) {
        return zone;
    }
    return locatePrefix(path, prefix) ?? topDirOf(path);
}

function matcherOf(rule: CodeownersRule): RegExp {
    const known = matchers.get(rule);
    if (known !== undefined) {
        return known;
    }
    // Правило собрали в обход `parseCodeowners` (так делают тесты): компилируем по месту.
    const compiled = compilePattern(rule.pattern) ?? /(?!)/;
    matchers.set(rule, compiled);
    return compiled;
}

/**
 * Хвост строки после `#` отбрасывается. Решётка считается началом комментария в начале строки
 * и после пробела; экранированная (`\#`) комментарий не начинает, но такие шаблоны Шерпа всё
 * равно не берёт (`compilePattern`).
 */
function stripComment(line: string): string {
    let escaped = false;
    let previousIsSpace = true;

    for (let index = 0; index < line.length; index += 1) {
        const char = line.charAt(index);
        if (escaped) {
            escaped = false;
            previousIsSpace = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            previousIsSpace = false;
            continue;
        }
        if (char === '#' && previousIsSpace) {
            return line.slice(0, index);
        }
        previousIsSpace = char === ' ' || char === '\t';
    }
    return line;
}

/** Слова строки: разделитель — неэкранированный пробел, `\ ` остаётся частью шаблона. */
function splitTokens(line: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let escaped = false;

    for (const char of line) {
        if (escaped) {
            current += `\\${char}`;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === ' ' || char === '\t') {
            if (current !== '') {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (escaped) {
        current += '\\';
    }
    if (current !== '') {
        tokens.push(current);
    }
    return tokens;
}

/**
 * Шаблон → регулярка по всему пути от корня репозитория; `null` — синтаксис не поддержан
 * и строку надо выбросить.
 *
 * Якорение: `/` в начале или в середине держит шаблон у корня, иначе он матчится на любой
 * глубине. Хвостовой `/` — только каталог и всё под ним. Шаблон, чей последний сегмент —
 * точное имя, берёт и файл, и каталог с содержимым (`/apps/github`); сегмент с глобом берёт
 * ровно то, на что попал (`docs/*` — только прямые дети).
 */
function compilePattern(pattern: string): RegExp | null {
    if (pattern.startsWith('!') || pattern.includes('[') || pattern.includes(']') || pattern.includes('\\#')) {
        return null;
    }

    const dirOnly = pattern.endsWith('/');
    const body = (dirOnly ? pattern.slice(0, -1) : pattern).replace(/^\/+/, '');
    const segments = body.split('/').filter((segment) => segment !== '');
    const last = segments[segments.length - 1];
    if (last === undefined) {
        return null;
    }

    const anchored = pattern.startsWith('/') || body.includes('/');
    let source = anchored ? '^' : '^(?:[^/]+/)*';
    let needSlash = false;

    segments.forEach((segment, index) => {
        if (segment === '**') {
            if (index === segments.length - 1) {
                source += needSlash ? '/.*' : '.*';
                return;
            }
            source += needSlash ? '/(?:[^/]+/)*' : '(?:[^/]+/)*';
            needSlash = false;
            return;
        }
        source += (needSlash ? '/' : '') + compileSegment(segment);
        needSlash = true;
    });

    // Шаблон, кончающийся двумя звёздами, хвост уже дописал в цикле: `foo/**/` — это всё
    // под `foo`, а не «минимум два уровня вложенности».
    if (last !== '**') {
        if (dirOnly) {
            source += '/.*';
        } else if (!hasGlobMeta(last)) {
            source += '(?:/.*)?';
        }
    }

    return new RegExp(`${source}$`);
}

/** Один сегмент: `*` не пересекает `/`, `?` — один любой символ кроме `/`, остальное — литерал. */
function compileSegment(segment: string): string {
    let source = '';
    let escaped = false;

    for (const char of segment) {
        if (escaped) {
            source += escapeLiteral(char);
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '*') {
            source += '[^/]*';
            continue;
        }
        if (char === '?') {
            source += '[^/]';
            continue;
        }
        source += escapeLiteral(char);
    }
    return escaped ? `${source}\\\\` : source;
}

function escapeLiteral(char: string): string {
    return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Сегменты шаблона до первого с глобом; экранирование снимается — это уже путь, не шаблон. */
function staticPrefix(pattern: string): string[] {
    const body = (pattern.endsWith('/') ? pattern.slice(0, -1) : pattern).replace(/^\/+/, '');
    const fixed: string[] = [];

    for (const segment of body.split('/')) {
        if (segment === '' || segment === '**' || hasGlobMeta(segment)) {
            break;
        }
        fixed.push(segment.replace(/\\(.)/g, '$1'));
    }
    return fixed;
}

function hasGlobMeta(segment: string): boolean {
    let escaped = false;
    for (const char of segment) {
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (GLOB_META.has(char)) {
            return true;
        }
    }
    return false;
}

/** Путь до вхождения сегментов префикса включительно; `null` — такого вхождения нет. */
function locatePrefix(path: string, prefix: readonly string[]): string | null {
    const segments = path.split('/');
    for (let start = 0; start + prefix.length <= segments.length; start += 1) {
        if (prefix.every((segment, offset) => segments[start + offset] === segment)) {
            return segments.slice(0, start + prefix.length).join('/');
        }
    }
    return null;
}

/** Верхний каталог файла; у файла в корне — он сам: пустой `path` зоны протокол запрещает. */
function topDirOf(path: string): string {
    return path.split('/')[0] ?? path;
}
