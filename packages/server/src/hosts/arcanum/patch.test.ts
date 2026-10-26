import { describe, expect, it } from 'vitest';

import { mockFile } from './mock-transport.js';
import { countPatchStats, splitPatchByFile } from './patch.js';

describe('разрезка патча по файлам', () => {
    it('патч arc: куски начинаются с `diff --git`, переименование — парой кусков', () => {
        const chunks = splitPatchByFile(mockFile('arc/diff-iteration.txt'));

        expect([...chunks.keys()]).toEqual([
            'examples/ui/packages/grid/src/index.ts',
            'examples/ui/packages/grid/src/legacy.ts',
            // Переименование `arc` рисует парой кусков: старый путь удалён, новый добавлен.
            'examples/ui/docs/old.md',
            'examples/ui/docs/moved.md',
            'examples/ui/docs/keep.md',
            'examples/ui/docs/renamed.md',
            'examples/ui/docs/added.md',
            'examples/ui/docs/huge.md',
            'examples/ui/assets/icon.svg',
        ]);
        for (const text of chunks.values()) {
            expect(text.startsWith('diff --git ')).toBe(true);
            expect(text.endsWith('\n')).toBe(true);
        }
    });

    it('пути без кавычек разбираются', () => {
        const chunks = splitPatchByFile(['diff --git a/src/app.ts b/src/app.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'));

        expect([...chunks.keys()]).toEqual(['src/app.ts']);
    });

    // Живой `arc` пробел в пути не экранирует, поэтому заголовок разбирается по известным путям.
    it('путь с пробелом без кавычек: сторона узнаётся по списку запрошенных путей', () => {
        const patch = [
            'diff --git a/docs/Sherpa Additions.dc.html b/docs/Sherpa Additions.dc.html',
            '--- a/docs/Sherpa Additions.dc.html',
            '+++ b/docs/Sherpa Additions.dc.html',
            '@@ -1 +1 @@',
            '-было',
            '+стало',
            '',
            'diff --git a/docs/Sherpa.dc.html b/docs/Sherpa.dc.html',
            'deleted file mode 100644',
            '--- a/docs/Sherpa.dc.html',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-было',
        ].join('\n');
        // Порядок списка значения не имеет: короткий путь — префикс длинного.
        const known = ['docs/Sherpa.dc.html', 'docs/Sherpa Additions.dc.html'];

        expect([...splitPatchByFile(patch, known).keys()]).toEqual([
            'docs/Sherpa Additions.dc.html',
            'docs/Sherpa.dc.html',
        ]);
    });

    it('без списка путей пробел в заголовке рвёт путь — отсюда и список', () => {
        const patch = ['diff --git a/docs/with space.md b/docs/with space.md', '@@ -1 +1 @@', '-a', '+b'].join('\n');

        expect([...splitPatchByFile(patch).keys()]).not.toContain('docs/with space.md');
    });

    it('экранирование в кавычках: пробелы, кавычки и октальные байты UTF-8', () => {
        const cyrillic = [...new TextEncoder().encode('заметки.md')]
            .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
            .join('');
        const patch = [
            `diff --git "a/docs/with space.md" "b/docs/with space.md"`,
            '@@ -1 +1 @@',
            '-a',
            '+b',
            `diff --git "a/docs/${cyrillic}" "b/docs/${cyrillic}"`,
            '@@ -1 +1 @@',
            '-в',
            '+г',
            String.raw`diff --git "a/docs/\"quoted\".md" "b/docs/\"quoted\".md"`,
            '@@ -1 +1 @@',
            '-a',
            '+b',
        ].join('\n');

        expect([...splitPatchByFile(patch).keys()]).toEqual([
            'docs/with space.md',
            'docs/заметки.md',
            'docs/"quoted".md',
        ]);
    });

    it('копия не отбирает у источника его собственный кусок', () => {
        // Один диффсет: файл скопирован в copy.ts и сам же изменён. Оба куска претендуют на
        // ключ app.ts, и владеть им обязан кусок с правой стороной app.ts — в любом порядке.
        const copyChunk = ['diff --git a/src/app.ts b/src/copy.ts', '@@ -0,0 +1 @@', '+копия'];
        const modifyChunk = ['diff --git a/src/app.ts b/src/app.ts', '@@ -1 +1 @@', '-было', '+стало'];

        for (const order of [
            [...copyChunk, ...modifyChunk],
            [...modifyChunk, ...copyChunk],
        ]) {
            const chunks = splitPatchByFile(order.join('\n'), ['src/app.ts', 'src/copy.ts']);

            expect(chunks.get('src/app.ts')).toContain('+стало');
            expect(chunks.get('src/copy.ts')).toContain('+копия');
        }
    });

    it('пустой патч даёт пустую карту', () => {
        expect(splitPatchByFile('').size).toBe(0);
    });

    // Разрезка идёт синхронно в единственном потоке сервера, поэтому её цена обязана расти
    // линейно по числу файлов: сторона заголовка ищется просмотром самого заголовка, а не
    // перебором всех известных путей. Замер на этой машине: 2000 файлов — 4 мс линейной
    // разрезкой против 562 мс перебором; порог взят с запасом на медленную машину.
    it('патч на 2000 файлов режется за линейное время', () => {
        const paths = Array.from(
            { length: 2000 },
            (_, index) => `examples/ui/src/file-${String(index)}.ts`,
        );
        const patch = paths
            .map((path) =>
                [
                    `diff --git a/${path} b/${path}`,
                    `--- a/${path}`,
                    `+++ b/${path}`,
                    '@@ -1 +1 @@',
                    '-было',
                    '+стало',
                ].join('\n'),
            )
            .join('\n');

        const started = performance.now();
        const chunks = splitPatchByFile(patch, paths);

        expect(chunks.size).toBe(paths.length);
        expect(performance.now() - started).toBeLessThan(300);
    });
});

describe('числа патча', () => {
    it('считаются только строки тела ханков', () => {
        const chunks = splitPatchByFile(mockFile('arc/diff-iteration.txt'));

        expect(countPatchStats(chunks.get('examples/ui/packages/grid/src/index.ts') ?? '')).toEqual({
            additions: 2,
            deletions: 1,
        });
        expect(countPatchStats(chunks.get('examples/ui/packages/grid/src/legacy.ts') ?? '')).toEqual({
            additions: 0,
            deletions: 2,
        });
        // Кусок переименования — весь новый файл добавлениями: честной дельты `arc` не считает,
        // и адаптер её не досчитывает.
        expect(countPatchStats(chunks.get('examples/ui/docs/moved.md') ?? '')).toEqual({
            additions: 3,
            deletions: 0,
        });
    });

    it('строка `+++ text` внутри ханка — добавление, а не заголовок', () => {
        const patch = [
            'diff --git a/a.md b/a.md',
            '--- a/a.md',
            '+++ b/a.md',
            '@@ -1,1 +1,2 @@',
            ' текст',
            '+++ подчёркивание',
            '--- было',
        ].join('\n');

        expect(countPatchStats(patch)).toEqual({ additions: 1, deletions: 1 });
    });
});
