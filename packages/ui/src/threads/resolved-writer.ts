/**
 * Сериализует resolve/unresolve одной сущности: последнее действие всегда уходит на хост
 * последним. `id` — тред на хосте без `commentResolve` и отдельный issue-комментарий на хосте
 * с ним; механика очереди и отката у них общая.
 */
export interface ResolvedWriterOptions {
    readonly read: (id: string) => boolean;
    /** Последнее серверное значение из SSE-снапшота, если сущность ещё существует. */
    readonly readConfirmed?: (id: string) => boolean | null;
    readonly apply: (id: string, resolved: boolean) => void;
    readonly rollback?: (id: string, resolved: boolean) => void;
    /** false — SSE уже подтвердил значение и снял оптимистичный слой. */
    readonly shouldRollback?: (id: string) => boolean;
    readonly send: (id: string, resolved: boolean) => Promise<void>;
}

export interface ResolvedWriter {
    /** Оптимистично применяет значение; false означает, что последняя запись сорвалась. */
    readonly write: (id: string, resolved: boolean) => Promise<boolean>;
}

interface PendingWrite {
    readonly seq: number;
    chain: Promise<void>;
    confirmed: boolean;
}

const RESOLVED = Promise.resolve();
const persistentWriters = new WeakMap<object, Map<string, ResolvedWriter>>();

/**
 * Очередь привязана к долгоживущему стору и не сбрасывается при ремаунте Full diff.
 * `scope` разводит очереди тредов и комментариев: id у них из разных пространств.
 */
export function resolvedWriterFor(key: object, scope: string, options: ResolvedWriterOptions): ResolvedWriter {
    const byScope = persistentWriters.get(key) ?? new Map<string, ResolvedWriter>();
    persistentWriters.set(key, byScope);
    const existing = byScope.get(scope);
    if (existing !== undefined) {
        return existing;
    }
    const created = createResolvedWriter(options);
    byScope.set(scope, created);
    return created;
}

export function createResolvedWriter(options: ResolvedWriterOptions): ResolvedWriter {
    const writes = new Map<string, PendingWrite>();
    let seq = 0;

    return {
        write: async (id, resolved) => {
            const previous = writes.get(id);
            const pending: PendingWrite = {
                seq: (seq += 1),
                confirmed: previous?.confirmed ?? options.read(id),
                chain: RESOLVED,
            };
            options.apply(id, resolved);

            const request = (previous?.chain ?? RESOLVED).then(async () => {
                pending.confirmed = previous?.confirmed ?? pending.confirmed;
                await options.send(id, resolved);
                pending.confirmed = resolved;
            });
            pending.chain = request.then(
                () => undefined,
                () => {
                    pending.confirmed = options.readConfirmed?.(id) ?? pending.confirmed;
                },
            );
            writes.set(id, pending);

            try {
                await request;
                return true;
            } catch {
                pending.confirmed = options.readConfirmed?.(id) ?? pending.confirmed;
                // Старый отказ не имеет права стирать более свежее оптимистичное действие.
                const latest = writes.get(id)?.seq === pending.seq;
                if (latest && options.shouldRollback?.(id) === false) {
                    // Ответ POST потерян, но SSE уже подтвердил то же значение.
                    return true;
                }
                if (latest) {
                    (options.rollback ?? options.apply)(id, pending.confirmed);
                }
                return false;
            } finally {
                if (writes.get(id)?.seq === pending.seq) {
                    writes.delete(id);
                }
            }
        },
    };
}
