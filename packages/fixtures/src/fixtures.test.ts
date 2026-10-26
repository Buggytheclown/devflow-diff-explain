import type { Comment, FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildFixture,
    FIXTURE_NAMES,
    fixtureData,
    fixtureIteration,
    HUGE_CHANGED_LINE_COUNT,
    HUGE_COLLAPSED_FILE_LINES,
    HUGE_COLLAPSED_FILE_PATH,
    HUGE_FILE_COUNT,
    HUGE_PARSED_FILE_COUNT,
    HUGE_PARSED_LINE_COUNT,
    LARGE_FILE_COUNT,
    LONG_LINE_MARKER,
    MEDIUM_TOTALS,
} from './data/index.js';
import { totalChanges } from './patch.js';

const HUNK_HEADER = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@(?: .*)?$/;

interface HunkCounts {
    additions: number;
    deletions: number;
}

/**
 * Минимальный разбор unified diff: заголовки ханков, сходимость счётчиков и когерентность номеров
 * строк между ханками одного файла (смещение `newStart − oldStart` обязано равняться накопленной
 * дельте предыдущих ханков, ханки не перекрываются и идут по возрастанию — иначе `git apply` такой
 * патч отвергнет, а «expand context» и миникарта в UI поедут). Полноценный парсер живёт в UI;
 * здесь важно, что фикстуры вообще парсибельны и не врут в `+N/−M`.
 */
function parsePatch(patch: string): HunkCounts {
    const lines = patch.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }

    let seenHunk = false;
    let additions = 0;
    let deletions = 0;
    let expectedOld = 0;
    let expectedNew = 0;
    let actualOld = 0;
    let actualNew = 0;
    // Накопленная дельта строк по уже пройденным ханкам и их правые границы.
    let delta = 0;
    let prevOldEnd = 0;
    let prevNewEnd = 0;

    for (const line of lines) {
        const header = HUNK_HEADER.exec(line);
        if (header !== null) {
            const oldStart = Number(header[1]);
            const newStart = Number(header[3]);
            if (seenHunk) {
                expect(actualOld).toBe(expectedOld);
                expect(actualNew).toBe(expectedNew);
                delta += expectedNew - expectedOld;
                expect({ header: line, newStart }).toEqual({ header: line, newStart: oldStart + delta });
                expect(oldStart).toBeGreaterThan(prevOldEnd);
                expect(newStart).toBeGreaterThan(prevNewEnd);
            }
            seenHunk = true;
            expectedOld = Number(header[2]);
            expectedNew = Number(header[4]);
            prevOldEnd = oldStart + expectedOld - 1;
            prevNewEnd = newStart + expectedNew - 1;
            actualOld = 0;
            actualNew = 0;
            continue;
        }

        if (!seenHunk) {
            // Шапка файла: `diff --git`, режимы, `index`, `---`/`+++`.
            expect(line).toMatch(
                /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |rename |copy |similarity index )/,
            );
            continue;
        }

        const prefix = line.slice(0, 1);
        if (prefix === '+') {
            additions += 1;
            actualNew += 1;
        } else if (prefix === '-') {
            deletions += 1;
            actualOld += 1;
        } else if (prefix === ' ') {
            actualOld += 1;
            actualNew += 1;
        } else {
            throw new Error(`строка вне ханка и без префикса: ${JSON.stringify(line)}`);
        }
    }

    if (seenHunk) {
        expect(actualOld).toBe(expectedOld);
        expect(actualNew).toBe(expectedNew);
    } else {
        // Патч без ханков законен ровно в одном случае — смена режима файла.
        expect(lines.some((line) => line.startsWith('new mode '))).toBe(true);
    }

    return { additions, deletions };
}

/**
 * Строки, которые патч вообще показывает: `side:line` по обеим сторонам, включая контекст.
 * Якорь треда за пределами этого множества UI не теряет, а приклеивает к ближайшей видимой
 * строке — состояние фикстуры оказалось бы не на своём месте, и молча.
 */
function patchLines(patch: string): Set<string> {
    const shown = new Set<string>();
    let oldNo = 0;
    let newNo = 0;
    for (const line of patch.split('\n')) {
        const header = HUNK_HEADER.exec(line);
        if (header !== null) {
            oldNo = Number(header[1]);
            newNo = Number(header[3]);
            continue;
        }
        if (oldNo === 0 && newNo === 0) {
            continue;
        }
        const prefix = line.slice(0, 1);
        if (prefix === '+') {
            shown.add(`new:${String(newNo)}`);
            newNo += 1;
        } else if (prefix === '-') {
            shown.add(`old:${String(oldNo)}`);
            oldNo += 1;
        } else if (prefix === ' ') {
            shown.add(`old:${String(oldNo)}`);
            shown.add(`new:${String(newNo)}`);
            oldNo += 1;
            newNo += 1;
        }
    }
    return shown;
}

function depthOf(comment: Comment): number {
    return comment.replies.reduce((max, reply) => Math.max(max, depthOf(reply) + 1), 1);
}

function hasBranching(comment: Comment): boolean {
    return comment.replies.length > 1 || comment.replies.some(hasBranching);
}

function countDrafts(comment: Comment): number {
    return comment.replies.reduce((total, reply) => total + countDrafts(reply), comment.draft ? 1 : 0);
}

function fileByPath(files: readonly FileDiff[], path: string): FileDiff {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`в фикстуре нет файла ${path}`);
    }
    return file;
}

describe('фикстуры: общие инварианты', () => {
    for (const name of FIXTURE_NAMES) {
        describe(name, () => {
            it('детерминирована: повторная сборка даёт те же данные', () => {
                // Именно две сборки с нуля: сравнение двух обращений к кэшу `fixtureData` прошло бы
                // и с `Date.now()` внутри билдера.
                expect(JSON.stringify(buildFixture(name))).toBe(JSON.stringify(buildFixture(name)));
                // Сравнение не должно быть пустым: итерации входят в него наравне с остальным.
                expect(buildFixture(name).iterations.length).toBeGreaterThan(0);
            });

            it('все патчи всех итераций и срезов — валидный unified diff, счётчики сходятся', () => {
                const data = fixtureData(name);
                const diffs = [
                    ...data.iterations.map((iteration) => iteration.diff),
                    ...data.interdiffs.map((interdiff) => interdiff.diff),
                ];
                for (const diff of diffs) {
                    for (const file of diff.files) {
                        if (file.patch === null) {
                            expect(file.binary || file.additions + file.deletions === 0).toBe(true);
                            continue;
                        }
                        const counts = parsePatch(file.patch);
                        expect(counts).toEqual({ additions: file.additions, deletions: file.deletions });
                    }
                }
            });

            it('якоря тредов указывают на файлы и строки этого диффа', () => {
                const data = fixtureIteration(name);
                const byId = new Map(data.diff.files.map((file) => [file.fileId, file] as const));
                for (const thread of data.threads) {
                    if (thread.anchor === null) {
                        continue;
                    }
                    const file = byId.get(thread.anchor.fileId);
                    expect(file?.path).toBe(thread.anchor.path);
                    const position = thread.anchor.position;
                    if (position === null || file?.patch === undefined || file.patch === null) {
                        continue;
                    }
                    const line = `${position.side}:${String(position.line)}`;
                    expect(patchLines(file.patch).has(line), `тред ${thread.id}: ${file.path} ${line}`).toBe(
                        true,
                    );
                }
            });

            it('каждый файл ownership встречается максимум в одной зоне', () => {
                const seen = new Set<string>();
                for (const zone of fixtureIteration(name).ownership?.zones ?? []) {
                    for (const path of zone.paths) {
                        expect(seen.has(path), `${path} продублирован в зонах`).toBe(false);
                        seen.add(path);
                    }
                }
            });

            it('в исходных данных нет черновиков', () => {
                const drafts = fixtureIteration(name).threads.reduce(
                    (total, thread) => total + countDrafts(thread.root),
                    0,
                );
                expect(drafts).toBe(0);
            });
        });
    }
});

describe('фикстура medium', () => {
    const data = fixtureIteration('medium');

    it('совпадает с шапкой дизайн-хендоффа плюс картинки: 21 файл, +812 −56', () => {
        expect(data.diff.files.length).toBe(MEDIUM_TOTALS.files);
        expect(totalChanges(data.diff.files)).toEqual({
            additions: MEDIUM_TOTALS.additions,
            deletions: MEDIUM_TOTALS.deletions,
        });
    });

    it('ownership даёт 12 из 21 файла и 570 из 868 строк, машинные файлы остаются вне зон', () => {
        const mine = new Set(data.ownership?.paths ?? []);
        const mineLines = data.diff.files.reduce(
            (total, file) => total + (mine.has(file.path) ? file.additions + file.deletions : 0),
            0,
        );
        const zoned = new Set(data.ownership?.zones?.flatMap((zone) => zone.paths) ?? []);

        expect(mine.size).toBe(12);
        expect(mineLines).toBe(570);
        expect(totalChanges(data.diff.files)).toEqual({ additions: 812, deletions: 56 });
        expect(data.diff.files.filter((file) => file.generated).every((file) => !zoned.has(file.path))).toBe(true);
    });

    it('несёт глубокий ветвящийся тред', () => {
        const deepest = data.threads.reduce((max, thread) => Math.max(max, depthOf(thread.root)), 0);
        expect(deepest).toBeGreaterThan(6);
        expect(data.threads.some((thread) => hasBranching(thread.root))).toBe(true);
    });

    it('несёт треды всех сортов: людские, бот-, resolved, outdated, уровня PR', () => {
        expect(data.threads.filter((thread) => !thread.root.author.bot).length).toBeGreaterThanOrEqual(4);
        const bots = data.threads.filter((thread) => thread.root.author.bot);
        expect(bots.length).toBe(2);
        for (const thread of bots) {
            expect(thread.root.author.displayName).toMatch(/^AI Review \(/);
        }
        expect(data.threads.filter((thread) => thread.resolved).length).toBe(1);
        expect(data.threads.filter((thread) => thread.outdated).length).toBe(1);
        expect(data.threads.filter((thread) => thread.anchor === null).length).toBe(1);
    });

    it('id комментариев: у инлайновых положительный, у уровня PR — отрицательный', () => {
        for (const thread of data.threads) {
            const inline = thread.anchor !== null;
            expect(Number(thread.root.id) > 0).toBe(inline);
        }
    });

    it('несёт generated-файлы, и PCI-линза с ними пересекается', () => {
        const generated = data.diff.files.filter((file) => file.generated).map((file) => file.path);
        expect(generated.length).toBeGreaterThanOrEqual(2);

        const pci = data.extraLenses.find((lens) => lens.id === 'pci');
        expect(pci?.paths.length).toBeGreaterThanOrEqual(2);
        expect(pci?.paths.some((path) => generated.includes(path))).toBe(true);
    });

    it('линза ownership покрывает часть файлов, но не все', () => {
        const paths = data.ownership?.paths ?? [];
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.length).toBeLessThan(data.diff.files.length);
        for (const path of paths) {
            expect(data.diff.files.some((file) => file.path === path)).toBe(true);
        }
    });
});

describe('фикстура small', () => {
    const data = fixtureIteration('small');

    it('ниже порога маршрута', () => {
        const totals = totalChanges(data.diff.files);
        expect(totals.additions + totals.deletions).toBeLessThanOrEqual(40);
    });

    it('хост без синхронизации viewed отдаёт viewed: null', () => {
        expect(data.pr.capabilities.fileViewedSync).toBe(false);
        for (const file of data.diff.files) {
            expect(file.viewed).toBeNull();
        }
    });
});

describe('фикстура empty', () => {
    const data = fixtureIteration('empty');

    it('пустой PR: итерация есть, изменений нет', () => {
        expect(data.diff.files).toEqual([]);
        // База и голова совпадают: относительно базы менять нечего.
        expect(data.diff.headCommit).toBe(data.diff.baseCommit);
        expect(data.threads).toEqual([]);
        expect(data.ownership?.paths).toEqual([]);
    });

    it('шип не заблокирован хостом: sticky и синхронизация viewed на месте', () => {
        expect(data.pr.capabilities.publishVerdicts).toContain('sticky_ship');
        expect(data.pr.state).toBe('open');
    });
});

describe('фикстура large', () => {
    const data = fixtureIteration('large');

    it('годится для виртуализации: 60+ файлов и тысячи строк', () => {
        expect(data.diff.files.length).toBe(LARGE_FILE_COUNT);
        expect(data.diff.files.length).toBeGreaterThanOrEqual(60);
        const totals = totalChanges(data.diff.files);
        expect(totals.additions + totals.deletions).toBeGreaterThan(2000);
    });
});

/**
 * Гвардия перф-фикстуры: цифры, на которых стоит перф-прогон (`e2e/src/performance.spec.ts`).
 * Уехали они — уехал и смысл замеров, поэтому проверяются здесь, а не в комментарии.
 */
describe('фикстура huge', () => {
    const data = fixtureIteration('huge');
    const files = data.diff.files;

    it('100 файлов и больше 20 000 изменённых строк', () => {
        expect(files.length).toBe(HUGE_FILE_COUNT);
        expect(files.length).toBeGreaterThanOrEqual(100);
        const totals = totalChanges(files);
        expect(totals.additions + totals.deletions).toBe(HUGE_CHANGED_LINE_COUNT);
        expect(totals.additions + totals.deletions).toBeGreaterThanOrEqual(20_000);
    });

    it('до воркера доходит меряемая часть: файлы без свёртки по причине', () => {
        // Свёрнутая по viewed/generated карточка разбор не заказывает — в замер она не входит.
        const parsed = files.filter((file) => file.viewed !== true && !file.generated);
        const totals = totalChanges(parsed);
        expect(parsed.length).toBe(HUGE_PARSED_FILE_COUNT);
        expect(totals.additions + totals.deletions).toBe(HUGE_PARSED_LINE_COUNT);
    });

    it('ровно один файл выше порога свёртки', () => {
        const big = files.filter((file) => file.additions + file.deletions > 2000);
        expect(big.map((file) => file.path)).toEqual([HUGE_COLLAPSED_FILE_PATH]);
        expect(big[0]?.additions).toBe(HUGE_COLLAPSED_FILE_LINES);
        expect(big[0]?.generated).toBe(false);
    });

    it('форма реалистична: 2–6 ханков у правок, смесь типов, машинные файлы, длинные строки', () => {
        const hunksOf = (file: FileDiff): number =>
            (file.patch ?? '').split('\n').filter((line) => line.startsWith('@@')).length;
        const modified = files.filter((file) => file.changeType === 'modify');
        expect(modified.length).toBeGreaterThanOrEqual(60);
        for (const file of modified) {
            expect(hunksOf(file), file.path).toBeGreaterThanOrEqual(2);
            expect(hunksOf(file), file.path).toBeLessThanOrEqual(6);
        }

        expect(files.filter((file) => file.changeType === 'add').length).toBeGreaterThanOrEqual(5);
        expect(files.filter((file) => file.changeType === 'delete').length).toBeGreaterThanOrEqual(3);
        expect(files.filter((file) => file.generated).length).toBe(10);
        expect(files.filter((file) => (file.patch ?? '').includes(LONG_LINE_MARKER)).length).toBeGreaterThanOrEqual(3);
        expect(data.threads.length).toBeGreaterThanOrEqual(5);
    });
});

describe('фикстура edge', () => {
    const data = fixtureIteration('edge');
    const files = data.diff.files;

    it('переименование несёт прежний путь', () => {
        const moved = fileByPath(files, 'services/orders/src/infra/time/clock.ts');
        expect(moved.changeType).toBe('move');
        expect(moved.oldPath).toBe('services/orders/src/infra/clock.ts');
        expect(moved.patch).toContain('rename from services/orders/src/infra/clock.ts');
    });

    it('удаление — только минусы', () => {
        const deleted = fileByPath(files, 'services/orders/src/legacy/edit-window-v1.ts');
        expect(deleted.changeType).toBe('delete');
        expect(deleted.additions).toBe(0);
        expect(deleted.deletions).toBeGreaterThan(0);
    });

    it('binary приходит без патча', () => {
        const binary = fileByPath(files, 'services/orders/assets/edit-window-flow.png');
        expect(binary.binary).toBe(true);
        expect(binary.patch).toBeNull();
    });

    it('пустой файл — без патча и без изменённых строк', () => {
        const empty = fileByPath(files, 'services/orders/src/infra/time/index.ts');
        expect(empty.patch).toBeNull();
        expect(empty.additions + empty.deletions).toBe(0);
    });

    it('whitespace-only дифф меняет только пробелы', () => {
        const file = fileByPath(files, 'services/orders/src/api/schemas.ts');
        const patch = file.patch ?? '';
        const added = patch
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
            .map((line) => line.slice(1).trim());
        const removed = patch
            .split('\n')
            .filter((line) => line.startsWith('-') && !line.startsWith('---'))
            .map((line) => line.slice(1).trim());
        expect(added).toEqual(removed);
    });

    it('односторонний файл — только плюсы', () => {
        const oneSided = fileByPath(files, 'services/orders/docs/rollout.md');
        expect(oneSided.deletions).toBe(0);
        expect(oneSided.additions).toBeGreaterThan(0);
    });

    it('смена режима — шапка old/new mode без ханков и без изменённых строк', () => {
        const script = fileByPath(files, 'services/orders/scripts/rollout.sh');
        const patch = script.patch ?? '';
        expect(patch).toContain('old mode 100644');
        expect(patch).toContain('new mode 100755');
        expect(patch).not.toContain('@@');
        expect(script.additions + script.deletions).toBe(0);
    });

    it('конфликтный файл размечен своим типом изменения', () => {
        expect(fileByPath(files, 'services/orders/src/domain/order.ts').changeType).toBe('conflict');
    });
});
