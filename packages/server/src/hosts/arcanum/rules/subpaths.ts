import { compileGlob } from './glob.js';

/**
 * Серверная семантика `subpaths` правил ревью a.yaml: разбор строки фильтра и вычисление «покрыт
 * ли файл этим правилом». Чистые функции без IO — сеть живёт в `review-rules.ts`.
 *
 * Правила семантики (разведка по исходникам сервера Арканума, `docs/architecture.md` §Линзы):
 * - фильтр — список шаблонов через запятую, `\,` — литеральная запятая внутри шаблона;
 * - шаблон с `!` — исключение;
 * - список читается **с конца**: первое совпадение решает; ничего не совпало — файл покрыт, только
 *   если первый элемент списка был исключением (список-«вычитание» по умолчанию всё включает);
 * - пути относительно каталога a.yaml, ведущий `/` срезается, и всегда есть неявная конъюнкция
 *   с `<каталог>/**` — правило не дотягивается за пределы своего поддерева.
 *
 * Файл покрывают **все** правила, чьи `subpaths` его берут, — не одно «последнее». Это проверено
 * голден-сверкой на живом PR (числа — в `review-rules.ts`): именно так Арканум собирает
 * `review.rules`, а модель «правило забирает файл, покрытый вычёркивается» с ней расходится.
 */

/** Один элемент фильтра: скомпилированный шаблон и признак исключения. */
interface SubpathPattern {
    readonly exclude: boolean;
    readonly matcher: RegExp;
    /** Статическая граница шаблона до первого glob-сегмента; пустая строка означает каталог a.yaml. */
    readonly boundary: string;
}

export interface SubpathsFilter {
    readonly patterns: readonly SubpathPattern[];
}

/** Правило ревью, приведённое к тому минимуму, который нужен матчингу. */
export interface PathRule {
    /** Каталог владеющего a.yaml от корня репозитория, без ведущего и хвостового `/`. */
    readonly baseDir: string;
    readonly subpaths: SubpathsFilter;
}

/**
 * Фильтр из `subpaths_filter` ответа Арканума: массив строк, каждая — список шаблонов через
 * запятую (в живых a.yaml список чаще всего одной строкой). Элементы всех строк складываются
 * в один упорядоченный список — порядок и решает.
 */
export function parseSubpathsFilter(raw: readonly string[]): SubpathsFilter {
    const patterns = raw.flatMap((line) => splitPatterns(line)).map(toPattern);
    return { patterns };
}

/** Пустой фильтр: правило без `subpaths` берёт всё поддерево своего a.yaml. */
export const MATCH_ALL: SubpathsFilter = { patterns: [] };

/** Покрывает ли фильтр путь, уже приведённый к каталогу a.yaml. */
export function matchesSubpaths(filter: SubpathsFilter, relativePath: string): boolean {
    const { patterns } = filter;
    if (patterns.length === 0) {
        return true;
    }

    for (let index = patterns.length - 1; index >= 0; index -= 1) {
        const pattern = patterns[index];
        if (pattern?.matcher.test(relativePath) === true) {
            return !pattern.exclude;
        }
    }
    // Ни один шаблон не сработал: список из одних исключений включает всё, список включений — ничто.
    return patterns[0]?.exclude ?? true;
}

/** Покрывает ли правило файл: сначала поддерево a.yaml, затем фильтр. */
export function ruleCovers(rule: PathRule, path: string): boolean {
    const relative = relativeToBase(rule.baseDir, path);
    return relative !== null && matchesSubpaths(rule.subpaths, relative);
}

/**
 * Граница зоны правила для покрытого файла: каталог a.yaml либо статический подпуть
 * решившего include-шаблона (`src/pci/**` → `<config>/src/pci`).
 */
export function ruleZonePath(rule: PathRule, path: string): string {
    const relative = relativeToBase(rule.baseDir, path);
    if (relative === null) {
        return rule.baseDir;
    }
    for (let index = rule.subpaths.patterns.length - 1; index >= 0; index -= 1) {
        const pattern = rule.subpaths.patterns[index];
        if (pattern?.matcher.test(relative) === true) {
            return nonEmptyZonePath(joinPath(rule.baseDir, pattern.exclude ? '' : pattern.boundary), path);
        }
    }
    return nonEmptyZonePath(rule.baseDir, path);
}

/** Правила, покрывающие файл, в порядке их объявления в a.yaml (от корня иерархии к ближайшему). */
export function rulesCovering<R extends PathRule>(path: string, rules: readonly R[]): R[] {
    return rules.filter((rule) => ruleCovers(rule, path));
}

/** Путь относительно каталога a.yaml; `null` — файл вне поддерева (неявное `<каталог>/**`). */
export function relativeToBase(baseDir: string, path: string): string | null {
    if (baseDir === '') {
        return path;
    }
    const prefix = `${baseDir}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Каталог a.yaml по пути конфига: `/examples/ui/a.yaml` → `examples/ui`, `/a.yaml` → ``. */
export function configDirOf(configPath: string): string {
    const withoutLeadingSlash = configPath.replace(/^\/+/, '');
    const lastSlash = withoutLeadingSlash.lastIndexOf('/');
    return lastSlash === -1 ? '' : withoutLeadingSlash.slice(0, lastSlash);
}

/**
 * Разбор строки фильтра: запятая разделяет шаблоны, `\,` остаётся частью шаблона.
 *
 * Отсюда следствие, о котором стоит помнить: альтернативы `{ts,tsx}` в списке `subpaths`
 * недостижимы — голая запятая разрежет шаблон пополам, а экранированная станет литералом внутри
 * группы. Именно поэтому в живых a.yaml таких шаблонов и нет.
 */
function splitPatterns(line: string): string[] {
    const items: string[] = [];
    let current = '';

    for (let index = 0; index < line.length; index += 1) {
        const char = line.charAt(index);
        if (char === '\\' && index + 1 < line.length) {
            // Экранирование сохраняем как есть: литерал из него сделает уже компилятор глоба.
            current += char + line.charAt(index + 1);
            index += 1;
            continue;
        }
        if (char === ',') {
            items.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    items.push(current);

    return items.map((item) => item.trim()).filter((item) => item !== '');
}

function toPattern(item: string): SubpathPattern {
    const exclude = item.startsWith('!');
    // Ведущий `/` срезается: путь шаблона и так относителен каталогу a.yaml.
    const pattern = (exclude ? item.slice(1) : item).trim().replace(/^\/+/, '');
    return { exclude, matcher: compileGlob(pattern), boundary: staticBoundary(pattern) };
}

/** Подпуть до первого сегмента с glob-метасимволом; точный путь целиком становится границей. */
function staticBoundary(pattern: string): string {
    const segments = pattern.split('/');
    const fixed: string[] = [];
    for (const segment of segments) {
        if (hasGlobMeta(segment)) {
            break;
        }
        fixed.push(segment.replace(/\\(.)/g, '$1'));
    }
    return fixed.join('/');
}

function hasGlobMeta(segment: string): boolean {
    let escaped = false;
    for (const char of segment) {
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === '*' || char === '?' || char === '[' || char === '{') {
            return true;
        }
    }
    return false;
}

function joinPath(baseDir: string, relative: string): string {
    if (baseDir === '') {
        return relative;
    }
    return relative === '' ? baseDir : `${baseDir}/${relative}`;
}

/** У корневого a.yaml пустая граница запрещена протоколом — делим её по верхнему каталогу файла. */
function nonEmptyZonePath(zonePath: string, filePath: string): string {
    return zonePath === '' ? (filePath.split('/')[0] ?? filePath) : zonePath;
}
