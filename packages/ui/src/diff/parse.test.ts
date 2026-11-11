import { FIXTURE_NAMES, fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PATCH_CASES } from '../../../protocol/src/diff/patch-cases.js';
import { lowlight } from './languages.js';
import * as wordDiff from './word-diff.js';

afterEach(() => { vi.restoreAllMocks(); });

import type { DiffFileModel, DiffGap, DiffHunk } from './model.js';
import { toParseRequest } from './model.js';
import { parseFileDiff } from './parse.js';

function parse(file: FileDiff): DiffFileModel {
    return parseFileDiff(toParseRequest(file));
}

function fileByPath(fixture: 'medium' | 'small' | 'large' | 'edge', path: string): FileDiff {
    const file = fixtureIteration(fixture).diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`нет файла ${path} в фикстуре ${fixture}`);
    }
    return file;
}

/** Патч из строк — в тестах кривых и синтетических случаев. */
function patchOf(lines: readonly string[]): string {
    return [...lines, ''].join('\n');
}

function modelOf(patch: string, path = 'services/orders/src/api/b.ts'): DiffFileModel {
    return parseFileDiff({ fileId: 'f1', path, oldPath: null, changeType: 'modify', binary: false, patch });
}

function hunks(model: DiffFileModel): DiffHunk[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffHunk => block.kind === 'hunk')
        : [];
}

function gaps(model: DiffFileModel): DiffGap[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffGap => block.kind === 'gap')
        : [];
}

describe('дифф-парсер на реальных патчах фикстур', () => {
    for (const name of FIXTURE_NAMES) {
        it(`${name}: счётчики модели сходятся с FileDiff по каждому файлу`, () => {
            const files = fixtureIteration(name).diff.files;
            const counted = files.map((file) => {
                const model = parse(file);
                return { path: file.path, additions: model.additions, deletions: model.deletions };
            });

            expect(counted).toEqual(
                files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
            );
        });

        it(`${name}: реальные патчи разбираются без флага malformed`, () => {
            const files = fixtureIteration(name).diff.files;

            expect(files.filter((file) => parse(file).malformed).map((file) => file.path)).toEqual([]);
        });

        it(`${name}: номера строк идут подряд и сходятся с заголовком ханка`, () => {
            for (const file of fixtureIteration(name).diff.files) {
                for (const hunk of hunks(parse(file))) {
                    let oldLine = hunk.oldStart;
                    let newLine = hunk.newStart;
                    for (const line of hunk.lines) {
                        if (line.kind !== 'add') {
                            expect(line.oldLine).toBe(oldLine);
                            oldLine += 1;
                        }
                        if (line.kind !== 'del') {
                            expect(line.newLine).toBe(newLine);
                            newLine += 1;
                        }
                    }
                    expect(oldLine - hunk.oldStart).toBe(hunk.oldCount);
                    expect(newLine - hunk.newStart).toBe(hunk.newCount);
                }
            }
        });
    }

    it('текст строки едет без префикса патча', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(hunks(model)[0]?.lines[0]).toMatchObject({
            kind: 'add',
            oldLine: null,
            newLine: 1,
            text: '# Rollout',
        });
    });
});

describe('подсветка ханка по сторонам', () => {
    /** Категории строки по её тексту — так видно, что покрашено, без арифметики смещений. */
    function painted(model: DiffFileModel, index: number): [string, string][] {
        const line = hunks(model)[0]?.lines[index];
        if (line === undefined) {
            throw new Error(`нет строки №${String(index)}`);
        }
        return (line.tokens ?? []).map((token) => [token.kind, line.text.slice(token.from, token.to)]);
    }

    it('комментарий, открытый на старой стороне, не течёт в добавленную строку', () => {
        const model = modelOf(
            patchOf(['@@ -10,2 +10,2 @@', '-/* legacy note', '+const answer = 42;', ' still inside */']),
        );

        expect(painted(model, 0)).toEqual([['comment', '/* legacy note']]);
        expect(painted(model, 1)).toEqual([
            ['keyword', 'const'],
            ['number', '42'],
        ]);
    });

    it('многострочный комментарий красится на всех своих строках', () => {
        const model = modelOf(
            patchOf(['@@ -10,3 +10,3 @@', '+/* open', '+   body', '+   close */', '-const a = 1;']),
        );

        expect(painted(model, 0)).toEqual([['comment', '/* open']]);
        expect(painted(model, 1)).toEqual([['comment', '   body']]);
        expect(painted(model, 2)).toEqual([['comment', '   close */']]);
    });

    it('файл без языка в реестре токенов не получает', () => {
        const model = modelOf(patchOf(['@@ -1,1 +1,1 @@', '+const a = 1;']), 'services/orders/.gitignore');

        expect(hunks(model)[0]?.lines[0]?.tokens).toBeUndefined();
    });
});

describe('«сырые» края', () => {
    it('binary: содержимого нет, вариант модели явный', () => {
        const model = parse(fileByPath('edge', 'services/orders/assets/edit-window-flow.png'));

        expect(model.content).toEqual({ kind: 'binary' });
        expect(model.additions).toBe(0);
        expect(model.deletions).toBe(0);
    });

    it('пустой патч: текстового диффа нет', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/infra/time/index.ts'));

        expect(model.content).toEqual({ kind: 'none' });
        expect(model.changeType).toBe('add');
    });

    it('смена режима без правок: режим распознан, ханков нет', () => {
        const model = parse(fileByPath('edge', 'services/orders/scripts/rollout.sh'));

        expect(model.modeChange).toEqual({ from: '100644', to: '100755' });
        expect(model.content).toEqual({ kind: 'none' });
    });

    it('переименование с правкой: старый путь и ханки на месте', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/infra/time/clock.ts'));

        expect(model.changeType).toBe('move');
        expect(model.oldPath).toBe('services/orders/src/infra/clock.ts');
        expect(hunks(model)).toHaveLength(1);
    });

    it('удаление файла: только удаления', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/legacy/edit-window-v1.ts'));

        expect(model.onlyDeletions).toBe(true);
        expect(model.onlyAdditions).toBe(false);
    });

    it('добавление файла: только добавления', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(model.onlyAdditions).toBe(true);
        expect(model.onlyDeletions).toBe(false);
    });

    it('whitespace-only: флаг на ханке и на файле', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/api/schemas.ts'));

        expect(model.whitespaceOnly).toBe(true);
        expect(hunks(model).map((hunk) => hunk.whitespaceOnly)).toEqual([true]);
    });

    it('CRLF-only считается пробельным изменением', () => {
        const model = modelOf(patchOf(['@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;\r', '+const b = 2;']));

        expect(model.whitespaceOnly).toBe(true);
    });

    it('содержательная правка пробельной не считается', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/infra/time/clock.ts'));

        expect(model.whitespaceOnly).toBe(false);
    });

    it('конфликт прокидывается changeType-ом, содержимое остаётся текстом', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/domain/order.ts'));

        expect(model.changeType).toBe('conflict');
        expect(model.content.kind).toBe('text');
        expect(hunks(model)[0]?.lines.map((line) => line.text)).toContain('<<<<<<< HEAD');
    });
});

describe('пропуски между ханками и по краям', () => {
    it('ведущий пропуск считается от начала файла', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/api/schemas.ts'));

        // Ханк начинается с 12-й строки — до него скрыто 11.
        expect(gaps(model).find((gap) => gap.edge === 'leading')).toEqual({
            kind: 'gap',
            edge: 'leading',
            hiddenLines: 11,
            oldStart: 1,
            newStart: 1,
        });
    });

    it('ханк с первой строки ведущего пропуска не даёт', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(gaps(model).some((gap) => gap.edge === 'leading')).toBe(false);
    });

    it('внутренний пропуск считается из заголовков соседних ханков', () => {
        const model = modelOf(
            patchOf([
                '@@ -10,2 +10,3 @@',
                ' const a = 1;',
                '+const b = 2;',
                ' const c = 3;',
                '@@ -40,1 +41,1 @@',
                '-const d = 4;',
                '+const d = 40;',
            ]),
        );

        expect(gaps(model).find((gap) => gap.edge === 'inner')).toEqual({
            kind: 'gap',
            edge: 'inner',
            hiddenLines: 28,
            oldStart: 12,
            newStart: 13,
        });
    });

    it('край после последнего ханка честно без числа', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/api/schemas.ts'));

        expect(gaps(model).find((gap) => gap.edge === 'trailing')?.hiddenLines).toBeNull();
    });

    it('`\\ No newline at end of file` закрывает файл — хвостового пропуска нет', () => {
        const model = modelOf(
            patchOf(['@@ -1,1 +1,1 @@', '-const a = 1;', '+const a = 2;', '\\ No newline at end of file']),
        );

        expect(gaps(model)).toEqual([]);
        expect(hunks(model)[0]?.lines.at(-1)?.noNewline).toBe(true);
    });

    it('`\\ No newline` в середине ханка тоже закрывает файл', () => {
        const model = modelOf(
            patchOf([
                '@@ -1,2 +1,3 @@',
                ' const a = 1;',
                '-const b = 2;',
                '\\ No newline at end of file',
                '+const b = 20;',
                '+const c = 3;',
            ]),
        );

        expect(gaps(model)).toEqual([]);
        expect(hunks(model)[0]?.lines[1]?.noNewline).toBe(true);
    });

    it('добавленный файл целиком в патче — хвостового пропуска нет', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(gaps(model)).toEqual([]);
    });

    it('удалённый файл целиком в патче — хвостового пропуска нет', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/legacy/edit-window-v1.ts'));

        expect(gaps(model)).toEqual([]);
    });

    it('якоря пропусков — настоящие номера строк, не нули', () => {
        for (const name of FIXTURE_NAMES) {
            for (const file of fixtureIteration(name).diff.files) {
                for (const gap of gaps(parse(file))) {
                    expect(gap.oldStart).toBeGreaterThan(0);
                    expect(gap.newStart).toBeGreaterThan(0);
                }
            }
        }
    });
});

describe('кривой патч не роняет парсер', () => {
    it('непонятная строка едет в модель контекстом с флагом malformed', () => {
        const model = modelOf(patchOf(['@@ -1,3 +1,3 @@', ' const a = 1;', '???мусор', ' const c = 3;']));

        expect(model.malformed).toBe(true);
        expect(hunks(model)[0]?.lines[1]).toMatchObject({
            kind: 'context',
            text: '???мусор',
            malformed: true,
        });
    });

    it('обрубленный ханк не съедает следующий и помечается malformed', () => {
        const model = modelOf(
            patchOf(['@@ -1,9 +1,9 @@', ' const a = 1;', '@@ -40,1 +40,1 @@', '-const d = 4;', '+const d = 40;']),
        );

        expect(hunks(model)).toHaveLength(2);
        expect(hunks(model)[1]?.lines).toHaveLength(2);
        expect(model.malformed).toBe(true);
        // Счётчики обрубленного ханка — по телу (1/1), а не по вранью заголовка (9/9).
        expect(hunks(model)[0]).toMatchObject({ oldCount: 1, newCount: 1 });
    });

    it('патч, обрывающийся на середине ханка, помечается malformed', () => {
        const model = modelOf(patchOf(['@@ -1,4 +1,4 @@', ' const a = 1;', '-const b = 2;']));

        expect(model.malformed).toBe(true);
        expect(hunks(model)[0]).toMatchObject({ oldCount: 2, newCount: 1 });
    });

    it('строка, начинающаяся со слэша, но не маркер — обычная непонятная строка', () => {
        const model = modelOf(patchOf(['@@ -1,3 +1,3 @@', ' const a = 1;', '\\garbage', ' const c = 3;']));

        expect(model.malformed).toBe(true);
        expect(hunks(model)[0]?.lines[1]).toMatchObject({ kind: 'context', text: '\\garbage', malformed: true });
        expect(hunks(model)[0]?.lines[0]?.noNewline).toBeUndefined();
    });

    it('патч без заголовка ханка даёт вариант «нет текстового диффа»', () => {
        const model = modelOf('diff --git a/b.ts b/b.ts\nindex 1111111..2222222 100644\n');

        expect(model.content).toEqual({ kind: 'none' });
        expect(model.malformed).toBe(false);
    });

    it('«Binary files … differ» в тексте патча даёт binary', () => {
        const model = modelOf(
            'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
            'services/orders/assets/logo.png',
        );

        expect(model.content).toEqual({ kind: 'binary' });
    });
});

describe('сериализуемость модели', () => {
    it('модель каждого файла фикстур переживает structuredClone без потерь', () => {
        for (const name of FIXTURE_NAMES) {
            for (const file of fixtureIteration(name).diff.files) {
                const model = parse(file);
                expect(structuredClone(model)).toEqual(model);
            }
        }
    });
});


describe('UI-проекция общего корпуса', () => {
    for (const item of PATCH_CASES) it(item.name, () => {
        const model = modelOf(item.patch);
        expect(hunks(model).flatMap((hunk) => hunk.lines).map((line) =>
            [line.kind === 'add' ? `+${line.text}` : line.kind === 'del' ? `-${line.text}` : line.malformed ? line.text : line.text === '' ? '' : ` ${line.text}`, line.oldLine, line.newLine],
        )).toEqual(item.rows);
        expect(model.malformed).toBe(item.malformed);
    });

    it('сбой лексера и word-diff оставляет текст, координаты и EOF-маркеры', () => {
        vi.spyOn(lowlight, 'highlight').mockImplementation(() => { throw new Error('Injected lexer failure'); });
        vi.spyOn(wordDiff, 'diffWords').mockImplementation(() => { throw new Error('Injected word-diff failure'); });
        const model = modelOf('@@ -1 +1 @@\n-const old = 1;\n\\ No newline at end of file\n+const next = 2;\n\\ No newline at end of file\n');
        expect(hunks(model)[0]?.lines).toEqual([
            { kind: 'del', oldLine: 1, newLine: null, text: 'const old = 1;', noNewline: true },
            { kind: 'add', oldLine: null, newLine: 1, text: 'const next = 2;', noNewline: true },
        ]);
        expect(model.malformed).toBe(false);
    });
});


describe('координаты контекста рядом с нулевыми диапазонами', () => {
    for (const item of [
        { name: 'вставка в начало', patch: '@@ -0,0 +1 @@\n+added\n', leading: 0, old: 1, next: 2 },
        { name: 'вставка в конец', patch: '@@ -3,0 +4 @@\n+added\n', leading: 3, old: 4, next: 5 },
        { name: 'удаление в начале', patch: '@@ -1 +0,0 @@\n-removed\n', leading: 0, old: 2, next: 1 },
        { name: 'удаление в конце', patch: '@@ -4 +3,0 @@\n-removed\n', leading: 3, old: 5, next: 4 },
    ]) it(item.name, () => {
        const model = modelOf(item.patch);
        expect(gaps(model).find((gap) => gap.edge === 'leading')?.hiddenLines ?? 0).toBe(item.leading);
        expect(gaps(model).find((gap) => gap.edge === 'trailing')).toMatchObject({ oldStart: item.old, newStart: item.next });
    });

    it('между двумя вставками считает контекст по обеим сторонам', () => {
        const model = modelOf('@@ -0,0 +1 @@\n+a\n@@ -2,0 +4 @@\n+b\n');
        expect(gaps(model).find((gap) => gap.edge === 'inner'))
            .toMatchObject({ oldStart: 1, newStart: 2, hiddenLines: 2 });
    });
});
