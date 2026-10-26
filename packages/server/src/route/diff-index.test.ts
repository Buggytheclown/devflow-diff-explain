import type { PrDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { indexDiff } from './diff-index.js';
import { mediumDiff } from './fixture-support.js';

/**
 * Разметка ханка: валидатор обязан считать номера строк ровно так же, как их считает UI
 * (`packages/ui/src/diff/parse.ts`) — модель якорится по тому, что видит ревьюер. Каждое
 * правило здесь зафиксировано отдельным патчем; расхождение в один сдвиг убивает живой якорь.
 */

const PATH = 'services/orders/src/infra/clock.ts';

/** Дифф фикстуры с подменённым патчем одного файла: собирать PrDiff с нуля незачем. */
function diffWith(lines: readonly string[]): PrDiff {
    const diff = mediumDiff();
    return {
        ...diff,
        files: diff.files.map((file) => (file.path === PATH ? { ...file, patch: lines.join('\n') } : file)),
    };
}

function changed(lines: readonly string[]): { old: number[]; new: number[] } {
    const file = indexDiff(diffWith(lines)).get(PATH);
    return { old: [...(file?.old ?? [])], new: [...(file?.new ?? [])] };
}

const HEADERS = ['--- a/x.ts', '+++ b/x.ts'];

describe('индекс изменённых строк: разметка ханка читается как в UI', () => {
    it('строка контекста с ведущим пробелом двигает обе стороны', () => {
        expect(changed([...HEADERS, '@@ -1,3 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;'])).toEqual({
            old: [2],
            new: [2],
        });
    });

    it('пустая строка без префикса — тоже контекст: хосты режут хвостовой пробел', () => {
        expect(
            changed([...HEADERS, '@@ -1,4 +1,4 @@', ' const a = 1;', '', '-const b = 2;', '+const b = 3;']),
        ).toEqual({ old: [3], new: [3] });
    });

    it('строка с неопознанным префиксом считается контекстом и не сбивает нумерацию', () => {
        expect(
            changed([...HEADERS, '@@ -1,4 +1,4 @@', ' const a = 1;', '?мусор', '-const b = 2;', '+const b = 3;']),
        ).toEqual({ old: [3], new: [3] });
    });

    it('маркер `\\ No newline at end of file` номера не двигает', () => {
        expect(
            changed([
                ...HEADERS,
                '@@ -1,2 +1,2 @@',
                ' const a = 1;',
                '-const b = 2;',
                '\\ No newline at end of file',
                '+const b = 3;',
            ]),
        ).toEqual({ old: [2], new: [2] });
    });

    it('счётчики заголовка ограничивают тело: хвост за ними в индекс не попадает', () => {
        expect(changed([...HEADERS, '@@ -1,1 +1,1 @@', '-old', '+new', '+хвост за ханком'])).toEqual({
            old: [1],
            new: [1],
        });
    });

    it('укороченный заголовок `@@ -a +c @@` — по одной строке на сторону', () => {
        expect(changed([...HEADERS, '@@ -5 +5 @@', '-old', '+new'])).toEqual({ old: [5], new: [5] });
    });

    it('следующий заголовок обрывает недобранный ханк', () => {
        expect(
            changed([...HEADERS, '@@ -1,9 +1,9 @@', '-old', '@@ -20,1 +20,1 @@', '+new']),
        ).toEqual({ old: [1], new: [20] });
    });

    it('у файла без текстового патча менять нечего', () => {
        const file = indexDiff({
            ...mediumDiff(),
            files: mediumDiff().files.map((candidate) =>
                candidate.path === PATH ? { ...candidate, patch: null } : candidate,
            ),
        }).get(PATH);

        expect(file?.old.size).toBe(0);
        expect(file?.new.size).toBe(0);
    });
});
