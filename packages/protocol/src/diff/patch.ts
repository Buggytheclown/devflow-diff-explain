/** Общая разметка unified patch. Оформление и политика допуска импорта живут у потребителей. */
export interface PatchCodeLine {
    readonly kind: 'add' | 'del' | 'context';
    readonly raw: string;
    readonly text: string;
    readonly old: number | null;
    readonly new: number | null;
    readonly malformed?: true;
    noNewline?: true;
}

export interface PatchMarker {
    readonly kind: 'marker';
    readonly raw: string;
    readonly old: null;
    readonly new: null;
}

export interface PatchHunk {
    readonly kind: 'hunk';
    readonly raw: string;
    readonly oldStart: number;
    readonly newStart: number;
    readonly declaredOldCount: number;
    readonly declaredNewCount: number;
    readonly oldCount: number;
    readonly newCount: number;
    readonly lines: readonly (PatchCodeLine | PatchMarker)[];
    readonly malformed: boolean;
}

export interface ParsedPatch {
    readonly parts: readonly ({ readonly kind: 'meta'; readonly raw: string } | PatchHunk)[];
    readonly malformed: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Повреждённые старые патчи остаются читаемыми: неизвестный префикс — контекст с диагностикой.
 * Это разбор фактических строк, а не доказательство соответствия патча полным оригиналам.
 */
export function parseUnifiedPatch(patch: string): ParsedPatch {
    const lines = patch === '' ? [] : patch.split('\n');
    // Последний разделитель — не дополнительная пустая строка тела даже у усечённого ханка.
    if (lines.at(-1) === '') lines.pop();
    const parts: ParsedPatch['parts'][number][] = [];
    let malformed = false;
    let index = 0;
    while (index < lines.length) {
        const raw = lines[index] ?? '';
        const header = HUNK_HEADER.exec(raw);
        index += 1;
        if (header === null) {
            parts.push({ kind: 'meta', raw });
            continue;
        }
        const oldStart = Number(header[1]);
        const newStart = Number(header[3]);
        const declaredOldCount = header[2] === undefined ? 1 : Number(header[2]);
        const declaredNewCount = header[4] === undefined ? 1 : Number(header[4]);
        let old = oldStart;
        let next = newStart;
        let restOld = declaredOldCount;
        let restNew = declaredNewCount;
        let hunkMalformed = false;
        const body: (PatchCodeLine | PatchMarker)[] = [];
        let previous: PatchCodeLine | undefined;
        while (index < lines.length) {
            const line = lines[index] ?? '';
            // EOF-маркер относится к предыдущей строке, в том числе после исчерпания counts.
            if (line.startsWith('\\ ')) {
                if (previous !== undefined) previous.noNewline = true;
                body.push({ kind: 'marker', raw: line, old: null, new: null });
                index += 1;
                continue;
            }
            if ((restOld <= 0 && restNew <= 0) || HUNK_HEADER.test(line) || line.startsWith('diff --git ')) break;
            index += 1;
            const prefix = line.slice(0, 1);
            const unknown = prefix !== '+' && prefix !== '-' && prefix !== ' ' && line !== '';
            const kind = prefix === '+' ? 'add' : prefix === '-' ? 'del' : 'context';
            previous = {
                kind, raw: line, text: unknown ? line : line.slice(1),
                old: kind === 'add' ? null : old, new: kind === 'del' ? null : next,
                ...(unknown ? { malformed: true as const } : {}),
            };
            body.push(previous);
            if (kind !== 'add') { old += 1; restOld -= 1; }
            if (kind !== 'del') { next += 1; restNew -= 1; }
            hunkMalformed ||= unknown;
        }
        const oldCount = old - oldStart;
        const newCount = next - newStart;
        hunkMalformed ||= oldCount !== declaredOldCount || newCount !== declaredNewCount;
        parts.push({ kind: 'hunk', raw, oldStart, newStart, declaredOldCount, declaredNewCount,
            oldCount, newCount, lines: body, malformed: hunkMalformed });
        malformed ||= hunkMalformed;
    }
    return { parts, malformed };
}
