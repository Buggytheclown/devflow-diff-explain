import type { CapturedPr, CodeReader } from '@sherpa/protocol';
import { capturedPrSchema } from '@sherpa/protocol';

export interface PrMetaCacheOptions {
    /** Локальный читатель импортированного снимка. */
    readonly host: CodeReader | null;
    readonly retryIntervalMs?: number;
}

/** Метаданные последнего явного импорта для синхронной сборки SSE-состояния. */
export class PrMetaCache {
    private readonly host: CodeReader | null;
    private readonly listeners = new Set<() => void>();
    private meta: CapturedPr | null = null;
    private closed = false;
    /** Номер последнего выданного `refresh()`; растёт в порядке старта запросов. */
    private started = 0;
    /** Номер запроса, чей ответ сейчас лежит в кеше. */
    private applied = 0;

    constructor(options: PrMetaCacheOptions) {
        this.host = options.host;
    }

    /** Синхронный источник для `buildState`. */
    get(): CapturedPr | null {
        return this.meta;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Начальная загрузка из локального снимка; polling отсутствует. */
    start(): void {
        if (this.host === null || this.closed) {
            return;
        }
        void this.refresh();
    }

    /** Явное обновление; ошибка чтения сохраняет прежнее значение. */
    async refresh(): Promise<void> {
        if (this.host === null || this.closed) {
            return;
        }
        const generation = ++this.started;
        let meta: CapturedPr | null;
        try {
            const imported = await this.host.getPr();
            meta = imported === null ? null : capturedPrSchema.parse(imported);
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
            try { listener(); } catch (error) { console.error('sherpa-server: ошибка подписчика метаданных', error); }
        }
    }

    /** Останавливает локальные уведомления. */
    close(): void {
        this.closed = true;
        this.listeners.clear();
    }
}
