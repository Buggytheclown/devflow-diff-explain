import type { RpcErrorCode } from '@sherpa/protocol';

/**
 * Ошибка доменного слоя с кодом контракта: ручки переводят её в тело `rpcError`
 * и соответствующий HTTP-статус, ничего не додумывая.
 */
export class RpcFailure extends Error {
    readonly code: RpcErrorCode;
    readonly details: readonly string[] | undefined;

    constructor(code: RpcErrorCode, message: string, details?: readonly string[]) {
        super(message);
        this.name = 'RpcFailure';
        this.code = code;
        this.details = details;
    }
}

/** Живой сервер того же PR уже держит манифест — второй процесс подниматься не должен (docs/architecture.md §1). */
export class ServerAlreadyRunningError extends Error {
    readonly prKey: string;
    readonly port: number;
    readonly pid: number;

    constructor(details: { prKey: string; port: number; pid: number }) {
        super(
            `Сервер Шерпы для PR ${details.prKey} уже запущен: PID ${String(details.pid)}, ` +
                `порт ${String(details.port)}. Второй сервер на тот же PR не поднимается.`,
        );
        this.name = 'ServerAlreadyRunningError';
        this.prKey = details.prKey;
        this.port = details.port;
        this.pid = details.pid;
    }
}

/**
 * Текст сетевой ошибки `fetch` для лога и ответа ручки. Сам `fetch` бросает безликое
 * «fetch failed», а причина (`SELF_SIGNED_CERT_IN_CHAIN`, `ECONNREFUSED`) лежит в `cause` —
 * без неё по логу не понять, что сломалось. Таймаут по `AbortSignal.timeout` — своя формулировка.
 */
export function describeFetchError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    if (error.name === 'TimeoutError') {
        return 'таймаут';
    }
    const cause = describeCause(error.cause);
    return cause === null ? error.message : `${error.message}: ${cause}`;
}

function describeCause(cause: unknown): string | null {
    if (!(cause instanceof Error)) {
        return null;
    }
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
    if (code === null) {
        return cause.message;
    }
    return cause.message === '' ? code : `${code} ${cause.message}`;
}
