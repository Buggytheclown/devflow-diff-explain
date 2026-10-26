import { describe, expect, it } from 'vitest';

import type { CodeownersRule } from './codeowners.js';
import { ownersOf, parseCodeowners, zonePathOf } from './codeowners.js';

/**
 * Корпус CODEOWNERS: примеры из документации GitHub (`*`, `*.js`, `/build/logs/`, `docs/*`,
 * `apps/`, `/docs/`, `/scripts/`, две звезды, `/apps/github`) плюс края диалекта, до которых
 * документация не доходит.
 */

/** Совпадает ли одиночный шаблон с путём — короткая обёртка для читаемых таблиц. */
function matches(pattern: string, path: string): boolean {
    const rules = parseCodeowners(`${pattern} @owner`);
    return rules.length > 0 && ownersOf(rules, path) !== null;
}

function rule(pattern: string, ...owners: string[]): CodeownersRule {
    return { pattern, owners, line: 1 };
}

describe('CODEOWNERS: разбор', () => {
    it('комментарии и пустые строки выброшены, владельцы разобраны по словам', () => {
        const rules = parseCodeowners(
            ['# заголовок файла', '', '   ', '*.ts @alice @acme/core', 'docs/ docs@example.com # хвост'].join('\n'),
        );

        expect(rules).toEqual([
            { pattern: '*.ts', owners: ['@alice', '@acme/core'], line: 4 },
            { pattern: 'docs/', owners: ['docs@example.com'], line: 5 },
        ]);
    });

    it('правило без владельцев разбирается — у файла просто нет владельца', () => {
        const rules = parseCodeowners(['/apps/ @octocat', '/apps/github'].join('\n'));

        expect(rules[1]).toEqual({ pattern: '/apps/github', owners: [], line: 2 });
        expect(ownersOf(rules, 'apps/github/main.ts')?.owners).toEqual([]);
        expect(ownersOf(rules, 'apps/other/main.ts')?.owners).toEqual(['@octocat']);
    });

    it('пробел в шаблоне экранируется и разделителем слов не становится', () => {
        const rules = parseCodeowners('docs/release\\ notes/ @alice');

        expect(rules[0]?.owners).toEqual(['@alice']);
        expect(ownersOf(rules, 'docs/release notes/v1.md')).not.toBeNull();
        expect(ownersOf(rules, 'docs/release/notes/v1.md')).toBeNull();
    });

    it('неподдерживаемый синтаксис выбрасывает строку целиком', () => {
        const rules = parseCodeowners(
            ['!secret/ @alice', 'src/[a-z]*.ts @bob', 'weird\\#name @carol', 'src/ @dave'].join('\n'),
        );

        expect(rules).toEqual([{ pattern: 'src/', owners: ['@dave'], line: 4 }]);
    });

    it('перевод строки Windows не прилипает ни к владельцу, ни к шаблону', () => {
        const rules = parseCodeowners('/src/ @alice\r\n/apps/github @acme/core\r\n');

        expect(rules).toEqual([
            { pattern: '/src/', owners: ['@alice'], line: 1 },
            { pattern: '/apps/github', owners: ['@acme/core'], line: 2 },
        ]);
        expect(ownersOf(rules, 'apps/github/main.ts')?.owners).toEqual(['@acme/core']);
    });

    it('BOM в начале файла не попадает в первый шаблон', () => {
        const rules = parseCodeowners('\uFEFF/src/ @alice');

        expect(rules).toEqual([{ pattern: '/src/', owners: ['@alice'], line: 1 }]);
        expect(ownersOf(rules, 'src/a.ts')?.owners).toEqual(['@alice']);
    });

    it('фигурные скобки — литерал, альтернатив у GitHub нет', () => {
        expect(matches('src/{a,b}.ts', 'src/{a,b}.ts')).toBe(true);
        expect(matches('src/{a,b}.ts', 'src/a.ts')).toBe(false);
    });
});

describe('CODEOWNERS: матчинг', () => {
    it('примеры документации GitHub', () => {
        expect(matches('*', 'a.ts')).toBe(true);
        expect(matches('*', 'src/deep/a.ts')).toBe(true);

        expect(matches('*.js', 'app.js')).toBe(true);
        expect(matches('*.js', 'src/deep/app.js')).toBe(true);
        expect(matches('*.js', 'app.ts')).toBe(false);

        expect(matches('/build/logs/', 'build/logs/a.txt')).toBe(true);
        expect(matches('/build/logs/', 'build/logs/deep/a.txt')).toBe(true);
        expect(matches('/build/logs/', 'src/build/logs/a.txt')).toBe(false);

        expect(matches('docs/*', 'docs/getting-started.md')).toBe(true);
        expect(matches('docs/*', 'docs/build-app/troubleshooting.md')).toBe(false);

        expect(matches('apps/', 'apps/a.ts')).toBe(true);
        expect(matches('apps/', 'src/deep/apps/a.ts')).toBe(true);
        expect(matches('apps/', 'apps')).toBe(false);

        expect(matches('/docs/', 'docs/a.md')).toBe(true);
        expect(matches('/docs/', 'src/docs/a.md')).toBe(false);

        expect(matches('/scripts/', 'scripts/deploy.sh')).toBe(true);

        expect(matches('**/logs', 'logs/a.txt')).toBe(true);
        expect(matches('**/logs', 'build/logs/a.txt')).toBe(true);
        expect(matches('**/logs', 'deeply/nested/logs/a.txt')).toBe(true);
        expect(matches('**/logs', 'build/logsly/a.txt')).toBe(false);

        expect(matches('/apps/github', 'apps/github')).toBe(true);
        expect(matches('/apps/github', 'apps/github/main.ts')).toBe(true);
        expect(matches('/apps/github', 'apps/other/main.ts')).toBe(false);
    });

    it('одна звезда не пересекает `/`, `?` — один символ', () => {
        expect(matches('src/*/a.ts', 'src/x/a.ts')).toBe(true);
        expect(matches('src/*/a.ts', 'src/x/y/a.ts')).toBe(false);
        expect(matches('src/a?.ts', 'src/ab.ts')).toBe(true);
        expect(matches('src/a?.ts', 'src/a/b.ts')).toBe(false);
    });

    it('две звезды — любое число каталогов, включая ноль', () => {
        expect(matches('a/**/b', 'a/b')).toBe(true);
        expect(matches('a/**/b', 'a/x/b')).toBe(true);
        expect(matches('a/**/b', 'a/x/y/b')).toBe(true);
        expect(matches('a/**/b', 'x/a/b')).toBe(false);

        expect(matches('**/foo', 'foo')).toBe(true);
        expect(matches('**/foo', 'x/y/foo')).toBe(true);

        expect(matches('foo/**', 'foo/a.ts')).toBe(true);
        expect(matches('foo/**', 'foo/a/b.ts')).toBe(true);
        expect(matches('foo/**', 'foo')).toBe(false);

        // Хвостовой `/` за двумя звёздами ничего не добавляет: это всё тот же «всё под foo».
        expect(matches('foo/**/', 'foo/a.ts')).toBe(true);
        expect(matches('foo/**/', 'foo/a/b.ts')).toBe(true);
        expect(matches('foo/**/', 'foo')).toBe(false);
    });

    it('шаблон без хвостового `/` берёт и файл, и каталог с содержимым', () => {
        expect(matches('src/lib', 'src/lib')).toBe(true);
        expect(matches('src/lib', 'src/lib/a.ts')).toBe(true);
        expect(matches('src/lib', 'src/library.ts')).toBe(false);
    });

    it('побеждает последнее совпавшее правило, а не самое точное', () => {
        const rules = parseCodeowners(['* @root', 'src/ @src-team', '*.md @docs'].join('\n'));

        expect(ownersOf(rules, 'src/a.md')?.owners).toEqual(['@docs']);
        expect(ownersOf(rules, 'src/a.ts')?.owners).toEqual(['@src-team']);
        expect(ownersOf(rules, 'a.txt')?.owners).toEqual(['@root']);
    });

    it('путь вне всех правил остаётся без правила', () => {
        expect(ownersOf(parseCodeowners('/src/ @alice'), 'docs/a.md')).toBeNull();
    });
});

describe('CODEOWNERS: границы зон', () => {
    it('зона — статический префикс шаблона', () => {
        expect(zonePathOf(rule('src/pci/**'), 'src/pci/a.ts')).toBe('src/pci');
        expect(zonePathOf(rule('/apps/'), 'apps/a.ts')).toBe('apps');
        expect(zonePathOf(rule('docs/*.md'), 'docs/a.md')).toBe('docs');
        expect(zonePathOf(rule('/apps/github'), 'apps/github/main.ts')).toBe('apps/github');
    });

    it('шаблон без статического префикса отдаёт верхний каталог файла', () => {
        expect(zonePathOf(rule('*.js'), 'src/deep/a.js')).toBe('src');
        expect(zonePathOf(rule('**/logs'), 'build/logs/a.txt')).toBe('build');
        expect(zonePathOf(rule('*.js'), 'a.js')).toBe('a.js');
    });

    it('шаблон на любой глубине даёт зону там, где он совпал', () => {
        expect(zonePathOf(rule('apps/'), 'apps/a.ts')).toBe('apps');
        expect(zonePathOf(rule('apps/'), 'deep/nested/apps/a.ts')).toBe('deep/nested/apps');
    });
});
