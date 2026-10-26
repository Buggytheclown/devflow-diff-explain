import { describe, expect, it } from 'vitest';

import type { MarkdownBlock } from './markdown.js';
import { parseBlocks, parseInline, parseStop, stripInlineCode } from './markdown.js';

/**
 * Разбор в узлы по профилям. Разметку, которую из узлов строит UI, проверяют тесты рендера
 * в `packages/ui/src/markdown`; здесь — форма узлов, белые списки и то, что видит валидатор.
 */

function list(block: MarkdownBlock | undefined) {
    if (block?.kind !== 'list') {
        throw new Error(`ждали список, пришло ${String(block?.kind)}`);
    }
    return block.list;
}

describe('профиль комментария', () => {
    it('голый адрес — ссылка только со схемой: имя файла и www ссылками не становятся', () => {
        expect(parseInline('см. https://example.com/a. и markdown.ts, www.example.com', 'comment')).toEqual([
            { kind: 'text', text: 'см. ' },
            { kind: 'link', href: 'https://example.com/a', children: [{ kind: 'text', text: 'https://example.com/a' }] },
            { kind: 'text', text: '. и markdown.ts, www.example.com' },
        ]);
    });

    it('картинка и небезопасная ссылка остаются исходным синтаксисом', () => {
        expect(parseInline('![схема](https://x.test/a.png) [тут](/local "t")', 'comment')).toEqual([
            { kind: 'text', text: '![схема](https://x.test/a.png) [тут](/local "t")' },
        ]);
    });

    it('перенос внутри жирного рвёт узел на две строки абзаца', () => {
        expect(parseBlocks('**раз\nдва** три')).toEqual([
            {
                kind: 'paragraph',
                lines: [
                    [{ kind: 'strong', children: [{ kind: 'text', text: 'раз' }] }],
                    [{ kind: 'strong', children: [{ kind: 'text', text: 'два' }] }, { kind: 'text', text: ' три' }],
                ],
            },
        ]);
    });

    it('блок кода в пункте встаёт после списка, список на нём рвётся', () => {
        const blocks = parseBlocks('1. Поставить:\n   ```sh\n   pnpm i\n   ```\n2. Запустить', 1);

        expect(blocks.map((block) => [block.kind, block.source])).toEqual([
            ['list', { start: 1, end: 1 }],
            ['code', { start: 2, end: 4 }],
            ['list', { start: 5, end: 5 }],
        ]);
        expect(blocks[1]).toMatchObject({ lang: 'sh', text: 'pnpm i' });
    });

    it('глубже пяти уровней пункты встают в ряд с пятым', () => {
        const source = Array.from({ length: 7 }, (_, depth) => `${'  '.repeat(depth)}- ${String(depth)}`).join('\n');
        let level = list(parseBlocks(source)[0]);
        for (let depth = 0; depth < 4; depth += 1) {
            const next = level.items[0]?.list;
            if (next === null || next === undefined) {
                throw new Error(`нет уровня ${String(depth + 1)}`);
            }
            level = next;
        }

        expect(level.items.map((item) => item.children)).toEqual([
            [{ kind: 'text', text: '4' }],
            [{ kind: 'text', text: '5' }],
            [{ kind: 'text', text: '6' }],
        ]);
    });

    it('строки пунктов и хвост списка без пустых строк', () => {
        const blocks = parseBlocks('- [x] раз\n\n- два\n\nабзац', 10);

        expect(blocks.map((block) => block.source)).toEqual([{ start: 10, end: 12 }, { start: 14, end: 14 }]);
        expect(list(blocks[0]).items).toEqual([
            { sourceLine: 10, children: [{ kind: 'text', text: 'раз' }], list: null, check: true },
            { sourceLine: 12, children: [{ kind: 'text', text: 'два' }], list: null, check: null },
        ]);
    });

    it('отступ в четыре пробела — блок кода', () => {
        expect(parseBlocks('текст\n\n    const a = 1;')[1]).toEqual({ kind: 'code', lang: null, fenced: false, text: 'const a = 1;' });
    });

    it('перенос внутри инлайн-кода и адреса ссылки остаётся строкой абзаца', () => {
        expect(parseBlocks('раз `код\nпродолжение` два\nтри')).toEqual([
            {
                kind: 'paragraph',
                lines: [
                    [{ kind: 'text', text: 'раз ' }, { kind: 'code', text: 'код' }],
                    [{ kind: 'code', text: 'продолжение' }, { kind: 'text', text: ' два' }],
                    [{ kind: 'text', text: 'три' }],
                ],
            },
        ]);
        expect(parseBlocks('см. [a](\nhttps://x.test) далее\nтри', 10)).toEqual([
            {
                source: { start: 10, end: 12 },
                kind: 'paragraph',
                lines: [
                    [{ kind: 'text', text: 'см. ' }, { kind: 'link', href: 'https://x.test', children: [{ kind: 'text', text: 'a' }] }],
                    [{ kind: 'text', text: ' далее' }],
                    [{ kind: 'text', text: 'три' }],
                ],
            },
        ]);
    });
});

describe('профиль маршрута', () => {
    it('живёт только инлайн-код, экранирование и сущности — как в исходнике', () => {
        expect(parseInline('`a` **b** \\* &amp; <https://x.test>', 'route')).toEqual([
            { kind: 'code', text: 'a' },
            { kind: 'text', text: ' **b** \\* &amp; <https://x.test>' },
        ]);
        expect(stripInlineCode('**`a`** [b](https://x.test)')).toBe('**a** [b](https://x.test)');
    });
});

describe('профиль описания остановки', () => {
    it('словарь проходит без нарушений', () => {
        const stop = parseStop('Текст с `кодом` и **главным**.\n\n- раз\n- два\n\n1. [тикет](https://x.test/T-1)\n2. [стоп](#stop-2)');

        expect([...stop.violations]).toEqual([]);
        expect(stop.longestList).toBe(2);
        expect(stop.blocks.map((block) => block.kind)).toEqual(['paragraph', 'list', 'list']);
    });

    it('каждая конструкция вне словаря — своё нарушение', () => {
        const cases: readonly (readonly [string, string])[] = [
            ['# Заголовок', 'heading'],
            ['Заголовок\n===', 'heading'],
            ['```\nx\n```', 'code'],
            ['    x', 'code'],
            ['| a |\n| - |\n| 1 |', 'table'],
            ['![a](https://x.test/a.png)', 'image'],
            ['> цитата', 'quote'],
            ['- a\n  - b', 'nested-list'],
            ['  - a', 'nested-list'],
            ['+ a', 'list-marker'],
            ['1) a', 'list-marker'],
            ['*курсив*', 'italic'],
            ['~~нет~~', 'strike'],
            ['---', 'rule'],
            ['[a](src/a.ts)', 'link'],
            ['[a](mailto:x@y.test)', 'link'],
            ['- a\n\n  второй абзац пункта', 'list-paragraphs'],
            ['[ref]: https://x.test', 'link-definition'],
            ['[a][ref]\n\n[ref]: https://x.test', 'link-definition'],
        ];
        for (const [source, violation] of cases) {
            expect([...parseStop(source).violations], source).toEqual([violation]);
        }
    });

    it('конструкция вне словаря рисуется строками исходника', () => {
        expect(parseStop('- a\n  - b\n\nтекст').blocks).toEqual([
            { kind: 'paragraph', lines: [[{ kind: 'text', text: '- a' }], [{ kind: 'text', text: '  - b' }]] },
            { kind: 'paragraph', lines: [[{ kind: 'text', text: 'текст' }]] },
        ]);
    });

    it('видимый текст: адрес ссылки, бэктики, звёздочки и маркеры списка не в счёт', () => {
        const stop = parseStop(`**аб** \`вг\` [де](https://x.test/${'z'.repeat(100)})\n\n- жз\n1. ик`);

        expect(stop.visibleChars).toBe('аб вг де'.length + 'жз'.length + 'ик'.length);
    });

    it('голый адрес — текст, но в счёт идёт целиком', () => {
        const stop = parseStop('см. https://x.test/a');

        expect(stop.blocks).toEqual([{ kind: 'paragraph', lines: [[{ kind: 'text', text: 'см. https://x.test/a' }]] }]);
        expect(stop.visibleChars).toBe(20);
    });
});
