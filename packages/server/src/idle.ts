/**
 * Самоостановка сервера по простою. Сервер PR — фоновый демон, поднятый `devflow-diff-explain up`: без этого
 * он висел бы в памяти до перезагрузки машины, потому что команды `down` в контракте нет.
 * Состояние живёт в SQLite и остановку переживает — следующий `up` поднимает сервер заново.
 */

/** Порог простоя по умолчанию: четверть часа без UI и без вызовов CLI. */
export const DEFAULT_IDLE_SECONDS = 15 * 60;

/** Шаг проверки простоя: при пороге в четверть часа минуты хватает, короткий порог опрашивается чаще. */
const MAX_CHECK_INTERVAL_MS = 60_000;
const MIN_CHECK_INTERVAL_MS = 50;

/** Недокументированное переопределение порога: им сквозной тест бандла сокращает четверть часа до секунд. */
const IDLE_SECONDS_ENV = 'SHERPA_IDLE_SECONDS';

export interface IdleWatchOptions {
    /** Порог простоя в секундах; `0` — самоостановка выключена. */
    readonly idleSeconds: number;
    /** Инжектируемые часы, как в очереди и регистре воркера: тесты гоняют простой без ожидания. */
    readonly now?: () => Date;
}

/**
 * Учёт занятости сервера для HTTP-слоя: одна точка на входе роутера вместо отметок в каждой ручке.
 */
export interface ActivityTracker {
    /** Запрос пришёл; возвращённую функцию роутер зовёт, когда соединение этого ответа закрылось. */
    open: () => () => void;
}

/**
 * Сервер занят, пока открыто хотя бы одно соединение (вкладка UI на SSE, висящий long-poll `next`)
 * или пока с последнего запроса прошло меньше порога. Внутренние таймеры — keepalive SSE, таймер
 * смерти воркера — активностью не считаются: иначе сервер не умрёт никогда.
 */
export class IdleWatch implements ActivityTracker {
    private readonly idleMs: number;
    private readonly now: () => Date;

    private openConnections = 0;
    private lastActivity: number;
    private timer: NodeJS.Timeout | null = null;
    private onIdle: (() => void) | null = null;
    private fired = false;

    constructor(options: IdleWatchOptions) {
        this.idleMs = Math.max(options.idleSeconds, 0) * 1000;
        this.now = options.now ?? ((): Date => new Date());
        this.lastActivity = this.now().getTime();
    }

    /** Выключенный порог: активность считается по-прежнему, но останавливать сервер никто не станет. */
    get enabled(): boolean {
        return this.idleMs > 0;
    }

    open(): () => void {
        this.openConnections += 1;
        this.lastActivity = this.now().getTime();

        let closed = false;
        return () => {
            if (closed) {
                return;
            }
            closed = true;
            this.openConnections -= 1;
            // Отсчёт простоя идёт от закрытия соединения, а не от его открытия: у SSE и long-poll
            // между этими моментами минуты.
            this.lastActivity = this.now().getTime();
        };
    }

    /**
     * Взводит самоостановку. До этого момента активность уже считается, но останавливать нечего:
     * сервер ещё поднимается.
     */
    arm(onIdle: () => void): void {
        if (!this.enabled || this.fired || this.timer !== null) {
            return;
        }

        this.onIdle = onIdle;
        const timer = setInterval(() => {
            this.checkNow();
        }, this.checkIntervalMs());
        // Таймер простоя сам процесс живым держать не должен.
        timer.unref();
        this.timer = timer;
    }

    /** Немедленная проверка: в проде её дёргает таймер, в тестах — сдвиг часов. */
    checkNow(): void {
        const onIdle = this.onIdle;
        if (onIdle === null || this.openConnections > 0) {
            return;
        }
        if (this.now().getTime() - this.lastActivity < this.idleMs) {
            return;
        }

        this.fired = true;
        this.close();
        onIdle();
    }

    /** Гасит таймер простоя: после остановки сервера будить некого. Повторный вызов — no-op. */
    close(): void {
        this.onIdle = null;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private checkIntervalMs(): number {
        return Math.max(MIN_CHECK_INTERVAL_MS, Math.min(MAX_CHECK_INTERVAL_MS, this.idleMs / 2));
    }
}

/**
 * Порог простоя из окружения (`SHERPA_IDLE_SECONDS`, недокументированный): им сквозной тест бандла
 * сокращает четверть часа до секунд. Мусор, пустое значение и отрицательные числа — дефолт.
 */
export function readIdleSeconds(env: NodeJS.ProcessEnv): number {
    const raw = env[IDLE_SECONDS_ENV];
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_IDLE_SECONDS;
    }

    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_IDLE_SECONDS;
}

/** Порог простоя для строки лога: минуты для круглых значений, иначе секунды. */
export function formatIdlePeriod(seconds: number): string {
    if (seconds >= 60 && seconds % 60 === 0) {
        return `${String(seconds / 60)} мин`;
    }
    return `${String(seconds)} с`;
}
