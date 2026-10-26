import type { FileDiff } from '@sherpa/protocol';

import type { DiffFileModel, DiffLine } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';

export interface DiffSearchMatch {
    readonly fileId: string;
    readonly path: string;
    readonly side: 'old' | 'new';
    readonly line: number;
    readonly text: string;
    readonly matchStart: number;
    readonly matchEnd: number;
}

export interface DiffSearchResult {
    readonly matches: readonly DiffSearchMatch[];
    readonly truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Ищет по текущим моделям, а для ещё не разобранных файлов — по сырым unified-патчам. */
export function searchDiff(
    files: readonly FileDiff[],
    query: string,
    limit = 50,
    models: ReadonlyMap<string, DiffFileModel> = new Map(),
): DiffSearchResult {
    const needle = query.trim().toLowerCase();
    if (needle === '' || limit <= 0) {
        return { matches: [], truncated: false };
    }

    const matches: DiffSearchMatch[] = [];
    const add = (file: FileDiff, side: 'old' | 'new', line: number, text: string): boolean => {
        const matchStart = text.toLowerCase().indexOf(needle);
        if (matchStart < 0) {
            return true;
        }
        if (matches.length === limit) {
            return false;
        }
        matches.push({
            fileId: file.fileId,
            path: file.path,
            side,
            line,
            text,
            matchStart,
            matchEnd: matchStart + needle.length,
        });
        return true;
    };

    for (const file of files) {
        const model = models.get(file.fileId);
        const complete = model === undefined ? searchPatch(file, add) : searchModel(file, model, add);
        if (!complete) {
            return { matches, truncated: true };
        }
    }
    return { matches, truncated: false };
}

function searchModel(
    file: FileDiff,
    model: DiffFileModel,
    add: (file: FileDiff, side: 'old' | 'new', line: number, text: string) => boolean,
): boolean {
    if (model.content.kind !== 'text') {
        return true;
    }
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const target = searchTarget(line);
            if (target !== null && !add(file, target.side, target.line, line.text)) {
                return false;
            }
        }
    }
    return true;
}

function searchTarget(line: DiffLine): { readonly side: 'old' | 'new'; readonly line: number } | null {
    if (line.newLine !== null && line.kind !== 'del') {
        return { side: 'new', line: line.newLine };
    }
    return line.oldLine === null ? null : { side: 'old', line: line.oldLine };
}

function searchPatch(
    file: FileDiff,
    add: (file: FileDiff, side: 'old' | 'new', line: number, text: string) => boolean,
): boolean {
    if (file.patch === null) {
        return true;
    }
    let oldLine: number | null = null;
    let newLine: number | null = null;
    for (const raw of file.patch.split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header !== null) {
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            continue;
        }
        if (oldLine === null || newLine === null || raw.startsWith('\\ ')) {
            continue;
        }

        const marker = raw[0];
        let text: string;
        let target: { readonly side: 'old' | 'new'; readonly line: number };
        if (marker === '+') {
            text = raw.slice(1);
            target = { side: 'new', line: newLine };
            newLine += 1;
        } else if (marker === '-') {
            text = raw.slice(1);
            target = { side: 'old', line: oldLine };
            oldLine += 1;
        } else {
            text = marker === ' ' || raw === '' ? raw.slice(1) : raw;
            target = { side: 'new', line: newLine };
            oldLine += 1;
            newLine += 1;
        }
        if (!add(file, target.side, target.line, text)) {
            return false;
        }
    }
    return true;
}

/** Сторона, на которой номер реально существует; контекст предпочитает новую сторону. */
export function lineSideInDiff(file: FileDiff, line: number): 'old' | 'new' | null {
    const model = parseFileDiff(toParseRequest(file));
    if (model.content.kind !== 'text') {
        return null;
    }

    let oldExists = false;
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const candidate of block.lines) {
            if (candidate.newLine === line) {
                return 'new';
            }
            if (candidate.oldLine === line) {
                oldExists = true;
            }
        }
    }
    return oldExists ? 'old' : null;
}
