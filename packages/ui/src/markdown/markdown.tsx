import type {
    HeadingLevel,
    InlineNode,
    MarkdownBlock,
    MarkdownList,
    MarkdownSource,
    TableAlign,
} from '@sherpa/protocol/markdown';
import { parseBlocks, parseInline, parseStopBlocks } from '@sherpa/protocol/markdown';
import { parseCodeLink } from '@sherpa/protocol';
import type { CodeLocation } from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { Fragment } from 'react';

import type { LanguageId, SyntaxToken } from '../diff/model.js';
import { highlightText, languageByName } from '../diff/syntax.js';

import './markdown.css';

/**
 * Рендер markdown в React-элементы. `dangerouslySetInnerHTML` здесь нет и быть не может:
 * элементы строятся из разобранных узлов, сырой HTML исходника доезжает текстом.
 *
 * Профиль `comment` отдаёт блоки (абзацы, заголовки, цитаты, таблицы, списки, код) — вставлять
 * его надо в контейнер. Профиль `route` отдаёт только инлайн-узлы: элемент строки (`h2`, `p`,
 * `li`) остаётся за вызывающим, поэтому раскладка карточек маршрута не меняется.
 * Описание остановки и summary PR (`stop`) рисует `StopMarkdown` — ему нужен ещё и обработчик переходов.
 */
export function Markdown({ text, profile, onCodeLink }: { text: string; profile: 'comment' | 'route'; onCodeLink?: ((location: CodeLocation) => void) | undefined }) {
    if (profile === 'route') {
        return <>{inlineNodes(parseInline(text, 'route'))}</>;
    }
    const link: LinkRenderer = (node, key) => {
        if (node.href.startsWith('#code?')) {
            const location = parseCodeLink(node.href);
            if (location === null || onCodeLink === undefined) return <Fragment key={key}>{inlineNodes(node.children)}</Fragment>;
            return <a key={key} className="md-link" href={node.href} onClick={(event) => {
                event.preventDefault(); onCodeLink(location);
            }}>{inlineNodes(node.children)}</a>;
        }
        return <a key={key} className="md-link" href={node.href} target="_blank" rel="noreferrer">{inlineNodes(node.children)}</a>;
    };
    return <>{parseBlocks(text).map((block, index) => renderBlock(block, index, link))}</>;
}

/** Внутренний переход из описания остановки: к остановке плана или к файлу диффа. */
export type StopLink =
    | { readonly kind: 'stop'; readonly planIndex: number }
    | { readonly kind: 'file'; readonly path: string };

/**
 * Описание остановки и summary PR: блоки словаря §2 спеки 09-20 — абзацы и плоский список.
 * Вставлять в контейнер `.md-blocks`.
 *
 * Внешняя ссылка уводит в новую вкладку; внутреннюю (`#stop-N`, `#file-<path>`) перехватывает
 * `onOpenLink` — это тот же переход, что у файловых чипов остановки. Без обработчика внутренняя
 * ссылка никуда не ведёт: прыгать по адресу вью не умеет.
 */
export function StopMarkdown({ text, onOpenLink }: { text: string; onOpenLink?: (link: StopLink) => void }) {
    const link: LinkRenderer = (node, key) => {
        const target = stopLinkOf(node.href);
        if (target === null) {
            // Чужая ссылка уводит из читалки — только новой вкладкой и без реферера.
            return (
                <a key={key} className="md-link" href={node.href} target="_blank" rel="noopener noreferrer">
                    {inlineNodes(node.children)}
                </a>
            );
        }
        return (
            <a
                key={key}
                className="md-link"
                href={node.href}
                onClick={(event) => {
                    event.preventDefault();
                    onOpenLink?.(target);
                }}
            >
                {inlineNodes(node.children)}
            </a>
        );
    };
    return <>{parseStopBlocks(text).map((block, index) => renderBlock(block, index, link))}</>;
}

/** Адрес внутреннего перехода; `null` — ссылка внешняя. */
export function stopLinkOf(href: string): StopLink | null {
    const stop = /^#stop-(\d+)$/.exec(href);
    if (stop !== null) {
        return { kind: 'stop', planIndex: Number(stop[1]) };
    }
    const file = /^#file-(\S+)$/.exec(href);
    return file === null ? null : { kind: 'file', path: file[1] ?? '' };
}

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const;

/** Как нарисовать ссылку: у описания остановки внутренние адреса перехватывает вью. */
type LinkRenderer = (node: Extract<InlineNode, { kind: 'link' }>, key: number) => ReactNode;

export function renderBlock(block: MarkdownBlock, index: number, link?: LinkRenderer): ReactNode {
    switch (block.kind) {
        case 'heading': {
            // Настоящие h1–h6: уровень несёт структуру, а кегль сжат до трёх ступеней
            // шкалы хендоффа — своя типографика внутри чужого текста ломает ритм карточки.
            const Tag = HEADING_TAGS[block.level];
            return (
                <Tag
                    key={index}
                    data-source-line={block.source?.start}
                    className={`md-heading ${headingClass(block.level)}`}
                >
                    {inlineNodes(block.children, link)}
                </Tag>
            );
        }
        case 'code': {
            // Язык не опознан — забор остаётся текстом, а инфо-строка всё равно видна в `data-lang`.
            const language = block.lang === null ? null : languageByName(block.lang);
            return (
                <pre key={index} className="md-pre" data-lang={block.lang ?? undefined}>
                    <code>{codeLines(block, language)}</code>
                </pre>
            );
        }
        case 'list':
            return <ListBlock key={index} list={block.list} link={link} />;
        case 'quote':
            return (
                <blockquote key={index} className="md-quote">
                    {block.children.map((child, childIndex) => renderBlock(child, childIndex, link))}
                </blockquote>
            );
        case 'table':
            return (
                <div key={index} className="md-table-wrap">
                    <table className="md-table">
                        <thead>
                            <tr data-source-line={block.source?.start}>
                                {block.head.map((cell, cellIndex) => (
                                    <th key={cellIndex} style={alignStyle(block.align[cellIndex] ?? null)}>
                                        {inlineNodes(cell, link)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        {block.rows.length === 0 ? null : (
                            <tbody>
                                {block.rows.map((row, rowIndex) => (
                                    <tr key={rowIndex} data-source-line={sourceLine(block.source, rowIndex + 2)}>
                                        {row.map((cell, cellIndex) => (
                                            <td key={cellIndex} style={alignStyle(block.align[cellIndex] ?? null)}>
                                                {inlineNodes(cell, link)}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        )}
                    </table>
                </div>
            );
        case 'paragraph':
            return (
                <p key={index} className="md-p">
                    {block.lines.map((line, lineIndex) => (
                        <Fragment key={lineIndex}>
                            {lineIndex === 0 ? null : <br />}
                            {withSourceLine(sourceLine(block.source, lineIndex), inlineNodes(line, link))}
                        </Fragment>
                    ))}
                </p>
            );
    }
}

/** Номер строки исходника со смещением от начала блока; блок без диапазона — вне документа диффа. */
function sourceLine(source: MarkdownSource | undefined, offset: number): number | undefined {
    return source === undefined ? undefined : source.start + offset;
}

/** Обёртка с номером строки, по которой выделение в документе находит строку диффа. */
function withSourceLine(line: number | undefined, children: ReactNode): ReactNode {
    return line === undefined ? children : <span data-source-line={line}>{children}</span>;
}

/**
 * Забор с диапазоном исходника размечается построчно: каждой строке нужен свой номер, поэтому
 * и подсветка идёт по строкам. Без диапазона тело подсвечивается целиком.
 */
function codeLines(block: Extract<MarkdownBlock, { kind: 'code' }>, language: LanguageId | null): ReactNode {
    if (block.source === undefined) {
        return language === null ? block.text : highlighted(block.text, language);
    }
    // Открывающий забор занимает строку перед телом.
    const first = block.fenced ? 1 : 0;
    return block.text.split('\n').map((line, index) => (
        <Fragment key={index}>
            {index === 0 ? null : '\n'}
            {withSourceLine(
                sourceLine(block.source, index + first),
                language === null ? line : highlighted(line, language),
            )}
        </Fragment>
    ));
}

function headingClass(level: HeadingLevel): string {
    return `md-h${String(level)}`;
}

function alignStyle(align: TableAlign): CSSProperties | undefined {
    return align === null ? undefined : { textAlign: align };
}

/**
 * Подсветка тела забора тем же движком, что и дифф: забор — цельный фрагмент кода,
 * поэтому подсвечивается одним вызовом, а не построчно.
 */
function highlighted(text: string, language: LanguageId): ReactNode[] {
    const tokens = highlightText(text, language);
    return text.split('\n').map((line, index) => (
        <Fragment key={index}>
            {index === 0 ? null : '\n'}
            {lineTokens(line, tokens[index] ?? [])}
        </Fragment>
    ));
}

function lineTokens(line: string, tokens: readonly SyntaxToken[]): ReactNode[] {
    const nodes: ReactNode[] = [];
    let at = 0;

    for (const token of tokens) {
        if (token.from > at) {
            nodes.push(line.slice(at, token.from));
        }
        nodes.push(
            <span key={token.from} className={`syntax-${token.kind}`}>
                {line.slice(token.from, token.to)}
            </span>,
        );
        at = token.to;
    }

    if (at < line.length) {
        nodes.push(line.slice(at));
    }
    return nodes;
}

function ListBlock({ list, link }: { list: MarkdownList; link: LinkRenderer | undefined }) {
    const items = list.items.map((item, index) => (
        <li key={index} className={item.check === null ? 'md-item' : 'md-item md-item--task'}>
            {item.check === null ? null : (
                <span className={item.check ? 'md-check md-check--on' : 'md-check'} aria-hidden="true" />
            )}
            {withSourceLine(item.sourceLine, inlineNodes(item.children, link))}
            {item.list === null ? null : <ListBlock list={item.list} link={link} />}
        </li>
    ));
    return list.ordered ? <ol className="md-list">{items}</ol> : <ul className="md-list">{items}</ul>;
}

function inlineNodes(nodes: readonly InlineNode[], link?: LinkRenderer): ReactNode[] {
    return nodes.map((node, index) => {
        switch (node.kind) {
            case 'text':
                return <Fragment key={index}>{node.text}</Fragment>;
            case 'code':
                return (
                    <code key={index} className="md-code">
                        {node.text}
                    </code>
                );
            case 'strong':
                return (
                    <strong key={index} className="md-strong">
                        {inlineNodes(node.children, link)}
                    </strong>
                );
            case 'em':
                return <em key={index}>{inlineNodes(node.children, link)}</em>;
            case 'strike':
                return <del key={index}>{inlineNodes(node.children, link)}</del>;
            case 'link':
                if (link !== undefined) {
                    return link(node, index);
                }
                // Чужая ссылка уводит из читалки — только новой вкладкой и без реферера.
                return (
                    <a key={index} className="md-link" href={node.href} target="_blank" rel="noreferrer">
                        {inlineNodes(node.children)}
                    </a>
                );
        }
    });
}
