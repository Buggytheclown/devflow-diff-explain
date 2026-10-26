import type { ReviewHost, Thread } from '@sherpa/protocol';

/**
 * Одна подписка сервера на треды хоста и монотонная ревизия для SSE (`UI_REVIEW_EVENT`).
 * Снапшот тредов в событие не едет — UI перечитывает ручку, когда ревизия выросла.
 *
 * Подписка ленивая: стартует с первым SSE-клиентом и гаснет без клиентов — иначе поллинг
 * Арканума крутился бы в пустоту (а самоостановка сервера внутренние таймеры активностью
 * не считает, см. `idle.ts`).
 */
export interface ReviewFeedOptions {
    /**
     * Хост-специфичная подписка на смену статуса ревью: у Арканума это `common_status`
     * в том же дешёвом полле. Живёт в фиде, потому что её лень должна совпадать с ленью тредов.
     */
    readonly watchStatus?: (onChange: () => void) => () => void;
    /** Что делать на смене статуса: сервер перечитывает мету PR. */
    readonly onStatusChange?: () => void;
}

export class ReviewFeed {
    private readonly host: ReviewHost | null;
    private readonly watchStatus: ((onChange: () => void) => () => void) | null;
    private readonly onStatusChange: (() => void) | null;
    private readonly listeners = new Set<(revision: number) => void>();

    private revisionValue = 0;
    private unwatch: (() => void) | null = null;
    private unwatchStatus: (() => void) | null = null;
    /** Последний виденный снапшот: переживает остановку подписки, чтобы реконнект не врал ревизией. */
    private lastSnapshot: string | null = null;
    private closed = false;

    constructor(host: ReviewHost | null, options: ReviewFeedOptions = {}) {
        this.host = host;
        this.watchStatus = options.watchStatus ?? null;
        this.onStatusChange = options.onStatusChange ?? null;
    }

    get revision(): number {
        return this.revisionValue;
    }

    /** Локальная write-ручка изменила треды: будим UI, не дожидаясь поллинга хоста. */
    bumpLocalWrite(): number {
        if (this.closed) {
            return this.revisionValue;
        }
        this.revisionValue += 1;
        for (const listener of [...this.listeners]) {
            listener(this.revisionValue);
        }
        return this.revisionValue;
    }

    subscribe(listener: (revision: number) => void): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.listeners.add(listener);
        this.start();

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.stop();
            }
        };
    }

    /** Останавливает подписку и отпускает слушателей: сервер закрывается. */
    close(): void {
        this.closed = true;
        this.listeners.clear();
        this.stop();
    }

    private start(): void {
        if (this.host === null || this.unwatch !== null) {
            return;
        }
        this.unwatch = this.host.watchThreads((threads) => {
            this.onThreads(threads);
        });
        const onStatusChange = this.onStatusChange;
        if (this.watchStatus !== null && onStatusChange !== null) {
            this.unwatchStatus = this.watchStatus(onStatusChange);
        }
    }

    private stop(): void {
        this.unwatch?.();
        this.unwatch = null;
        this.unwatchStatus?.();
        this.unwatchStatus = null;
    }

    private onThreads(threads: Thread[]): void {
        let snapshot: string;
        try {
            snapshot = JSON.stringify(threads);
        } catch {
            // Снапшот не сериализуется — считать его изменившимся честнее, чем проглотить.
            snapshot = `unserializable#${String(this.revisionValue + 1)}`;
        }
        if (snapshot === this.lastSnapshot) {
            return;
        }

        this.lastSnapshot = snapshot;
        this.revisionValue += 1;
        for (const listener of [...this.listeners]) {
            listener(this.revisionValue);
        }
    }
}
