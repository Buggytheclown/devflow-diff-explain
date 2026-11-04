import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { promisify } from 'node:util';

const REVISION = /^[a-f0-9]{40}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** Экспорт двух закреплённых ревизий Arc; временный каталог после импорта удаляет вызывающий. */
export async function exportArcSnapshot(options) {
    const { cwd, baseCommit, headCommit, project, diffId } = options;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !REVISION.test(baseCommit) ||
        !REVISION.test(headCommit) || typeof project !== 'string' || !PROJECT.test(project) ||
        typeof diffId !== 'string' || diffId.trim() === '') {
        throw new Error('Arc export needs an absolute checkout directory, full committed hashes, project and diffId.');
    }
    const arcBinary = options.arcBinary ?? 'arc';
    const info = await arcJson(arcBinary, ['info', '--json'], cwd);
    if (info?.repository !== 'arcadia') throw new Error('Arc export requires an Arcadia checkout.');
    const root = (await arcText(arcBinary, ['root'], cwd)).trim();
    if (!path.isAbsolute(root) || !inside(await fs.realpath(root), await fs.realpath(cwd))) {
        throw new Error('Arc did not identify the requested checkout.');
    }
    const resolved = parseInventory(await arcJson(arcBinary,
        ['diff', '--name-status', '--json', '--resolve-moves=1', baseCommit, headCommit], root));
    const treeCache = new Map();
    let inventory = resolved.files;
    if (resolved.directories.length > 0) {
        const flat = parseInventory(await arcJson(arcBinary,
            ['diff', '--name-status', '--json', '--resolve-moves=0', baseCommit, headCommit], root));
        if (flat.directories.length > 0) throw new Error('Arc flat inventory still contains moved directories.');
        inventory = await overlayDirectoryMoves(flat.files, resolved, arcBinary, root, baseCommit, treeCache);
    }
    const exportRoot = await fs.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), 'devflow-arc-export-'));
    await fs.chmod(exportRoot, 0o700);
    try {
        const prepared = [];
        for (const changed of inventory) {
            const beforePath = changed.oldPath ?? changed.path;
            const before = changed.changeType === 'add' ? null :
                { path: beforePath, entry: await treeEntry(arcBinary, root, baseCommit, beforePath, treeCache) };
            const after = changed.changeType === 'delete' ? null :
                { path: changed.path, entry: await treeEntry(arcBinary, root, headCommit, changed.path, treeCache) };
            if (before !== null) checkMode(before.entry, before.path, baseCommit);
            if (after !== null) checkMode(after.entry, after.path, headCommit);
            prepared.push({ changed, before, after });
        }
        const baseStage = path.join(exportRoot, '.base');
        const headStage = path.join(exportRoot, '.head');
        await exportPaths(arcBinary, root, baseCommit, prepared.flatMap(({ before }) =>
            before === null || before.entry.mode === '160000' ? [] : [before.path]), baseStage);
        await exportPaths(arcBinary, root, headCommit, prepared.flatMap(({ after }) =>
            after === null || after.entry.mode === '160000' ? [] : [after.path]), headStage);
        const files = [];
        for (const [index, { changed, before: oldSide, after: newSide }] of prepared.entries()) {
            const before = oldSide === null ? null : await side('before', oldSide, baseStage, index);
            const after = newSide === null ? null : await side('after', newSide, headStage, index);
            files.push({ path: changed.path, oldPath: changed.oldPath, changeType: changed.changeType,
                before, after, patch: null, generated: false, hostFileUrl: null });
        }
        const manifest = { format: 'code-snapshot/1', project, diffId, baseCommit, headCommit,
            capturedAt: options.capturedAt ?? new Date().toISOString(), pr: options.pr ?? null,
            files, sources: [], activate: options.activate ?? true };
        const temporary = path.join(exportRoot, '.manifest.json.tmp');
        await fs.writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
        const complete = path.join(exportRoot, 'manifest.json');
        await fs.rename(temporary, complete);
        return complete;
    } catch (error) {
        await fs.rm(exportRoot, { recursive: true, force: true });
        throw error;
    }

    async function side(label, source, stage, index) {
        const { path: filePath, entry } = source;
        const relative = `artifacts/${String(index).padStart(6, '0')}-${label}`;
        const target = path.join(exportRoot, relative);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        if (entry.mode === '160000' && entry.type === 'commit' && REVISION.test(entry.hash)) {
            // Gitlink хранит только ID вложенного коммита; его дерево не экспортируется.
            await fs.writeFile(target, entry.hash, { mode: 0o600, flag: 'wx' });
            return { file: relative, kind: 'gitlink', mode: entry.mode };
        }
        const exported = await safeExportedPath(stage, filePath);
        if (entry.mode === '120000') {
            // readlink читает саму ссылку, никогда не следует по цели.
            if (!exported.isSymbolicLink()) throw new Error(`Arc export did not preserve symlink: ${filePath}.`);
            const bytes = await fs.readlink(path.join(stage, filePath), { encoding: 'buffer' });
            if (classifyBytes(bytes) === 'binary') throw new Error(`Arc symlink target is not UTF-8 text: ${filePath}.`);
            await fs.writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
            return { file: relative, kind: 'symlink', mode: entry.mode };
        }
        if (!exported.isFile()) throw new Error(`Arc export returned a non-file for ${filePath}.`);
        const kind = await classifyFile(path.join(stage, filePath));
        await fs.chmod(path.join(stage, filePath), 0o600);
        return { file: `${label === 'before' ? '.base' : '.head'}/${filePath}`, kind,
            ...(entry.mode === '100644' ? {} : { mode: entry.mode }) };
    }
}

function parseInventory(value) {
    if (!Array.isArray(value) || value.some((group) => !Array.isArray(group?.names))) {
        throw new Error('Arc returned an unsupported changed-file inventory.');
    }
    const files = [];
    const directories = [];
    const filePaths = new Set();
    const directoryPaths = new Set();
    for (const group of value) for (const item of group.names) {
        if (!validPath(item?.path)) throw new Error('Arc inventory contains an unsupported object or path.');
        if (item.type === 'directory') {
            if (directoryPaths.has(item.path)) throw new Error(`Arc inventory repeats directory ${item.path}.`);
            directoryPaths.add(item.path);
            if (!['new file', 'deleted', 'modified', 'renamed', 'copied'].includes(item.status))
                throw new Error(`Arc directory status is unsupported: ${String(item.status)}.`);
            if (item.status === 'renamed' || item.status === 'copied') {
                if (!validPath(item.source?.path)) throw new Error(`Arc directory lacks a valid source: ${item.path}.`);
                directories.push({ path: item.path, oldPath: item.source.path,
                    changeType: item.status === 'renamed' ? 'move' : 'copy' });
            }
            continue;
        }
        if (item.type !== 'file') throw new Error('Arc inventory contains an unsupported object or path.');
        if (filePaths.has(item.path)) throw new Error(`Arc inventory repeats file ${item.path}.`);
        filePaths.add(item.path);
        const status = item.status;
        const changeType = status === 'new file' ? 'add' : status === 'modified' ? 'modify' :
            status === 'deleted' ? 'delete' : status === 'renamed' ? 'move' :
            status === 'copied' ? 'copy' : null;
        if (changeType === null) throw new Error(`Arc inventory status is unsupported: ${String(status)}.`);
        const oldPath = item.source?.path ?? null;
        if ((changeType === 'move' || changeType === 'copy') && !validPath(oldPath)) {
            throw new Error(`Arc did not provide the old path for ${changeType}: ${item.path}.`);
        }
        if (oldPath !== null && (changeType !== 'move' && changeType !== 'copy' || !validPath(oldPath))) {
            throw new Error('Arc inventory contains an unexpected old path.');
        }
        files.push({ path: item.path, oldPath, changeType });
    }
    return { files, directories };
}

async function overlayDirectoryMoves(flatFiles, resolved, arcBinary, root, revision, cache) {
    if (flatFiles.some((file) => file.changeType === 'move' || file.changeType === 'copy')) {
        throw new Error('Arc flat inventory unexpectedly contains resolved moves.');
    }
    const deleted = new Set(flatFiles.filter((file) => file.changeType === 'delete').map((file) => file.path));
    const resolvedFiles = new Map(resolved.files.filter((file) => file.changeType === 'move' || file.changeType === 'copy')
        .map((file) => [file.path, file]));
    const usedOldPaths = new Set();
    const additions = new Map();
    for (const file of flatFiles.filter((entry) => entry.changeType === 'add')) {
        const exact = resolvedFiles.get(file.path);
        const matching = resolved.directories.filter((directory) => file.path.startsWith(`${directory.path}/`));
        matching.sort((a, b) => b.path.length - a.path.length);
        if (matching.length > 1 && matching[0].path.length === matching[1].path.length) {
            throw new Error(`Arc directory provenance is ambiguous for ${file.path}.`);
        }
        const directory = matching[0];
        const mapped = exact ?? (directory === undefined ? null : {
            path: file.path, oldPath: `${directory.oldPath}/${file.path.slice(directory.path.length + 1)}`,
            changeType: directory.changeType,
        });
        if (mapped === null) continue;
        if (mapped.changeType === 'move') {
            if (!deleted.has(mapped.oldPath)) {
                if (exact !== undefined) throw new Error(`Arc move lacks a flat deletion: ${file.path}.`);
                continue;
            }
            if (usedOldPaths.has(mapped.oldPath)) throw new Error(`Arc move repeats source: ${mapped.oldPath}.`);
            usedOldPaths.add(mapped.oldPath);
        } else if (await findTreeEntry(arcBinary, root, revision, mapped.oldPath, cache) === null) {
            if (exact !== undefined) throw new Error(`Arc copy source is missing: ${mapped.oldPath}.`);
            continue;
        }
        additions.set(file.path, mapped);
    }
    for (const file of resolvedFiles.values()) if (!additions.has(file.path)) {
        throw new Error(`Arc resolved file is absent from the flat inventory: ${file.path}.`);
    }
    return flatFiles.flatMap((file) => file.changeType === 'delete' && usedOldPaths.has(file.path) ? [] :
        [additions.get(file.path) ?? file]);
}

async function treeEntry(arcBinary, root, revision, filePath, cache) {
    const found = await findTreeEntry(arcBinary, root, revision, filePath, cache);
    if (found === null) throw new Error(`Arc committed object is missing or ambiguous: ${filePath} @ ${revision}.`);
    return found;
}

async function findTreeEntry(arcBinary, root, revision, filePath, cache) {
    const parent = path.posix.dirname(filePath);
    // Файл в корне запрашиваем точно: полный список корня Аркадии не нужен.
    const query = parent === '.' ? filePath : parent;
    const key = `${revision}\0${query}`;
    if (!cache.has(key)) cache.set(key, arcJson(arcBinary, ['ls-tree', '--json', revision,
        query.startsWith('-') ? `./${query}` : query], root).then((entries) => {
        if (!Array.isArray(entries)) throw new Error(`Arc returned an invalid tree for ${query}.`);
        const byName = new Map();
        for (const entry of entries) {
            if (typeof entry?.name !== 'string' || byName.has(entry.name)) {
                throw new Error(`Arc returned an ambiguous tree for ${query}.`);
            }
            byName.set(entry.name, entry);
        }
        return byName;
    }));
    const entry = (await cache.get(key)).get(filePath) ?? null;
    if (entry !== null && (typeof entry.mode !== 'string' || typeof entry.type !== 'string')) {
        throw new Error(`Arc committed object is malformed: ${filePath} @ ${revision}.`);
    }
    return entry;
}

function validPath(value) {
    return typeof value === 'string' && value !== '' && !value.startsWith('/') &&
        !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
function inside(root, cwd) {
    const relative = path.relative(root, cwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function arcJson(binary, args, cwd) {
    const raw = await arcBytes(binary, args, cwd);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw new Error(`Arc returned invalid JSON for ${args[0]}.`); }
}
async function arcText(binary, args, cwd) {
    return new TextDecoder('utf-8', { fatal: true }).decode(await arcBytes(binary, args, cwd));
}
async function arcBytes(binary, args, cwd) {
    try {
        const { stdout } = await execFileAsync(binary, args, { cwd, encoding: 'buffer', maxBuffer: MAX_METADATA_BYTES });
        return stdout;
    } catch (error) {
        throw new Error(`Arc ${args[0]} failed: ${String(error.stderr ?? error.message).slice(-4096).trim()}`, { cause: error });
    }
}
function checkMode(entry, filePath, revision) {
    const regular = entry.type === 'blob' && ['100644', '100755', '120000'].includes(entry.mode);
    const gitlink = entry.type === 'commit' && entry.mode === '160000' && REVISION.test(entry.hash);
    if (!regular && !gitlink) throw new Error(`Arc committed object has unsupported type/mode: ${filePath} @ ${revision}.`);
}

async function exportPaths(binary, root, revision, paths, stage) {
    await fs.mkdir(stage, { mode: 0o700 });
    const exact = [...new Set(paths)];
    const selected = new Set(exact);
    for (const filePath of exact) {
        let parent = path.posix.dirname(filePath);
        while (parent !== '.') {
            if (selected.has(parent)) throw new Error(`Arc inventory contains an ancestor path collision: ${parent}.`);
            parent = path.posix.dirname(parent);
        }
    }
    // Ограничиваем argv, не передавая корень дерева или список через shell.
    let batch = [];
    let length = 0;
    for (const filePath of exact) {
        const argument = `./${filePath}`;
        if (Buffer.byteLength(argument) > 96 * 1024) throw new Error(`Arc path is too long: ${filePath}.`);
        if (length + Buffer.byteLength(argument) > 96 * 1024 && batch.length > 0) {
            await arcBytes(binary, ['export', revision, ...batch, '--to', stage], root);
            batch = [];
            length = 0;
        }
        batch.push(argument);
        length += Buffer.byteLength(argument) + 1;
    }
    if (batch.length > 0) await arcBytes(binary, ['export', revision, ...batch, '--to', stage], root);
}

async function safeExportedPath(stage, filePath) {
    let current = stage;
    const parts = filePath.split('/');
    for (const part of parts.slice(0, -1)) {
        current = path.join(current, part);
        const status = await fs.lstat(current);
        if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`Arc export contains an unsafe ancestor: ${filePath}.`);
    }
    const final = path.join(current, parts.at(-1));
    const status = await fs.lstat(final);
    if (!status.isFile() && !status.isSymbolicLink()) throw new Error(`Arc export returned an unsupported object: ${filePath}.`);
    if (status.isFile() && !inside(await fs.realpath(stage), await fs.realpath(final))) {
        throw new Error(`Arc export escaped the private directory: ${filePath}.`);
    }
    return status;
}

async function classifyFile(filePath) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const chunk of createReadStream(filePath)) {
        try { if (hasBinaryControls(decoder.decode(chunk, { stream: true }))) return 'binary'; }
        catch { return 'binary'; }
    }
    try { return hasBinaryControls(decoder.decode()) ? 'binary' : 'text'; }
    catch { return 'binary'; }
}

function classifyBytes(bytes) {
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return hasBinaryControls(decoded) ? 'binary' : 'text';
    } catch { return 'binary'; }
}
function hasBinaryControls(text) {
    for (const character of text) {
        const point = character.codePointAt(0);
        if (point <= 8 || point === 11 || (point >= 14 && point <= 31) || point === 127) return true;
    }
    return false;
}
