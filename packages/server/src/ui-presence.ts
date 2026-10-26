import { UI_GONE_GRACE_SECONDS } from '@sherpa/protocol';

export interface UiPresenceOptions {
    /** Инжектируемые часы: тесты проходят минутный грейс без реального ожидания. */
    readonly now?: () => Date;
    /** Контрактный грейс ухода UI; тесты могут сократить его через композицию сервера. */
    readonly graceSeconds?: number;
}

/**
 * Присутствие ревьюера по SSE: UI считается ушедшим, когда последнее соединение закрыто дольше
 * грейса. До первого подключения уход невозможен; возврат UI начинает состояние заново.
 */
export class UiPresence {
    private readonly now: () => Date;
    private readonly graceMs: number;
    private readonly listeners = new Set<() => void>();

    private connections = 0;
    private connectedBefore = false;
    private gone = false;
    private goneDeadline: number | null = null;
    private goneTimer: NodeJS.Timeout | null = null;
    private closed = false;

    constructor(options: UiPresenceOptions = {}) {
        this.now = options.now ?? ((): Date => new Date());
        this.graceMs = Math.max(options.graceSeconds ?? UI_GONE_GRACE_SECONDS, 0) * 1000;
    }

    /** Число живых SSE-подключений UI. */
    get connectionCount(): number {
        return this.connections;
    }

    /** UI был подключён и отсутствует дольше грейса. */
    get uiGone(): boolean {
        this.checkNow();
        return this.gone;
    }

    /** Учитывает живое SSE-соединение; возвращённая функция снимает его ровно один раз. */
    connect(): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.connections += 1;
        this.connectedBefore = true;
        this.gone = false;
        this.goneDeadline = null;
        this.clearGoneTimer();

        let disconnected = false;
        return () => {
            if (disconnected || this.closed) {
                return;
            }
            disconnected = true;
            this.connections -= 1;
            if (this.connections === 0) {
                this.goneDeadline = this.now().getTime() + this.graceMs;
                this.scheduleGoneCheck();
                this.checkNow();
            }
        };
    }

    /** Подписка на переход в `uiGone`; возвращает функцию отписки. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Немедленная переоценка: в тестах вызывается после сдвига инжектируемых часов. */
    checkNow(): void {
        if (
            this.closed ||
            this.gone ||
            !this.connectedBefore ||
            this.connections > 0 ||
            this.goneDeadline === null ||
            this.now().getTime() < this.goneDeadline
        ) {
            return;
        }

        this.gone = true;
        this.goneDeadline = null;
        this.clearGoneTimer();
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    /** Гасит таймер и подписки при остановке сервера. */
    close(): void {
        this.closed = true;
        this.clearGoneTimer();
        this.listeners.clear();
    }

    /** Таймер нужен для продакшена; с фиктивными часами тесты вызывают `checkNow()` сами. */
    private scheduleGoneCheck(): void {
        this.clearGoneTimer();
        if (this.goneDeadline === null) {
            return;
        }

        const delay = Math.max(this.goneDeadline - this.now().getTime(), 0);
        const timer = setTimeout(() => {
            this.goneTimer = null;
            this.checkNow();
        }, delay);
        timer.unref();
        this.goneTimer = timer;
    }

    private clearGoneTimer(): void {
        if (this.goneTimer !== null) {
            clearTimeout(this.goneTimer);
            this.goneTimer = null;
        }
    }
}
