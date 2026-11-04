import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, createTwoFilesPatch, parsePatch } from 'diff';
import { z } from 'zod';
import {
    codeSnapshotInputSchema, codeSnapshotReceiptSchema, sourcesInputSchema,
    imageMimeOf, prDiffSchema, capturedPrSchema,
} from '@sherpa/protocol';
import type { CodeSnapshotInput, CodeSnapshotReceipt, FileContent, FileImage, PrDiff } from '@sherpa/protocol';
import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import { IterationStore } from './iteration-store.js';
import { walkPatch } from './route/diff-index.js';

const artifactSchema = z.object({ hash: z.string(), kind: z.enum(['text', 'binary', 'symlink', 'gitlink']), mode: z.string().optional(), size: z.number() });
const storedFileSchema = z.object({ fileId: z.string(), before: artifactSchema.nullable(), after: artifactSchema.nullable(), patchOrigin: z.enum(['provided', 'generated', 'binary']) });
const storedSchema = z.object({
    id: z.string(), project: z.string(), capturedAt: z.iso.datetime(), pr: capturedPrSchema.nullable(),
    diff: prDiffSchema, files: z.array(storedFileSchema),
});
type Stored = z.infer<typeof storedSchema>;
type Artifact = z.infer<typeof artifactSchema>;
interface InputArtifact { file: string; kind: Artifact['kind']; mode?: string | undefined }
type PreparedSource = Omit<CodeSnapshotInput['sources'][number], 'artifact'> & { artifact: Artifact };

/** Импорт только локальных байтов. Здесь нет клиентов провайдеров и запуска VCS. */
export class CodeSnapshots {
    constructor(private readonly db: SherpaDatabase, readonly project: string,
        private readonly readLocalBlob?: (blobId: string) => Promise<Uint8Array | null>) {}

    get(id: string): Stored | null {
        const row = this.db.prepare('SELECT data FROM code_snapshots WHERE id = ? AND project = ?').get(id, this.project) as SqlRow | undefined;
        return row === undefined ? null : storedSchema.parse(JSON.parse(String(row.data)));
    }

    forDiff(diffId: string): Stored | null {
        const row = this.db.prepare('SELECT data FROM code_snapshots WHERE diff_id = ? AND project = ?').get(diffId, this.project) as SqlRow | undefined;
        return row === undefined ? null : storedSchema.parse(JSON.parse(String(row.data)));
    }

    active(): Stored | null {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'active_code_snapshot'").get() as SqlRow | undefined;
        return row === undefined ? null : this.get(String(row.value));
    }

    bytes(blobId: string): Uint8Array | null {
        const direct = this.db.prepare('SELECT bytes FROM code_artifacts WHERE hash = ?').get(blobId) as SqlRow | undefined;
        if (direct !== undefined) return verifiedBytes(direct, blobId);
        const alias = this.db.prepare('SELECT hash FROM code_artifact_aliases WHERE blob_id = ?').get(blobId) as SqlRow | undefined;
        if (alias === undefined) return null;
        const hash = String(alias.hash);
        const target = this.db.prepare('SELECT bytes FROM code_artifacts WHERE hash = ?').get(hash) as SqlRow | undefined;
        return target === undefined ? null : verifiedBytes(target, hash);
    }

    /** Адрес уже закреплён в БД: ошибка/пропажа байтов не разрешает fallback к файловому кешу. */
    hasRegisteredBlob(blobId: string): boolean {
        return this.db.prepare('SELECT 1 FROM code_artifacts WHERE hash = ?').get(blobId) !== undefined ||
            this.db.prepare('SELECT 1 FROM code_artifact_aliases WHERE blob_id = ?').get(blobId) !== undefined;
    }

    file(diff: PrDiff, fileId: string): FileContent | null {
        const file = this.forDiff(diff.diffId)?.files.find((entry) => entry.fileId === fileId);
        if (file === undefined || file.before?.kind === 'binary' || file.after?.kind === 'binary') return null;
        return { oldText: this.text(file.before), newText: this.text(file.after) };
    }

    source(diffId: string, revision: string, sourcePath: string): string | null {
        const found = this.sourceArtifact(diffId, revision, sourcePath);
        if (found === null || found.kind === 'binary') return null;
        const bytes = this.bytes(found.hash);
        return bytes === null ? null : decode(bytes);
    }

    sourceArtifact(diffId: string, revision: string, sourcePath: string): { hash: string; kind: string; origin?: CodeSnapshotInput['sources'][number]['origin'] } | null {
        const row = this.db.prepare(`SELECT sources.hash, sources.kind, sources.origin FROM code_sources AS sources
            JOIN code_snapshots AS snapshots ON snapshots.id = sources.snapshot_id
            WHERE snapshots.project = ? AND snapshots.diff_id = ? AND sources.revision = ? AND sources.path = ?`)
            .get(this.project, diffId, revision, sourcePath) as SqlRow | undefined;
        return row === undefined ? null : { hash: String(row.hash), kind: String(row.kind), ...(row.origin == null ? {} : { origin: JSON.parse(String(row.origin)) as CodeSnapshotInput['sources'][number]['origin'] }) };
    }

    raw(diffId: string, fileId: string, side: 'old' | 'new'): Uint8Array | null {
        const file = this.forDiff(diffId)?.files.find((entry) => entry.fileId === fileId);
        const artifact = side === 'old' ? file?.before : file?.after;
        return artifact == null ? null : this.bytes(artifact.hash);
    }

    async importSnapshot(manifestFile: string): Promise<CodeSnapshotReceipt> {
        const { root, value } = await manifest(manifestFile);
        const input = codeSnapshotInputSchema.parse(value);
        if (input.project !== this.project) throw new Error('Snapshot project does not match this application.');
        const blobs = new Map<string, Uint8Array>();
        const files: Stored['files'] = [];
        const changes: PrDiff['files'] = [];
        const aliases = new Map<string, string>();
        const sources: PreparedSource[] = [];
        const paths = new Set<string>();
        const ids = new Set<string>();
        const legacy = new IterationStore({ db: this.db }).get(input.diffId);
        const registered = this.forDiff(input.diffId);
        if (legacy !== null && (legacy.diff.baseCommit !== input.baseCommit || legacy.diff.headCommit !== input.headCommit ||
            legacy.diff.files.length !== input.files.length || legacy.diff.files.some((file) => !input.files.some((entry) => entry.path === file.path && entry.oldPath === file.oldPath && entry.changeType === file.changeType)))) {
            throw new Error('This manifest conflicts with the saved inventory or revisions of this diffId.');
        }
        const load = artifactLoader(root, blobs);
        // Импортёр может перечислить те же файлы в другом порядке; старые ссылки и чтение
        // должны видеть прежнюю последовательность, заданную сохранённым диффом.
        const historicalOrder = new Map(legacy?.diff.files.map((file, index) => [file.path, index]) ?? []);
        const orderedFiles = [...input.files].sort((a, b) =>
            (historicalOrder.get(a.path) ?? 0) - (historicalOrder.get(b.path) ?? 0));
        for (const file of orderedFiles) {
            const historical = legacy?.diff.files.find((entry) => entry.path === file.path);
            const fileId = historical?.fileId ?? file.fileId ?? file.path;
            if (paths.has(file.path) || ids.has(fileId)) throw new Error(`Duplicate changed file: ${file.path}.`);
            paths.add(file.path); ids.add(fileId);
            if ((file.before === null) !== (file.changeType === 'add') || (file.after === null) !== (file.changeType === 'delete')) {
                throw new Error(`Missing or unexpected side for ${file.path}.`);
            }
            if ((file.changeType === 'move' || file.changeType === 'copy') && file.oldPath === null) throw new Error(`Missing oldPath for ${file.path}.`);
            const before = file.before === null ? null : await load(file.before);
            const after = file.after === null ? null : await load(file.after);
            const binary = before?.kind === 'binary' || after?.kind === 'binary';
            if (historical !== undefined && historical.binary !== binary) {
                throw new Error(`This manifest conflicts with saved file metadata for ${file.path} under this diffId.`);
            }
            const oldText = before === null ? '' : binary ? null : decode(requiredBlob(blobs, before.hash));
            const newText = after === null ? '' : binary ? null : decode(requiredBlob(blobs, after.hash));
            let patch: string | null = file.patch === null ? historical?.patch ?? null : decode(await readArtifact(root, file.patch));
            if (historical?.patch != null && patch !== historical.patch) {
                throw new Error(`This manifest conflicts with the saved patch or coordinates of ${file.path} for this diffId.`);
            }
            const patchOrigin = file.patch === null && registered !== null
                ? registered.files.find((entry) => entry.fileId === fileId)?.patchOrigin ?? (binary ? 'binary' : 'provided')
                : binary ? 'binary' : patch === null ? 'generated' : 'provided';
            if (!binary && oldText !== null && newText !== null) {
                patch ??= createTwoFilesPatch(file.oldPath ?? file.path, file.path, oldText, newText);
                if (oldText === newText && !/^@@/m.test(patch)) {
                    // Переименование/режим без ханков: всё равно требуется настоящий заголовок patch.
                    const parsed = parsePatch(patch);
                    if (patch.trim() !== '' && (parsed.length !== 1 || parsed[0]?.oldFileName === undefined || parsed[0].newFileName === undefined)) {
                        throw new Error(`Invalid metadata-only patch: ${file.path}.`);
                    }
                } else {
                    if (applyPatch(oldText, patch) !== newText) throw new Error(`Patch does not reproduce complete file sides: ${file.path}.`);
                    const oldLines = oldText.split('\n'), newLines = newText.split('\n');
                    for (const line of walkPatch(patch)) {
                        if ((line.old !== null && oldLines[line.old - 1] !== line.raw.slice(1)) ||
                            (line.new !== null && newLines[line.new - 1] !== line.raw.slice(1))) {
                            throw new Error(`Patch coordinates do not match complete file sides: ${file.path}.`);
                        }
                    }
                }
            }
            const mime = imageMimeOf(file.path);
            const image = mime === null ? null : { mime, before: before === null ? null : { blobId: before.hash, size: before.size }, after: after === null ? null : { blobId: after.hash, size: after.size } };
            if (historical?.image != null) recordImageAliases(historical.image, image, aliases, file.path);
            changes.push({ fileId, path: file.path, oldPath: file.oldPath, changeType: file.changeType, binary,
                generated: historical?.generated ?? file.generated, patch, additions: historical?.additions ?? patchStats(patch, '+'), deletions: historical?.deletions ?? patchStats(patch, '-'),
                viewed: historical?.viewed ?? null, blameUrl: historical?.blameUrl ?? null,
                hostFileUrl: historical === undefined ? file.hostFileUrl : historical.hostFileUrl,
                image: historical?.image ?? image,
            });
            files.push({ fileId, before, after, patchOrigin });
            if (before !== null) sources.push({ path: file.oldPath ?? file.path, revision: input.baseCommit, artifact: before });
            if (after !== null) sources.push({ path: file.path, revision: input.headCommit, artifact: after });
        }
        for (const source of input.sources) sources.push({ ...source, artifact: await load(source.artifact) });
        const diff = prDiffSchema.parse({ diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit, files: changes });
        const identity = { project: input.project, baseCommit: input.baseCommit, headCommit: input.headCommit,
            files: changes.map((file, index) => ({ path: file.path, oldPath: file.oldPath, changeType: file.changeType, patchHash: file.patch === null ? null : digest(file.patch), ...files[index] })).sort((a, b) => a.path.localeCompare(b.path)) };
        // Старые ID без diffId остаются адресуемыми при точном повторном импорте. Новые
        // включают opaque diffId: одинаковые локальные байты могут быть разными версиями.
        const previousIdentityId = digest(JSON.stringify(identity));
        const id = registered?.id === previousIdentityId ? previousIdentityId : digest(JSON.stringify({ diffId: input.diffId, ...identity }));
        diff.codeSnapshotId = id;
        diff.capturedAt = legacy?.diff.capturedAt ?? input.capturedAt;
        diff.metadata = legacy?.diff.metadata ?? input.pr;
        const stored = storedSchema.parse({ id, project: input.project, capturedAt: registered?.capturedAt ?? diff.capturedAt,
            pr: registered?.pr ?? diff.metadata, diff, files });
        if (this.readLocalBlob !== undefined) {
            for (const [blobId, hash] of aliases) {
                const cached = await this.readLocalBlob(blobId);
                if (cached !== null && digest(cached) !== hash) throw new Error(`Conflicting local image blob: ${blobId}.`);
            }
        }
        transaction(this.db, () => {
            const existing = this.forDiff(input.diffId);
            if (existing !== null && existing.id !== id) throw new Error('This diffId already names different immutable bytes.');
            const same = this.get(id);
            if (same !== null && same.diff.diffId !== input.diffId) throw new Error(`These bytes already belong to diffId ${same.diff.diffId}. Reuse that snapshot.`);
            this.saveBlobs(blobs);
            this.saveAliases(aliases);
            this.db.prepare('INSERT OR IGNORE INTO code_snapshots (id, project, diff_id, data) VALUES (?, ?, ?, ?)').run(id, this.project, input.diffId, JSON.stringify(stored));
            this.saveSources(id, sources);
            const active = this.active();
            const activate = input.activate && (active === null || (registered?.capturedAt ?? input.capturedAt) >= active.capturedAt);
            const iterations = new IterationStore({ db: this.db });
            if (activate) this.db.prepare("UPDATE iterations SET status = 'previous' WHERE status = 'active'").run();
            iterations.registerSnapshot(existing?.diff ?? diff, id, { diffId: diff.diffId, baseCommit: diff.baseCommit, headCommit: diff.headCommit, createdAt: legacy?.iteration.createdAt ?? input.capturedAt, status: activate ? 'active' : legacy?.iteration.status ?? 'previous' });
            if (activate) {
                this.db.prepare("UPDATE iterations SET status = 'active' WHERE diff_id = ?").run(input.diffId);
                this.db.prepare("INSERT INTO meta (key, value) VALUES ('active_code_snapshot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
            }
        })();
        return codeSnapshotReceiptSchema.parse({ codeSnapshotId: id, diffId: diff.diffId, files: changes.length, sources: sources.length });
    }

    async importSources(manifestFile: string): Promise<CodeSnapshotReceipt> {
        const { root, value } = await manifest(manifestFile);
        const input = sourcesInputSchema.parse(value);
        const snapshot = this.get(input.codeSnapshotId);
        if (input.project !== this.project || snapshot === null) throw new Error('Unknown code snapshot or project.');
        const blobs = new Map<string, Uint8Array>();
        const sources: PreparedSource[] = [];
        const load = artifactLoader(root, blobs);
        for (const source of input.sources) {
            if (source.revision !== snapshot.diff.baseCommit && source.revision !== snapshot.diff.headCommit) throw new Error('Source revision is outside this code snapshot.');
            sources.push({ ...source, artifact: await load(source.artifact) });
        }
        transaction(this.db, () => { this.saveBlobs(blobs); this.saveSources(snapshot.id, sources); })();
        return { codeSnapshotId: snapshot.id, diffId: snapshot.diff.diffId, files: snapshot.files.length, sources: sources.length };
    }

    private text(artifact: Artifact | null): string | null {
        if (artifact === null) return null;
        const bytes = this.bytes(artifact.hash);
        if (bytes === null) throw new Error('Imported artifact is missing.');
        return decode(bytes);
    }

    contextArtifacts(diffId: string) {
        const snapshot = this.forDiff(diffId);
        if (snapshot === null) return [];
        return (this.db.prepare('SELECT revision, path, hash, kind FROM code_sources WHERE snapshot_id = ? ORDER BY revision, path').all(snapshot.id) as { revision: string; path: string; hash: string; kind: string }[])
            .map((row) => ({ ...row, read: () => this.bytes(row.hash) }));
    }

    private saveBlobs(blobs: Map<string, Uint8Array>): void {
        for (const [hash, bytes] of blobs) this.db.prepare('INSERT OR IGNORE INTO code_artifacts (hash, bytes) VALUES (?, ?)').run(hash, bytes);
    }

    private saveAliases(aliases: Map<string, string>): void {
        for (const [blobId, hash] of aliases) {
            // Канонический SHA всегда обозначает собственные байты, даже если ещё не был сохранён.
            if (/^[a-f0-9]{64}$/.test(blobId) && blobId !== hash) throw new Error(`Conflicting canonical image blob: ${blobId}.`);
            const direct = this.db.prepare('SELECT bytes FROM code_artifacts WHERE hash = ?').get(blobId) as SqlRow | undefined;
            if (direct !== undefined && blobId !== hash) throw new Error(`Conflicting canonical image blob: ${blobId}.`);
            const existing = this.db.prepare('SELECT hash FROM code_artifact_aliases WHERE blob_id = ?').get(blobId) as SqlRow | undefined;
            if (existing !== undefined && existing.hash !== hash) throw new Error(`Conflicting immutable image blob: ${blobId}.`);
            if (blobId !== hash) this.db.prepare('INSERT OR IGNORE INTO code_artifact_aliases (blob_id, hash) VALUES (?, ?)').run(blobId, hash);
        }
    }

    private saveSources(snapshotId: string, sources: PreparedSource[]): void {
        const snapshot = this.get(snapshotId);
        if (snapshot === null) throw new Error('Unknown code snapshot.');
        for (const source of sources) {
            if (source.revision !== snapshot.diff.baseCommit && source.revision !== snapshot.diff.headCommit) throw new Error('Source revision is outside this code snapshot.');
            const found = this.db.prepare('SELECT hash, kind, origin FROM code_sources WHERE snapshot_id = ? AND revision = ? AND path = ?').get(snapshotId, source.revision, source.path) as SqlRow | undefined;
            const origin = source.origin === undefined ? null : JSON.stringify(source.origin);
            if (found !== undefined && (found.hash !== source.artifact.hash || found.kind !== source.artifact.kind || found.origin !== origin)) throw new Error(`Conflicting immutable source: ${source.path} @ ${source.revision}.`);
            this.db.prepare('INSERT OR IGNORE INTO code_sources (snapshot_id, revision, path, hash, kind, origin) VALUES (?, ?, ?, ?, ?, ?)').run(snapshotId, source.revision, source.path, source.artifact.hash, source.artifact.kind, source.origin === undefined ? null : JSON.stringify(source.origin));
        }
    }
}

async function manifest(file: string): Promise<{ root: string; value: unknown }> {
    const real = await fs.realpath(file);
    return { root: path.dirname(real), value: JSON.parse(await fs.readFile(real, 'utf8')) as unknown };
}

async function readArtifact(root: string, relative: string): Promise<Uint8Array> {
    const real = await fs.realpath(path.resolve(root, relative));
    const inside = path.relative(root, real);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Artifact path escapes the import directory.');
    const handle = await fs.open(real, 'r');
    try {
        if (!(await handle.stat()).isFile()) throw new Error('Artifact must be a regular file.');
        return await handle.readFile();
    } finally { await handle.close(); }
}

async function loadArtifact(root: string, input: InputArtifact, blobs: Map<string, Uint8Array>): Promise<Artifact> {
    const bytes = await readArtifact(root, input.file);
    if (input.kind !== 'binary') decode(bytes);
    const hash = digest(bytes); blobs.set(hash, bytes);
    return { hash, size: bytes.length, kind: input.kind, ...(input.mode === undefined ? {} : { mode: input.mode }) };
}

/** Один импорт видит одни байты для каждого локального пути/типа/режима; следующий импорт читает заново. */
function artifactLoader(root: string, blobs: Map<string, Uint8Array>): (input: InputArtifact) => Promise<Artifact> {
    const cache = new Map<string, Promise<Artifact>>();
    return (input: InputArtifact): Promise<Artifact> => {
        const key = JSON.stringify([input.file, input.kind, input.mode ?? null]);
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
        const loaded = loadArtifact(root, input, blobs);
        cache.set(key, loaded);
        return loaded;
    };
}

function requiredBlob(blobs: Map<string, Uint8Array>, hash: string): Uint8Array {
    const bytes = blobs.get(hash); if (bytes === undefined) throw new Error('Missing import bytes.'); return bytes;
}
function verifiedBytes(row: SqlRow, hash: string): Uint8Array {
    if (!(row.bytes instanceof Uint8Array) || digest(row.bytes) !== hash) throw new Error('Stored artifact hash mismatch.');
    return row.bytes;
}
function recordImageAliases(historical: FileImage, imported: FileImage | null, aliases: Map<string, string>, filePath: string): void {
    if (imported === null) throw new Error(`This manifest conflicts with saved image addresses for ${filePath} under this diffId.`);
    if (historical.mime !== imported.mime) throw new Error(`This manifest conflicts with saved image addresses for ${filePath} under this diffId.`);
    for (const side of ['before', 'after'] as const) {
        const oldSide = historical[side], newSide = imported[side];
        if ((oldSide === null) !== (newSide === null) || (oldSide !== null && newSide !== null && oldSide.size !== newSide.size)) {
            throw new Error(`This manifest conflicts with saved image addresses for ${filePath} under this diffId.`);
        }
        if (oldSide === null || newSide === null || oldSide.blobId === newSide.blobId) continue;
        const previous = aliases.get(oldSide.blobId);
        if (previous !== undefined && previous !== newSide.blobId) throw new Error(`Conflicting immutable image blob: ${oldSide.blobId}.`);
        aliases.set(oldSide.blobId, newSide.blobId);
    }
}
function decode(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function patchStats(patch: string | null, prefix: string): number {
    let count = 0;
    for (const line of walkPatch(patch ?? '')) if (line.changed && line.raw.startsWith(prefix)) count++;
    return count;
}
