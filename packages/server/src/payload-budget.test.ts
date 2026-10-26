import { describe, expect, it } from 'vitest';

import type { PayloadFileSpec } from './payload-budget.js';
import { byteLength, fitPayloadFiles, fitText, truncateUtf8, unavailableBlock } from './payload-budget.js';

/**
 * Подгонка payload под бюджет (docs/protocol.md §4). Бюджет считается в байтах, поэтому все проверки
 * тут — про байты, а не про длину строки: у кириллицы и эмодзи это разные величины.
 */

/** Текст, который заведомо не влезает ни в один бюджет теста и не жертвует хвостом при trimEnd. */
const LONG = 'x'.repeat(5000);

describe('обрезка по байтам', () => {
    it('режет по байтам, а не по символам, и не рвёт кириллицу пополам', () => {
        // Каждая кириллическая буква — два байта: в пять байт влезают две.
        expect(truncateUtf8('привет', 5)).toBe('пр');
        expect(truncateUtf8('привет', 3)).toBe('п');
        expect(byteLength(truncateUtf8('привет', 5))).toBe(4);
    });

    it('на точной границе отдаёт текст целиком', () => {
        expect(truncateUtf8('abcdef', 6)).toBe('abcdef');
        expect(truncateUtf8('привет', 12)).toBe('привет');
        // Байтом больше запрошенного — по-прежнему всё.
        expect(truncateUtf8('abcdef', 7)).toBe('abcdef');
    });

    it('суррогатную пару не разрывает: эмодзи либо целиком, либо его нет', () => {
        // '😀' — четыре байта и две кодовые единицы: половина пары в четыре байта «влезает».
        expect(truncateUtf8('a😀b', 4)).toBe('a');
        expect(truncateUtf8('a😀b', 5)).toBe('a😀');
        expect(truncateUtf8('a😀b', 6)).toBe('a😀b');
    });

    it('нулевой и отрицательный потолок дают пустую строку', () => {
        expect(truncateUtf8('привет', 0)).toBe('');
        expect(truncateUtf8('привет', -10)).toBe('');
    });
});

describe('текст под потолок', () => {
    it('влезающий текст отдаётся как есть', () => {
        expect(fitText('abc', 10, 'FALLBACK')).toBe('abc');
        // Ровно по границе — тоже целиком.
        expect(fitText('abc', 3, 'FALLBACK')).toBe('abc');
    });

    it('не влезающий текст помечен и укладывается в потолок', () => {
        const result = fitText(LONG, 300, 'FB');

        expect(result).toContain('[TRUNCATED: remaining content omitted by the payload budget.]');
        expect(result.startsWith('xxx')).toBe(true);
        expect(byteLength(result)).toBeLessThanOrEqual(300);
    });

    it('потолок меньше пометки — остаётся обрезанный fallback', () => {
        // Fallback сам длиннее потолка: режется он.
        expect(fitText(LONG, 10, 'FALLBACK-LONG')).toBe('FALLBACK-L');
        // Fallback короткий, но пометка о срезе в потолок не влезает — текста не остаётся вовсе.
        expect(fitText(LONG, 20, 'FB')).toBe('FB');
    });

    it('нулевой потолок не оставляет ничего', () => {
        expect(fitText(LONG, 0, 'FB')).toBe('');
    });

    it('пометка вместо содержимого называет причину', () => {
        expect(unavailableBlock('PR diff', 'the diff is too large')).toBe(
            '# PR diff\n\n[TRUNCATED: the diff is too large]\n',
        );
    });
});

describe('подгонка файлов payload под бюджет', () => {
    /** Спека, чей `render` всегда просит больше, чем ему дадут. */
    function greedy(name: string, order: number, minimum: string): PayloadFileSpec {
        return { name, order, minimum, render: () => LONG };
    }

    it('резервирует бюджет под пометки ещё не собранных файлов', () => {
        const first = 'A'.repeat(10);
        const second = 'B'.repeat(20);
        const third = 'C'.repeat(30);
        // Чуть выше суммы пометок (60): излишек достаётся первому, остальным — ровно их минимум.
        const files = fitPayloadFiles(
            [greedy('first.md', 1, first), greedy('second.md', 2, second), greedy('third.md', 3, third)],
            260,
        );

        expect(byteLength(files[0]?.content ?? '')).toBe(210);
        expect(files[0]?.content).toContain('[TRUNCATED:');
        expect(files[1]?.content).toBe(second);
        expect(files[2]?.content).toBe(third);
        expect(files.reduce((total, file) => total + byteLength(file.content), 0)).toBe(260);
    });

    it('при бюджете не меньше суммы пометок каждый файл получает не меньше своей', () => {
        const minimums = ['A'.repeat(7), 'B'.repeat(64), 'C'.repeat(3), 'D'.repeat(120)];
        const specs = minimums.map((minimum, index) => greedy(`f${String(index)}.md`, index + 1, minimum));
        const total = minimums.reduce((sum, minimum) => sum + byteLength(minimum), 0);

        for (const budget of [total, total + 1, total + 500, total * 10]) {
            const files = fitPayloadFiles(specs, budget);
            for (const [index, file] of files.entries()) {
                expect(byteLength(file.content)).toBeGreaterThanOrEqual(byteLength(minimums[index] ?? ''));
            }
            expect(files.reduce((sum, file) => sum + byteLength(file.content), 0)).toBeLessThanOrEqual(budget);
        }
    });

    it('бюджет меньше суммы пометок: ранним файлам не достаётся ничего', () => {
        const first = 'A'.repeat(10);
        const second = 'B'.repeat(10);

        const files = fitPayloadFiles([greedy('first.md', 1, first), greedy('second.md', 2, second)], 5);

        // Резерв под пометку второго файла съедает весь бюджет первого — вырожденный, но честный случай.
        expect(files[0]?.content).toBe('');
        expect(files[1]?.content).toBe('BBBBB');
    });

    it('render, проигнорировавший свой потолок, всё равно ужимается под бюджет', () => {
        const ignoring: PayloadFileSpec = { name: 'huge.md', order: 1, minimum: 'FB', render: () => LONG };

        const files = fitPayloadFiles([ignoring], 400);

        expect(byteLength(files[0]?.content ?? '')).toBeLessThanOrEqual(400);
        expect(files[0]?.content).toContain('[TRUNCATED:');
    });

    it('render получает остаток бюджета, а не весь бюджет', () => {
        const seen: number[] = [];
        const specs: PayloadFileSpec[] = [
            {
                name: 'first.md',
                order: 1,
                minimum: 'A'.repeat(10),
                render: (maxBytes) => {
                    seen.push(maxBytes);
                    return 'a'.repeat(50);
                },
            },
            {
                name: 'second.md',
                order: 2,
                minimum: 'B'.repeat(10),
                render: (maxBytes) => {
                    seen.push(maxBytes);
                    return 'b';
                },
            },
        ];

        fitPayloadFiles(specs, 100);

        // Первому — бюджет минус пометка второго; второму — что осталось после первого.
        expect(seen).toEqual([90, 50]);
    });

    it('имена, порядок полей и порядок массива сохраняются', () => {
        const files = fitPayloadFiles(
            [greedy('b.md', 7, 'FB'), greedy('a.md', 3, 'FB'), greedy('c.md', 1, 'FB')],
            1000,
        );

        expect(files.map((file) => file.name)).toEqual(['b.md', 'a.md', 'c.md']);
        expect(files.map((file) => file.order)).toEqual([7, 3, 1]);
    });

    it('отрицательный бюджет равен нулевому', () => {
        const specs = [greedy('a.md', 1, 'FB')];

        expect(fitPayloadFiles(specs, -100)).toEqual(fitPayloadFiles(specs, 0));
        expect(fitPayloadFiles(specs, -100)[0]?.content).toBe('');
    });

    it('пустой список спек даёт пустой результат', () => {
        expect(fitPayloadFiles([], 1000)).toEqual([]);
    });
});
