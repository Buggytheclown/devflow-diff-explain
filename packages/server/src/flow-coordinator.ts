import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrDiff, RouteSnapshot } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';
import type { TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import type { RouteStore } from './route-store.js';
import { validateArchitectureCheckpoint } from './architecture-checkpoint.js';
import { materializeReviewTarget } from './route-payload.js';
import type { SharedPayloadStore } from './shared-payload.js';
export { diagramSourceErrors } from './diagram-sources.js';

interface Options {
    store: RouteStore; queue: TaskQueue; dir: string; shared: SharedPayloadStore;
    loadDiff: (id: string) => Promise<PrDiff>;
}

/** Повтор архитектуры использует тот же текущий checkpoint, что и объяснение файлов. */
export class FlowCoordinator {
    private stopped = false;
    private busy = false;
    private scheduled = false;
    private dirty = false;
    private unsubscribers: (() => void)[] = [];
    private readonly diffs = new Map<string, PrDiff>();
    constructor(private readonly options: Options) {}

    start(): void {
        this.unsubscribers = [this.options.store.subscribe(() => { this.schedule(); }), this.options.queue.subscribeChanges(() => { this.schedule(); })];
        this.schedule();
    }
    close(): void { this.stopped = true; for (const stop of this.unsubscribers) stop(); }
    private schedule(): void {
        if (this.stopped) return;
        this.dirty = true;
        if (this.scheduled || this.busy) return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; void this.reconcile(); });
    }
    private async reconcile(): Promise<void> {
        if (this.busy || this.stopped) return;
        this.busy = true; this.dirty = false;
        const { store, queue } = this.options;
        const snapshot = store.current();
        const replacing = store.read().phase === 'reading';
        try {
            const pending = !replacing && snapshot?.storyContractVersion === 6 && snapshot.flow?.status === 'pending' ? snapshot.flow : null;
            for (const task of queue.listTasks()) {
                if (task.type === 'route.diagram' && (task.status === 'queued' || task.status === 'leased') && task.id !== pending?.taskId) queue.cancel(task.id);
            }
            if (!replacing && snapshot !== null && snapshot.storyContractVersion !== 6 && snapshot.flow?.status === 'pending') {
                store.setFlow(snapshot.snapshotId, { status: 'unavailable', reason: snapshot.provenance.locale === 'ru'
                    ? 'Подготовка схемы прежнего формата остановлена. Сохранённый рассказ доступен; схему можно построить заново.'
                    : 'Legacy diagram preparation stopped. The saved explanation remains available; retry to build the architecture.' });
                return;
            }
            if (replacing || store.generation()?.status === 'cancelled' || snapshot?.storyContractVersion !== 6 || pending === null) return;
            if (pending.taskId !== null) {
                const task = queue.getTask(pending.taskId);
                if (task === null || task.status === 'failed' || task.status === 'cancelled' || task.status === 'done') store.setFlow(snapshot.snapshotId, {
                    status: 'unavailable', reason: snapshot.provenance.locale === 'ru' ? 'Схема недоступна. Рассказ и дифф можно читать.' : 'Diagram unavailable. The explanation and diff remain available.',
                });
                else if (!this.diffs.has(snapshot.diffId)) {
                    const diff = await this.options.loadDiff(snapshot.diffId);
                    if (this.current(snapshot.snapshotId, pending.taskId)) this.diffs.set(diff.diffId, diff);
                }
                return;
            }
            const diff = await this.options.loadDiff(snapshot.diffId);
            if (!this.current(snapshot.snapshotId, null)) return;
            this.diffs.clear(); this.diffs.set(diff.diffId, diff);
            const task = queue.enqueue(this.payload(snapshot, diff));
            store.setFlow(snapshot.snapshotId, { ...pending, taskId: task.id });
        } catch {
            if (snapshot !== null && this.current(snapshot.snapshotId, null)) store.setFlow(snapshot.snapshotId, {
                status: 'unavailable', reason: snapshot.provenance.locale === 'ru' ? 'Не удалось подготовить схему по сохранённой версии кода.' : 'Could not prepare a diagram from the saved code revision.',
            });
        } finally { this.busy = false; this.reschedule(); }
    }
    private reschedule(): void { if (this.dirty) this.schedule(); }
    private current(id: string, taskId: number | null): boolean {
        const value = this.options.store.current();
        return !this.stopped && this.options.store.generation()?.status !== 'cancelled' && this.options.store.read().phase !== 'reading' && value?.snapshotId === id && value.flow?.status === 'pending' && value.flow.taskId === taskId;
    }
    diffIdForTask(taskId: number): string | null {
        const snapshot = this.options.store.current();
        return snapshot?.flow?.status === 'pending' && snapshot.flow.taskId === taskId ? snapshot.diffId : null;
    }
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type !== 'route.diagram') return null;
        const snapshot = this.options.store.current();
        if (snapshot?.storyContractVersion !== 6 || !this.current(snapshot.snapshotId, task.id)) return { kind: 'rejected', errors: ['This diagram belongs to an obsolete explanation.'] };
        const diff = this.diffs.get(snapshot.diffId);
        if (diff === undefined) { this.schedule(); return { kind: 'deferred', errors: ['Saved diff is loading. Retry completion.'] }; }
        const checked = validateArchitectureCheckpoint(result, snapshot, diff, undefined, this.options.store.flowBeforeRetry(snapshot.snapshotId), true);
        if (!checked.ok) return { kind: 'rejected', errors: checked.errors };
        return { kind: 'accepted', persist: () => {
            if (this.current(snapshot.snapshotId, task.id)) this.options.store.applyCheckpoint(checked.value.overview, checked.value.files, snapshot.provenance);
        } };
    }
    private payload(snapshot: RouteSnapshot, diff: PrDiff) {
        const { shared } = this.options;
        const dir = path.join(this.options.dir, randomUUID());
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const schema = path.join(dir, 'result-schema.json');
        const overview = path.join(dir, 'accepted-overview.json');
        fs.writeFileSync(schema, JSON.stringify(generateJsonSchemas().allFilesResult), { mode: 0o600 });
        fs.writeFileSync(overview, JSON.stringify({ summary: snapshot.summary, flow: this.options.store.flowBeforeRetry(snapshot.snapshotId),
            blocks: snapshot.stops.map((block) => ({ id: block.id, title: block.title, paragraph: block.paragraph, nodeIds: block.nodeIds,
                files: block.guidedFiles?.map((file) => file.path), relatedFiles: block.relatedFiles?.map((file) => file.path) })) }), { mode: 0o600 });
        const target = materializeReviewTarget(shared, { diff, meta: null }).target;
        return { type: 'route.diagram' as const, priority: 'background' as const,
            instructions: `Help repair or refine the PR architecture. Choose what to research using ordinary PR/code tools at the pinned revision; context files are optional. Return update.flow and update.blocks by ID when links need to change. Saved file explanations and reading position are preserved. You may also correct accepted files. Write in ${snapshot.provenance.locale === 'ru' ? 'Russian' : 'English'} and follow the attached checkpoint schema.\nPinned target: ${JSON.stringify({ diffId: diff.diffId, baseCommit: diff.baseCommit, headCommit: diff.headCommit })}`,
            contextFiles: [target, overview], resultSchemaFile: schema };
    }
}
