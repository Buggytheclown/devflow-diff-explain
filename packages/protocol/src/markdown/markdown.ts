import MarkdownIt from 'markdown-it';
import type { StateInline, Token } from 'markdown-it';

/**
 * Разбор markdown для всего, что читает ревьюер. Разбирает `markdown-it` целиком (commonmark,
 * таблицы, зачёркивание), а что из разобранного живёт в профиле, решает белый список: конструкция
 * вне списка остаётся литеральным текстом исходника. Сырой HTML не разбирается (`html: false`) и
 * доезжает текстом; строк HTML модуль не отдаёт — UI строит элементы из узлов.
 *
 * Профиля три. `comment` — полный набор для тел комментариев и markdown-файлов диффа; `stop` —
 * словарь описания остановки (`docs/spec.md`): абзацы, плоский
 * список, код, жирный, ссылки — им же пишется summary PR, его же проверяют валидаторы секции и
 * скелета; `route` — только инлайн-код, для плоских текстов маршрута (связка, пометки валидатора,
 * заголовок остановки).
 */

export type MarkdownProfile = 'comment' | 'route' | 'stop';

export type InlineNode =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'strong'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'em'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'strike'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'link'; readonly href: string; readonly children: readonly InlineNode[] };

export interface MarkdownList {
    readonly ordered: boolean;
    readonly items: readonly MarkdownListItem[];
}

export interface MarkdownListItem {
    readonly sourceLine?: number;
    readonly children: readonly InlineNode[];
    readonly list: MarkdownList | null;
    /** null — обычный пункт; булево — пункт чек-листа `- [ ]` / `- [x]`. */
    readonly check: boolean | null;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** null — выравнивание колонки не задано двоеточиями в строке-разделителе. */
export type TableAlign = 'left' | 'center' | 'right' | null;

export interface MarkdownSource { readonly start: number; readonly end: number }

export type MarkdownBlock = { readonly source?: MarkdownSource } & (
    /** Строки абзаца: одиночный перенос сохраняется — люди пишут плоским текстом. */
    | { readonly kind: 'paragraph'; readonly lines: readonly (readonly InlineNode[])[] }
    | { readonly kind: 'heading'; readonly level: HeadingLevel; readonly children: readonly InlineNode[] }
    /**
     * `lang` — первое слово инфо-строки забора в нижнем регистре; null — забор без языка или код
     * с отступом. У кода с отступом (`fenced: false`) строки текста начинаются с первой строки `source`.
     */
    | { readonly kind: 'code'; readonly lang: string | null; readonly fenced: boolean; readonly text: string }
    | { readonly kind: 'list'; readonly list: MarkdownList }
    | { readonly kind: 'quote'; readonly depth: 1 | 2; readonly children: readonly MarkdownBlock[] }
    | {
          readonly kind: 'table';
          readonly align: readonly TableAlign[];
          readonly head: readonly (readonly InlineNode[])[];
          readonly rows: readonly (readonly (readonly InlineNode[])[])[];
      });

/** Нарушение словаря описания остановки; тексты для модели — у валидатора секции. */
export type StopViolation =
    | 'heading'
    | 'code'
    | 'table'
    | 'image'
    | 'quote'
    | 'nested-list'
    | 'list-marker'
    | 'list-paragraphs'
    | 'italic'
    | 'strike'
    | 'rule'
    | 'link'
    | 'link-definition'
    /** Блок, которого нет ни в словаре, ни среди известных нарушений. */
    | 'markup';

export interface StopMarkup {
    readonly blocks: readonly MarkdownBlock[];
    readonly violations: ReadonlySet<StopViolation>;
    /** Пунктов в самом длинном списке. */
    readonly longestList: number;
    /** Видимый текст: текст, инлайн-код и текст ссылок; адреса ссылок и маркеры разметки не считаются. */
    readonly visibleChars: number;
}

/** Ссылка рендерится только с этими схемами; всё прочее (`javascript:`, `data:`, относительные) — текст. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s]+$/i;
/** Внешняя ссылка описания остановки: только веб, `mailto:` модели не нужен. */
const WEB_HREF = /^https?:\/\/[^\s]+$/i;

/** Внутренняя ссылка описания остановки: переход к остановке плана или к файлу диффа. */
const STOP_HREF = /^#(?:stop-\d+|file-\S+)$/;

/** Маркер чек-листа в начале текста пункта. */
const TASK_MARKER = /^\[([ xX])\][ \t]+/;

/** Глубже этого вложенность списка не строится: пункты встают в один ряд с родителем. */
const MAX_LIST_DEPTH = 4;

/** Глубже цитаты не вкладываются: третий и следующие `>` остаются литеральным текстом. */
const MAX_QUOTE_DEPTH = 2;

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

function createParser(linkify: boolean): MarkdownIt {
    const md = new MarkdownIt('default', { html: false, linkify });
    // Голый адрес — только со схемой: `markdown.ts` и `www.x` ссылками не становятся.
    md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
    // Какой адрес станет ссылкой, решает профиль; адрес доезжает как в исходнике.
    md.validateLink = () => true;
    md.normalizeLink = (url) => url;
    md.normalizeLinkText = (text) => text;
    // Экранирования и сущности остаются отдельными токенами: в профиле `route` они литеральны.
    md.core.ruler.disable('text_join');
    // Ленивого продолжения цитаты нет: она кончается на первой строке без `>`.
    md.block.ruler.before(
        'paragraph',
        'quote_end',
        (state, _start, _end, silent) => silent && state.parentType === 'blockquote',
        { alt: ['blockquote'] },
    );
    keepLineBreaks(md);
    return md;
}

type InlineRule = (state: StateInline, silent: boolean) => boolean;

/**
 * Перенос строки внутри инлайн-кода и адреса ссылки `markdown-it` съедает, а строки абзаца
 * должны совпадать со строками исходника: по ним встают якоря в просмотре markdown-файла.
 * Код сохраняет переносы в `content`, у ссылки и картинки число съеденных переносов — в `meta`.
 */
function keepLineBreaks(md: MarkdownIt): void {
    wrapInlineRule(md, 'backticks', (state, start, count) => {
        const token = state.tokens[count];
        const raw = state.src.slice(start, state.pos);
        if (token?.type !== 'code_inline' || !raw.includes('\n')) {
            return;
        }
        const lines = raw.slice(token.markup.length, raw.length - token.markup.length).split('\n');
        // Пробел с обеих сторон срезается так же, как у `markdown-it`; перенос на краю остаётся переносом.
        if (lines.join(' ') !== token.content) {
            lines[0] = (lines[0] ?? '').replace(/^ /, '');
            lines[lines.length - 1] = (lines.at(-1) ?? '').replace(/ $/, '');
        }
        token.content = lines.join('\n');
    });
    for (const name of ['link', 'image']) {
        wrapInlineRule(md, name, (state, start, count) => {
            const lost = newlines(state.src.slice(start, state.pos)) - breaksIn(state.tokens.slice(count));
            const token = state.tokens[count];
            if (lost > 0 && token !== undefined) {
                token.meta = { lostBreaks: lost };
            }
        });
    }
}

/** Подменяет встроенное правило инлайн-разбора: `after` видит позицию до правила и индекс первого его токена. */
function wrapInlineRule(md: MarkdownIt, name: string, after: (state: StateInline, start: number, count: number) => void): void {
    // Публичного доступа к функции правила у `Ruler` нет, только замена по имени.
    const rules = (md.inline.ruler as unknown as { readonly __rules__: readonly { readonly name: string; readonly fn: InlineRule }[] }).__rules__;
    const original = rules.find((rule) => rule.name === name)?.fn;
    if (original === undefined) {
        throw new Error(`markdown-it: нет инлайн-правила ${name}`);
    }
    md.inline.ruler.at(name, (state, silent) => {
        const start = state.pos;
        // Накопленный текст правило выпустит отдельным токеном перед своими.
        const count = state.tokens.length + (state.pending === '' ? 0 : 1);
        if (!original(state, silent)) {
            return false;
        }
        if (!silent) {
            after(state, start, count);
        }
        return true;
    });
}

function newlines(text: string): number {
    return text.split('\n').length - 1;
}

/** Сколько переносов строки разбор сохранил в токенах. */
function breaksIn(tokens: readonly Token[]): number {
    return tokens.reduce((sum, token) => {
        const own = token.type === 'softbreak' || token.type === 'hardbreak' ? 1 : token.type === 'code_inline' ? newlines(token.content) : 0;
        return sum + own + breaksIn(token.children ?? []);
    }, 0);
}

/** Голый URL становится ссылкой только в комментариях. */
const commentParser = createParser(true);
const plainParser = createParser(false);

interface Node {
    readonly token: Token;
    readonly children: readonly Node[];
}

interface Context {
    readonly profile: MarkdownProfile;
    readonly lines: readonly string[];
    readonly firstLine: number | undefined;
    readonly violations: Set<StopViolation>;
}

/** Инлайн-разбор строки: что из синтаксиса живо, а что остаётся текстом, решает профиль. */
export function parseInline(source: string, profile: MarkdownProfile): readonly InlineNode[] {
    const parser = profile === 'comment' ? commentParser : plainParser;
    const tokens = parser.parseInline(source, {})[0]?.children ?? [];
    return inline(tree(tokens), context(profile, source, undefined));
}

/** Блочный разбор профиля `comment`; `firstLine` — номер первой строки, если нужны диапазоны исходника. */
export function parseBlocks(source: string, firstLine?: number): readonly MarkdownBlock[] {
    const ctx = context('comment', source, firstLine);
    return blocks(tree(commentParser.parse(source, {})), ctx, 0);
}

/** Блочный разбор описания остановки: блоки для рендера и всё, что нужно валидатору. */
export function parseStop(source: string): StopMarkup {
    const ctx = context('stop', source, undefined);
    let longestList = 0;
    const out: MarkdownBlock[] = [];

    const env: { references?: Record<string, unknown> } = {};
    for (const node of tree(plainParser.parse(source, env))) {
        markViolations(node, ctx, false);
        if (node.token.type === 'paragraph_open') {
            out.push({ kind: 'paragraph', lines: splitLines(inlineOf(node, ctx)) });
        } else if (isList(node)) {
            longestList = Math.max(longestList, node.children.length);
            out.push(stopList(node, ctx) ?? literalBlock(node, ctx));
        } else {
            out.push(literalBlock(node, ctx));
        }
    }

    // Определение `[метка]: адрес` токенов не оставляет — на экране его нет, а ссылки через метку вне словаря.
    if (Object.keys(env.references ?? {}).length > 0) {
        ctx.violations.add('link-definition');
    }
    return { blocks: out, violations: ctx.violations, longestList, visibleChars: visibleLength(out) };
}

export function parseStopBlocks(source: string): readonly MarkdownBlock[] {
    return parseStop(source).blocks;
}

/**
 * Текст без разметки инлайн-кода: бэктики парной пары срезаются, содержимое остаётся.
 * Для строковых атрибутов (`title`, `aria-label`, подписи команд палитры) — markdown туда
 * не отдать, а бэктики модели читаются в озвучке как есть.
 */
export function stripInlineCode(text: string): string {
    return parseInline(text, 'route').map(nodeText).join('');
}

function context(profile: MarkdownProfile, source: string, firstLine: number | undefined): Context {
    return { profile, lines: source.replace(/\r\n?/g, '\n').split('\n'), firstLine, violations: new Set() };
}

/** Плоский поток токенов — в дерево по `nesting`. */
function tree(tokens: readonly Token[]): Node[] {
    const root: Node[] = [];
    const stack: { token: Token; children: Node[] }[] = [];
    for (const token of tokens) {
        const siblings = stack.at(-1)?.children ?? root;
        if (token.nesting === 1) {
            const node = { token, children: [] };
            siblings.push(node);
            stack.push(node);
        } else if (token.nesting === -1) {
            stack.pop();
        } else {
            siblings.push({ token, children: [] });
        }
    }
    return root;
}

function blocks(nodes: readonly Node[], ctx: Context, quoteDepth: number): MarkdownBlock[] {
    return nodes.flatMap((node) => block(node, ctx, quoteDepth));
}

function block(node: Node, ctx: Context, quoteDepth: number): MarkdownBlock[] {
    const { token } = node;
    const at = position(token.map?.[0], token.map?.[1], ctx);
    switch (token.type) {
        case 'paragraph_open':
            return [{ ...at, kind: 'paragraph', lines: splitLines(inlineOf(node, ctx)) }];
        case 'heading_open':
            return [{ ...at, kind: 'heading', level: HEADING_LEVELS[Number(token.tag.slice(1)) - 1] ?? 1, children: inlineOf(node, ctx) }];
        case 'fence':
            return [{ ...at, kind: 'code', lang: fenceLang(token.info), fenced: true, text: token.content.replace(/\n$/, '') }];
        case 'code_block':
            return [{ ...at, kind: 'code', lang: null, fenced: false, text: token.content.replace(/\n$/, '') }];
        case 'blockquote_open': {
            if (quoteDepth < MAX_QUOTE_DEPTH) {
                return [{ ...at, kind: 'quote', depth: quoteDepth === 0 ? 1 : 2, children: blocks(node.children, ctx, quoteDepth + 1) }];
            }
            return blocks(node.children, ctx, quoteDepth + 1).map(quotedLiterally);
        }
        case 'bullet_list_open':
        case 'ordered_list_open':
            return listBlocks(node, ctx, quoteDepth);
        case 'table_open':
            return [{ ...at, ...table(node, ctx) }];
        case 'hr':
            return [{ ...at, kind: 'paragraph', lines: [[{ kind: 'text', text: token.markup }]] }];
        default:
            return [literalBlock(node, ctx)];
    }
}

/** Цитата глубже потолка: её `>` остаётся текстом в начале каждой строки. */
function quotedLiterally(block: MarkdownBlock): MarkdownBlock {
    if (block.kind !== 'paragraph') {
        return block;
    }
    return { ...block, lines: block.lines.map((line) => merge([{ kind: 'text', text: '> ' }, ...line])) };
}

/** Диапазон строк исходника `[start, end)`; хвостовые пустые строки в него не входят. */
function position(start: number | undefined, end: number | undefined, ctx: Context): { source?: MarkdownSource } {
    if (ctx.firstLine === undefined || start === undefined || end === undefined) {
        return {};
    }
    let last = end - 1;
    while (last > start && /^[\s>]*$/.test(ctx.lines[last] ?? '')) {
        last -= 1;
    }
    return { source: { start: ctx.firstLine + start, end: ctx.firstLine + last } };
}

/** Блок вне белого списка — строки исходника как есть. */
function literalBlock(node: Node, ctx: Context): MarkdownBlock {
    const [start, end] = node.token.map ?? [0, 0];
    const lines = ctx.lines
        .slice(start, end)
        .filter((line) => line.trim() !== '')
        .map((line): readonly InlineNode[] => [{ kind: 'text', text: line }]);
    return { ...position(start, end, ctx), kind: 'paragraph', lines };
}

function isList(node: Node): boolean {
    return node.token.type === 'bullet_list_open' || node.token.type === 'ordered_list_open';
}

/**
 * Список комментария. В пункт помещаются только первый абзац и вложенный список; прочие блоки
 * пункта (код, цитата, второй абзац) встают после списка, и список на этом пункте рвётся.
 */
function listBlocks(list: Node, ctx: Context, quoteDepth: number): MarkdownBlock[] {
    const ordered = list.token.type === 'ordered_list_open';
    const out: MarkdownBlock[] = [];
    let items: MarkdownListItem[] = [];
    let start: number | undefined;

    for (const item of list.children) {
        const rest: Node[] = [];
        start ??= item.token.map?.[0];
        items.push(...listItem(item, ctx, 0, rest));
        if (rest.length > 0) {
            const restStart = Math.min(...rest.map((node) => node.token.map?.[0] ?? Infinity));
            out.push({ ...position(start, restStart, ctx), kind: 'list', list: { ordered, items } });
            out.push(...blocks(rest, ctx, quoteDepth));
            items = [];
            start = undefined;
        } else if (item === list.children.at(-1)) {
            out.push({ ...position(start, item.token.map?.[1], ctx), kind: 'list', list: { ordered, items } });
        }
    }
    return out;
}

/** Пункт и, за потолком вложенности, его вложенные пункты в один ряд с ним; лишние блоки — в `rest`. */
function listItem(item: Node, ctx: Context, depth: number, rest: Node[]): MarkdownListItem[] {
    const children = [...item.children];
    const paragraph = children[0]?.token.type === 'paragraph_open' ? children.shift() : undefined;
    const task = taskOf(paragraph === undefined ? [] : inlineOf(paragraph, ctx));
    const flattened: MarkdownListItem[] = [];
    let list: MarkdownList | null = null;

    const next = children[0];
    if (next !== undefined && isList(next)) {
        children.shift();
        const items = next.children.flatMap((child) => listItem(child, ctx, depth + 1, rest));
        if (depth + 1 > MAX_LIST_DEPTH) {
            flattened.push(...items);
        } else {
            list = { ordered: next.token.type === 'ordered_list_open', items };
        }
    }
    rest.push(...children);

    const line = item.token.map?.[0];
    const sourceLine = ctx.firstLine === undefined || line === undefined ? {} : { sourceLine: ctx.firstLine + line };
    return [{ ...sourceLine, children: task.children, list, check: task.check }, ...flattened];
}

/** Маркер чек-листа снимается только вместе с текстом после него: `- [ ]` в одиночку — литерал. */
function taskOf(nodes: readonly InlineNode[]): { readonly check: boolean | null; readonly children: readonly InlineNode[] } {
    const first = nodes[0];
    const match = first?.kind === 'text' ? TASK_MARKER.exec(first.text) : null;
    if (first?.kind !== 'text' || match === null) {
        return { check: null, children: nodes };
    }
    const children = merge([{ kind: 'text', text: first.text.slice(match[0].length) }, ...nodes.slice(1)]);
    if (children.length === 0) {
        return { check: null, children: nodes };
    }
    return { check: (match[1] ?? '') !== ' ', children };
}

function table(node: Node, ctx: Context): Extract<MarkdownBlock, { kind: 'table' }> {
    const section = (type: string) => node.children.find((child) => child.token.type === type)?.children ?? [];
    const headRow = section('thead_open')[0]?.children ?? [];
    return {
        kind: 'table',
        align: headRow.map((cell) => alignOf(cell.token.attrGet('style'))),
        head: headRow.map((cell) => inlineOf(cell, ctx)),
        rows: section('tbody_open').map((row) => row.children.map((cell) => inlineOf(cell, ctx))),
    };
}

function alignOf(style: string | null): TableAlign {
    const align = /text-align:(left|center|right)/.exec(style ?? '')?.[1];
    return align === 'left' || align === 'center' || align === 'right' ? align : null;
}

/** Язык забора: первое слово инфо-строки, без бэктиков и регистра. */
function fenceLang(info: string): string | null {
    const word = (info.trim().split(/\s+/)[0] ?? '').replace(/`/g, '').toLowerCase();
    return word === '' ? null : word;
}

/**
 * Список описания остановки — только плоский, `- `, `* ` или `1. ` от начала строки, в пункте один
 * абзац. Иначе `null`: список уходит литералом, а нарушение отмечает `markViolations`.
 */
function stopList(list: Node, ctx: Context): MarkdownBlock | null {
    const items: MarkdownListItem[] = [];
    for (const item of list.children) {
        const children = item.children;
        const first = children[0];
        if (!stopListItem(list, item, ctx) || children.length > 1 || (first !== undefined && first.token.type !== 'paragraph_open')) {
            return null;
        }
        items.push({ children: first === undefined ? [] : inlineOf(first, ctx), list: null, check: null });
    }
    return { kind: 'list', list: { ordered: list.token.type === 'ordered_list_open', items } };
}

/** Маркер пункта из словаря и стоит в начале строки. */
function stopListItem(list: Node, item: Node, ctx: Context): boolean {
    const line = ctx.lines[item.token.map?.[0] ?? -1] ?? '';
    return stopMarker(list.token) && !/^\s/.test(line);
}

/** Маркеры списка описания остановки: `- ` и `* ` для пунктов, `1. ` для нумерации; `+ ` и `1) ` — нет. */
function stopMarker(list: Token): boolean {
    return list.type === 'bullet_list_open' ? list.markup === '-' || list.markup === '*' : list.markup === '.';
}

/**
 * Белый список блоков описания остановки — по всему дереву, включая то, что уйдёт литералом:
 * известная конструкция вне словаря — своё нарушение, неизвестная — `markup`.
 */
function markViolations(node: Node, ctx: Context, inList: boolean): void {
    const { token } = node;
    const found = ctx.violations;
    switch (token.type) {
        case 'paragraph_open':
        case 'inline':
            break;
        case 'list_item_open':
            if (node.children.filter((child) => child.token.type === 'paragraph_open').length > 1) {
                found.add('list-paragraphs');
            }
            break;
        case 'heading_open':
            found.add('heading');
            break;
        case 'fence':
        case 'code_block':
            found.add('code');
            break;
        case 'table_open':
            // Строки и ячейки таблицы — её внутренности, не блоки описания.
            found.add('table');
            return;
        case 'blockquote_open':
            found.add('quote');
            break;
        case 'hr':
            found.add('rule');
            break;
        case 'bullet_list_open':
        case 'ordered_list_open':
            if (inList || node.children.some((item) => /^\s/.test(ctx.lines[item.token.map?.[0] ?? -1] ?? ''))) {
                found.add('nested-list');
            }
            if (!stopMarker(token)) {
                found.add('list-marker');
            }
            break;
        default:
            found.add('markup');
    }
    for (const child of node.children) {
        markViolations(child, ctx, inList || isList(node));
    }
}

/** Инлайн-узлы блока-контейнера (абзац, заголовок, ячейка): их несёт дочерний токен `inline`. */
function inlineOf(node: Node, ctx: Context): InlineNode[] {
    const tokens = node.children.find((child) => child.token.type === 'inline')?.token.children ?? [];
    return inline(tree(tokens), ctx);
}

function inline(nodes: readonly Node[], ctx: Context): InlineNode[] {
    return merge(
        nodes.flatMap((node) => {
            const lost = (node.token.meta as { lostBreaks?: number } | null)?.lostBreaks ?? 0;
            const out = inlineNode(node, ctx);
            return lost === 0 ? out : [...out, { kind: 'text', text: '\n'.repeat(lost) }];
        }),
    );
}

function inlineNode(node: Node, ctx: Context): InlineNode[] {
    const { token } = node;
    const { profile } = ctx;
    switch (token.type) {
        case 'text':
            return [{ kind: 'text', text: token.content }];
        case 'text_special':
            return [{ kind: 'text', text: profile === 'route' ? token.markup : token.content }];
        case 'softbreak':
        case 'hardbreak':
            return [{ kind: 'text', text: '\n' }];
        case 'code_inline':
            // Код через перенос — по куску на строку абзаца.
            return token.content
                .split('\n')
                .flatMap((text, index): InlineNode[] => [
                    ...(index === 0 ? [] : [{ kind: 'text', text: '\n' } as const]),
                    ...(text === '' ? [] : [{ kind: 'code', text } as const]),
                ]);
        case 'strong_open':
            if (profile !== 'route') {
                return [{ kind: 'strong', children: inline(node.children, ctx) }];
            }
            break;
        case 'em_open':
            if (profile === 'comment') {
                return [{ kind: 'em', children: inline(node.children, ctx) }];
            }
            violate(ctx, 'italic');
            break;
        case 's_open':
            if (profile === 'comment') {
                return [{ kind: 'strike', children: inline(node.children, ctx) }];
            }
            violate(ctx, 'strike');
            break;
        case 'link_open': {
            const href = token.attrGet('href') ?? '';
            if (profile === 'comment' ? (SAFE_HREF.test(href) || href.startsWith('#code?')) : profile === 'stop' && (WEB_HREF.test(href) || STOP_HREF.test(href))) {
                return [{ kind: 'link', href, children: inline(node.children, ctx) }];
            }
            violate(ctx, 'link');
            break;
        }
        case 'image':
            violate(ctx, 'image');
            break;
    }
    return literalInline(node, ctx);
}

function violate(ctx: Context, violation: StopViolation): void {
    if (ctx.profile === 'stop') {
        ctx.violations.add(violation);
    }
}

/** Инлайн-конструкция вне белого списка — обратно в исходный синтаксис, содержимое разбирается дальше. */
function literalInline(node: Node, ctx: Context): InlineNode[] {
    const { token } = node;
    const text = (value: string): InlineNode => ({ kind: 'text', text: value });
    switch (token.type) {
        case 'link_open':
            if (token.markup === 'linkify') {
                return inline(node.children, ctx);
            }
            if (token.markup === 'autolink') {
                return [text('<'), ...inline(node.children, ctx), text('>')];
            }
            return [text('['), ...inline(node.children, ctx), text(`](${destination(token, 'href')})`)];
        case 'image':
            return [text('!['), ...inline(tree(token.children ?? []), ctx), text(`](${destination(token, 'src')})`)];
        default:
            return [text(token.markup), ...inline(node.children, ctx), text(token.markup)];
    }
}

function destination(token: Token, attr: 'href' | 'src'): string {
    const title = token.attrGet('title');
    return `${token.attrGet(attr) ?? ''}${title === null ? '' : ` "${title}"`}`;
}

/** Соседние текстовые узлы — в один, пустые — прочь. */
function merge(nodes: readonly InlineNode[]): InlineNode[] {
    const out: InlineNode[] = [];
    for (const node of nodes) {
        const last = out.at(-1);
        if (node.kind === 'text' && last?.kind === 'text') {
            out[out.length - 1] = { kind: 'text', text: last.text + node.text };
        } else if (node.kind !== 'text' || node.text !== '') {
            out.push(node);
        }
    }
    return out;
}

/** Строки абзаца: перенос внутри выделения или ссылки рвёт узел на две строки. */
function splitLines(nodes: readonly InlineNode[]): InlineNode[][] {
    const lines: InlineNode[][] = [];
    let line: InlineNode[] = [];
    const push = (parts: readonly (readonly InlineNode[])[]) => {
        parts.forEach((part, index) => {
            if (index > 0) {
                lines.push(merge(line));
                line = [];
            }
            line.push(...part);
        });
    };

    for (const node of nodes) {
        switch (node.kind) {
            case 'text':
                push(node.text.split('\n').map((text) => [{ kind: 'text', text }]));
                break;
            case 'code':
                line.push(node);
                break;
            default:
                push(splitLines(node.children).map((children) => (children.length === 0 ? [] : [{ ...node, children }])));
        }
    }
    lines.push(merge(line));
    return lines;
}

function nodeText(node: InlineNode): string {
    switch (node.kind) {
        case 'text':
        case 'code':
            return node.text;
        case 'strong':
        case 'em':
        case 'strike':
        case 'link':
            return node.children.map(nodeText).join('');
    }
}

function visibleLength(blocks: readonly MarkdownBlock[]): number {
    const inlineLength = (nodes: readonly InlineNode[]) => nodes.reduce((sum, node) => sum + nodeText(node).replace(/\n/g, '').length, 0);
    const listLength = (list: MarkdownList): number =>
        list.items.reduce((sum, item) => sum + inlineLength(item.children) + (item.list === null ? 0 : listLength(item.list)), 0);
    return blocks.reduce((sum, block) => {
        switch (block.kind) {
            case 'paragraph':
                return sum + block.lines.reduce((lines, line) => lines + inlineLength(line), 0);
            case 'heading':
                return sum + inlineLength(block.children);
            case 'code':
                return sum + block.text.length;
            case 'list':
                return sum + listLength(block.list);
            case 'quote':
                return sum + visibleLength(block.children);
            case 'table':
                return sum + [block.head, ...block.rows].flat().reduce((cells, cell) => cells + inlineLength(cell), 0);
        }
    }, 0);
}
