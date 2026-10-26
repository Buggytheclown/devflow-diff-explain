import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown, StopMarkdown } from './markdown.tsx';
import { stripInlineCode } from '@sherpa/protocol/markdown';

/**
 * Рендерер markdown: три профиля и свойства безопасности. Проверяется готовая разметка —
 * ровно то, что увидит браузер: любой сырой HTML обязан доехать экранированным текстом.
 */

function comment(text: string): string {
    return renderToStaticMarkup(<Markdown text={text} profile="comment" />);
}

function route(text: string): string {
    return renderToStaticMarkup(<Markdown text={text} profile="route" />);
}

function stop(text: string): string {
    return renderToStaticMarkup(<StopMarkdown text={text} />);
}

describe('markdown, профиль комментария', () => {
    it('абзацы разделяются пустой строкой, одиночный перенос — <br>', () => {
        expect(comment('первая\nвторая\n\nтретья')).toBe(
            '<p class="md-p">первая<br/>вторая</p><p class="md-p">третья</p>',
        );
    });

    it('заголовок — h1–h6 с классом уровня, седьмая решётка уже не заголовок', () => {
        expect(comment('# один')).toBe('<h1 class="md-heading md-h1">один</h1>');
        expect(comment('## два')).toBe('<h2 class="md-heading md-h2">два</h2>');
        expect(comment('### три')).toBe('<h3 class="md-heading md-h3">три</h3>');
        expect(comment('#### четыре')).toBe('<h4 class="md-heading md-h4">четыре</h4>');
        expect(comment('###### шесть')).toBe('<h6 class="md-heading md-h6">шесть</h6>');
        expect(comment('##### Что не так\nтекст')).toBe(
            '<h5 class="md-heading md-h5">Что не так</h5><p class="md-p">текст</p>',
        );
        expect(comment('####### семь')).toBe('<p class="md-p">####### семь</p>');
    });

    it('списки: маркированный, нумерованный и вложенность по отступу', () => {
        expect(comment('- раз\n- два')).toBe(
            '<ul class="md-list"><li class="md-item">раз</li><li class="md-item">два</li></ul>',
        );
        expect(comment('1. раз\n2. два')).toContain('<ol class="md-list">');
        expect(comment('- раз\n  - вложенный\n- два')).toBe(
            '<ul class="md-list"><li class="md-item">раз<ul class="md-list"><li class="md-item">вложенный</li></ul></li>' +
                '<li class="md-item">два</li></ul>',
        );
    });

    it('блок кода в заборе переносится строками, язык — в data-lang и в подсветку', () => {
        const html = comment('до\n```ts\nconst a = 1;\nconst b = 2;\n```\nпосле');

        expect(html).toContain(
            '<pre class="md-pre" data-lang="ts"><code><span class="syntax-keyword">const</span> a = ' +
                '<span class="syntax-number">1</span>;\n<span class="syntax-keyword">const</span> b = ' +
                '<span class="syntax-number">2</span>;</code></pre>',
        );
        expect(html).toContain('<p class="md-p">до</p>');
        expect(html).toContain('<p class="md-p">после</p>');
    });

    it('код использует общие категории типов и переменных', () => {
        expect(comment('```ts\nclass Order {}\n```')).toContain(
            '<span class="syntax-type">Order</span>',
        );
        expect(comment('```sh\necho "$HOME"\n```')).toContain(
            '<span class="syntax-variable">$HOME</span>',
        );
    });

    it('незнакомый язык — только data-lang, без подсветки; забор без языка — без атрибута', () => {
        expect(comment('```brainfuck\n+[----->+++<]>.\n```')).toBe(
            '<pre class="md-pre" data-lang="brainfuck"><code>+[-----&gt;+++&lt;]&gt;.</code></pre>',
        );
        expect(comment('```\nfn main() {}\n```')).toBe('<pre class="md-pre"><code>fn main() {}</code></pre>');
    });

    it('внутри забора цитата и таблица — литеральный текст', () => {
        expect(comment('```\n> не цитата\n| не | таблица |\n| --- | --- |\n```')).toBe(
            '<pre class="md-pre"><code>&gt; не цитата\n| не | таблица |\n| --- | --- |</code></pre>',
        );
    });

    it('незакрытый забор закрывается концом текста — хвост не пропадает', () => {
        expect(comment('```\nconst a = 1;')).toBe('<pre class="md-pre"><code>const a = 1;</code></pre>');
    });

    it('забор из четырёх бэктиков не закрывается тройным внутри', () => {
        expect(comment('````\n```\nx\n```\n````\nхвост')).toBe(
            '<pre class="md-pre"><code>```\nx\n```</code></pre><p class="md-p">хвост</p>',
        );
    });

    it('жирный и курсив, непарная звёздочка — литерал', () => {
        expect(comment('**жирный** и *курсив*')).toBe(
            '<p class="md-p"><strong class="md-strong">жирный</strong> и <em>курсив</em></p>',
        );
        expect(comment('2 * 3 = 6')).toBe('<p class="md-p">2 * 3 = 6</p>');
    });

    it('звёздочка у пробела выделения не открывает: глобы и указатели остаются целы', () => {
        expect(comment('переименуй *.ts и *.tsx файлы')).toBe(
            '<p class="md-p">переименуй *.ts и *.tsx файлы</p>',
        );
        expect(comment('char *buf, int *len')).toBe('<p class="md-p">char *buf, int *len</p>');
        expect(comment('площадь = a * b * c')).toBe('<p class="md-p">площадь = a * b * c</p>');
        expect(comment('2 ** 3 и 4 ** 5')).toBe('<p class="md-p">2 ** 3 и 4 ** 5</p>');
    });

    it('зачёркивание парное, одиночная тильда и непарная пара — литерал', () => {
        expect(comment('~~зачёркнуто~~ и ~~пара~~')).toBe(
            '<p class="md-p"><del>зачёркнуто</del> и <del>пара</del></p>',
        );
        expect(comment('непарное ~~хвост и a ~ b и ~/dir')).toBe(
            '<p class="md-p">непарное ~~хвост и a ~ b и ~/dir</p>',
        );
    });

    it('чек-лист: маркер рисуется спаном, интерактивного input нет', () => {
        const html = comment('- [ ] не сделано\n- [x] сделано\n- [X] тоже');

        expect(html).toBe(
            '<ul class="md-list">' +
                '<li class="md-item md-item--task"><span class="md-check" aria-hidden="true"></span>не сделано</li>' +
                '<li class="md-item md-item--task"><span class="md-check md-check--on" aria-hidden="true"></span>сделано</li>' +
                '<li class="md-item md-item--task"><span class="md-check md-check--on" aria-hidden="true"></span>тоже</li>' +
                '</ul>',
        );
        expect(html).not.toContain('<input');
    });

    it('скобки без текста после них — обычный пункт с литералом', () => {
        expect(comment('- [ ]')).toBe('<ul class="md-list"><li class="md-item">[ ]</li></ul>');
    });

    it('цитата разбирается рекурсивно: внутри свои абзацы и списки', () => {
        expect(comment('> цитата\n> - пункт')).toBe(
            '<blockquote class="md-quote"><p class="md-p">цитата</p>' +
                '<ul class="md-list"><li class="md-item">пункт</li></ul></blockquote>',
        );
    });

    it('вложенность цитат до второго уровня, третья решётка — литерал', () => {
        expect(comment('> > вложенная')).toBe(
            '<blockquote class="md-quote"><blockquote class="md-quote"><p class="md-p">вложенная</p></blockquote></blockquote>',
        );
        expect(comment('> > > текст')).toBe(
            '<blockquote class="md-quote"><blockquote class="md-quote"><p class="md-p">&gt; текст</p></blockquote></blockquote>',
        );
    });

    it('цитата кончается на первой строке без `>` — ленивого продолжения нет', () => {
        expect(comment('> цитата\nобычный')).toBe(
            '<blockquote class="md-quote"><p class="md-p">цитата</p></blockquote><p class="md-p">обычный</p>',
        );
        expect(comment('абзац\n> цитата')).toBe(
            '<p class="md-p">абзац</p><blockquote class="md-quote"><p class="md-p">цитата</p></blockquote>',
        );
    });

    it('таблица: выравнивание из строки-разделителя, обрамляющие трубы необязательны', () => {
        expect(comment('| a | b |\n| :-- | --: |\n| 1 | 2 |')).toBe(
            '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
                '<th style="text-align:left">a</th><th style="text-align:right">b</th>' +
                '</tr></thead><tbody><tr>' +
                '<td style="text-align:left">1</td><td style="text-align:right">2</td>' +
                '</tr></tbody></table></div>',
        );
        expect(comment('a | b\n--- | ---\n1 | 2')).toContain('<th>a</th><th>b</th>');
    });

    it('таблица: экранированная труба остаётся в ячейке, ряды ровняются по шапке', () => {
        expect(comment('| a | b |\n| --- | --- |\n| x \\| y | z |')).toContain('<td>x | y</td><td>z</td>');
        expect(comment('| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |')).toContain(
            '<tbody><tr><td>1</td><td></td><td></td></tr><tr><td>1</td><td>2</td><td>3</td></tr></tbody>',
        );
    });

    it('строка с трубами без строки-разделителя — обычный абзац', () => {
        expect(comment('| a | b |\nобычный текст')).toBe('<p class="md-p">| a | b |<br/>обычный текст</p>');
    });

    it('абзац обрывается на таблице, а не съедает её строками', () => {
        expect(comment('абзац\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toContain(
            '<p class="md-p">абзац</p><div class="md-table-wrap">',
        );
    });

    it('ссылка открывается новой вкладкой без реферера, длинный URL рвётся классом', () => {
        const html = comment('[тикет](https://st.yandex-team.ru/SHERPA-1)');

        expect(html).toBe(
            '<p class="md-p"><a class="md-link" href="https://st.yandex-team.ru/SHERPA-1" target="_blank" rel="noreferrer">тикет</a></p>',
        );
    });

    it('голый URL становится ссылкой, точка предложения в адрес не уезжает', () => {
        const html = comment('см. https://example.com/a/b?x=1.');

        expect(html).toContain('href="https://example.com/a/b?x=1"');
        expect(html).toContain('>https://example.com/a/b?x=1</a>.');
    });

    it('скобка внутри адреса не рвёт ссылку', () => {
        const html = comment('[wiki](https://ru.wikipedia.org/wiki/Foo_(bar)) хвост');

        expect(html).toBe(
            '<p class="md-p"><a class="md-link" href="https://ru.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noreferrer">wiki</a> хвост</p>',
        );
    });

    it('mailto — единственная неверебная схема, которую пускаем', () => {
        expect(comment('[почта](mailto:alice@example.com)')).toContain('href="mailto:alice@example.com"');
    });
});

describe('markdown, санитайзинг', () => {
    it('сырой HTML остаётся текстом', () => {
        const html = comment('<img src=x onerror="alert(1)"> и <script>alert(2)</script>');

        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script');
        expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
        expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    });

    it('javascript: и data: ссылками не становятся — только текстом', () => {
        const js = comment('[клик](javascript:alert(1))');
        const data = comment('[клик](data:text/html;base64,PHNjcmlwdD4=)');

        expect(js).not.toContain('<a');
        expect(js).toContain('[клик](javascript:alert(1))');
        expect(data).not.toContain('<a');
        expect(data).toContain('data:text/html;base64,PHNjcmlwdD4=');
    });

    it('относительная и протокольная ссылка тоже литеральны — схема должна быть явной', () => {
        expect(comment('[тут](/local/file)')).not.toContain('<a');
        expect(comment('[тут](//example.com)')).not.toContain('<a');
    });

    it('пробел в схеме не обманывает проверку', () => {
        expect(comment('[клик](java\tscript:alert(1))')).not.toContain('<a');
        expect(comment('[клик]( javascript:alert(1))')).not.toContain('<a');
    });
});

describe('markdown, профиль маршрута', () => {
    it('инлайн-код рендерится моно-стилем без бэктиков на экране', () => {
        expect(route('`EditPolicy` решает по окну')).toBe(
            '<code class="md-code">EditPolicy</code> решает по окну',
        );
    });

    it('блочный синтаксис литерален: маршрут — узкая колонка', () => {
        expect(route('# Заголовок')).toBe('# Заголовок');
        expect(route('- пункт')).toBe('- пункт');
        expect(route('**жирный** и *курсив*')).toBe('**жирный** и *курсив*');
        expect(route('[текст](https://example.com)')).toBe('[текст](https://example.com)');
        expect(route('https://example.com')).toBe('https://example.com');
    });

    it('цитата, таблица и зачёркивание в маршруте тоже литеральны', () => {
        expect(route('~~зачёркнуто~~')).toBe('~~зачёркнуто~~');
        expect(route('> цитата')).toBe('&gt; цитата');
        expect(route('| a | b |')).toBe('| a | b |');
        expect(route('- [x] сделано')).toBe('- [x] сделано');
    });

    it('сырой HTML экранируется и здесь', () => {
        expect(route('<b>жирный</b>')).toBe('&lt;b&gt;жирный&lt;/b&gt;');
    });

    it('непарный бэктик — литеральный текст', () => {
        expect(route('поле `slot стало обязательным')).toBe('поле `slot стало обязательным');
        // Обрезанная клампом голова абзаца рвёт пару — так и должно быть видно.
        expect(route('решение с кодом `edit-window')).toContain('`edit-window');
    });

    it('двойные бэктики закрываются такими же, одиночный пробел у краёв срезается', () => {
        expect(route('`` a`b ``')).toBe('<code class="md-code">a`b</code>');
    });
});

describe('markdown, профиль описания остановки', () => {
    it('абзацы разделяются пустой строкой, соседние строки остаются одним абзацем', () => {
        expect(stop('Первый абзац.\n\nВторой абзац.')).toBe('<p class="md-p">Первый абзац.</p><p class="md-p">Второй абзац.</p>');
        expect(stop('Строка.\nПродолжение.')).toBe('<p class="md-p">Строка.<br/>Продолжение.</p>');
    });

    it('списки — плоские `- ` и `1. `, маркер из текста уходит', () => {
        expect(stop('- свежие продукты\n- аптека')).toBe(
            '<ul class="md-list"><li class="md-item">свежие продукты</li><li class="md-item">аптека</li></ul>',
        );
        expect(stop('1. первый\n2. второй')).toContain('<ol class="md-list">');
    });

    it('абзац после списка — свой блок', () => {
        expect(stop('- пункт\n\nВывод.')).toBe(
            '<ul class="md-list"><li class="md-item">пункт</li></ul><p class="md-p">Вывод.</p>',
        );
    });

    it('инлайн-код тот же, что в комментариях, жирный — strong', () => {
        expect(stop('`EditWindow` и **важное**')).toBe(
            '<p class="md-p"><code class="md-code">EditWindow</code> и <strong class="md-strong">важное</strong></p>',
        );
    });

    it('курсив, зачёркивание и голый URL словарём не предусмотрены — литеральный текст', () => {
        expect(stop('*курсив* ~~зачёркнуто~~ https://example.com')).toBe(
            '<p class="md-p">*курсив* ~~зачёркнуто~~ https://example.com</p>',
        );
    });

    it('внешняя ссылка уходит в новую вкладку без реферера', () => {
        expect(stop('[тикет](https://example.com/t)')).toBe(
            '<p class="md-p"><a class="md-link" href="https://example.com/t" target="_blank" rel="noopener noreferrer">тикет</a></p>',
        );
    });

    it('внутренние ссылки остаются на месте: вкладку не меняют, переход делает вью', () => {
        expect(stop('[остановка](#stop-3)')).toBe(
            '<p class="md-p"><a class="md-link" href="#stop-3">остановка</a></p>',
        );
        expect(stop('[файл](#file-src/a.ts)')).toContain('href="#file-src/a.ts"');
    });

    it('чужая схема ссылкой не становится', () => {
        expect(stop('[клик](javascript:alert(1))')).toBe('<p class="md-p">[клик](javascript:alert(1))</p>');
    });

    it('сырой HTML экранируется', () => {
        expect(stop('<b>жирный</b>')).toBe('<p class="md-p">&lt;b&gt;жирный&lt;/b&gt;</p>');
    });

    it('вложенный пункт и прочее вне словаря остаются строкой абзаца', () => {
        // Валидатор такую секцию отвергает; доехав до UI, она не должна рисовать ни списка, ни заголовка.
        expect(stop('  - вложенный')).toBe('<p class="md-p">  - вложенный</p>');
        expect(stop('# Заголовок')).toBe('<p class="md-p"># Заголовок</p>');
    });
});

describe('срезание бэктиков для строковых атрибутов', () => {
    it('парные бэктики уходят, содержимое остаётся', () => {
        expect(stripInlineCode('Политика решает по `EditWindow`, а не по часам')).toBe(
            'Политика решает по EditWindow, а не по часам',
        );
    });

    it('непарный бэктик остаётся на месте — текст не переписываем', () => {
        expect(stripInlineCode('окно `EditWindow')).toBe('окно `EditWindow');
    });

    it('прочий синтаксис не трогается: это не рендер, а зачистка атрибута', () => {
        expect(stripInlineCode('**жирный** [текст](https://example.com)')).toBe(
            '**жирный** [текст](https://example.com)',
        );
    });
});
