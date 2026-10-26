import type { Element, RootContent } from 'hast';

import { lowlight } from './languages.js';
import type { LanguageId, SyntaxKind, SyntaxToken } from './model.js';

/**
 * Подсветка синтаксиса поверх highlight.js (обёртка `lowlight`, реестр грамматик — `languages.ts`).
 *
 * Один обход дерева определяет общие для всех тем категории. Всё, чего в таблице нет,
 * наследует категорию родителя, а корень — plain.
 * Переключение темы меняет CSS, повторно разбирать текст не нужно.
 */

/**
 * Исходный скоуп hljs → категория подсветки. Ключ — первый сегмент скоупа.
 *
 * Значение `null` — сброс: `subst` (подстановка в шаблонной строке) лежит внутри `string`,
 * но это код, а не строка. Отсутствие ключа — наследование категории родителя, поэтому
 * `doctag` внутри комментария остаётся комментарием.
 */
const SCOPE_KINDS = new Map<string, SyntaxKind | null>([
    ['keyword', 'keyword'],
    ['built_in', 'keyword'],
    ['type', 'type'],
    ['literal', 'keyword'],
    // Заголовок markdown: старый лексер красил его как keyword, цвет сохраняем.
    ['section', 'keyword'],
    ['string', 'string'],
    ['attr', 'property'],
    ['property', 'property'],
    ['number', 'number'],
    ['variable', 'variable'],
    ['template-variable', 'variable'],
    ['regexp', 'string'],
    ['char', 'string'],
    ['symbol', 'string'],
    // Код в markdown: красим только инлайн-код в бэктиках, см. `kindOf`.
    ['code', 'string'],
    ['comment', 'comment'],
    ['doctag', 'comment'],
    // `@decorator`, `#include`, shebang, атрибуты C# — всё, что hljs зовёт мета.
    ['meta', 'decorator'],
    ['subst', null],
]);

/**
 * Выше этого объёма подсветка не окупается: это минифицированный бандл или сгенерированные
 * данные, читать их построчно всё равно никто не будет, а hljs на таком тексте стоит десятки
 * миллисекунд. Порог по строке совпадает с `MARKUP_LIMIT` в `diff-view/line-segments.ts`:
 * длинные строки там и так рисуются без разметки.
 */
export const MAX_HIGHLIGHT_CHARS = 200_000;
const MAX_HIGHLIGHT_LINE = 4000;

/** Фрагмент стоит подсветки: не минифицированный бандл и без сверхдлинных строк. */
export function highlightable(lines: readonly string[]): boolean {
    let total = 0;
    for (const line of lines) {
        if (line.length > MAX_HIGHLIGHT_LINE) {
            return false;
        }
        total += line.length + 1;
        if (total > MAX_HIGHLIGHT_CHARS) {
            return false;
        }
    }
    return true;
}

/** Расширения файлов → язык hljs. Вся JS-семья ложится на `typescript`: его грамматика — надмножество. */
const EXTENSIONS = new Map<string, LanguageId>([
    ['ts', 'typescript'],
    ['tsx', 'typescript'],
    ['mts', 'typescript'],
    ['cts', 'typescript'],
    ['js', 'typescript'],
    ['jsx', 'typescript'],
    ['mjs', 'typescript'],
    ['cjs', 'typescript'],
    ['py', 'python'],
    ['pyi', 'python'],
    ['pyw', 'python'],
    ['go', 'go'],
    ['java', 'java'],
    ['kt', 'kotlin'],
    ['kts', 'kotlin'],
    ['c', 'c'],
    ['cc', 'cpp'],
    ['cpp', 'cpp'],
    ['cxx', 'cpp'],
    ['h', 'cpp'],
    ['hh', 'cpp'],
    ['hpp', 'cpp'],
    ['rs', 'rust'],
    ['rb', 'ruby'],
    ['php', 'php'],
    ['cs', 'csharp'],
    ['swift', 'swift'],
    ['scala', 'scala'],
    ['sc', 'scala'],
    ['sql', 'sql'],
    ['sh', 'bash'],
    ['bash', 'bash'],
    ['zsh', 'bash'],
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
    ['json', 'json'],
    ['css', 'css'],
    ['scss', 'scss'],
    ['less', 'less'],
    ['xml', 'xml'],
    ['html', 'xml'],
    ['htm', 'xml'],
    ['svg', 'xml'],
    ['md', 'markdown'],
    ['markdown', 'markdown'],
    ['mk', 'makefile'],
    ['proto', 'protobuf'],
    ['ini', 'ini'],
    ['toml', 'ini'],
    ['cfg', 'ini'],
    ['properties', 'properties'],
    ['graphql', 'graphql'],
    ['gql', 'graphql'],
    ['lua', 'lua'],
    ['pl', 'perl'],
    ['pm', 'perl'],
    ['r', 'r'],
    ['cmake', 'cmake'],
    ['groovy', 'groovy'],
    ['gradle', 'groovy'],
    ['dart', 'dart'],
    ['hs', 'haskell'],
    ['erl', 'erlang'],
    ['ex', 'elixir'],
    ['exs', 'elixir'],
    ['clj', 'clojure'],
    ['cljs', 'clojure'],
    ['diff', 'diff'],
    ['patch', 'diff'],
]);

/** Файлы, которые узнают по имени целиком, а не по расширению. */
const FILENAMES = new Map<string, LanguageId>([
    ['makefile', 'makefile'],
    ['gnumakefile', 'makefile'],
    ['dockerfile', 'dockerfile'],
    ['cmakelists.txt', 'cmake'],
    ['gemfile', 'ruby'],
    ['rakefile', 'ruby'],
]);

/**
 * Инфо-строки заборов, которых реестр hljs не знает под таким именем. Своих алиасов
 * (`ts`, `py`, `c++`, `yml`) у него хватает — таблица закрывает только дырки.
 */
const NAME_ALIASES = new Map<string, LanguageId>([
    ['cfg', 'ini'],
    ['conf', 'ini'],
    ['docker', 'dockerfile'],
    ['jsonc', 'json'],
    ['plain', 'plaintext'],
    ['text', 'plaintext'],
]);

/** null — языка для этого файла в реестре нет: файл рисуется без подсветки. */
export function languageOf(path: string): LanguageId | null {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();

    const byName = FILENAMES.get(name);
    if (byName !== undefined) {
        return registered(byName);
    }

    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return null;
    }
    const byExtension = EXTENSIONS.get(name.slice(dot + 1));
    return byExtension === undefined ? null : registered(byExtension);
}

/**
 * Имя языка (инфо-строка забора markdown) → язык реестра; null — такого в реестре нет.
 * Алиасы hljs (`ts`, `golang`, `c++`) реестр разрешает сам.
 */
export function languageByName(name: string): LanguageId | null {
    const key = name.trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (key.length === 0) {
        return null;
    }
    return registered(NAME_ALIASES.get(key) ?? key);
}

function registered(name: string): LanguageId | null {
    return lowlight.registered(name) ? name : null;
}

/**
 * Токены многострочного текста, разложенные по строкам: индекс результата — номер строки
 * в `text.split('\n')`, смещения токена — от начала своей строки. Токен, пересёкший перевод
 * строки (блочный комментарий, шаблонная строка), режется по строкам.
 */
export function highlightText(text: string, language: LanguageId): SyntaxToken[][] {
    const lines: SyntaxToken[][] = text.split('\n').map(() => []);
    if (!lowlight.registered(language)) {
        return lines;
    }

    walk(lowlight.highlight(language, text).children, null, lines, { line: 0, column: 0 }, language);
    return lines.map(merge);
}

/** Токены одной строки — тонкая обёртка над `highlightText` для одиночных строк. */
export function tokenizeLine(text: string, language: LanguageId): SyntaxToken[] {
    return highlightText(text, language)[0] ?? [];
}

/** Позиция обхода в исходном тексте: hast отдаёт узлы подряд, поэтому её хватает. */
interface Cursor {
    line: number;
    column: number;
}

function walk(
    nodes: readonly RootContent[],
    kind: SyntaxKind | null,
    lines: SyntaxToken[][],
    cursor: Cursor,
    language: LanguageId,
    container?: Element,
): void {
    for (const node of nodes) {
        if (node.type === 'text') {
            emit(node.value, kind, lines, cursor);
            continue;
        }
        if (node.type === 'element') {
            walk(
                node.children,
                kindOf(node, kind, language, container),
                lines,
                cursor,
                language,
                node,
            );
        }
    }
}

/** Категория узла: своя, если скоуп есть в таблице (в том числе как сброс), иначе родительская. */
function kindOf(
    node: Element,
    parent: SyntaxKind | null,
    language: LanguageId,
    container?: Element,
): SyntaxKind | null {
    const classes = node.properties.className;
    const first = Array.isArray(classes) ? classes[0] : undefined;
    if (typeof first !== 'string' || !first.startsWith('hljs-')) {
        return parent;
    }
    const scope = first.slice('hljs-'.length);
    // Старые грамматики Go/C++ кладут `title` внутрь `function`, новые дают `title.function`.
    // Красим только имя, не весь контейнер объявления с параметрами и пробелами.
    if (scope === 'title' && Array.isArray(classes) && parent !== 'decorator') {
        const containerClasses = container?.properties.className;
        if (classes.includes('class_') || containerClasses?.includes('hljs-class')) {
            return 'type';
        }
        if (classes.includes('function_') || containerClasses?.includes('hljs-function')) {
            return 'function';
        }
    }
    // YAML называет meta и границу документа, и якоря. Только якорь/ссылка — переменная.
    if (scope === 'meta' && (language === 'yaml' || language === 'yml')) {
        const firstChild = node.children[0];
        if (firstChild?.type === 'text' && /^[&*]/.test(firstChild.value)) {
            return 'variable';
        }
    }
    if (!SCOPE_KINDS.has(scope)) {
        return parent;
    }
    // Скоупом `code` hljs помечает и инлайн-код в бэктиках, и целый огороженный блок вместе
    // с ограждениями. Инлайн красим как строку (так делал старый лексер), а забор оставляем
    // plain: залить цветом строк тело каждого блока кода в .md-диффе — шум на весь экран.
    if (scope === 'code' && spansLines(node)) {
        return parent;
    }
    const own = SCOPE_KINDS.get(scope) ?? null;
    // Внутри мета (`#include <x>`, `@dataclass(frozen=True)`) hljs размечает и ключевые слова,
    // и литералы; для ревьюера это одна конструкция, поэтому цвет декоратора держится до конца,
    // уступая только строке.
    if (parent === 'decorator' && own !== 'string') {
        return parent;
    }
    return own;
}

/** Текст узла занимает больше одной строки. */
function spansLines(node: Element): boolean {
    return node.children.some(
        (child) =>
            (child.type === 'text' && child.value.includes('\n')) ||
            (child.type === 'element' && spansLines(child)),
    );
}

/** Текст узла в токены: по куску на строку; пустые куски и plain не эмитятся. */
function emit(
    value: string,
    kind: SyntaxKind | null,
    lines: SyntaxToken[][],
    cursor: Cursor,
): void {
    for (const [index, piece] of value.split('\n').entries()) {
        if (index > 0) {
            cursor.line += 1;
            cursor.column = 0;
        }
        if (piece.length === 0) {
            continue;
        }
        if (kind !== null) {
            lines[cursor.line]?.push({
                from: cursor.column,
                to: cursor.column + piece.length,
                kind,
            });
        }
        cursor.column += piece.length;
    }
}

/** Соседние токены одной категории склеиваются. */
function merge(tokens: readonly SyntaxToken[]): SyntaxToken[] {
    const merged: SyntaxToken[] = [];
    for (const token of tokens) {
        const last = merged.at(-1);
        if (last?.kind === token.kind && last.to === token.from) {
            merged[merged.length - 1] = { ...last, to: token.to };
            continue;
        }
        merged.push(token);
    }
    return merged;
}
