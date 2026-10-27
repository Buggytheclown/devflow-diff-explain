import type { FileChangeType, FileDiff } from '@sherpa/protocol';

/**
 * Модель диффа одного файла для рендера: файл → блоки (ханки и пропуски) → строки.
 *
 * Модель уезжает из воркера через structured clone (docs/architecture.md), поэтому здесь только plain-данные:
 * ни функций, ни классов, ни `Map`. Валидации нет намеренно — патч уже прошёл `fileDiffSchema`
 * на границе сервера, а воркер собирается тем же бандлом.
 */

/** Полуинтервал `[from, to)` по индексам символов строки. */
export interface CharRange {
    from: number;
    to: number;
}

/**
 * Категории подсветки отделяют ключи конфигов, числа и имена от строковых значений.
 * Всё, в чём лексер не уверен, категории не получает вовсе — крашеного мусора быть не должно.
 */
export type SyntaxKind =
    | 'keyword'
    | 'property'
    | 'number'
    | 'variable'
    | 'type'
    | 'function'
    | 'string'
    | 'comment'
    | 'decorator';

export interface SyntaxToken extends CharRange {
    kind: SyntaxKind;
}

export type DiffLineKind = 'context' | 'add' | 'del';

/** Строка диффа без префикса патча. Номера строк nullable по типу строки: у add нет старого, у del — нового. */
export interface DiffLine {
    kind: DiffLineKind;
    oldLine: number | null;
    newLine: number | null;
    text: string;
    /** Изменённые куски внутри пары del/add (docs/spec.md); ключа нет — подсвечивать нечего. */
    words?: CharRange[];
    tokens?: SyntaxToken[];
    /** Строку патча парсер не понял и сохранил как есть (fail-open: UI не падает на кривом диффе). */
    malformed?: true;
    /** В патче за строкой шло `\ No newline at end of file`. */
    noNewline?: true;
    /** Исходный пропуск, из которого строка была раскрыта; нужен пост-обработкам для сохранения результата. */
    sourceGapKey?: string;
}

export interface DiffHunk {
    kind: 'hunk';
    oldStart: number;
    /** Строк старой стороны в `lines`: на кривом патче это факт тела, а не враньё заголовка (см. `malformed`). */
    oldCount: number;
    newStart: number;
    newCount: number;
    /**
     * Изменения ханка сводятся к пробелам и переводам строк
     * (docs/spec.md — однострочный нотис).
     */
    whitespaceOnly: boolean;
    lines: DiffLine[];
}

/** Пропуск неизменённых строк: между ханками или по краям файла. */
export interface DiffGap {
    kind: 'gap';
    edge: 'leading' | 'inner' | 'trailing';
    /**
     * Сколько строк скрыто; null — конец файла: его длину из патча не узнать,
     * а выдумывать число нельзя.
     */
    hiddenLines: number | null;
    /**
     * Сколько изменённых строк скрыто вместе с неизменёнными. Парсер такого не делает — поле
     * заполняет обрезка по якорям остановки: там пропуск может унести чужие изменения,
     * и называть их «неизменёнными» было бы враньём.
     */
    hiddenChanged?: number;
    /** Стабильный ключ исходного пропуска; появляется после первого частичного раскрытия. */
    sourceKey?: string;
    /** Первая скрытая строка в каждой из версий — якорь для дозагрузки контекста. */
    oldStart: number;
    newStart: number;
}

export type DiffBlock = DiffHunk | DiffGap;

export type DiffFileContent =
    | { kind: 'text'; blocks: DiffBlock[] }
    /** Однострочный нотис нетекстового файла. */
    | { kind: 'binary' }
    /** Текстового диффа нет: пустой патч, rename/copy без правок, одна лишь смена режима. */
    | { kind: 'none' };

    /**
 * Имя языка в реестре highlight.js (`diff/languages.ts`): `typescript`, `python`, `bash`.
 * Строка, а не union: реестр знает полсотни языков, перечислять их в типе незачем.
 */
export type LanguageId = string;

export interface ModeChange {
    from: string;
    to: string;
}

export interface DiffFileModel {
    fileId: string;
    path: string;
    oldPath: string | null;
    changeType: FileChangeType;
    /** null — языка для этого файла в реестре подсветки нет. */
    language: LanguageId | null;
/**
     * Смена прав из заголовка патча (docs/spec.md — однострочный нотис);
     * null — прав не меняли.
     */
    modeChange: ModeChange | null;
    /** Счётчики самого патча: с `FileDiff.additions`/`deletions` они обязаны сходиться. */
    additions: number;
    deletions: number;
    onlyAdditions: boolean;
    onlyDeletions: boolean;
    /** Весь текстовый дифф файла сводится к пробелам (в т. ч. CRLF-only). */
    whitespaceOnly: boolean;
    /** В патче встретились строки, которых парсер не понял. */
    malformed: boolean;
    content: DiffFileContent;
}

/** Вход парсера: то, что нужно из `FileDiff`, — остальное в воркер не едет. */
export interface DiffParseRequest {
    fileId: string;
    path: string;
    oldPath: string | null;
    changeType: FileChangeType;
    binary: boolean;
    patch: string | null;
}

export function toParseRequest(file: FileDiff): DiffParseRequest {
    return {
        fileId: file.fileId,
        path: file.path,
        oldPath: file.oldPath,
        changeType: file.changeType,
        binary: file.binary,
        patch: file.patch,
    };
}
