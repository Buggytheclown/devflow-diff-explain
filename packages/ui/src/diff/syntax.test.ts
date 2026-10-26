import { describe, expect, it } from 'vitest';

import type { LanguageId, SyntaxKind } from './model.js';
import { highlightable, highlightText, languageByName, languageOf, tokenizeLine } from './syntax.js';

/** Токены парами «категория → текст»: так видно, что именно покрашено. */
function paint(text: string, language: LanguageId): [SyntaxKind, string][] {
    return tokenizeLine(text, language).map((token) => [token.kind, text.slice(token.from, token.to)]);
}

/** То же для многострочного текста: массив строк, в каждой — пары своей строки. */
function paintText(text: string, language: LanguageId): [SyntaxKind, string][][] {
    const lines = text.split('\n');
    return highlightText(text, language).map((tokens, index) =>
        tokens.map((token) => [token.kind, (lines[index] ?? '').slice(token.from, token.to)]),
    );
}

describe('язык по пути файла', () => {
    it('вся JS-семья ложится на грамматику typescript', () => {
        expect(languageOf('src/a.ts')).toBe('typescript');
        expect(languageOf('src/a.tsx')).toBe('typescript');
        expect(languageOf('src/a.jsx')).toBe('typescript');
        expect(languageOf('src/a.mjs')).toBe('typescript');
        expect(languageOf('src/a.cts')).toBe('typescript');
    });

    it('расширения прочих языков', () => {
        expect(languageOf('service/order_service.py')).toBe('python');
        expect(languageOf('cmd/main.go')).toBe('go');
        expect(languageOf('.github/workflows/ci.yml')).toBe('yaml');
        expect(languageOf('README.md')).toBe('markdown');
        expect(languageOf('api/order.proto')).toBe('protobuf');
        expect(languageOf('src/main/java/Order.kt')).toBe('kotlin');
        expect(languageOf('src/lib.rs')).toBe('rust');
        expect(languageOf('include/order.hpp')).toBe('cpp');
    });

    it('языки, которых старому лексеру не хватало, больше не null', () => {
        expect(languageOf('scripts/rollout.sh')).toBe('bash');
        expect(languageOf('Makefile')).toBe('makefile');
        expect(languageOf('build/Dockerfile')).toBe('dockerfile');
        expect(languageOf('CMakeLists.txt')).toBe('cmake');
    });

    it('файлы без языка', () => {
        expect(languageOf('.gitignore')).toBeNull();
        expect(languageOf('pnpm-lock.lock')).toBeNull();
        expect(languageOf('assets/logo.png')).toBeNull();
        expect(languageOf('LICENSE')).toBeNull();
    });

    it('имя языка: свои алиасы hljs плюс таблица дырок; незнакомое — null', () => {
        expect(languageByName('ts')).toBe('ts');
        expect(languageByName('golang')).toBe('golang');
        expect(languageByName('C++')).toBe('c++');
        expect(languageByName('docker')).toBe('dockerfile');
        expect(languageByName('ts title="a.ts"')).toBe('ts');
        expect(languageByName('brainfuck')).toBeNull();
        expect(languageByName('   ')).toBeNull();
    });

    it('имена свойств Object.prototype — обычные незнакомые имена, а не падение', () => {
        expect(languageByName('constructor')).toBeNull();
        expect(languageByName('__proto__')).toBeNull();
        expect(languageOf('src/constructor')).toBeNull();
        expect(languageOf('src/a.constructor')).toBeNull();
        expect(languageOf('src/__proto__.toString')).toBeNull();
    });
});

describe('категории подсветки', () => {
    it('разбор возвращает одну категорию для каждого токена независимо от оформления', () => {
        expect(tokenizeLine('int main() { return 0; }', 'cpp')).toEqual([
            { from: 0, to: 3, kind: 'type' },
            { from: 4, to: 8, kind: 'function' },
            { from: 13, to: 19, kind: 'keyword' },
            { from: 20, to: 21, kind: 'number' },
        ]);
    });

    it('имена классов и свойства получают категории типа и свойства', () => {
        expect(paint('class Order extends Base {}; value.field;', 'typescript')).toEqual([
            ['keyword', 'class'],
            ['type', 'Order'],
            ['keyword', 'extends'],
            ['type', 'Base'],
            ['property', 'field'],
        ]);
    });

    it('ключевые слова и числа TypeScript различаются по категории', () => {
        expect(paint('export const EDIT_WINDOW_MS = 30 * 60 * 1000;', 'typescript')).toEqual([
            ['keyword', 'export'],
            ['keyword', 'const'],
            ['variable', 'EDIT_WINDOW_MS'],
            ['number', '30'],
            ['number', '60'],
            ['number', '1000'],
        ]);
    });

    it('импорт: путь — строка', () => {
        expect(paint('import { Clock } from "../infra/clock";', 'typescript')).toEqual([
            ['keyword', 'import'],
            ['type', 'Clock'],
            ['keyword', 'from'],
            ['string', '"../infra/clock"'],
        ]);
    });

    it('обычный идентификатор категории не получает — сомнение красится в plain', () => {
        expect(paint('const value = order;', 'typescript')).toEqual([['keyword', 'const']]);
    });

    it('декоратор — своя категория', () => {
        expect(paint('@Injectable()', 'typescript')).toEqual([['decorator', '@Injectable']]);
    });

    it('шебанг красится декоратором: hljs зовёт его мета', () => {
        expect(paint('#!/bin/sh', 'bash')).toEqual([['decorator', '#!/bin/sh']]);
    });

    it('мета целиком в цвете декоратора, внутри уступает только строке', () => {
        expect(paint('@dataclass(frozen=True)', 'python')).toEqual([['decorator', '@dataclass(frozen=True)']]);
        expect(paint('#include <vector>', 'cpp')).toEqual([
            ['decorator', '#include '],
            ['string', '<vector>'],
        ]);
    });

    it('ключи JSON и YAML отличаются от строковых значений и чисел', () => {
        expect(paint('  "editWindowMs": 1800000,', 'json')).toEqual([
            ['property', '"editWindowMs"'],
            ['number', '1800000'],
        ]);
        expect(paint('replicas: 3', 'yaml')).toEqual([
            ['property', 'replicas:'],
            ['number', '3'],
        ]);
    });

    it('строковое значение конфига сохраняет отдельную категорию', () => {
        expect(paint('title: "Build service"', 'yaml')).toEqual([
            ['property', 'title:'],
            ['string', '"Build service"'],
        ]);
        expect(paint('"title": "Build service"', 'json')).toEqual([
            ['property', '"title"'],
            ['string', '"Build service"'],
        ]);
    });

    it('YAML-якорь и ссылка на него выделяются как переменные', () => {
        for (const language of ['yaml', 'yml']) {
            expect(paintText('config: &service\ncopy: *service', language)).toEqual([
                [
                    ['property', 'config:'],
                    ['variable', '&service'],
                ],
                [
                    ['property', 'copy:'],
                    ['variable', '*service'],
                ],
            ]);
            expect(paint('---', language)).toEqual([['decorator', '---']]);
        }
    });

    it('имя функции и имя класса отличаются от ключевых слов', () => {
        expect(paint('function apply() { return 1; }', 'typescript')).toEqual([
            ['keyword', 'function'],
            ['function', 'apply'],
            ['keyword', 'return'],
            ['number', '1'],
        ]);
        expect(paint('class Order extends Base {}', 'typescript')).toEqual([
            ['keyword', 'class'],
            ['type', 'Order'],
            ['keyword', 'extends'],
            ['type', 'Base'],
        ]);
        expect(paint('apply(order);', 'typescript')).toEqual([['function', 'apply']]);
        expect(paint('int main() { return 0; }', 'cpp')).toEqual([
            ['type', 'int'],
            ['function', 'main'],
            ['keyword', 'return'],
            ['number', '0'],
        ]);
    });

    it('переменная внутри строки shell сохраняет свою категорию', () => {
        expect(paint('echo "$HOME"', 'bash')).toEqual([
            ['keyword', 'echo'],
            ['string', '"'],
            ['variable', '$HOME'],
            ['string', '"'],
        ]);
    });

    it('python: объявление, литералы и комментарий', () => {
        expect(paint('def apply_edit(self, order: Order) -> None:', 'python')).toEqual([
            ['keyword', 'def'],
            ['function', 'apply_edit'],
            ['keyword', 'None'],
        ]);
        expect(paint('    total = 0  # running sum', 'python')).toEqual([
            ['number', '0'],
            ['comment', '# running sum'],
        ]);
    });

    it('go: ключевое слово и строка', () => {
        expect(paint('func main() {', 'go')).toEqual([
            ['keyword', 'func'],
            ['function', 'main'],
        ]);
        expect(paint('\tfmt.Println("hi")', 'go')).toEqual([['string', '"hi"']]);
    });

    it('markdown: заголовок — keyword, инлайн-код — string', () => {
        expect(paint('## Domain', 'markdown')).toEqual([['keyword', '## Domain']]);
        expect(paint('- `order.ts` — the aggregate root.', 'markdown')).toEqual([['string', '`order.ts`']]);
    });

    it('markdown: огороженный блок кода не заливается цветом строк', () => {
        expect(paintText('# Title\n\n```ts\nconst a = 1;\n```\n\ntext `inline` here', 'markdown')).toEqual([
            [['keyword', '# Title']],
            [],
            [],
            [],
            [],
            [],
            [['string', '`inline`']],
        ]);
    });

    it('подстановка в шаблонной строке — код, а не строка', () => {
        expect(paint('const t = `id-${String(x)} ok`;', 'typescript')).toEqual([
            ['keyword', 'const'],
            ['string', '`id-'],
            // `String` — built_in внутри subst: категория строки сброшена, keyword взял своё.
            ['keyword', 'String'],
            ['string', ' ok`'],
        ]);
    });

    it('doctag внутри комментария остаётся комментарием, а не уходит в декоратор', () => {
        expect(paintText('/**\n * @param order the aggregate root\n */', 'typescript')).toEqual([
            [['comment', '/**']],
            [['comment', ' * @param order the aggregate root']],
            [['comment', ' */']],
        ]);
    });

    it('соседние токены одной категории склеиваются: экранирование внутри строки — один кусок', () => {
        expect(paint('const s = "a\\"b";', 'typescript')).toEqual([
            ['keyword', 'const'],
            ['string', '"a\\"b"'],
        ]);
    });

    it('смещения считаются по сырой строке с табами', () => {
        expect(tokenizeLine('\tconst\tx = "tab";', 'typescript')).toEqual([
            { from: 1, to: 6, kind: 'keyword' },
            { from: 11, to: 16, kind: 'string' },
        ]);
    });
});

describe('многострочные конструкции', () => {
    it('блочный комментарий красится на всех своих строках — чего построчный лексер не умел', () => {
        expect(paintText('/*\n * body\n */\nconst x = 1;', 'typescript')).toEqual([
            [['comment', '/*']],
            [['comment', ' * body']],
            [['comment', ' */']],
            [
                ['keyword', 'const'],
                ['number', '1'],
            ],
        ]);
    });

    it('докстринг Python держится до закрывающих кавычек', () => {
        expect(paintText('"""doc\nmore"""\nx = 1', 'python')).toEqual([
            [['string', '"""doc']],
            [['string', 'more"""']],
            [['number', '1']],
        ]);
    });

    it('токен режется по переводу строки, смещения — от начала своей строки', () => {
        const tokens = highlightText('  /* a\n b */', 'typescript');
        expect(tokens).toEqual([
            [{ from: 2, to: 6, kind: 'comment' }],
            [{ from: 0, to: 5, kind: 'comment' }],
        ]);
    });

    it('число строк на выходе совпадает с числом строк на входе', () => {
        expect(highlightText('a\n\nb\n', 'typescript')).toHaveLength(4);
        expect(highlightText('', 'typescript')).toEqual([[]]);
    });
});

describe('предохранитель по длине', () => {
    it('обычный фрагмент подсвечивается', () => {
        expect(highlightable(['const a = 1;', 'const b = 2;'])).toBe(true);
    });

    it('минифицированный бандл — нет: одна строка длиннее порога разметки', () => {
        expect(highlightable(['x'.repeat(4001)])).toBe(false);
    });

    it('сгенерированные данные — нет: фрагмент длиннее порога целиком', () => {
        expect(highlightable(new Array<string>(2000).fill('y'.repeat(200)))).toBe(false);
    });
});
