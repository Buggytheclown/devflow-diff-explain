import type {
    RpcError,
    RpcErrorCode,
    Task,
    TaskAckResponse,
    TaskCompleteResponse,
} from '@sherpa/protocol';
import { PROTOCOL_VERSION } from '@sherpa/protocol';

import { formatCommand } from './command.js';
import { CLI_VERSION } from './version.js';

/**
 * Задача в промпт-формате (`docs/protocol.md §4`): модель читает вывод глазами, поэтому в нём
 * инструкция, пути к контексту, выданный CLI файл результата и готовые команды сдачи —
 * тяжёлый контекст остаётся файлами.
 */
export function formatTask(task: Task, resultFile: string, prKey: string, leaseRef: string, entry = process.argv[1]): string {
    const lines = [
        `TASK sherpa/${String(task.id)} (${task.type}), attempt ${String(task.attempt)}`,
        '',
        task.instructions,
        '',
        ...(task.type === 'chat' && task.instructions.includes('Available context (read selectively;') ? [] : [`Context: ${task.contextFiles.length === 0 ? 'none' : task.contextFiles.join('\n')}`]),
    ];

    if (task.resultSchemaFile !== undefined) {
        lines.push(`Result schema: ${task.resultSchemaFile} — the result is validated against it.`);
    }

    lines.push(
        '',
        `Write the result to ${resultFile} and submit it:`,
        `  ${formatCommand(entry, 'task', 'complete', String(task.id), '--file', resultFile, '--pr', prKey, '--lease', leaseRef, '--next')}`,
        `Interim status: ${formatCommand(entry, 'task', 'progress', String(task.id), '--text', '...', '--pr', prKey, '--lease', leaseRef)}`,
        `Cannot do it: ${formatCommand(entry, 'task', 'fail', String(task.id), '--reason', '...', '--pr', prKey, '--lease', leaseRef)}`,
    );

    return lines.join('\n');
}

/**
 * Единственная ссылка, которую скилл показывает ревьюеру, — держать формат стабильным.
 * Токен во фрагменте: на сервер он не уходит, но переживает перезагрузку страницы (`docs/protocol.md §8`).
 */
export function formatUiUrl(port: number, token: string, host = '127.0.0.1'): string {
    const authority = host.includes(':') ? `[${host}]` : host;
    return `http://${authority}:${String(port)}/#t=${token}`;
}

/** Закрепляем сохранённые версии, оставляя актуальный токен авторизации сервера. */
export function formatSavedUiUrl(base: string, code: string | undefined, review: string | undefined, view: 'diff' | 'route' | undefined): string {
    if (code === undefined) return base;
    const url = new URL(base);
    const fragment = new URLSearchParams(url.hash.slice(1));
    fragment.set('code', code);
    if (review !== undefined) fragment.set('review', review);
    fragment.set('view', view ?? (review === undefined ? 'diff' : 'route'));
    url.hash = fragment.toString();
    return url.toString();
}

/** Ссылка для пользователя и следующий шаг сессии. */
export function formatUpReady(uiUrl: string, prKey: string, entry = process.argv[1]): string {
    return [uiUrl, '', 'Show this link to the user in full — it opens the explanation in their browser.',
        `Then run \`${formatCommand(entry, 'worker', 'next', '--pr', prKey)}\` and follow the instructions in its output.`].join('\n');
}

/** Работа воркера окончена: слово DONE — сигнал сессии завершаться (`docs/protocol.md §3`). */
export function formatDone(message: string): string {
    return `${message}\n\nDONE`;
}

/** `file` — путь, который воркер передал в `complete`: повтор команды идёт с ним же. */
export function formatCompleteResponse(response: TaskCompleteResponse, taskId: number, file: string, prKey: string, leaseRef = '', entry = process.argv[1]): string {
    switch (response.kind) {
        case 'partial':
        case 'accepted':
            return `${response.message}\nCall \`${formatCommand(entry, 'worker', 'next', '--pr', prKey)}\` for the next task.`;
        case 'rejected':
            return [
                `The result of task sherpa/${String(taskId)} was rejected:`,
                ...response.errors.map((error, index) => `  ${String(index + 1)}. ${error}`),
                ...(response.errors.some((error) => error.includes('now closed with an error')) ? [] : [`Fix it and call \`${formatCommand(entry, 'task', 'complete', String(taskId), '--file', file, '--pr', prKey, '--lease', leaseRef)}\` again.`]),
            ].join('\n');
        case 'noop':
            return `${response.message}\nCall \`${formatCommand(entry, 'worker', 'next', '--pr', prKey)}\` for the next task.`;
    }
}

export function formatProgressResponse(response: TaskAckResponse, taskId: number, prKey: string, entry = process.argv[1]): string {
    switch (response.kind) {
        case 'accepted':
            return `Status for task sherpa/${String(taskId)} recorded — carry on.`;
        case 'noop':
            return `${response.message}\nCall \`${formatCommand(entry, 'worker', 'next', '--pr', prKey)}\` for the next task.`;
    }
}

export function formatFailResponse(response: TaskAckResponse, taskId: number, prKey: string, entry = process.argv[1]): string {
    switch (response.kind) {
        case 'accepted':
            return (
                `The refusal of task sherpa/${String(taskId)} is accepted, the reviewer sees the reason.\n` +
                `Call \`${formatCommand(entry, 'worker', 'next', '--pr', prKey)}\` for the next task.`
            );
        case 'noop':
            return `${response.message}\nCall \`${formatCommand(entry, 'worker', 'next', '--pr', prKey)}\` for the next task.`;
    }
}

/**
 * Роль вызова в жизненном цикле воркера: от неё зависит следующий шаг при `worker_conflict`.
 * `register` — сессия только просится в воркеры и воркером ещё не была;
 * `worker` — сессия работала воркером и потеряла слот.
 */
export type CallRole = 'register' | 'worker';

/**
 * Ошибка сервера. Тексты контракта уже человеческие, поэтому CLI печатает их как есть
 * и добавляет следующий шаг только там, где из сообщения он не следует.
 */
export function formatRpcError(error: RpcError['error'], role: CallRole, entry = process.argv[1]): string {
    const lines = [`devflow-diff-explain: ${error.message}`];
    for (const detail of error.details ?? []) {
        lines.push(`  - ${detail}`);
    }

    const nextStep = nextStepFor(error.code, role, entry);
    if (nextStep !== undefined) {
        lines.push(nextStep);
    }
    return lines.join('\n');
}

/**
 * Локальный отказ до отправки: слишком большой результат сервер завершил бы задачу ошибкой,
 * а так задача остаётся в аренде и у модели есть попытка сократить файл.
 */
export function formatOversizedResult(taskId: number, file: string, bytes: number, prKey: string, limit: number, leaseRef = '', entry = process.argv[1]): string {
    return (
        `devflow-diff-explain: the result is ${kilobytes(bytes)} while the limit is ${kilobytes(limit)} — ` +
        `too large to submit.\nShorten ${file} and call ` +
        `\`${formatCommand(entry, 'task', 'complete', String(taskId), '--file', file, '--pr', prKey, '--lease', leaseRef)}\` again. ` +
        'The task stays yours, nothing is lost.'
    );
}

export function helpText(entry = process.argv[1]): string {
    const cli = formatCommand(entry);
    const commands: readonly (readonly [string, string])[] = [
        [
            `${cli} up [--snapshot <manifest.json> | --pr <saved key>] [--code <codeSnapshotId>] [--review <routeSnapshotId>] [--harness <name>] [--model <name>] ` +
                '[--lang <ru|en>] [--no-open]',
            'start the explanation server and become its worker',
        ],
        [
            `${cli} worker register [--harness <name>] [--model <name>] [--lang <ru|en>]`,
            'register this session as the PR worker',
        ],
        [`${cli} snapshot|sources schema`, 'print the import manifest schema'],
        [`${cli} snapshot|sources import --file <manifest.json> [--pr <key>]`, 'import artifacts into a running application'],
        [`${cli} worker next`, 'take the next task; waits for one as long as it takes'],
        [`${cli} task complete <id> --file <path> [--next]`, 'submit; --next waits for the next task'],
        [`${cli} task progress <id> --text "<text>"`, 'interim status for the reviewer'],
        [`${cli} task fail <id> --reason "<text>"`, 'refuse a task with a reason'],
    ];
    const flags: readonly (readonly [string, string])[] = [
        ['--pr <key>', 'the saved target to connect to; defaults to SHERPA_PR'],
        ['--snapshot <manifest.json>', 'import complete pinned bytes and inventory before preparing a new project'],
        ['--code <codeSnapshotId>', 'open a saved code version with a current server token'],
        ['--review <routeSnapshotId>', 'open a saved review of --code; omit to open the diff'],
        ['--harness <name>', 'harness label in the worker status; for `up` and `worker register`'],
        ['--model <name>', 'model name in the worker status; for `up` and `worker register`'],
        [
            '--lang <ru|en>',
            'the language you speak with the reviewer in; hints the answer language, omit if unsure',
        ],
        ['--no-open', 'do not open the browser after `up` starts a new server'],
        ['--version', 'CLI version'],
    ];

    return [
        `devflow-diff-explain ${CLI_VERSION} (protocol ${PROTOCOL_VERSION}) — the Devflow Diff Explain worker CLI.`,
        '',
        'Commands:',
        ...twoColumns(commands),
        '',
        'Flags:',
        ...twoColumns(flags),
    ].join('\n');
}

/** Выравнивание справки: колонка описаний общая для всего блока. */
function twoColumns(rows: readonly (readonly [string, string])[]): string[] {
    const width = Math.max(...rows.map(([left]) => left.length));
    return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

function nextStepFor(code: RpcErrorCode, role: CallRole, entry: string | undefined): string | undefined {
    // Свой сервер конфликтом на регистрацию не отвечает — слот перехватывается; но если ответил
    // (чужая сборка), терминальная приписка неверна: воркером эта сессия и не была.
    if (code === 'worker_conflict') {
        return role === 'register' ? undefined : WORKER_CONFLICT_STOP;
    }
    if (code === 'result_too_large') return `The task is closed and the reviewer sees why — call \`${formatCommand(entry, 'worker', 'next')}\` for the next one.`;
    return NEXT_STEP_BY_CODE[code];
}

/**
 * Слот воркера ушёл другой сессии посреди работы: петлю продолжать нечем.
 * Формулировка «stop the loop» — маркер из SKILL.md, менять её в отрыве от него нельзя.
 */
const WORKER_CONFLICT_STOP =
    'This session is no longer the worker of this PR: stop the loop and do not call `devflow-diff-explain` again — ' +
    'another session has taken over.';

/**
 * Следующий шаг по коду ошибки. `version_incompatible`, `lease_not_held` и `unknown_task`
 * сервер уже сопровождает инструкцией — второй раз её не повторяем.
 */
const NEXT_STEP_BY_CODE: Partial<Record<RpcErrorCode, string>> = {
    unauthorized: 'The token from the manifest is stale — restart the Devflow Diff Explain skill.',
    bad_request: 'Check the command arguments and call it again.',
    internal: 'Repeat the command; if it keeps failing, restart the Devflow Diff Explain skill.',
};

function kilobytes(bytes: number): string {
    return `${String(Math.ceil(bytes / 1024))} KB`;
}
