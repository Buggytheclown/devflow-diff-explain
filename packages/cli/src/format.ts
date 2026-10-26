import type {
    LocalVcsKind,
    RpcError,
    RpcErrorCode,
    Task,
    TaskAckResponse,
    TaskCompleteResponse,
} from '@sherpa/protocol';
import { PROTOCOL_VERSION, RESULT_MAX_BYTES } from '@sherpa/protocol';

import { CLI_VERSION } from './version.js';

/**
 * Задача в промпт-формате (`docs/protocol.md §4`): модель читает вывод глазами, поэтому в нём
 * инструкция, пути к контексту, выданный CLI файл результата и готовые команды сдачи —
 * тяжёлый контекст остаётся файлами.
 */
export function formatTask(task: Task, resultFile: string): string {
    const lines = [
        `TASK sherpa/${String(task.id)} (${task.type}), attempt ${String(task.attempt)}`,
        '',
        task.instructions,
        '',
        `Context: ${task.contextFiles.length === 0 ? 'none' : task.contextFiles.join('\n')}`,
    ];

    if (task.resultSchemaFile !== undefined) {
        lines.push(`Result schema: ${task.resultSchemaFile} — the result is validated against it.`);
    }

    lines.push(
        '',
        `Write the result to ${resultFile} and submit it:`,
        `  devflow-diff-explain task complete ${String(task.id)} --file ${resultFile}`,
        `Interim status: devflow-diff-explain task progress ${String(task.id)} --text "..."`,
        `Cannot do it: devflow-diff-explain task fail ${String(task.id)} --reason "..."`,
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

/** Что именно ревьюируется локально — строкой вывода `up`. */
export interface LocalReviewSummary {
    readonly vcs: LocalVcsKind;
    readonly repo: string;
    readonly branch: string;
    /** Явная база; undefined — её считает сервер. */
    readonly base: string | undefined;
    /** Поручение на исход ревью, подтверждённое сервером (`--verdicts`); null — ревью без вердиктов. */
    readonly verdicts: string | null;
}

/**
 * Итог `devflow-diff-explain up`: ссылка для ревьюера и следующий шаг сессии.
 * Сервер и регистрация из вывода не видны — модели про них знать нечего.
 */
export function formatUpReady(uiUrl: string, prKey: string, local: LocalReviewSummary | null = null): string {
    const lines = [uiUrl, ''];
    if (local !== null) {
        lines.push(
            `Reviewing the working tree of ${local.repo} on branch ${local.branch}, ` +
                `base ${local.base ?? defaultBaseWording(local.vcs)}.`,
        );
        if (local.verdicts !== null) {
            lines.push(
                'The reviewer finishes with Ship or Request changes; both arrive as a `review.feedback` task ' +
                    `that repeats the user's instruction: "${local.verdicts}".`,
            );
        }
    }

    lines.push(
        'Show this link to the user in full — it opens the review in their browser.',
        `Then run \`devflow-diff-explain worker next --pr ${prKey}\` and follow the instructions in its output.`,
    );
    return lines.join('\n');
}

/** Чем сервер считает базу, когда её не назвали: у arc это trunk, у git — ветка по умолчанию. */
function defaultBaseWording(vcs: LocalVcsKind): string {
    return vcs === 'arc' ? 'merge-base with trunk' : 'merge-base with the default branch';
}

/** Работа воркера окончена: слово DONE — сигнал сессии завершаться (`docs/protocol.md §3`). */
export function formatDone(message: string): string {
    return `${message}\n\nDONE`;
}

/** `file` — путь, который воркер передал в `complete`: повтор команды идёт с ним же. */
export function formatCompleteResponse(response: TaskCompleteResponse, taskId: number, file: string): string {
    switch (response.kind) {
        case 'accepted':
            return `${response.message}\nCall \`devflow-diff-explain worker next\` for the next task.`;
        case 'rejected':
            return [
                `The result of task sherpa/${String(taskId)} was rejected:`,
                ...response.errors.map((error, index) => `  ${String(index + 1)}. ${error}`),
                `Fix it and call \`devflow-diff-explain task complete ${String(taskId)} --file ${file}\` again.`,
            ].join('\n');
        case 'noop':
            return `${response.message}\nCall \`devflow-diff-explain worker next\` for the next task.`;
    }
}

export function formatProgressResponse(response: TaskAckResponse, taskId: number): string {
    switch (response.kind) {
        case 'accepted':
            return `Status for task sherpa/${String(taskId)} recorded — carry on.`;
        case 'noop':
            return `${response.message}\nCall \`devflow-diff-explain worker next\` for the next task.`;
    }
}

export function formatFailResponse(response: TaskAckResponse, taskId: number): string {
    switch (response.kind) {
        case 'accepted':
            return (
                `The refusal of task sherpa/${String(taskId)} is accepted, the reviewer sees the reason.\n` +
                'Call `devflow-diff-explain worker next` for the next task.'
            );
        case 'noop':
            return `${response.message}\nCall \`devflow-diff-explain worker next\` for the next task.`;
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
export function formatRpcError(error: RpcError['error'], role: CallRole): string {
    const lines = [`devflow-diff-explain: ${error.message}`];
    for (const detail of error.details ?? []) {
        lines.push(`  - ${detail}`);
    }

    const nextStep = nextStepFor(error.code, role);
    if (nextStep !== undefined) {
        lines.push(nextStep);
    }
    return lines.join('\n');
}

/**
 * Локальный отказ до отправки: слишком большой результат сервер завершил бы задачу ошибкой,
 * а так задача остаётся в аренде и у модели есть попытка сократить файл.
 */
export function formatOversizedResult(taskId: number, file: string, bytes: number): string {
    return (
        `devflow-diff-explain: the result is ${kilobytes(bytes)} while the limit is ${kilobytes(RESULT_MAX_BYTES)} — ` +
        `too large to submit.\nShorten ${file} and call ` +
        `\`devflow-diff-explain task complete ${String(taskId)} --file ${file}\` again. ` +
        'The task stays yours, nothing is lost.'
    );
}

export function helpText(): string {
    const commands: readonly (readonly [string, string])[] = [
        [
            'devflow-diff-explain up [--local <path> [--verdicts <instruction>]] [--harness <name>] [--model <name>] ' +
                '[--lang <ru|en>] [--no-open]',
            'start the review server and become its worker',
        ],
        [
            'devflow-diff-explain worker register [--harness <name>] [--model <name>] [--lang <ru|en>]',
            'register this session as the PR worker',
        ],
        ['devflow-diff-explain worker next', 'take the next task; waits for one as long as it takes'],
        ['devflow-diff-explain task complete <id> --file <path>', 'submit the result of a task'],
        ['devflow-diff-explain task progress <id> --text "<text>"', 'interim status for the reviewer'],
        ['devflow-diff-explain task fail <id> --reason "<text>"', 'refuse a task with a reason'],
    ];
    const flags: readonly (readonly [string, string])[] = [
        ['--pr <key>', 'the PR to connect to; defaults to SHERPA_PR, then to the PR of the arc branch here'],
        [
            '--local <path>',
            'review the working tree of this project directory instead of a PR; only for `up`',
        ],
        ['--base <ref>', 'what the working tree is compared with; only with `--local`'],
        [
            '--verdicts <instruction>',
            "the user's instruction for the outcome of the review, in their words; the reviewer then " +
                'finishes with Ship or Request changes instead of Comment; only with `--local`',
        ],
        ['--harness <name>', 'harness label in the worker status; for `up` and `worker register`'],
        ['--model <name>', 'model name in the worker status; for `up` and `worker register`'],
        [
            '--lang <ru|en>',
            'the language you speak with the reviewer in; hints the UI language, omit if unsure',
        ],
        ['--no-open', 'do not open the browser after `up` starts a new server'],
        ['--version', 'CLI version'],
    ];

    return [
        `devflow-diff-explain ${CLI_VERSION} (protocol ${PROTOCOL_VERSION}) — the Sherpa worker CLI.`,
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

function nextStepFor(code: RpcErrorCode, role: CallRole): string | undefined {
    // Свой сервер конфликтом на регистрацию не отвечает — слот перехватывается; но если ответил
    // (чужая сборка), терминальная приписка неверна: воркером эта сессия и не была.
    if (code === 'worker_conflict') {
        return role === 'register' ? undefined : WORKER_CONFLICT_STOP;
    }
    return NEXT_STEP_BY_CODE[code];
}

/**
 * Слот воркера ушёл другой сессии посреди работы: петлю продолжать нечем.
 * Формулировка «stop the loop» — маркер из SKILL.md, менять её в отрыве от него нельзя.
 */
const WORKER_CONFLICT_STOP =
    'This session is no longer the worker of this PR: stop the loop and do not call `sherpa` again — ' +
    'another session has taken over.';

/**
 * Следующий шаг по коду ошибки. `version_incompatible`, `lease_not_held` и `unknown_task`
 * сервер уже сопровождает инструкцией — второй раз её не повторяем.
 */
const NEXT_STEP_BY_CODE: Partial<Record<RpcErrorCode, string>> = {
    unauthorized: 'The token from the manifest is stale — restart the Sherpa skill.',
    bad_request: 'Check the command arguments and call it again.',
    result_too_large:
        'The task is closed and the reviewer sees why — call `devflow-diff-explain worker next` for the next one.',
    internal: 'Repeat the command; if it keeps failing, restart the Sherpa skill.',
};

function kilobytes(bytes: number): string {
    return `${String(Math.ceil(bytes / 1024))} KB`;
}
