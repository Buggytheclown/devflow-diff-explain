import type { Locale } from '@sherpa/protocol';
import { localeSchema } from '@sherpa/protocol';

import { CliError } from './errors.js';

/** Разобранный вызов CLI. Всё, что нужно команде, известно уже после разбора аргументов. */
export type Command =
    | { readonly kind: 'version' }
    | { readonly kind: 'help' }
    | {
          readonly kind: 'server';
          /** Аргументы сервера как есть: их разбирает `runServer` модуля сервера, а не CLI. */
          readonly argv: readonly string[];
      }
    | {
          readonly kind: 'up';
          readonly prKey: string | undefined;
          /** Каталог проекта локального ревью (`--local`); несовместим с `--pr`. */
          readonly local: string | undefined;
          /** База сравнения локального ревью (`--base`); только вместе с `--local`. */
          readonly base: string | undefined;
          /** Метка харнеса для статуса воркера в UI; необязательна. */
          readonly harness: string | undefined;
          /** Имя модели воркера для статуса воркера в UI; необязательно. */
          readonly model: string | undefined;
          /** Язык, на котором агент общается с ревьюером, — подсказка для локали UI. */
          readonly lang: Locale | undefined;
          /** Не открывать браузер после холодного старта. */
          readonly noOpen: boolean;
      }
    | {
          readonly kind: 'worker-next';
          readonly prKey: string | undefined;
      }
    | {
          readonly kind: 'worker-register';
          readonly prKey: string | undefined;
          /** Метка харнеса для статуса воркера в UI; необязательна. */
          readonly harness: string | undefined;
          /** Имя модели воркера для статуса воркера в UI; необязательно. */
          readonly model: string | undefined;
          /** Язык, на котором агент общается с ревьюером, — подсказка для локали UI. */
          readonly lang: Locale | undefined;
      }
    | {
          readonly kind: 'task-complete';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly file: string;
      }
    | {
          readonly kind: 'task-progress';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly text: string;
      }
    | {
          readonly kind: 'task-fail';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly reason: string;
      };

const OPTIONS = [
    '--pr',
    '--local',
    '--base',
    '--file',
    '--text',
    '--reason',
    '--harness',
    '--model',
    '--lang',
] as const;
const FLAGS = ['--no-open'] as const;
type OptionName = (typeof OPTIONS)[number];
type FlagName = (typeof FLAGS)[number];

type TaskSubcommand = 'complete' | 'progress' | 'fail';

/** Предел свободных строк `harness` и `model` в контракте (`@sherpa/protocol`). */
const LABEL_MAX_CHARS = 64;

/**
 * Разбор аргументов. Любая кривизна — `CliError` с подсказкой правильного вызова:
 * модель ошибается в формате команд, и вывод должен её выправлять (`docs/protocol.md §1`).
 */
export function parseArgs(argv: readonly string[]): Command {
    // До проверки `--version`/`--help`: аргументы после `server`, включая их, принадлежат серверу.
    if (argv[0] === 'server') {
        return { kind: 'server', argv: argv.slice(1) };
    }
    if (argv.includes('--version') || argv.includes('-v')) {
        return { kind: 'version' };
    }
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        return { kind: 'help' };
    }

    const { options, flags, positionals } = splitArgs(argv);
    const prKey = options.get('--pr');
    const group = positionals[0];

    if (group !== 'up' && flags.size > 0) {
        throw new CliError('devflow-diff-explain: --no-open is only available for `devflow-diff-explain up`.');
    }
    if (group !== 'up' && (options.has('--local') || options.has('--base'))) {
        throw new CliError('devflow-diff-explain: --local and --base are only available for `devflow-diff-explain up`.');
    }
    if (group === 'up') {
        return parseUpCommand(positionals, options, flags, prKey);
    }
    if (group === 'worker') {
        return parseWorkerCommand(positionals, options, prKey);
    }
    if (group === 'task') {
        return parseTaskCommand(positionals, options, prKey);
    }

    throw new CliError(
        `devflow-diff-explain: unknown command ${JSON.stringify(positionals.join(' '))}.\n` +
            'Available: `devflow-diff-explain up`, `devflow-diff-explain worker next`, `devflow-diff-explain task complete|progress|fail <id>`; ' +
            '`devflow-diff-explain --help` lists them all.',
    );
}

/**
 * Метка харнеса или модели из аргумента. Значение называет модель, и приходит оно как придётся:
 * в кавычках, в бэктиках, с пробелами по краям, иногда длиннее контрактного предела.
 * Пустая после чистки строка равносильна отсутствию параметра.
 */
export function sanitizeLabel(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw
        .replace(/^[\s'"`]+/u, '')
        .replace(/[\s'"`]+$/u, '')
        .slice(0, LABEL_MAX_CHARS)
        .trim();
    return trimmed === '' ? undefined : trimmed;
}

function parseUpCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    flags: ReadonlySet<FlagName>,
    prKey: string | undefined,
): Command {
    if (positionals.length > 1) {
        throw new CliError(
            `devflow-diff-explain: unexpected arguments after \`up\`: ${positionals.slice(1).join(' ')}.\n` +
                'Expected `devflow-diff-explain up [--pr <pr key> | --local <path> [--base <ref>]] ' +
                '[--harness <harness name>] [--model <model name>] [--lang <ru|en>] [--no-open]`; ' +
                'without `--pr` and `--local` the PR is taken from the arc branch of the current directory.',
        );
    }

    const local = parseLocal(options.get('--local'));
    const base = options.get('--base')?.trim();
    if (local !== undefined && prKey !== undefined) {
        throw new CliError(
            'devflow-diff-explain: `--local` and `--pr` mean different reviews — pass one of them.\n' +
                'Use `--local <path>` to review the working tree of a checkout, `--pr <pr key>` to review a PR.',
        );
    }
    if (base !== undefined && local === undefined) {
        throw new CliError(
            'devflow-diff-explain: `--base` only makes sense with `--local`.\n' +
                'Call `devflow-diff-explain up --local <path> --base <ref>`; for a PR the base comes from the host.',
        );
    }
    return {
        kind: 'up',
        prKey,
        local,
        base: base === '' ? undefined : base,
        harness: sanitizeLabel(options.get('--harness')),
        model: sanitizeLabel(options.get('--model')),
        lang: parseLang(options.get('--lang')),
        noOpen: flags.has('--no-open'),
    };
}

/** Каталог проекта из `--local`: путь обязателен, пустое значение равносильно его отсутствию. */
function parseLocal(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.trim();
    if (value === '') {
        throw new CliError(MISSING_LOCAL_PATH);
    }
    return value;
}

const MISSING_LOCAL_PATH =
    'devflow-diff-explain: `--local` needs the path of the project directory to review.\n' +
    'Call `devflow-diff-explain up --local <path>` — `.` is the directory you are in right now.';

function parseWorkerCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if ((sub !== 'next' && sub !== 'register') || positionals.length > 2) {
        throw new CliError(
            'devflow-diff-explain: group `worker` has two commands — `devflow-diff-explain worker next` and `devflow-diff-explain worker register`.',
        );
    }
    if (sub === 'register') {
        return {
            kind: 'worker-register',
            prKey,
            harness: sanitizeLabel(options.get('--harness')),
            model: sanitizeLabel(options.get('--model')),
            lang: parseLang(options.get('--lang')),
        };
    }
    return { kind: 'worker-next', prKey };
}

/**
 * Язык сессии: в отличие от свободных меток `--harness`/`--model` список закрыт контрактом
 * (`localeSchema`) — UI выбирает по нему словарь, и «de» ему нечем ответить.
 */
function parseLang(raw: string | undefined): Locale | undefined {
    const value = sanitizeLabel(raw);
    if (value === undefined) {
        return undefined;
    }

    const parsed = localeSchema.safeParse(value.toLowerCase());
    if (!parsed.success) {
        throw new CliError(
            `devflow-diff-explain: --lang expects \`ru\` or \`en\`, got \`${value}\`.\n` +
                'Pass the language you speak with the reviewer in; if you are not sure, omit the flag ' +
                'and the UI will pick the language itself.',
        );
    }
    return parsed.data;
}

function parseTaskCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if (sub !== 'complete' && sub !== 'progress' && sub !== 'fail') {
        throw new CliError(
            'devflow-diff-explain: group `task` has three commands — `complete`, `progress`, `fail`.\n' +
                'For example: `devflow-diff-explain task complete 42 --file answer.md`.',
        );
    }
    if (positionals.length > 3) {
        throw new CliError(
            `devflow-diff-explain: unexpected arguments after \`task ${sub}\`: ${positionals.slice(3).join(' ')}.\n` +
                `Expected \`devflow-diff-explain task ${sub} <id> ${requiredOptionOf(sub)} "..."\`.`,
        );
    }

    const taskId = parseTaskId(positionals[2], sub);

    switch (sub) {
        case 'complete':
            return { kind: 'task-complete', prKey, taskId, file: requireOption(options, '--file', sub) };
        case 'progress':
            return { kind: 'task-progress', prKey, taskId, text: requireOption(options, '--text', sub) };
        case 'fail':
            return { kind: 'task-fail', prKey, taskId, reason: requireOption(options, '--reason', sub) };
    }
}

function parseTaskId(raw: string | undefined, sub: TaskSubcommand): number {
    if (raw === undefined) {
        throw new CliError(
            `devflow-diff-explain: no task number given.\nCall \`devflow-diff-explain task ${sub} <id> ${requiredOptionOf(sub)} "..."\`; ` +
                'the task number comes from the output of `devflow-diff-explain worker next`.',
        );
    }

    // `sherpa/42` вместо `42` — частая ошибка модели: она видит номер задачи именно в таком виде.
    const digits = raw.startsWith('sherpa/') ? raw.slice('sherpa/'.length) : raw;
    const taskId = Number(digits);
    if (!Number.isInteger(taskId) || taskId <= 0) {
        throw new CliError(
            `devflow-diff-explain: the task number must be a positive number, got ${JSON.stringify(raw)}.\n` +
                'Take the number from the output of `devflow-diff-explain worker next` (the `TASK sherpa/<id>` line).',
        );
    }
    return taskId;
}

function requireOption(options: ReadonlyMap<OptionName, string>, name: OptionName, sub: TaskSubcommand): string {
    const value = options.get(name);
    if (value === undefined || value === '') {
        throw new CliError(
            `devflow-diff-explain: \`task ${sub}\` requires ${name}.\n` +
                `Call \`devflow-diff-explain task ${sub} <id> ${name} ${name === '--file' ? '<path>' : '"..."'}\`.`,
        );
    }
    return value;
}

function requiredOptionOf(sub: TaskSubcommand): OptionName {
    switch (sub) {
        case 'complete':
            return '--file';
        case 'progress':
            return '--text';
        case 'fail':
            return '--reason';
    }
}

/** Поддерживаются обе формы записи флага: `--file путь` и `--file=путь`. */
function splitArgs(argv: readonly string[]): {
    options: ReadonlyMap<OptionName, string>;
    flags: ReadonlySet<FlagName>;
    positionals: readonly string[];
} {
    const options = new Map<OptionName, string>();
    const flags = new Set<FlagName>();
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        if (!arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }

        const separator = arg.indexOf('=');
        const name = separator === -1 ? arg : arg.slice(0, separator);
        if (isFlag(name)) {
            if (separator !== -1) {
                throw new CliError(`devflow-diff-explain: flag ${name} does not take a value.`);
            }
            flags.add(name);
            continue;
        }
        if (!isOption(name)) {
            throw new CliError(
                `devflow-diff-explain: unknown flag ${name}.\nAvailable: ${[...OPTIONS, ...FLAGS].join(', ')}, --version, --help.`,
            );
        }

        if (separator !== -1) {
            options.set(name, arg.slice(separator + 1));
            continue;
        }

        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new CliError(missingValueMessage(name));
        }
        options.set(name, value);
        index += 1;
    }

    return { options, flags, positionals };
}

/** Отказ называет, какое значение аргумента нужно передать явно. */
function missingValueMessage(name: OptionName): string {
    switch (name) {
        case '--local':
            return MISSING_LOCAL_PATH;
        default:
            return `devflow-diff-explain: flag ${name} has no value.`;
    }
}

function isOption(name: string): name is OptionName {
    return (OPTIONS as readonly string[]).includes(name);
}

function isFlag(name: string): name is FlagName {
    return (FLAGS as readonly string[]).includes(name);
}
