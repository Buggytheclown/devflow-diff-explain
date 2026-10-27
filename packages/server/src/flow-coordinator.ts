import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FlowContext, FlowDiagram, FlowState, PrDiff, ReviewSource, RouteSnapshot } from '@sherpa/protocol';
import { flowDiagramResultSchema, generateJsonSchemas } from '@sherpa/protocol';
import type { TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import type { RouteStore } from './route-store.js';
import { savedPatchIndex } from './saved-patch.js';
import { CONTEXT_BUDGET_BYTES, prDiffPayload } from './route-payload.js';
import type { SharedPayloadStore } from './shared-payload.js';
import { diffKeyOf } from './shared-payload.js';

interface Options {
    store: RouteStore; queue: TaskQueue; host: ReviewSource | null; dir: string; shared: SharedPayloadStore;
    loadDiff: (id: string) => Promise<PrDiff>;
}

/** Отдельный автомат: ошибка схемы не меняет готовность рассказа и полных патчей. */
export class FlowCoordinator {
    private stopped = false;
    private busy = false;
    private scheduled = false;
    private unsubscribers: (() => void)[] = [];
    private readonly diffs = new Map<string, PrDiff>();
    constructor(private readonly options: Options) {}

    start(): void {
        this.unsubscribers = [this.options.store.subscribe(() => { this.schedule(); }), this.options.queue.subscribeChanges(() => { this.schedule(); })];
        this.schedule();
    }
    close(): void { this.stopped = true; for (const stop of this.unsubscribers) stop(); }
    private schedule(): void {
        if (this.scheduled || this.stopped) return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; void this.reconcile(); });
    }
    private async reconcile(): Promise<void> {
        if (this.busy || this.stopped) return;
        this.busy = true;
        const { store, queue } = this.options;
        const snapshot = store.current();
        const replacing = store.read().phase === 'reading';
        try {
            // Отмена устаревших задач не затрагивает сохранённую схему предыдущего рассказа.
            for (const task of queue.listTasks()) {
                if (task.type === 'route.diagram' && (task.status === 'queued' || task.status === 'leased') && task.id !== (!replacing && snapshot?.flow?.status === 'pending' ? snapshot.flow.taskId : null)) queue.cancel(task.id);
            }
            if (replacing || store.generation()?.status === 'cancelled') return;
            if (snapshot?.storyContractVersion !== 5 && store.read().phase === 'ready' && snapshot?.flow === undefined) return;
            if ((snapshot?.storyContractVersion !== 4 && snapshot?.storyContractVersion !== 5) || (snapshot.flow !== undefined && snapshot.flow.status !== 'pending')) return;
            const state: Extract<FlowState, {status: 'pending'}> = snapshot.flow ?? { status: 'pending', taskId: null, round: 0, requests: [], contexts: [], missing: [] };
            if (state.taskId !== null) {
                const task = queue.listTasks().find((entry) => entry.id === state.taskId);
                if (task === undefined || task.status === 'failed' || task.status === 'cancelled' || task.status === 'done') store.setFlow(snapshot.snapshotId, { status: 'unavailable', reason: this.message(snapshot, 'Схема недоступна. Рассказ и дифф можно читать.', 'Diagram unavailable. The explanation and diff remain available.') });
                return;
            }
            const diff = await this.options.loadDiff(snapshot.diffId);
            if (!this.current(snapshot.snapshotId, state.taskId)) return;
            this.diffs.clear(); this.diffs.set(diff.diffId, diff);
            if (state.requests.length > 0) {
                const contexts = [...state.contexts]; const missing = [...state.missing];
                const meta = await bounded(this.options.host?.getPr() ?? Promise.resolve(null)).catch(() => null);
                for (const request of state.requests) {
                    if (!this.current(snapshot.snapshotId, null)) return;
                    try {
                        if (!meta?.capabilities.sourceAtRevision || !this.options.host?.getSourceAtRevision) throw new Error('Source at revision is unavailable');
                        const text = await bounded(this.options.host.getSourceAtRevision(request.path, diff.headCommit));
                        if (text === null || text.includes('\0')) throw new Error('Text unavailable');
                        const lines = text.split('\n');
                        if (request.end > lines.length) throw new Error('Lines unavailable');
                        const excerpt = lines.slice(request.start - 1, request.end).join('\n');
                        if (excerpt.length > 24_000) throw new Error('Excerpt too large');
                        contexts.push({ ...request, id: `context-${String(contexts.length + 1)}`, revision: diff.headCommit, text: excerpt });
                    } catch { missing.push(`${request.path}:${String(request.start)}-${String(request.end)} @ ${diff.headCommit}`); }
                }
                if (this.current(snapshot.snapshotId, null)) store.setFlow(snapshot.snapshotId, { ...state, requests: [], contexts, missing });
                return;
            }
            const task = queue.enqueue(this.payload(snapshot, state, diff));
            store.setFlow(snapshot.snapshotId, { ...state, taskId: task.id });
        } catch {
            if (snapshot !== null && this.current(snapshot.snapshotId, null)) store.setFlow(snapshot.snapshotId, { status: 'unavailable', reason: this.message(snapshot, 'Не удалось подготовить схему по сохранённой версии кода.', 'Could not prepare a diagram from the saved code revision.') });
        } finally { this.busy = false; if (store.current()?.snapshotId !== snapshot?.snapshotId) this.schedule(); }
    }
    private current(id: string, taskId: number | null): boolean {
        const value = this.options.store.current();
        return !this.stopped && this.options.store.generation()?.status !== 'cancelled' && this.options.store.read().phase !== 'reading' && value?.snapshotId === id && (value.flow === undefined ? taskId === null : value.flow.status === 'pending' && value.flow.taskId === taskId);
    }
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type !== 'route.diagram') return null;
        const snapshot = this.options.store.current();
        const state = snapshot?.flow;
        if (this.options.store.read().phase === 'reading' || snapshot === null || state?.status !== 'pending' || state.taskId !== task.id) return { kind: 'rejected', errors: ['This diagram belongs to an obsolete explanation.'] };
        const diff = this.diffs.get(snapshot.diffId);
        if (diff === undefined) { void this.options.loadDiff(snapshot.diffId).then((value) => { this.diffs.set(value.diffId, value); }).catch(() => undefined); return { kind: 'deferred', errors: ['Saved diff is loading. Retry completion.'] }; }
        let raw: unknown;
        try { raw = JSON.parse(result); } catch { return { kind: 'rejected', errors: ['Return valid JSON.'] }; }
        const parsed = flowDiagramResultSchema.safeParse(raw);
        if (!parsed.success) return { kind: 'rejected', errors: parsed.error.issues.map((issue) => issue.message) };
        const value = parsed.data;
        if (value.outcome === 'not_applicable' && state.missing.length > 0) return { kind: 'rejected', errors: ['Missing context is unavailability, not evidence that a diagram is inapplicable. Return a partial diagram or outcome unavailable.'] };
        if (value.contextRequests.length > 0 && state.round >= 2) return { kind: 'rejected', errors: ['Context budget exhausted. Return a partial diagram with local unknowns, or a reason.'] };
        const errors = value.diagram === null ? [] : diagramSourceErrors(value.diagram, diff, state.contexts);
        if (errors.length > 0) return { kind: 'rejected', errors };
        const next: FlowState = value.contextRequests.length > 0 ? { ...state, taskId: null, round: state.round + 1, requests: value.contextRequests }
            : value.diagram !== null ? { status: 'ready', diagram: value.diagram, contexts: state.contexts }
                : { status: value.outcome === 'not_applicable' ? 'not_applicable' : 'unavailable', reason: value.reason ?? 'Diagram unavailable.' };
        return { kind: 'accepted', onCommitted: () => { if (this.current(snapshot.snapshotId, task.id)) this.options.store.setFlow(snapshot.snapshotId, next); } };
    }
    private message(snapshot: RouteSnapshot, ru: string, en: string): string { return snapshot.provenance.locale === 'ru' ? ru : en; }
    private payload(snapshot: RouteSnapshot, state: Extract<FlowState, {status:'pending'}>, diff: PrDiff) {
        const { shared } = this.options;
        const dir = path.join(this.options.dir, randomUUID());
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const schema = path.join(dir, 'result-schema.json');
        const context = path.join(dir, 'context.json');
        fs.writeFileSync(schema, JSON.stringify(generateJsonSchemas().flowDiagramResult), { mode: 0o600 });
        fs.writeFileSync(context, JSON.stringify({ snapshotId: snapshot.snapshotId, revision: diff.headCommit, description: snapshot.summary, blocks: snapshot.stops.map((stop) => ({ title: stop.title, files: stop.guidedFiles?.map((file) => file.path) })), contextRoundsRemaining: 2 - state.round, contexts: state.contexts, unavailable: state.missing }), { mode: 0o600 });
        const key = diffKeyOf(diff);
        const prDiff = shared.prDiff(key, prDiffPayload({ diff, meta: null }, CONTEXT_BUDGET_BYTES).content);
        const guide = shared.guide('flow-diagram', `Explain the overall data flow in ${snapshot.provenance.locale === 'ru' ? 'Russian' : 'English'}.
Draw a small meaningful source -> transformation -> consumer flow. Order edges along that understandable path, keeping related transitions consecutive. Include necessary unchanged/external context so the change makes sense, not the whole architecture. Usually 3–6 nodes are enough; add only context needed to understand this PR. Use plain short node and arrow labels, ideally 2–5 words. Do not repeat the prose or put caveats in labels: keep precise evidence limits in limitation, which the UI shows in expandable diagram sources. Reuse a node id when a path branches or cycles; never duplicate a node to lay out the picture. Nodes are static; no navigation fields.
Every node AND edge has change: existing, added, modified, or unknown. Mark only what this PR demonstrably changes. Every edge has kind: data or control, and a label saying what passes or what starts. Runtime wiring must be confirmed, not inferred from executors/exports alone. Retry permission is not guaranteed retry.
Known items need minimal sources: {kind:patch,path,side,start,end} in the saved full diff, or {kind:context,id} from saved context snippets. Changed items need changed patch lines. Unknown items need a local limitation; say what is unknown instead of asserting an unverified connection.
If the diff omits necessary context, request up to four specific path/start/end ranges (80 lines each). The server reads only the pinned head revision and returns saved snippets. At most two rounds. Do not browse current checkout or remote code yourself. Unavailable context stays unknown. Use the saved patch index for omitted PR patches.
Return contextRequests with diagram:null to request context; otherwise return contextRequests:[] and diagram. If the accessible change has no useful data/control flow, return diagram:null, outcome:not_applicable and a concise localized reason. Missing necessary context, source errors or technical failures require outcome:unavailable; they never mean not_applicable. For a ready diagram or context request omit outcome. Follow the attached JSON schema. Do not claim examples or code were executed.`);
        return { type: 'route.diagram' as const, priority: 'background' as const, instructions: 'Read the saved PR context and guide. Explain the general flow and mark the PR changes. Return JSON matching the schema.', contextFiles: [guide, prDiff, context], resultSchemaFile: schema };
    }
}

/** Проверяем наличие всех строк, а не только попадание концов в разные ханки. */
export function diagramSourceErrors(diagram: FlowDiagram, diff: PrDiff, contexts: readonly FlowContext[]): string[] {
    const errors: string[] = [];
    const index = savedPatchIndex(diff);
    for (const item of [...diagram.nodes, ...diagram.edges]) {
        let changed = false;
        for (const source of item.sources) {
            if (source.kind === 'context') {
                if (!contexts.some((entry) => entry.id === source.id && entry.revision === diff.headCommit)) errors.push(`Unknown saved context: ${source.id}`);
                continue;
            }
            const lines = index.range(index.file(source.path, source.side), source);
            if (lines === null) errors.push(`Unavailable saved patch lines: ${source.path}:${String(source.start)}-${String(source.end)}`);
            changed ||= lines?.some((line) => line.changed) ?? false;
        }
        if ((item.change === 'added' || item.change === 'modified') && !changed) errors.push('PR changes need supporting changed patch lines.');
    }
    return errors;
}

function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('Source read timed out')); }, 10_000); timer.unref(); })]).finally(() => { clearTimeout(timer); });
}
