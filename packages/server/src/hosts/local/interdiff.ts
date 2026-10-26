import type { FileChangeType, FileDiff, PrDiff } from '@sherpa/protocol';
import { structuredPatch } from 'diff';

import { countPatchStats } from '../arcanum/patch.js';

import type { LocalIterationFile, LocalIterationRecord, LocalIterationsStore } from './iterations-store.js';

/**
 * Срез между двумя итерациями рабочего дерева: что изменилось от `base` к `head`. Старая сторона
 * патчей — голова итерации `base`, новая — голова `head`, ровно этого ждёт `line-map.ts`.
 *
 * Считается по истории итераций: состав файлов лежит в индексе, содержимое новых сторон — в
 * блобах. Патч строит jsdiff, заголовки дописываются под формат git — тот самый, который режет
 * `splitPatchByFile` и разбирает парсер UI.
 */

/** Сколько строк контекста вокруг изменения: столько же печатает `arc diff` по умолчанию. */
const CONTEXT_LINES = 3;

/** Режим файла в заголовках add/delete: правами локальный адаптер не занимается. */
const FILE_MODE = '100644';

export async function localInterdiff(
    store: Pick<LocalIterationsStore, 'blob'>,
    base: LocalIterationRecord,
    head: LocalIterationRecord,
): Promise<PrDiff> {
    const meta = { diffId: head.diffId, baseCommit: base.headCommit, headCommit: head.headCommit };
    if (base.diffId === head.diffId) {
        return { ...meta, files: [] };
    }

    const byPath = (record: LocalIterationRecord): Map<string, LocalIterationFile> =>
        new Map(record.files.map((file) => [file.path, file]));
    const left = byPath(base);
    const right = byPath(head);
    const paths = [...new Set([...left.keys(), ...right.keys()])].sort((one, other) => one.localeCompare(other));

    const files: FileDiff[] = [];
    for (const path of paths) {
        const file = await sliceFile(store, base, head, path, present(left.get(path)), present(right.get(path)));
        if (file !== null) {
            files.push(file);
        }
    }
    return { ...meta, files };
}

/**
 * Файл на одной стороне среза; null — на этой стороне его нет. Файл, удалённый в рабочем дереве,
 * своей итерацией и представлен как отсутствующий: `changeType: 'delete'` — это про дерево.
 */
function present(file: LocalIterationFile | undefined): LocalIterationFile | null {
    return file === undefined || file.changeType === 'delete' ? null : file;
}

async function sliceFile(
    store: Pick<LocalIterationsStore, 'blob'>,
    base: LocalIterationRecord,
    head: LocalIterationRecord,
    path: string,
    left: LocalIterationFile | null,
    right: LocalIterationFile | null,
): Promise<FileDiff | null> {
    if (left === null && right === null) {
        return null;
    }
    if (left !== null && right !== null && left.hash === right.hash) {
        return null;
    }

    const changeType: FileChangeType = left === null ? 'add' : right === null ? 'delete' : 'modify';
    const oldText = await sideText(store, left);
    const newText = await sideText(store, right);
    // Текста хотя бы одной стороны нет (двоичный, за лимитом, блоб не дожил) — показывать нечего.
    const patch =
        oldText === null || newText === null ? null : unifiedPatch(path, oldText, newText, changeType);
    const stats = patch === null ? { additions: 0, deletions: 0 } : countPatchStats(patch);

    return {
        fileId: sliceFileId(base.diffId, head.diffId, path),
        path,
        oldPath: null,
        changeType,
        binary: patch === null,
        // Правила ревью a.yaml локально не воспроизводим — как и у самой итерации.
        generated: false,
        additions: stats.additions,
        deletions: stats.deletions,
        patch,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        // Картинки в срезе не показываются: срез читают перенос и баннеры, а не глаз ревьюера.
        image: null,
    };
}

/** Текст стороны; null — сторона есть, но текстом не представима, `''` — стороны нет вовсе. */
async function sideText(
    store: Pick<LocalIterationsStore, 'blob'>,
    file: LocalIterationFile | null,
): Promise<string | null> {
    if (file === null) {
        return '';
    }
    if (file.kind !== 'text' || file.blob === null) {
        return null;
    }
    return store.blob(file.blob);
}

/**
 * Непрозрачный id файла среза. С `fileId` итераций он не совпадает намеренно: это другой дифф,
 * и якорить на него отметки или комментарии нельзя.
 */
export function sliceFileId(baseDiffId: string, headDiffId: string, path: string): string {
    return `slice:${baseDiffId.slice(0, 12)}:${headDiffId.slice(0, 12)}:${path}`;
}

/** Unified diff одного файла в формате git: заголовок, стороны и ханки `@@ -a,b +c,d @@`. */
function unifiedPatch(path: string, oldText: string, newText: string, changeType: FileChangeType): string {
    const header = [`diff --git a/${path} b/${path}`];
    if (changeType === 'add') {
        header.push(`new file mode ${FILE_MODE}`, '--- /dev/null', `+++ b/${path}`);
    } else if (changeType === 'delete') {
        header.push(`deleted file mode ${FILE_MODE}`, `--- a/${path}`, '+++ /dev/null');
    } else {
        header.push(`--- a/${path}`, `+++ b/${path}`);
    }

    const { hunks } = structuredPatch(path, path, oldText, newText, undefined, undefined, {
        context: CONTEXT_LINES,
    });
    return [...header, ...hunks.flatMap(renderHunk), ''].join('\n');
}

interface StructuredHunk {
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly lines: readonly string[];
}

/** Ханк строками патча. Пустая сторона начинается с нуля — так её пишет git, а не jsdiff. */
function renderHunk(hunk: StructuredHunk): string[] {
    const oldStart = hunk.oldLines === 0 ? 0 : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? 0 : hunk.newStart;
    const head =
        `@@ -${String(oldStart)},${String(hunk.oldLines)} ` +
        `+${String(newStart)},${String(hunk.newLines)} @@`;
    return [head, ...hunk.lines];
}
