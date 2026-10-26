import { describe, expect, it } from 'vitest';

import { FIXTURE_NAMES, fixtureIteration } from './data/index.js';
import { fileContentOf } from './file-content.js';

/**
 * Восстановление полного текста файла из патча. Проверяется то, на что опирается UI:
 * контекстная строка ханка лежит в тексте ровно на своём номере, неизменённые куски совпадают
 * в обеих версиях, а односторонние изменения дают null на отсутствующей стороне.
 */

const HUNK_HEADER = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;

interface ContextLine {
    oldLine: number;
    newLine: number;
    text: string;
}

/** Контекстные строки патча вместе с номерами по обе стороны. */
function contextLines(patch: string): ContextLine[] {
    const found: ContextLine[] = [];
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header !== null) {
            oldLine = Number(header[1]);
            newLine = Number(header[3]);
            continue;
        }
        if (oldLine === 0) {
            continue;
        }

        const prefix = raw.slice(0, 1);
        if (prefix === '+') {
            newLine += 1;
        } else if (prefix === '-') {
            oldLine += 1;
        } else if (prefix === ' ') {
            found.push({ oldLine, newLine, text: raw.slice(1) });
            oldLine += 1;
            newLine += 1;
        }
    }
    return found;
}

function lineAt(text: string, line: number): string | undefined {
    return text.split('\n')[line - 1];
}

describe('содержимое файла из патча', () => {
    for (const name of FIXTURE_NAMES) {
        const data = fixtureIteration(name);

        it(`${name}: контекстные строки патча стоят на своих номерах в обеих версиях`, () => {
            for (const file of data.diff.files) {
                const content = fileContentOf(file);
                if (content === null || file.patch === null) {
                    continue;
                }
                for (const context of contextLines(file.patch)) {
                    if (content.oldText !== null) {
                        expect(lineAt(content.oldText, context.oldLine), `${file.path}:${String(context.oldLine)}`).toBe(
                            context.text,
                        );
                    }
                    if (content.newText !== null) {
                        expect(lineAt(content.newText, context.newLine), `${file.path}:${String(context.newLine)}`).toBe(
                            context.text,
                        );
                    }
                }
            }
        });

        it(`${name}: стороны согласованы с типом изменения, binary без содержимого`, () => {
            for (const file of data.diff.files) {
                const content = fileContentOf(file);
                if (file.binary) {
                    expect(content, file.path).toBeNull();
                    continue;
                }
                if (content === null) {
                    throw new Error(`у текстового файла ${file.path} нет содержимого`);
                }
                expect(content.oldText === null, file.path).toBe(file.changeType === 'add');
                expect(content.newText === null, file.path).toBe(file.changeType === 'delete');
            }
        });

        it(`${name}: результат детерминирован`, () => {
            const again = fixtureIteration(name);
            expect(data.diff.files.map((file) => fileContentOf(file))).toEqual(
                again.diff.files.map((file) => fileContentOf(file)),
            );
        });
    }

    it('правка: хвост за последним ханком есть и одинаков в обеих версиях', () => {
        const file = fixtureIteration('medium').diff.files.find(
            (candidate) => candidate.path === 'services/orders/src/domain/order.ts',
        );
        if (file === undefined) {
            throw new Error('в фикстуре medium не нашёлся order.ts');
        }

        const content = fileContentOf(file);
        const oldLines = content?.oldText?.split('\n') ?? [];
        const newLines = content?.newText?.split('\n') ?? [];
        expect(newLines.length).toBeGreaterThan(0);
        // Хвост — одни и те же неизменённые строки, просто с разным смещением нумерации.
        expect(newLines.slice(-5)).toEqual(oldLines.slice(-5));
        expect(newLines.length - oldLines.length).toBe(file.additions - file.deletions);
    });

    it('добавленный файл: текст ровно из патча, без дописанного хвоста', () => {
        const file = fixtureIteration('medium').diff.files.find(
            (candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts',
        );
        if (file === undefined) {
            throw new Error('в фикстуре medium не нашёлся edit-window.ts');
        }

        const content = fileContentOf(file);
        expect(content?.oldText).toBeNull();
        expect(content?.newText?.split('\n')).toHaveLength(file.additions);
    });
});
