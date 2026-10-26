import type { RpcErrorCode } from '@sherpa/protocol';

/**
 * Ошибка, текст которой уже готов к показу модели: что случилось и что делать дальше.
 * Стеки и дампы наружу не выходят — вывод CLI читает языковая модель (`docs/protocol.md §3`).
 */
export class CliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliError';
    }
}

/**
 * Отказ сервера по контракту. Текст печатается как есть, а код нужен командам,
 * которые на отдельные отказы отвечают своим ходом, а не выходом с ошибкой.
 */
export class RpcCallError extends CliError {
    readonly code: RpcErrorCode;

    constructor(code: RpcErrorCode, message: string) {
        super(message);
        this.name = 'RpcCallError';
        this.code = code;
    }
}

/** Текст для пользователя из любой пойманной ошибки. */
export function userMessage(error: unknown): string {
    if (error instanceof CliError) {
        return error.message;
    }

    const detail = error instanceof Error ? error.message : String(error);
    return `devflow-diff-explain: unexpected failure — ${detail}\nRepeat the command; if it keeps failing, restart the Sherpa skill.`;
}
