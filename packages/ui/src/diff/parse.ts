import type { FileChangeType } from '@sherpa/protocol';

import type {
    DiffBlock,
    DiffFileContent,
    DiffFileModel,
    DiffGap,
    DiffHunk,
    DiffLine,
    DiffParseRequest,
    LanguageId,
    ModeChange,
    SyntaxToken,
} from './model.js';
import { highlightable, highlightText, languageOf } from './syntax.js';
import { diffWords } from './word-diff.js';

/**
 * Парсер сырого unified diff хоста в модель рендера. Работает в воркере (docs/architecture.md §1).
 *
 * Fail-open: на кривом патче парсер не бросает исключений — непонятная строка едет в модель
 * как контекст с флагом `malformed`. UI лучше показать странный дифф, чем пустой экран.
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const OLD_MODE_RE = /^old mode (\d+)$/;
const NEW_MODE_RE = /^new mode (\d+)$/;
const BINARY_RE = /^(?:GIT )?[Bb]inary (?:files|patch)/;

export function parseFileDiff(file: DiffParseRequest): DiffFileModel {
    const language = languageOf(file.path);
    const patch = parsePatch(file.patch, language);
    const binary = file.binary || patch.binary;

    const additions = patch.hunks.reduce((sum, hunk) => sum + count(hunk, 'add'), 0);
    const deletions = patch.hunks.reduce((sum, hunk) => sum + count(hunk, 'del'), 0);
    const changed = additions + deletions;

    return {
        fileId: file.fileId,
        path: file.path,
        oldPath: file.oldPath,
        changeType: file.changeType,
        language,
        modeChange: patch.modeChange,
        additions,
        deletions,
        onlyAdditions: additions > 0 && deletions === 0,
        onlyDeletions: deletions > 0 && additions === 0,
        whitespaceOnly: changed > 0 && patch.hunks.every((hunk) => hunk.whitespaceOnly),
        malformed: patch.malformed,
        content: content(binary, patch.hunks, file.changeType),
    };
}

function content(binary: boolean, hunks: readonly DiffHunk[], changeType: FileChangeType): DiffFileContent {
    if (binary) {
        return { kind: 'binary' };
    }
    if (hunks.length === 0) {
        return { kind: 'none' };
    }
    // Добавленный и удалённый файл целиком лежат в патче — скрытых строк за ханками нет.
    const wholeFile = changeType === 'add' || changeType === 'delete';
    return { kind: 'text', blocks: withGaps(hunks, wholeFile) };
}

interface ParsedPatch {
    hunks: DiffHunk[];
    modeChange: ModeChange | null;
    binary: boolean;
    malformed: boolean;
}

function parsePatch(patch: string | null, language: LanguageId | null): ParsedPatch {
    const result: ParsedPatch = { hunks: [], modeChange: null, binary: false, malformed: false };
    if (patch === null) {
        return result;
    }

    const lines = patch.split('\n');
    // Патч кончается переводом строки — хвостовой пустой элемент split'а не часть диффа.
    if (lines.at(-1) === '') {
        lines.pop();
    }

    let oldMode: string | null = null;
    let newMode: string | null = null;
    let index = 0;

    while (index < lines.length) {
        const line = lines[index] ?? '';
        const header = HUNK_HEADER_RE.exec(line);
        if (header !== null) {
            const hunk = readHunk(lines, index, header, language);
            result.hunks.push(hunk.hunk);
            result.malformed ||= hunk.malformed;
            index = hunk.next;
            continue;
        }

        oldMode = OLD_MODE_RE.exec(line)?.[1] ?? oldMode;
        newMode = NEW_MODE_RE.exec(line)?.[1] ?? newMode;
        result.binary ||= BINARY_RE.test(line);
        index += 1;
    }

    if (oldMode !== null && newMode !== null && oldMode !== newMode) {
        result.modeChange = { from: oldMode, to: newMode };
    }
    return result;
}

interface ReadHunk {
    hunk: DiffHunk;
    malformed: boolean;
    /** Индекс первой строки за ханком. */
    next: number;
}

function readHunk(
    lines: readonly string[],
    start: number,
    header: RegExpExecArray,
    language: LanguageId | null,
): ReadHunk {
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);

    const body: DiffLine[] = [];
    let malformed = false;
    let oldLine = oldStart;
    let newLine = newStart;
    let restOld = oldCount;
    let restNew = newCount;
    let index = start + 1;

    while (index < lines.length && (restOld > 0 || restNew > 0)) {
        const raw = lines[index] ?? '';
        // Обрубленный ханк: следующий заголовок приходит раньше, чем кончились заявленные строки.
        if (HUNK_HEADER_RE.test(raw) || raw.startsWith('diff --git ')) {
            break;
        }
        index += 1;

        // Служебный маркер патча — только `\ ` (слэш с пробелом); текст после него git локализует.
        if (raw.startsWith('\\ ')) {
            const last = body.at(-1);
            if (last !== undefined) {
                last.noNewline = true;
            }
            continue;
        }

        const prefix = raw.slice(0, 1);
        const text = raw.slice(1);
        if (prefix === '+') {
            body.push({ kind: 'add', oldLine: null, newLine, text });
            newLine += 1;
            restNew -= 1;
        } else if (prefix === '-') {
            body.push({ kind: 'del', oldLine, newLine: null, text });
            oldLine += 1;
            restOld -= 1;
        } else if (prefix === ' ' || raw === '') {
            // Пустая строка без префикса — контекст: некоторые хосты режут хвостовой пробел.
            body.push({ kind: 'context', oldLine, newLine, text });
            oldLine += 1;
            newLine += 1;
            restOld -= 1;
            restNew -= 1;
        } else {
            // Строку не опознали: сохраняем как есть и идём дальше (падать нельзя).
            malformed = true;
            body.push({ kind: 'context', oldLine, newLine, text: raw, malformed: true });
            oldLine += 1;
            newLine += 1;
            restOld -= 1;
            restNew -= 1;
        }
    }

    // Маркер `\ No newline at end of file` идёт после последней строки ханка,
    // а в заявленные счётчики не входит — иначе цикл выше до него не доберётся.
    const lastLine = body.at(-1);
    if (lastLine !== undefined && lines[index]?.startsWith('\\ ') === true) {
        lastLine.noNewline = true;
        index += 1;
    }

    // Заголовок разошёлся с телом: ханк обрублен следующим заголовком или концом патча,
    // либо строк оказалось больше заявленного. В модель едут фактические счётчики —
    // иначе пропуски считались бы по вранью заголовка, а наружу это никак не сигналилось.
    const actualOldCount = oldLine - oldStart;
    const actualNewCount = newLine - newStart;
    if (actualOldCount !== oldCount || actualNewCount !== newCount) {
        malformed = true;
    }

    markWords(body);
    if (language !== null) {
        highlightHunk(body, language);
    }

    const hunk: DiffHunk = {
        kind: 'hunk',
        oldStart,
        oldCount: actualOldCount,
        newStart,
        newCount: actualNewCount,
        whitespaceOnly: isWhitespaceOnly(body),
        lines: body,
    };

    return { hunk, malformed, next: index };
}

/**
 * Подсветка ханка по сторонам, а не построчно: старая (`del` + контекст) и новая (`add` + контекст)
 * собираются в самостоятельные тексты и подсвечиваются целиком. Построчно нельзя — многострочный
 * комментарий или шаблонная строка тогда красятся только в первой строке; вперемешку нельзя —
 * смесь двух версий файла кодом не является. Ханк для hljs — обрезок, и это нормально:
 * его режимы устойчивы к тексту, начатому и оборванному посреди конструкции.
 *
 * Контекст берёт токены новой стороны: именно она — то, что ревьюер читает как текущий код.
 */
function highlightHunk(lines: readonly DiffLine[], language: LanguageId): void {
    const oldSide = lines.filter((line) => line.kind !== 'add');
    const newSide = lines.filter((line) => line.kind !== 'del');
    const oldTokens = sideTokens(oldSide, language);
    const newTokens = sideTokens(newSide, language);

    if (newTokens !== null) {
        for (const [index, line] of newSide.entries()) {
            setTokens(line, newTokens[index]);
        }
    }
    if (oldTokens !== null) {
        for (const [index, line] of oldSide.entries()) {
            if (line.kind === 'del' || newTokens === null) {
                setTokens(line, oldTokens[index]);
            }
        }
    }
}

/** Токены одной стороны ханка; null — сторона пуста или не прошла предохранитель по длине. */
function sideTokens(lines: readonly DiffLine[], language: LanguageId): SyntaxToken[][] | null {
    if (lines.length === 0) {
        return null;
    }
    const texts = lines.map((line) => line.text);
    if (!highlightable(texts)) {
        return null;
    }
    return highlightText(texts.join('\n'), language);
}

/** Пустой набор токенов в модель не едет: ключа `tokens` у строки просто нет. */
function setTokens(line: DiffLine, tokens: SyntaxToken[] | undefined): void {
    if (tokens !== undefined && tokens.length > 0) {
        line.tokens = tokens;
    }
}

/**
 * Пары для word-level подсветки: блок удалённых строк спаривается с идущим следом блоком
 * добавленных по индексу внутри блока — обычное для просмотрщиков диффа соглашение.
 */
function markWords(lines: DiffLine[]): void {
    let index = 0;
    while (index < lines.length) {
        const dels = run(lines, index, 'del');
        if (dels.length === 0) {
            index += 1;
            continue;
        }

        const adds = run(lines, index + dels.length, 'add');
        index += dels.length + adds.length;

        for (const [i, del] of dels.entries()) {
            const add = adds[i];
            if (add === undefined) {
                break;
            }
            const words = diffWords(del.text, add.text);
            if (words === null) {
                continue;
            }
            if (words.old.length > 0) {
                del.words = words.old;
            }
            if (words.new.length > 0) {
                add.words = words.new;
            }
        }
    }
}

/** Подряд идущие строки одного вида, начиная с `start`. */
function run(lines: readonly DiffLine[], start: number, kind: DiffLine['kind']): DiffLine[] {
    const found: DiffLine[] = [];
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i];
        if (line?.kind !== kind) {
            break;
        }
        found.push(line);
    }
    return found;
}

/**
 * Изменения ханка сводятся к пробелам: удалённые и добавленные строки совпадают
 * после выкидывания всех пробельных символов (сюда же попадает CRLF-only).
 */
function isWhitespaceOnly(lines: readonly DiffLine[]): boolean {
    const squeeze = (kind: DiffLine['kind']): string[] =>
        lines.filter((line) => line.kind === kind).map((line) => line.text.replace(/\s+/g, ''));

    const dels = squeeze('del');
    const adds = squeeze('add');
    if (dels.length === 0 || dels.length !== adds.length) {
        return false;
    }
    return dels.every((text, i) => text === adds[i]);
}

function count(hunk: DiffHunk, kind: DiffLine['kind']): number {
    return hunk.lines.filter((line) => line.kind === kind).length;
}

/**
 * Ханки, разбавленные пропусками: до первого, между соседними и после последнего.
 * `wholeFile` — весь файл уже в патче, хвостового пропуска быть не может.
 */
function withGaps(hunks: readonly DiffHunk[], wholeFile: boolean): DiffBlock[] {
    const blocks: DiffBlock[] = [];

    for (const [index, hunk] of hunks.entries()) {
        const previous = hunks[index - 1];
        const gap = previous === undefined ? leadingGap(hunk) : innerGap(previous, hunk);
        if (gap !== null) {
            blocks.push(gap);
        }
        blocks.push(hunk);
    }

    const last = hunks.at(-1);
    if (last !== undefined && !wholeFile && !endsFile(last)) {
        blocks.push({
            kind: 'gap',
            edge: 'trailing',
            hiddenLines: null,
            oldStart: last.oldStart + last.oldCount,
            newStart: last.newStart + last.newCount,
        });
    }
    return blocks;
}

function leadingGap(hunk: DiffHunk): DiffGap | null {
    const first = hunk.oldCount > 0 ? hunk.oldStart : hunk.newStart;
    const hidden = Math.max(first - 1, 0);
    return hidden === 0 ? null : { kind: 'gap', edge: 'leading', hiddenLines: hidden, oldStart: 1, newStart: 1 };
}

function innerGap(previous: DiffHunk, next: DiffHunk): DiffGap | null {
    const oldStart = previous.oldStart + previous.oldCount;
    const newStart = previous.newStart + previous.newCount;

    // Стороны считаются независимо: у ханка без старой стороны `oldStart` — 0, и её счёт врёт.
    const sides: number[] = [];
    if (previous.oldStart > 0 && next.oldStart > 0) {
        sides.push(next.oldStart - oldStart);
    }
    if (previous.newStart > 0 && next.newStart > 0) {
        sides.push(next.newStart - newStart);
    }

    const hidden = Math.max(0, ...sides);
    return hidden === 0 ? null : { kind: 'gap', edge: 'inner', hiddenLines: hidden, oldStart, newStart };
}

/**
 * `\ No newline at end of file` где угодно в ханке: одна из версий файла кончилась внутри
 * ханка, значит общего неизменённого хвоста за ним нет — и пропуска тоже.
 */
function endsFile(hunk: DiffHunk): boolean {
    return hunk.lines.some((line) => line.noNewline === true);
}
