/**
 * Разрезка патча по файлам. `arc diff --git` печатает дифф всех запрошенных путей одним текстом,
 * а `FileDiff.patch` в контракте — пер-файловый: адаптер режет текст по заголовкам `diff --git`
 * и сопоставляет куски с элементами changelist по пути.
 *
 * Живой `arc` пути в заголовке **не экранирует** — `diff --git a/a b.md b/a b.md` с пробелом внутри
 * пути разобрать в общем виде нельзя. Поэтому заголовок сначала сверяется со списком путей, которые
 * у адаптера и так есть (changelist), и только потом разбирается по пробелам и кавычкам git.
 */

const FILE_HEADER = 'diff --git ';
const HUNK_HEADER = '@@ ';

export interface PatchStats {
    readonly additions: number;
    readonly deletions: number;
}

/**
 * Патчи файлов по путям. Кусок кладётся под обоими путями заголовка (`a/` и `b/`): у rename/copy
 * changelist знает новый путь, у delete — старый, а угадывать, какой из них спросят, незачем.
 *
 * Правая сторона (`b/`) — путь результата и всегда побеждает; левая занимает ключ, только пока он
 * свободен. Иначе кусок `a/X b/Y` (копия) затёр бы патч самого X, если тот тоже менялся.
 */
export function splitPatchByFile(patch: string, knownPaths: readonly string[] = []): Map<string, string> {
    const chunks = new Map<string, string>();
    // Множество строится один раз на патч: сверка заголовка со списком путей идёт на каждой
    // из двух сторон каждого заголовка, а патч большого PR — это тысячи заголовков.
    const known = new Set(knownPaths);
    let current: string[] | null = null;
    let header: HeaderPaths = { left: null, right: null };

    const flush = (): void => {
        if (current === null) {
            return;
        }
        // Хвостовые пустые строки — след разрезки текста, а не часть патча файла.
        while (current.at(-1) === '') {
            current.pop();
        }
        const text = `${current.join('\n')}\n`;
        if (header.left !== null && !chunks.has(header.left)) {
            chunks.set(header.left, text);
        }
        if (header.right !== null) {
            chunks.set(header.right, text);
        }
        current = null;
        header = { left: null, right: null };
    };

    for (const line of patch.split('\n')) {
        if (line.startsWith(FILE_HEADER)) {
            flush();
            current = [line];
            header = headerPaths(line, known);
            continue;
        }
        current?.push(line);
    }
    flush();

    return chunks;
}

/**
 * Числа строк патча. Считаются только строки внутри ханков: заголовки `---`/`+++` и содержимое
 * вида `+++ foo` иначе не различить. Пер-файловых `patch_stats` у changelist нет — проверено живьём.
 */
export function countPatchStats(patch: string): PatchStats {
    let additions = 0;
    let deletions = 0;
    let inHunk = false;

    for (const line of patch.split('\n')) {
        if (line.startsWith(HUNK_HEADER)) {
            inHunk = true;
            continue;
        }
        if (!inHunk) {
            continue;
        }

        const prefix = line.slice(0, 1);
        if (prefix === '+') {
            additions += 1;
        } else if (prefix === '-') {
            deletions += 1;
        } else if (prefix !== ' ' && prefix !== '\\' && line !== '') {
            // Строка не из тела ханка — дальше снова служебная часть патча.
            inHunk = false;
        }
    }

    return { additions, deletions };
}

/** Стороны заголовка `diff --git "a/old" "b/new"` без префиксов; `/dev/null` — не путь. */
interface HeaderPaths {
    readonly left: string | null;
    readonly right: string | null;
}

function headerPaths(line: string, knownPaths: ReadonlySet<string>): HeaderPaths {
    const rest = line.slice(FILE_HEADER.length);
    const known = knownHeaderPaths(rest, knownPaths);
    if (known !== null) {
        return known;
    }

    const first = readPath(rest, 0);
    if (first === null) {
        return { left: null, right: null };
    }
    const second = readPath(rest, first.next);

    return { left: stripSidePrefix(first.value), right: stripSidePrefix(second?.value) };
}

/**
 * Заголовок, собранный из известных путей: `a/<L> b/<R>`, где каждая сторона — либо путь, который
 * адаптер сам и запрашивал, либо `/dev/null`. Так разбирается и путь с пробелом, который живой
 * `arc` печатает без кавычек. Не сошлось — заголовок не про наши файлы, разбираем обычным путём.
 */
function knownHeaderPaths(rest: string, knownPaths: ReadonlySet<string>): HeaderPaths | null {
    const left = readKnownSide(rest, 'a/', knownPaths);
    if (left === null) {
        return null;
    }
    const right = readKnownSide(rest.slice(left.next), 'b/', knownPaths);
    if (right === null || left.next + right.next !== rest.length) {
        return null;
    }
    return { left: left.value, right: right.value };
}

interface KnownSide {
    readonly value: string | null;
    /** Индекс первого символа за стороной вместе с разделяющим пробелом. */
    readonly next: number;
}

function readKnownSide(source: string, prefix: string, knownPaths: ReadonlySet<string>): KnownSide | null {
    // Сторона либо заканчивает заголовок, либо отделена от следующей одним пробелом, поэтому
    // границу ищем не перебором путей, а по самой строке: конец строки и каждый пробел в ней.
    // Длинные варианты пробуются первыми — иначе `a/dir` победил бы у заголовка про `a/dir with space`.
    for (let end = source.length; end > 0; end = source.lastIndexOf(' ', end - 1)) {
        const candidate = source.slice(0, end);
        const known =
            candidate === '/dev/null' ||
            (candidate.startsWith(prefix) && knownPaths.has(candidate.slice(prefix.length)));
        if (!known) {
            continue;
        }
        return { value: stripSidePrefix(candidate), next: end === source.length ? end : end + 1 };
    }
    return null;
}

interface ReadPath {
    readonly value: string;
    /** Индекс первого символа за прочитанным путём. */
    readonly next: number;
}

function readPath(source: string, from: number): ReadPath | null {
    let index = from;
    while (index < source.length && source[index] === ' ') {
        index += 1;
    }
    if (index >= source.length) {
        return null;
    }

    if (source[index] === '"') {
        return readQuoted(source, index + 1);
    }
    const end = source.indexOf(' ', index);
    return end === -1
        ? { value: source.slice(index), next: source.length }
        : { value: source.slice(index, end), next: end };
}

/** Путь в кавычках: C-экранирование git — `\"`, `\\`, управляющие символы и октальные байты UTF-8. */
function readQuoted(source: string, from: number): ReadPath {
    const bytes: number[] = [];
    let index = from;

    while (index < source.length && source[index] !== '"') {
        const char = source[index] ?? '';
        if (char !== '\\') {
            for (const byte of new TextEncoder().encode(char)) {
                bytes.push(byte);
            }
            index += 1;
            continue;
        }

        const next = source[index + 1] ?? '';
        const octal = /^[0-7]{3}$/.exec(source.slice(index + 1, index + 4));
        if (octal !== null) {
            bytes.push(Number.parseInt(octal[0], 8));
            index += 4;
            continue;
        }
        const escaped = ESCAPES.get(next);
        if (escaped === undefined) {
            for (const byte of new TextEncoder().encode(next)) {
                bytes.push(byte);
            }
        } else {
            bytes.push(escaped);
        }
        index += 2;
    }

    return { value: new TextDecoder().decode(new Uint8Array(bytes)), next: index + 1 };
}

const ESCAPES = new Map<string, number>([
    ['n', 0x0a],
    ['t', 0x09],
    ['r', 0x0d],
    ['a', 0x07],
    ['b', 0x08],
    ['f', 0x0c],
    ['v', 0x0b],
    ['"', 0x22],
    ['\\', 0x5c],
]);

/** Срезает сторону патча: `a/path` → `path`; `/dev/null` путём не является. */
function stripSidePrefix(raw: string | undefined): string | null {
    if (raw === undefined || raw === '/dev/null') {
        return null;
    }
    const match = /^[ab]\/(.+)$/.exec(raw);
    return match?.[1] ?? raw;
}
