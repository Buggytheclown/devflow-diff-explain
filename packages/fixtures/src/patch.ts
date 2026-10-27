import type { FileChangeType, FileDiff, FileImage, HostId, ImageMime, ImageSide } from '@sherpa/protocol';

/**
 * Сборка unified diff для фикстур. Формат — как у `git diff` (заголовок файла, `@@ -a,b +c,d @@`,
 * строки с префиксом ' ' / '+' / '-'): его парсит настоящий дифф-парсер UI,
 * поэтому фикстуры обязаны быть валидным диффом, а не похожим на дифф текстом.
 *
 * Счётчики `additions`/`deletions` всегда выводятся из самого патча — разъехаться они не могут.
 */

/** Строка ханка вместе с префиксом: ' ' — контекст, '+' — добавлена, '-' — удалена. */
export type PatchLine = string;

export interface HunkSpec {
    /** Номер первой строки ханка в старой версии файла (1-based; 0 — если старой версии нет). */
    oldStart: number;
    newStart: number;
    /** Текст после закрывающего `@@`, как его пишет git. */
    section?: string;
    lines: readonly PatchLine[];
}

export interface FileSpec {
    path: string;
    /** Прежний путь для move/copy. */
    oldPath?: string;
    changeType: FileChangeType;
    binary?: boolean;
    generated?: boolean;
    /** null — хост не умеет viewed-отметки (см. `capabilities.fileViewedSync`). */
    viewed?: boolean | null;
    /** Ссылка на blame в вебе хоста; по умолчанию её нет. */
    blameUrl?: string;
    /** Ссылка на файл в PR в вебе хоста; по умолчанию её нет. */
    hostFileUrl?: string;
    hunks?: readonly HunkSpec[];
    /**
     * Файл — картинка: стороны заданы base64 (`before` нет у add, `after` — у delete).
     * `blobId` и `size` считает `makeFileDiff` от самих байтов.
     */
    image?: ImageSpec;
    /** Режим файла в git-заголовке; по умолчанию обычный файл. */
    mode?: string;
    /** Прежний режим: если отличается от `mode`, патч несёт строки `old mode`/`new mode`. */
    oldMode?: string;
}

/** Картинка файла: байты сторон в base64 — так они лежат в данных фикстур. */
export interface ImageSpec {
    mime: ImageMime;
    /** Отсутствует — стороны нет: `before` у add, `after` у delete. */
    before?: string;
    after?: string;
}

const DEFAULT_MODE = '100644';

/**
 * Байты сторон картинок по `blobId`: на них отвечает `FixtureHost.getBlob`. Наполняется при сборке
 * файлов фикстуры — данные держат base64, а id считается из них здесь же, в одном месте.
 */
const blobs = new Map<string, Uint8Array>();

/** Байты блоба фикстуры; null — такого id ни одна собранная фикстура не объявляла. */
export function fixtureBlob(blobId: HostId): Uint8Array | null {
    return blobs.get(blobId) ?? null;
}

/** base64 → байты без `Buffer`: пакет фикстур грузится и в браузер. */
export function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/** Сторона картинки; id содержательный — равные байты дают равный id, как у настоящего хоста. */
function imageSide(base64: string | undefined): ImageSide | null {
    if (base64 === undefined) {
        return null;
    }
    const bytes = decodeBase64(base64);
    const blobId = `blob:${hashHex(base64, 40)}`;
    blobs.set(blobId, bytes);
    return { blobId, size: bytes.length };
}

function imageOf(spec: FileSpec): FileImage | null {
    if (spec.image === undefined) {
        return null;
    }
    return {
        mime: spec.image.mime,
        before: imageSide(spec.image.before),
        after: imageSide(spec.image.after),
    };
}

/**
 * FNV-1a: стабильные «блоб-хеши» и id из пути, чтобы фикстура не зависела от порядка сборки.
 * Не криптография, а детерминированный отпечаток: им же считается `contentHash` снапшота
 * маршрута — нодовского `crypto` здесь быть не может, пакет грузится и в браузер.
 */
export function hashHex(input: string, length: number): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    let out = '';
    let state = hash;
    while (out.length < length) {
        out += state.toString(16).padStart(8, '0');
        state = Math.imul(state ^ 0x9e3779b9, 0x01000193) >>> 0;
    }
    return out.slice(0, length);
}

/**
 * Непрозрачный id элемента диффа вида `eid:1:<base64>`:
 * код-потребитель не должен его разбирать, и по виду это сразу понятно.
 */
export function makeFileId(diffId: HostId, path: string): HostId {
    return `eid:1:${base64url(`${diffId}/${path}`)}`;
}

/**
 * base64url без `Buffer`: пакет фикстур грузится и в браузер (галерея состояний, e2e),
 * а там нодовского `Buffer` нет.
 */
function base64url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function countLines(lines: readonly PatchLine[]): { additions: number; deletions: number; context: number } {
    let additions = 0;
    let deletions = 0;
    let context = 0;
    for (const line of lines) {
        const prefix = line.slice(0, 1);
        if (prefix === '+') {
            additions += 1;
        } else if (prefix === '-') {
            deletions += 1;
        } else if (prefix === ' ') {
            context += 1;
        } else {
            throw new Error(`строка ханка без префикса ' ', '+' или '-': ${JSON.stringify(line)}`);
        }
    }
    return { additions, deletions, context };
}

function renderHunk(hunk: HunkSpec): string {
    const { additions, deletions, context } = countLines(hunk.lines);
    const oldCount = context + deletions;
    const newCount = context + additions;
    const oldStart = oldCount === 0 ? 0 : hunk.oldStart;
    const newStart = newCount === 0 ? 0 : hunk.newStart;
    const section = hunk.section === undefined ? '' : ` ${hunk.section}`;
    const header = `@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@${section}`;
    return [header, ...hunk.lines].join('\n');
}

/** Смена режима: git показывает её отдельными строками заголовка, даже без правки содержимого. */
function isModeChanged(spec: FileSpec): boolean {
    const mode = spec.mode ?? DEFAULT_MODE;
    return (spec.oldMode ?? mode) !== mode;
}

function renderFileHeader(spec: FileSpec): string[] {
    const mode = spec.mode ?? DEFAULT_MODE;
    const from = spec.oldPath ?? spec.path;
    const blobA = hashHex(`old:${from}`, 7);
    const blobB = hashHex(`new:${spec.path}`, 7);
    const lines = [`diff --git a/${from} b/${spec.path}`];
    const modeChanged = isModeChanged(spec);
    const hasHunks = (spec.hunks ?? []).length > 0;

    switch (spec.changeType) {
        case 'add':
            lines.push(`new file mode ${mode}`, `index 0000000..${blobB}`, '--- /dev/null', `+++ b/${spec.path}`);
            break;
        case 'delete':
            lines.push(`deleted file mode ${mode}`, `index ${blobA}..0000000`, `--- a/${from}`, '+++ /dev/null');
            break;
        case 'move':
        case 'copy': {
            const verb = spec.changeType === 'move' ? 'rename' : 'copy';
            lines.push(
                'similarity index 92%',
                `${verb} from ${from}`,
                `${verb} to ${spec.path}`,
                `index ${blobA}..${blobB} ${mode}`,
                `--- a/${from}`,
                `+++ b/${spec.path}`,
            );
            break;
        }
        case 'modify':
        case 'conflict':
            if (modeChanged) {
                lines.push(`old mode ${String(spec.oldMode)}`, `new mode ${mode}`);
            }
            if (hasHunks) {
                // Режим в строке `index` git пишет только когда он не менялся.
                lines.push(
                    modeChanged ? `index ${blobA}..${blobB}` : `index ${blobA}..${blobB} ${mode}`,
                    `--- a/${from}`,
                    `+++ b/${spec.path}`,
                );
            }
            break;
    }
    return lines;
}

/**
 * Собрать `FileDiff`. Патч — null у binary и у файлов без текстового диффа (пустой файл):
 * так это и приходит из хоста, UI показывает такие файлы однострочными нотисами (`docs/spec.md`).
 * У смены режима без правки содержимого патч есть, но состоит из одной шапки без ханков.
 */
export function makeFileDiff(diffId: HostId, spec: FileSpec): FileDiff {
    const hunks = spec.hunks ?? [];
    const binary = spec.binary ?? false;
    const totals = countLines(hunks.flatMap((hunk) => hunk.lines));
    const hasPatch = !binary && (hunks.length > 0 || isModeChanged(spec));

    return {
        fileId: makeFileId(diffId, spec.path),
        path: spec.path,
        oldPath: spec.oldPath ?? null,
        changeType: spec.changeType,
        binary,
        generated: spec.generated ?? false,
        additions: totals.additions,
        deletions: totals.deletions,
        patch: hasPatch ? [...renderFileHeader(spec), ...hunks.map(renderHunk), ''].join('\n') : null,
        viewed: spec.viewed === undefined ? false : spec.viewed,
        blameUrl: spec.blameUrl ?? null,
        hostFileUrl: spec.hostFileUrl ?? null,
        image: imageOf(spec),
    };
}

/** Сумма `+`/`−` по набору файлов — фикстуры сверяют свои заявленные размеры этой же функцией. */
export function totalChanges(files: readonly FileDiff[]): { additions: number; deletions: number } {
    return files.reduce(
        (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
    );
}
