import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileChangeType, FileDiff, FileImage, ImageSide } from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES, imageMimeOf } from '@sherpa/protocol';

import { countPatchStats, splitPatchByFile } from '../arcanum/patch.js';

import type { LocalIterationFile } from './iterations-store.js';
import { isBinaryPatch, synthesizeAddPatch } from './patch.js';
import type { LocalVcs, NameStatusEntry, VcsInfo, VcsStatus } from './vcs.js';

/**
 * Снимок рабочего дерева локального чекаута: закоммиченное, staged, unstaged и неотслеживаемое
 * одним диффом относительно базового коммита. Снимок считается целиком, без инкрементальных
 * обновлений: дифф на каталоге проекта стоит доли секунды, а сходимость важнее. С VCS снимок
 * разговаривает только через `LocalVcs`: команд и разбора их вывода здесь нет.
 */

/**
 * Потолок неотслеживаемых файлов в снимке. Обрезать список молча нельзя — часть правок просто
 * исчезла бы из ревью, — поэтому перебор лимита это отказ с объяснением, а не тихая усечёнка.
 */
const MAX_UNTRACKED_FILES = 1_000;

/**
 * Сколько байтов одной стороны файла адаптер готов держать в памяти и отдавать текстом;
 * столько же у адаптера Арканума (`MAX_CONTENT_BYTES`). Больше — `patch: null` и `getFileContent`
 * без содержимого: ответ ручки диффа не должен быть безразмерным.
 */
export const MAX_FILE_BYTES = 2_000_000;

/** Каталог проекта внутри чекаута — общий контекст всех обращений к VCS. */
export interface LocalRepo {
    readonly vcs: LocalVcs;
    /** Каталог проекта: cwd команд VCS и корень путей, которые адаптер отдаёт наружу. */
    readonly projectDir: string;
    /** Корень чекаута: к нему привязаны пути статуса и аргумент чтения старой стороны. */
    readonly root: string;
    /** Каталог проекта от корня чекаута; пустая строка — проект и есть корень. */
    readonly prefix: string;
}

/** Каталог проекта вместе с корнем чекаута; не чекаут — понятная ошибка. */
export async function openLocalRepo(vcs: LocalVcs, projectDir: string): Promise<LocalRepo> {
    const printed = (await vcs.root()).trim();
    if (printed === '') {
        throw new Error(`${projectDir} is not ${checkoutName(vcs.kind)}`);
    }

    // Обе стороны через realpath: симлинки и `/var` → `/private/var` иначе разводят пути,
    // и каталог проекта оказывается «вне» собственного чекаута.
    const root = await fs.realpath(printed);
    const real = await fs.realpath(projectDir);
    const prefix = path.relative(root, real);
    if (prefix.startsWith('..') || path.isAbsolute(prefix)) {
        throw new Error(`${real} is outside the ${vcs.kind} checkout ${root}`);
    }
    return { vcs, projectDir: real, root, prefix };
}

/** «arc-чекаут» или «git-чекаут» с артиклем: текст отказа читает человек. */
function checkoutName(kind: LocalVcs['kind']): string {
    return kind === 'arc' ? 'an arc checkout' : 'a git checkout';
}

/** Дешёвая проверка «что-нибудь поменялось»: состояние чекаута без разбора самого диффа. */
export interface LocalProbe {
    readonly info: VcsInfo;
    readonly base: string;
    /** Ref базы: явный из `--base` или база по умолчанию этой VCS. */
    readonly baseRef: string;
    readonly status: VcsStatus;
    /** Неотслеживаемые файлы каталога проекта, путями от него. */
    readonly untracked: readonly string[];
    /**
     * Отметка каждого файла (mtime и размер) по абсолютному пути на момент проверки — до того,
     * как снят дифф. По ней снимок видит, что файл переписали у него под руками.
     */
    readonly marks: ReadonlyMap<string, string>;
    /** Отпечаток проверки: ветка, коммиты, состав изменений и mtime каждого файла. */
    readonly stamp: string;
}

/**
 * Состояние чекаута без чтения диффа: ветка и HEAD, база, список изменений и их mtime.
 * База пересчитывается на каждой проверке — trunk под чекаутом двигается.
 */
export async function probeLocal(repo: LocalRepo, explicitBase: string | null): Promise<LocalProbe> {
    const info = await repo.vcs.info();
    const { base, baseRef } = await resolveBase(repo, explicitBase);

    const status = await repo.vcs.status(repo.projectDir);
    const untracked = untrackedFilesOf(repo, status);

    const marks = new Map<string, string>();
    const mark = async (absPath: string): Promise<string> => {
        const value = await markOf(absPath);
        marks.set(absPath, value);
        return value;
    };

    const lines: string[] = [];
    for (const entry of status.changed) {
        lines.push(`${entry.status} ${entry.path} ${await mark(path.join(repo.root, entry.path))}`);
    }
    for (const file of untracked) {
        lines.push(`untracked ${file} ${await mark(path.join(repo.projectDir, file))}`);
    }

    return {
        info,
        base,
        baseRef,
        status,
        untracked,
        marks,
        stamp: JSON.stringify([info.branch, info.head, base, lines]),
    };
}

/**
 * База сравнения — всегда коммит. Ref разрешается на каждой проверке: базовая ветка под чекаутом
 * двигается, и сравнивать надо с тем, где она сейчас, а не со строкой, которую назвал ревьюер.
 * Явную базу берём как есть, базу по умолчанию — через merge-base с текущей веткой.
 */
async function resolveBase(
    repo: LocalRepo,
    explicitBase: string | null,
): Promise<{ base: string; baseRef: string }> {
    if (explicitBase !== null) {
        return { base: await repo.vcs.revParse(explicitBase), baseRef: displayRef(explicitBase) };
    }
    const baseRef = await repo.vcs.defaultBaseRef();
    return { base: await repo.vcs.mergeBase(baseRef), baseRef };
}

/** Сколько знаков полного sha показывать в шапке ревью: сорок туда не помещаются. */
const SHA_DISPLAY_CHARS = 12;

/** Ref базы для шапки: как назвал ревьюер, но полный sha — сокращённым. */
function displayRef(ref: string): string {
    return /^[0-9a-f]{40}$/iu.test(ref) ? ref.slice(0, SHA_DISPLAY_CHARS) : ref;
}

/** Откуда брать стороны файла: пути от корня чекаута плюс происхождение. */
export interface SideSource {
    /** Путь новой стороны от корня чекаута. */
    readonly rootPath: string;
    /** Путь старой стороны от корня чекаута; null — сторона совпадает с новой или её нет. */
    readonly oldRootPath: string | null;
    readonly changeType: FileChangeType;
    readonly untracked: boolean;
}

/** Один файл снимка вместе с тем, что адаптеру нужно внутри: пути от корня чекаута. */
export interface LocalFileEntry extends SideSource {
    readonly file: FileDiff;
}

export interface LocalSnapshot {
    readonly diffId: string;
    readonly baseCommit: string;
    /** Ref базы, с которой снят дифф: его и показывает мета ревью. */
    readonly baseRef: string;
    /** Ревьюируемая сторона: у рабочего дерева нет коммита, её опознаёт отпечаток диффа. */
    readonly headCommit: string;
    readonly createdAt: string;
    readonly branch: string;
    readonly login: string;
    /** Отпечаток проверки, на которой снимок собран: по нему опрос решает, что ничего не менялось. */
    readonly stamp: string;
    readonly files: readonly FileDiff[];
    readonly entries: ReadonlyMap<string, LocalFileEntry>;
    readonly fileIdByPath: ReadonlyMap<string, string>;
    /** Отпечаток содержимого каждого файла: по нему видно, менялся ли именно он, а не весь дифф. */
    readonly fileHashByPath: ReadonlyMap<string, string>;
    /** Байты сторон картинок по `ImageSide.blobId`; стороны за лимитом сюда не попадают. */
    readonly blobs: ReadonlyMap<string, Uint8Array>;
    /** Состав файлов для истории итераций: из него считается срез между двумя итерациями. */
    readonly iterationFiles: readonly LocalIterationFile[];
    /** Содержимое новых сторон текстовых файлов по адресу блоба — их и пишет история. */
    readonly textBlobs: ReadonlyMap<string, Uint8Array>;
}

/**
 * Снимок по готовой проверке. `diffId` — отпечаток содержимого диффа: пока дифф тот же,
 * итерация та же, и якоря заметок с комментариями остаются на месте.
 */
export async function buildLocalSnapshot(
    repo: LocalRepo,
    probe: LocalProbe,
    createdAt: string,
): Promise<LocalSnapshot> {
    const patchText = await repo.vcs.diff(probe.base);
    const nameStatus = await repo.vcs.nameStatus(probe.base);
    // Список путей нужен разрезке: пути с пробелом в заголовке `diff --git` иначе не разобрать.
    const chunks = splitPatchByFile(
        patchText,
        nameStatus.flatMap((entry) => (entry.oldPath === null ? [entry.path] : [entry.path, entry.oldPath])),
    );

    const fingerprint = createHash('sha256').update(probe.base).update('\n').update(patchText);
    const drafts: FileDraft[] = [];

    for (const entry of dedupeByPath(nameStatus)) {
        const chunk = chunks.get(entry.path) ?? null;
        const binary = chunk !== null && isBinaryPatch(chunk);
        // Новая сторона читается здесь же: история итераций хранит её содержимым, а не патчем.
        const absPath = path.join(repo.root, joinRoot(repo.prefix, entry.path));
        const newSide: FileBytes =
            binary || entry.changeType === 'delete'
                ? { kind: 'missing' }
                : await stableNewSide(absPath, probe.marks.get(absPath));
        drafts.push(trackedDraft(entry, chunk, binary, newSide));
    }
    for (const file of probe.untracked) {
        const content = await readFileBytes(path.join(repo.projectDir, file), MAX_FILE_BYTES);
        if (content.kind === 'missing') {
            // Файл исчез между проверкой и чтением — следующий опрос увидит дерево уже без него.
            continue;
        }
        // Файл за лимитом в отпечаток входит размером и mtime: читать его целиком незачем,
        // но правка в нём обязана двигать итерацию.
        fingerprint
            .update(file)
            .update('\n')
            .update(content.kind === 'bytes' ? content.bytes : content.mark);
        drafts.push(content.kind === 'bytes' ? untrackedDraft(file, content.bytes) : oversizedDraft(file, content));
    }

    const diffId = fingerprint.digest('hex');
    const entries = new Map<string, LocalFileEntry>();
    const fileIdByPath = new Map<string, string>();
    const fileHashByPath = new Map<string, string>();
    const files: FileDiff[] = [];
    const blobs = new Map<string, Uint8Array>();
    const iterationFiles: LocalIterationFile[] = [];
    const textBlobs = new Map<string, Uint8Array>();

    for (const draft of drafts) {
        iterationFiles.push(historyFileOf(draft, textBlobs));
        const sides: SideSource = {
            rootPath: joinRoot(repo.prefix, draft.path),
            oldRootPath: draft.oldPath === null ? null : joinRoot(repo.prefix, draft.oldPath),
            changeType: draft.changeType,
            untracked: draft.untracked,
        };
        const file: FileDiff = {
            fileId: `${diffId}:${draft.path}`,
            path: draft.path,
            oldPath: draft.oldPath,
            changeType: draft.changeType,
            binary: draft.binary,
            // Правила ревью a.yaml локально не воспроизводим: приглушать нечего.
            generated: false,
            additions: draft.additions,
            deletions: draft.deletions,
            patch: draft.patch,
            viewed: null,
            blameUrl: null,
            hostFileUrl: null,
            image: await imageOf(repo, probe.base, draft.path, sides, blobs),
        };
        files.push(file);
        entries.set(file.fileId, { file, ...sides });
        fileIdByPath.set(draft.path, file.fileId);
        fileHashByPath.set(draft.path, draft.fileHash);
    }

    return {
        diffId,
        baseCommit: probe.base,
        baseRef: probe.baseRef,
        // Головного коммита у рабочего дерева нет: ревьюируемую сторону опознаёт сам дифф.
        headCommit: diffId,
        createdAt,
        branch: probe.info.branch,
        login: probe.info.login,
        stamp: probe.stamp,
        files,
        entries,
        fileIdByPath,
        fileHashByPath,
        blobs,
        iterationFiles,
        textBlobs,
    };
}

/**
 * Новая сторона tracked-файла для истории итераций. Патч снят раньше — одним диффом в начале
 * снимка, — а содержимое читается сейчас, и между этим файл успевают переписать (агент, редактор).
 * Файл, чья отметка разошлась с виденной проверкой, отдаётся как отсутствующий: записать его текст
 * значило бы положить в одну итерацию патч одного состояния и содержимое другого, а срез на такой
 * паре показал бы изменившийся файл неизменным и увёз бы на него отметку «просмотрено».
 *
 * Отметки `expected` нет — файл на проверке не числился изменённым; тогда сверяются отметки до и
 * после чтения: это закрывает обход файлов, самую длинную часть окна.
 */
async function stableNewSide(absPath: string, expected: string | undefined): Promise<FileBytes> {
    const before = expected ?? (await markOf(absPath));
    const content = await readFileBytes(absPath, MAX_FILE_BYTES);
    if (content.kind !== 'bytes') {
        return content;
    }
    return (await markOf(absPath)) === before ? content : { kind: 'missing' };
}

/**
 * Файл глазами истории итераций: чем представлена его новая сторона и где лежит её текст.
 * Текст кладётся в блобы по своему sha256 — одинаковые версии файла не дублируются; текста нет —
 * `blob: null`, и срез по такому файлу патча не показывает.
 */
function historyFileOf(draft: FileDraft, textBlobs: Map<string, Uint8Array>): LocalIterationFile {
    // Сторона за лимитом размера важнее двоичности: её не читали, и текста у неё нет никакого.
    const kind = draft.newSide.kind === 'oversized' ? 'oversized' : draft.binary ? 'binary' : 'text';
    let blob: string | null = null;
    if (kind === 'text' && draft.newSide.kind === 'bytes') {
        blob = hashOf(draft.newSide.bytes);
        textBlobs.set(blob, draft.newSide.bytes);
    }
    return { path: draft.path, changeType: draft.changeType, kind, hash: draft.fileHash, blob };
}

/** Содержимое файла: либо байты, либо причина, по которой их нет. */
export type FileBytes =
    | { readonly kind: 'bytes'; readonly bytes: Buffer }
    /** Стороны нет вовсе: добавленный файл слева, удалённый справа, исчезнувший с диска. */
    | { readonly kind: 'missing' }
    /** Сторона больше лимита: в память она не едет. `mark` представляет её в отпечатке диффа. */
    | { readonly kind: 'oversized'; readonly size: number; readonly mark: string };

/**
 * Содержимое стороны файла. Отказ чтения из VCS пробрасывается ошибкой: «стороны нет» — свойство
 * самого файла, и прикидываться им сорвавшаяся команда не должна.
 */
export async function readSideBytes(
    repo: LocalRepo,
    base: string,
    source: SideSource,
    side: 'old' | 'new',
    limit = MAX_FILE_BYTES,
): Promise<FileBytes> {
    if (side === 'new') {
        return source.changeType === 'delete'
            ? { kind: 'missing' }
            : readFileBytes(path.join(repo.root, source.rootPath), limit);
    }
    if (source.untracked || source.changeType === 'add') {
        return { kind: 'missing' };
    }

    const bytes = await repo.vcs.show(base, source.oldRootPath ?? source.rootPath);
    return bytes.length > limit
        ? { kind: 'oversized', size: bytes.length, mark: String(bytes.length) }
        : { kind: 'bytes', bytes };
}

interface FileDraft {
    readonly path: string;
    readonly oldPath: string | null;
    readonly changeType: FileChangeType;
    readonly binary: boolean;
    readonly patch: string | null;
    readonly additions: number;
    readonly deletions: number;
    readonly untracked: boolean;
    /** Отпечаток того, что ревьюер видит по этому пути: сам патч, а не содержимое сторон. */
    readonly fileHash: string;
    /**
     * Содержимое новой стороны для истории итераций; `missing` — стороны нет, она двоичная
     * или её не удалось подтвердить (`stableNewSide`).
     */
    readonly newSide: FileBytes;
}

/** sha256 того, чем файл представлен в диффе. */
function hashOf(content: string | Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

function trackedDraft(
    entry: NameStatusEntry,
    chunk: string | null,
    binary: boolean,
    newSide: FileBytes,
): FileDraft {
    const patch = binary ? null : chunk;
    const stats = patch === null ? { additions: 0, deletions: 0 } : countPatchStats(patch);
    return {
        path: entry.path,
        oldPath: entry.oldPath,
        changeType: entry.changeType,
        binary,
        patch,
        additions: stats.additions,
        deletions: stats.deletions,
        untracked: false,
        // У двоичного это строка `Binary files … differ` — она же единственное, что видно в UI.
        fileHash: hashOf(chunk ?? ''),
        newSide,
    };
}

/**
 * Неотслеживаемый файл за лимитом размера: показывать нечего, но скрывать его из диффа нельзя —
 * ревьюер должен видеть, что файл появился. Тем же `binary: true`, что и у двоичных, UI говорит
 * «содержимое не показано».
 */
function oversizedDraft(file: string, side: Extract<FileBytes, { kind: 'oversized' }>): FileDraft {
    return {
        path: file,
        oldPath: null,
        changeType: 'add',
        binary: true,
        patch: null,
        additions: 0,
        deletions: 0,
        untracked: true,
        // Содержимое не читали: файл представляет тот же размер с mtime, что и в отпечатке диффа.
        fileHash: hashOf(side.mark),
        newSide: side,
    };
}

function untrackedDraft(file: string, content: Buffer): FileDraft {
    const patch = synthesizeAddPatch(file, content);
    const stats = patch === null ? { additions: 0, deletions: 0 } : countPatchStats(patch);
    return {
        path: file,
        oldPath: null,
        changeType: 'add',
        binary: patch === null,
        patch,
        additions: stats.additions,
        deletions: stats.deletions,
        untracked: true,
        // Двоичному патча не досталось — его представляют собственные байты.
        fileHash: hashOf(patch ?? content),
        newSide: patch === null ? { kind: 'missing' } : { kind: 'bytes', bytes: content },
    };
}

/**
 * Картинка файла по расширению пути — тот же признак, что у остальных хостов. Байты сторон
 * читаются здесь же: размер стороны UI знает до запроса, а `blobId` адресует содержимое.
 */
async function imageOf(
    repo: LocalRepo,
    base: string,
    filePath: string,
    source: SideSource,
    blobs: Map<string, Uint8Array>,
): Promise<FileImage | null> {
    const mime = imageMimeOf(filePath);
    if (mime === null) {
        return null;
    }
    return {
        mime,
        before: sideOf(await imageSideBytes(repo, base, source, 'old'), blobs),
        after: sideOf(await imageSideBytes(repo, base, source, 'new'), blobs),
    };
}

/**
 * Байты стороны картинки. Лимит здесь свой, контрактный: больше `IMAGE_BLOB_MAX_BYTES` UI сторону
 * и не запросил бы. Отказ чтения картинку не показывает, но снимок из-за неё не рушит.
 */
async function imageSideBytes(
    repo: LocalRepo,
    base: string,
    source: SideSource,
    side: 'old' | 'new',
): Promise<FileBytes> {
    try {
        return await readSideBytes(repo, base, source, side, IMAGE_BLOB_MAX_BYTES);
    } catch {
        return { kind: 'missing' };
    }
}

/** Сторона картинки по её байтам; `blobId` адресует содержимое, поэтому байты кэшируются по нему. */
function sideOf(content: FileBytes, blobs: Map<string, Uint8Array>): ImageSide | null {
    // Стороны нет или она за лимитом: блоба у нас нет, а выдумывать его id нельзя — он адрес байтов.
    if (content.kind !== 'bytes') {
        return null;
    }
    const blobId = createHash('sha256').update(content.bytes).digest('hex');
    blobs.set(blobId, new Uint8Array(content.bytes));
    return { blobId, size: content.bytes.length };
}

/** Один путь — одна запись: дублей `--name-status` не печатает, но дифф с ними был бы невалиден. */
function dedupeByPath(entries: readonly NameStatusEntry[]): NameStatusEntry[] {
    const byPath = new Map<string, NameStatusEntry>();
    for (const entry of entries) {
        byPath.set(entry.path, entry);
    }
    return [...byPath.values()];
}

/**
 * Неотслеживаемые файлы каталога проекта — те, что назвала сама VCS: раскрытие каталогов и
 * правила игнорирования остаются за ней. Файлов больше лимита — отказ: тихо обрезанный список
 * означал бы, что часть новых файлов пропала из ревью, и ревьюер об этом не узнал бы.
 */
function untrackedFilesOf(repo: LocalRepo, status: VcsStatus): string[] {
    const files: string[] = [];

    for (const rootPath of status.untracked) {
        const local = withinProject(repo.prefix, rootPath);
        if (local !== null) {
            files.push(local);
        }
    }

    if (files.length > MAX_UNTRACKED_FILES) {
        const kind = repo.vcs.kind;
        throw new Error(
            `the project directory has ${String(files.length)} untracked files, ` +
                `more than the ${String(MAX_UNTRACKED_FILES)} Sherpa reviews at once; ` +
                `add them to ${kind} or to .${kind}ignore, ` +
                'or point `devflow-diff-explain up --local <path>` at a narrower directory',
        );
    }
    return files.sort((left, right) => left.localeCompare(right));
}

/** Путь от корня чекаута → путь от каталога проекта; null — файл вне каталога проекта. */
function withinProject(prefix: string, rootPath: string): string | null {
    if (prefix === '') {
        return rootPath;
    }
    return rootPath.startsWith(`${prefix}/`) ? rootPath.slice(prefix.length + 1) : null;
}

function joinRoot(prefix: string, localPath: string): string {
    return prefix === '' ? localPath : `${prefix}/${localPath}`;
}

/**
 * Отпечаток файла для дешёвой проверки. Mtime и размер вместе: за одну миллисекунду файл успевает
 * смениться (редактор, агент), и правка другой длины видна даже с прежним mtime.
 */
async function markOf(absPath: string): Promise<string> {
    try {
        const stats = await fs.stat(absPath);
        return `${String(stats.mtimeMs)}:${String(stats.size)}`;
    } catch {
        return 'none';
    }
}

/** Содержимое файла с диска: размер проверяется до чтения, чтобы дамп не уехал в память целиком. */
async function readFileBytes(absPath: string, limit: number): Promise<FileBytes> {
    let size: number;
    let mtimeMs: number;
    try {
        ({ size, mtimeMs } = await fs.stat(absPath));
    } catch {
        return { kind: 'missing' };
    }
    if (size > limit) {
        return { kind: 'oversized', size, mark: `${String(size)} ${String(mtimeMs)}` };
    }

    try {
        return { kind: 'bytes', bytes: await fs.readFile(absPath) };
    } catch {
        return { kind: 'missing' };
    }
}
