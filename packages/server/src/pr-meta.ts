import type { PrMeta, ReviewHost } from '@sherpa/protocol';
import { prMetaSchema } from '@sherpa/protocol';

/** Через столько повторяем первую загрузку меты, пока хост не ответил ни разу. */
const RETRY_INTERVAL_MS = 30_000;

export interface PrMetaCacheOptions {
    /** null — у PR нет хост-адаптера: мета останется null навсегда. */
    readonly host: ReviewHost | null;
    readonly retryIntervalMs?: number;
}

/**
 * Кеш меты PR для снапшота UI. `buildState` синхронна (её зовут таймер SSE и пуш изменений),
 * а `getPr()` — сетевой вызов хоста, поэтому мета наполняется вне сборки снапшота: при старте
 * сервера и после публикации вердикта. До первого успеха `get()` отдаёт null, и UI честно
 * рисует заглушки. Каждое обновление будит подписчиков — снапшот с новой метой уезжает по SSE.
 */
export class PrMetaCache {
    private readonly host: ReviewHost | null;
    private readonly retryIntervalMs: number;
    private readonly listeners = new Set<() => void>();
    private meta: PrMeta | null = null;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    /** Номер последнего выданного `refresh()`; растёт в порядке старта запросов. */
    private started = 0;
    /** Номер запроса, чей ответ сейчас лежит в кеше. */
    private applied = 0;

    constructor(options: PrMetaCacheOptions) {
        this.host = options.host;
        this.retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
    }

    /** Синхронный источник для `buildState`. */
    get(): PrMeta | null {
        return this.meta;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Первая загрузка меты с повторами до первого успеха: без неё UI до самой публикации
     * вердикта показывал бы заглушку вместо хлебных крошек. После успеха хост больше не опрашивается —
     * мету обновляют события, которые её меняют.
     */
    start(): void {
        if (this.host === null || this.closed) {
            return;
        }
        void this.refresh().then(() => {
            if (this.meta === null && !this.closed) {
                this.retry = setTimeout(() => {
                    this.retry = null;
                    this.start();
                }, this.retryIntervalMs);
                this.retry.unref();
            }
        });
    }

    /**
     * Перечитывает мету у хоста. Провал (сеть, токен, ответ не сошёлся с контрактом) глотается
     * логом: прежнее значение кеша остаётся на экране, а вызвавшая ручка от этого не падает.
     */
    async refresh(): Promise<void> {
        if (this.host === null || this.closed) {
            return;
        }
        const generation = ++this.started;
        let meta: PrMeta;
        try {
            meta = prMetaSchema.parse(await this.host.getPr());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: мета PR не обновилась: ${message}\n`);
            return;
        }
        // Параллельные вызовы завершаются не в том порядке, в каком стартовали: у хоста свои
        // ретраи с таймаутами, и запрос из start() легко доживает до ответа на публикацию.
        // Ответ, начатый раньше уже применённого, выбрасываем — иначе в кеше навсегда осел бы
        // допубликационный статус: после первого успеха сам себя кеш не перечитывает.
        if (generation < this.applied) {
            return;
        }
        // Ответ мог прийти уже после остановки сервера: подписчиков к этому моменту нет,
        // и запись в кеш никого не задевает.
        this.applied = generation;
        this.meta = meta;
        for (const listener of this.listeners) {
            listener();
        }
    }

    /** Гасит ретрай: иначе он проснулся бы уже после остановки сервера. */
    close(): void {
        this.closed = true;
        if (this.retry !== null) {
            clearTimeout(this.retry);
            this.retry = null;
        }
        this.listeners.clear();
    }
}
