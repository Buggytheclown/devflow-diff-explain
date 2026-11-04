import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { codeLocationSchema, parseCodeLink, savedSourceSchema, fileContentSchema } from '@sherpa/protocol';
import type { CodeLocation, PrDiff, CodeReader, SavedSource, FileDiff, FileContent } from '@sherpa/protocol';
import type { SherpaDatabase, SqlRow } from './db.js';
import { savedPatchIndex } from './saved-patch.js';
import { stripCodeFence } from './route/raw-result.js';
import type { CodeSnapshots } from './code-snapshots.js';

const scope = new AsyncLocalStorage<SavedSources>();
export function withSavedSources<T>(sources: SavedSources, run: () => T): T { return scope.run(sources, run); }
export function sourceEvidence(diff: PrDiff | null, source: CodeLocation & { sourceId?: string | undefined }): SavedSource | null {
    const found = scope.getStore()?.get(source.sourceId ?? '') ?? null;
    return found !== null && diff !== null && found.diffId === diff.diffId &&
        found.revision === (source.side === 'old' ? diff.baseCommit : diff.headCommit) &&
        found.path === source.path && found.side === source.side && found.start <= source.start && found.end >= source.end ? found : null;
}
export function savedSourceById(id: string): SavedSource | null { return scope.getStore()?.get(id) ?? null; }
export function sourceFileEvidence(diff: PrDiff | null, source: { path: string; sourceId?: string | undefined }): SavedSource | null {
    if (diff === null || source.sourceId === undefined) return null;
    const found = scope.getStore()?.get(source.sourceId) ?? null;
    return found !== null && found.fullFile === true && found.diffId === diff.diffId &&
        found.revision === diff.headCommit && found.path === source.path && found.side === 'new' ? found : null;
}

/** Источники привязаны к БД конкретного PR; AsyncLocalStorage изолирует параллельные серверы. */
export class SavedSources {
    constructor(private readonly db: SherpaDatabase, private readonly host: CodeReader | null, private readonly snapshots?: CodeSnapshots) {}
    get(id: string): SavedSource | null {
        const row = this.db.prepare('SELECT data FROM saved_sources WHERE id = ?').get(id) as SqlRow | undefined;
        if (row === undefined) return null;
        let data: unknown; try { data = JSON.parse(String(row.data)); } catch { return null; }
        const parsed = savedSourceSchema.safeParse(data);
        if (!parsed.success || digest(parsed.data.text) !== parsed.data.hash) return null;
        const source = parsed.data;
        if (this.snapshots === undefined || source.fullFile === true) return source;
        const artifact = this.snapshots.sourceArtifact(source.diffId, source.revision, source.path);
        if (artifact == null || artifact.kind === 'binary') return source;
        const full = this.snapshots.source(source.diffId, source.revision, source.path);
        if (full?.split('\n').slice(source.start - 1, source.end).join('\n') !== source.text) return source;
        return { ...source, fullFile: true, ...(artifact.origin === undefined ? {} : { origin: artifact.origin }) };
    }
    async file(diff: PrDiff, file: FileDiff): Promise<FileContent | null> {
        if (this.snapshots?.forDiff(diff.diffId) != null) return this.snapshots.file(diff, file.fileId);
        if (file.binary) return null;
        const id = JSON.stringify([diff.diffId, diff.baseCommit, diff.headCommit, file.fileId]);
        const row = this.db.prepare('SELECT data FROM saved_file_content WHERE id = ?').get(id) as SqlRow | undefined;
        if (row !== undefined) return fileContentSchema.parse(JSON.parse(String(row.data)));
        if (this.host?.getSourceAtRevision === undefined) throw new Error('Pinned file content is unavailable.');
        const read = this.host.getSourceAtRevision.bind(this.host);
        const [oldText, newText] = await Promise.all([
            file.changeType === 'add' ? null : read(file.oldPath ?? file.path, diff.baseCommit),
            file.changeType === 'delete' ? null : read(file.path, diff.headCommit),
        ]);
        if ((file.changeType !== 'add' && oldText === null) || (file.changeType !== 'delete' && newText === null)) throw new Error('Pinned file content is unavailable.');
        if ((oldText?.length ?? 0) > 2_000_000 || (newText?.length ?? 0) > 2_000_000) return null;
        const content = fileContentSchema.parse({ oldText, newText });
        this.db.prepare('INSERT OR IGNORE INTO saved_file_content (id, data) VALUES (?, ?)').run(id, JSON.stringify(content));
        return content;
    }
    async capture(diff: PrDiff, location: CodeLocation): Promise<SavedSource> {
        if (location.side === 'new' && diff.files.some((file) => (file.path === location.path && file.changeType === 'delete') || (file.oldPath === location.path && file.path !== location.path && file.changeType === 'move')) && !diff.files.some((file) => file.path === location.path && file.changeType !== 'delete')) throw new Error('Source path is absent on the pinned new side.');
        const revision = location.side === 'old' ? diff.baseCommit : diff.headCommit;
        const id = digest(JSON.stringify([diff.diffId, revision, location]));
        const cached = this.get(id);
        if (cached !== null) {
            const pinned = this.snapshots?.source(diff.diffId, revision, location.path);
            if (pinned !== undefined) {
                const excerpt = pinned?.split('\n').slice(location.start - 1, location.end).join('\n');
                if (excerpt !== cached.text) throw new Error(`Saved source conflicts with pinned snapshot: ${location.path}.`);
            }
            return cached;
        }
        const text = this.snapshots === undefined
            ? await this.host?.getSourceAtRevision?.(location.path, revision) ?? null
            : this.snapshots.source(diff.diffId, revision, location.path);
        const lines = text?.split('\n');
        if (text === null || text.includes('\0') || lines === undefined || location.end > lines.length) throw new Error(`Source unavailable: ${location.path}:${String(location.start)}-${String(location.end)} @ ${revision}.`);
        const excerpt = lines.slice(location.start - 1, location.end).join('\n');
        if (this.snapshots === undefined && excerpt.length > 2_000_000) throw new Error(`Source excerpt too large: ${location.path}:${String(location.start)}-${String(location.end)}. Select a smaller supporting range or state the unavailable evidence.`);
        const artifact = this.snapshots?.sourceArtifact(diff.diffId, revision, location.path);
        const saved = savedSourceSchema.parse({ ...location, id, diffId: diff.diffId, revision, text: excerpt, hash: digest(excerpt),
            fullFile: artifact != null, ...(artifact?.origin === undefined ? {} : { origin: artifact.origin }) });
        this.db.prepare('INSERT OR IGNORE INTO saved_sources (id, data) VALUES (?, ?)').run(id, JSON.stringify(saved));
        return saved;
    }
    /** Полный импортированный источник вне инвентаря: компактная ссылка на его первый ряд. */
    async captureFile(diff: PrDiff, sourcePath: string): Promise<SavedSource> {
        const artifact = this.snapshots?.sourceArtifact(diff.diffId, diff.headCommit, sourcePath);
        if (artifact === undefined || artifact === null || artifact.kind === 'binary') throw new Error(`Full pinned source unavailable: ${sourcePath}.`);
        const saved = await this.capture(diff, { path: sourcePath, side: 'new', start: 1, end: 1 });
        if (saved.fullFile !== true) throw new Error(`Full pinned source unavailable: ${sourcePath}.`);
        return saved;
    }
    /** При сдаче разрешаем только реальные источники закреплённой версии задачи. */
    async prepare(diff: PrDiff, result: string, markdown: boolean): Promise<string> {
        const patch = savedPatchIndex(diff);
        if (markdown) {
            let prepared = result;
            const links = [...result.matchAll(/#(?:source|code)\?[^\s)]+/g)].map((match) => match[0]);
            for (const link of new Set(links)) {
                const location = parseCodeLink(link.replace('#source?', '#code?'));
                if (location === null) continue;
                const file = patch.file(location.path, location.side, true);
                if (link.startsWith('#code?') && patch.range(file, location) !== null) continue;
                const saved = await this.capture(diff, location.side === 'old' && file?.oldPath != null
                    ? { ...location, path: file.oldPath } : location);
                prepared = prepared.split(link).join(`#source?id=${saved.id}`);
            }
            return prepared;
        }
        let value: unknown;
        try { value = JSON.parse(stripCodeFence(result)); } catch { return result; }
        const visit = async (item: unknown): Promise<void> => {
            if (Array.isArray(item)) { for (const child of item) await visit(child); return; }
            if (item === null || typeof item !== 'object') return;
            const record = item as Record<string, unknown>;
            if (record.kind === 'lines' || record.kind === 'patch') {
                const location = codeLocationSchema.safeParse(record);
                if (location.success && patch.range(patch.file(location.data.path, location.data.side), location.data) === null) {
                    const saved = await this.capture(diff, location.data); record.sourceId = saved.id;
                }
            }
            if (record.kind === 'file' && typeof record.path === 'string') {
                if (typeof record.sourceId === 'string') {
                    if (sourceFileEvidence(diff, { path: record.path, sourceId: record.sourceId }) === null) throw new Error(`Unknown pinned source: ${record.sourceId}`);
                } else if (!diff.files.some((file) => file.path === record.path && file.changeType !== 'delete')) {
                    record.sourceId = (await this.captureFile(diff, record.path)).id;
                }
            }
            for (const child of Object.values(record)) await visit(child);
        };
        if (value !== null && typeof value === 'object' && 'files' in value && Array.isArray(value.files)) {
            const { files, ...structure } = value;
            await visit(structure);
            for (const file of files) {
                try { await visit(file); }
                catch { /* Неразрешённая ссылка отклоняет только этот файл в обычном валидаторе. */ }
            }
            return JSON.stringify({ ...structure, files });
        }
        await visit(value);
        return JSON.stringify(value);
    }
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
