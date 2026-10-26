import { describe, expect, it } from 'vitest';

import { compileGlob, GlobSyntaxError } from './glob.js';
import type { PathRule } from './subpaths.js';
import {
    configDirOf,
    MATCH_ALL,
    matchesSubpaths,
    parseSubpathsFilter,
    relativeToBase,
    ruleCovers,
    ruleZonePath,
    rulesCovering,
} from './subpaths.js';

/**
 * Корпус матчинга `subpaths` — на шаблонах, снятых с живых a.yaml Аркадии (`**, !ci.a.yaml`,
 * `!ads/**, …`, `go.mod, go.sum`, длинные списки исключений direct-modules) плюс края диалекта
 * Java NIO, до которых живые конфиги не доходят.
 */

/** Совпадает ли глоб с путём целиком — короткая обёртка для читаемых таблиц. */
function glob(pattern: string, path: string): boolean {
    return compileGlob(pattern).test(path);
}

function filter(...raw: string[]): (path: string) => boolean {
    const parsed = parseSubpathsFilter(raw);
    return (path) => matchesSubpaths(parsed, path);
}

describe('глоб-диалект Java NIO', () => {
    it('две звезды пересекают разделитель имён, одна — нет', () => {
        expect(glob('src/**', 'src/a/b/c.ts')).toBe(true);
        expect(glob('src/**', 'src/a.ts')).toBe(true);
        expect(glob('src/*', 'src/a.ts')).toBe(true);
        expect(glob('src/*', 'src/a/b.ts')).toBe(false);
        expect(glob('**', 'a/b/c')).toBe(true);
        expect(glob('*.ts', 'src/a.ts')).toBe(false);
        expect(glob('**/*.css', 'src/a/b.css')).toBe(true);
        expect(glob('**/*.css', 'a.css')).toBe(false);
    });

    it('шаблон сопоставляется с путём целиком', () => {
        expect(glob('src', 'src/a.ts')).toBe(false);
        expect(glob('go.mod', 'vendor/go.mod')).toBe(false);
        expect(glob('go.mod', 'go.mod')).toBe(true);
        // Точка — литерал, а не «любой символ» регулярки.
        expect(glob('go.mod', 'goXmod')).toBe(false);
    });

    it('`?` — ровно один символ, но не разделитель', () => {
        expect(glob('a?c.ts', 'abc.ts')).toBe(true);
        expect(glob('a?c.ts', 'ac.ts')).toBe(false);
        expect(glob('a?c.ts', 'a/c.ts')).toBe(false);
    });

    it('классы символов: диапазон, отрицание, литеральная каретка', () => {
        expect(glob('v[0-9].ts', 'v7.ts')).toBe(true);
        expect(glob('v[0-9].ts', 'vx.ts')).toBe(false);
        expect(glob('[a-z]*.ts', 'zebra.ts')).toBe(true);
        expect(glob('[!a-z]*.ts', 'Zebra.ts')).toBe(true);
        expect(glob('[!a-z]*.ts', 'zebra.ts')).toBe(false);
        // Разделитель имён в класс не попадает даже при отрицании.
        expect(glob('a[!x]c', 'a/c')).toBe(false);
        expect(glob('[^]x', '^x')).toBe(true);
    });

    it('группы `{a,b}` — альтернативы, вложенность запрещена', () => {
        expect(glob('src/*.{ts,tsx}', 'src/a.tsx')).toBe(true);
        expect(glob('src/*.{ts,tsx}', 'src/a.ts')).toBe(true);
        expect(glob('src/*.{ts,tsx}', 'src/a.js')).toBe(false);
        expect(() => compileGlob('{a,{b,c}}')).toThrow(GlobSyntaxError);
    });

    it('экранирование делает метасимвол литералом', () => {
        expect(glob('a\\*b.ts', 'a*b.ts')).toBe(true);
        expect(glob('a\\*b.ts', 'axb.ts')).toBe(false);
        expect(glob('weird\\,name.md', 'weird,name.md')).toBe(true);
        expect(glob('a\\{b.ts', 'a{b.ts')).toBe(true);
        expect(() => compileGlob('trailing\\')).toThrow(GlobSyntaxError);
    });

    it('сломанный шаблон — ошибка разбора, а не молчаливое несовпадение', () => {
        expect(() => compileGlob('[abc')).toThrow(GlobSyntaxError);
        expect(() => compileGlob('[a/b]')).toThrow(GlobSyntaxError);
        expect(() => compileGlob('[z-a]')).toThrow(GlobSyntaxError);
        expect(() => compileGlob('{a,b')).toThrow(GlobSyntaxError);
    });
});

describe('список subpaths', () => {
    it('`**, !ci.a.yaml` — всё поддерево, кроме одного файла', () => {
        const matches = filter('**, !ci.a.yaml');

        expect(matches('src/index.ts')).toBe(true);
        expect(matches('ci.a.yaml')).toBe(false);
        // `**` пересекает разделитель, поэтому вложенный одноимённый файл правилом покрыт.
        expect(matches('nested/ci.a.yaml')).toBe(true);
    });

    it('список из одних исключений включает всё, чего не исключил', () => {
        const matches = filter('!ads/**, !alice/**, !market/**');

        expect(matches('examples/ui/a.ts')).toBe(true);
        expect(matches('ads/banner.cpp')).toBe(false);
        expect(matches('market/checkout/x.ts')).toBe(false);
    });

    it('список из одних включений не берёт ничего сверх перечисленного', () => {
        const matches = filter('go.mod, go.sum');

        expect(matches('go.mod')).toBe(true);
        expect(matches('go.sum')).toBe(true);
        expect(matches('go.work')).toBe(false);
    });

    it('решает последнее совпадение, а не первое', () => {
        // Живой пример direct-modules: широкое включение, затем точечные вычитания.
        const matches = filter(
            'src/**, !src/tsconfig.json, !src/**/tsconfig.json',
        );

        expect(matches('src/pages/x.tsx')).toBe(true);
        expect(matches('src/tsconfig.json')).toBe(false);
        expect(matches('src/pages/tsconfig.json')).toBe(false);

        // Обратный порядок тех же шаблонов даёт другой ответ — порядок значим.
        expect(filter('!src/**/tsconfig.json, src/**')('src/pages/tsconfig.json')).toBe(true);
    });

    it('пробелы вокруг запятых и ведущий слэш не меняют смысла', () => {
        expect(filter('** , !digital_solutions_service/**')('adv/x.ts')).toBe(true);
        expect(filter('** , !digital_solutions_service/**')('digital_solutions_service/x.ts')).toBe(false);
        expect(filter('/src/**')('src/a.ts')).toBe(true);
    });

    it('`\\,` — часть шаблона, а не разделитель списка', () => {
        const matches = filter('weird\\,name.md, plain.md');

        expect(matches('weird,name.md')).toBe(true);
        expect(matches('plain.md')).toBe(true);
        expect(matches('weird')).toBe(false);
        expect(matches('name.md')).toBe(false);
    });

    it('несколько строк фильтра — один упорядоченный список', () => {
        const matches = filter('src/**', '!src/generated/**');

        expect(matches('src/a.ts')).toBe(true);
        expect(matches('src/generated/api.ts')).toBe(false);
    });

    it('пустой фильтр берёт всё поддерево', () => {
        expect(matchesSubpaths(MATCH_ALL, 'anything/at/all.ts')).toBe(true);
        expect(matchesSubpaths(parseSubpathsFilter([]), 'anything/at/all.ts')).toBe(true);
    });
});

describe('правила и поддеревья a.yaml', () => {
    const rule = (baseDir: string, ...raw: string[]): PathRule => ({
        baseDir,
        subpaths: raw.length === 0 ? MATCH_ALL : parseSubpathsFilter(raw),
    });

    it('каталог a.yaml вычисляется из пути конфига', () => {
        expect(configDirOf('/examples/ui/packages/grid/a.yaml')).toBe('examples/ui/packages/grid');
        expect(configDirOf('examples/ui/a.yaml')).toBe('examples/ui');
        expect(configDirOf('/a.yaml')).toBe('');
    });

    it('путь приводится к каталогу a.yaml, чужое поддерево отсекается', () => {
        expect(relativeToBase('examples/ui', 'examples/ui/src/a.ts')).toBe('src/a.ts');
        expect(relativeToBase('examples/ui', 'examples/ui-tools/a.ts')).toBeNull();
        expect(relativeToBase('', 'a.ts')).toBe('a.ts');
    });

    it('правило не дотягивается за пределы своего поддерева', () => {
        const grid = rule('examples/ui/packages/grid', '**');

        expect(ruleCovers(grid, 'examples/ui/packages/grid/src/a.ts')).toBe(true);
        expect(ruleCovers(grid, 'examples/ui/docs/a.md')).toBe(false);
    });

    it('файл покрывают все подходящие правила, в порядке объявления', () => {
        const broad = rule('pkg', 'src/**');
        const narrow = rule('pkg', 'src/pci/**');
        const other = rule('pkg', 'docs/**');

        expect(rulesCovering('pkg/src/pci/x.ts', [broad, narrow, other])).toEqual([broad, narrow]);
        expect(rulesCovering('pkg/src/x.ts', [broad, narrow, other])).toEqual([broad]);
        expect(rulesCovering('pkg/ci.a.yaml', [broad, narrow, other])).toEqual([]);
    });

    it('граница зоны учитывает статический подпуть решившего шаблона', () => {
        expect(ruleZonePath(rule('pkg', '**'), 'pkg/src/a.ts')).toBe('pkg');
        expect(ruleZonePath(rule('pkg', 'src/**'), 'pkg/src/a.ts')).toBe('pkg/src');
        expect(ruleZonePath(rule('pkg', 'src/legacy.ts'), 'pkg/src/legacy.ts')).toBe('pkg/src/legacy.ts');
        expect(ruleZonePath(rule('', 'docs/**'), 'docs/a.md')).toBe('docs');
        expect(ruleZonePath(rule('', '**'), 'market/a.ts')).toBe('market');
    });
});
