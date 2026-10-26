import fs from 'node:fs/promises';
import path from 'node:path';

import type { Locale, Verdict } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';

import type { FeedbackComment, FeedbackRoundContext, FeedbackThread } from './hosts/select.js';
import { fitPayloadFiles, fitText, unavailableBlock } from './payload-budget.js';
import type { EnqueueInput } from './queue.js';

/**
 * Контекст раунда локального ревью для агента: один markdown-файл с вердиктом, путями,
 * якорями и перепиской тредов, плюс схема результата файлом. Текст английский — его читает
 * модель.
 */

/** Потолок `feedback.md`: раунд из сотни тредов не имеет права вытеснить контекст сессии. */
export const FEEDBACK_PAYLOAD_BUDGET_BYTES = 256 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface FeedbackPayload {
    readonly instructions: string;
    readonly context: string;
    readonly schema: string;
}

/** Готовый payload раунда: промпт, контекст и схема результата. */
export function buildFeedbackPayload(
    context: FeedbackRoundContext,
    locale: Locale,
    budgetBytes = FEEDBACK_PAYLOAD_BUDGET_BYTES,
): FeedbackPayload {
    const [file] = fitPayloadFiles(
        [
            {
                name: 'feedback.md',
                order: 0,
                minimum: unavailableBlock(
                    'Review round',
                    'The review round did not fit in the payload budget.',
                ),
                render: (maxBytes) =>
                    fitText(
                        roundContextMarkdown(context),
                        maxBytes,
                        unavailableBlock(
                            'Review round',
                            'The review round did not fit in the payload budget.',
                        ),
                    ),
            },
        ],
        budgetBytes,
    );

    return {
        instructions: feedbackInstructions(context, locale),
        context: file?.content ?? '',
        schema: `${JSON.stringify(generateJsonSchemas().reviewFeedbackResult, null, 2)}\n`,
    };
}

/**
 * Промпт задачи: что именно агент обязан сделать с этим раундом. Язык ответов называется здесь
 * же — по нему приёмка и проверяет голос, поэтому просьба и проверка обязаны совпадать.
 */
export function feedbackInstructions(context: FeedbackRoundContext, locale: Locale): string {
    const writeIn = `Write the replies and the summary in ${locale === 'ru' ? 'Russian' : 'English'}.`;
    const tail =
        'The working tree is re-read automatically; do not run any other Sherpa command for this.';
    const guidance = verdictGuidance(context.verdict, context.instruction);
    const opening = guidance.opening(context.projectDir);
    if (context.threads.length === 0) {
        return [opening, guidance.empty, writeIn, tail].join(' ');
    }

    return [
        opening,
        'The review comments are in feedback.md, each with the absolute file path, line and code excerpt.',
        guidance.replies,
        writeIn,
        'Never edit files outside the project directory.',
        guidance.comments,
        tail,
    ].join(' ');
}

interface VerdictGuidance {
    /** Первая фраза промпта: что сделал ревьюер. */
    readonly opening: (projectDir: string) => string;
    /** Раунд без тредов: что делать и что сдать. */
    readonly empty: string;
    /** Что писать в ответах на треды. */
    readonly replies: string;
    /** Что делать с замечаниями. */
    readonly comments: string;
}

const NOTHING_TO_FIX = 'Nothing to fix: submit a result with an empty replies list and a one-line summary.';

const REPLY_WHAT_YOU_DID =
    'Reply to every thread by threadId in the result file (see schema): what you did, or why you did not.';

const FIX_EVERY_COMMENT =
    'Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is.';

const APPROVED = 'The changes are approved.';

/** Одобрение без поручения: к сборке задачи режим вердиктов уже снят. */
const ON_APPROVAL =
    'If the user asked you earlier to do something once the changes are approved ' +
    '(for example, commit them and open a pull request), do it now and say what you did in the summary.';

/**
 * Поручение пользователя на исход ревью (`--verdicts`) дословно, в кавычках: задача с вердиктом —
 * момент выполнить ту его часть, что относится к этому вердикту.
 */
function outcomeInstruction(verdict: Verdict, instruction: string): string {
    return (
        `The user's instruction for the outcome of this review: "${instruction}". ` +
        `Carry out the part that applies to verdict ${verdict} now and say what you did in the summary.`
    );
}

/** Что агенту делать с раундом по режиму публикации. */
function verdictGuidance(verdict: Verdict, instruction: string | null): VerdictGuidance {
    switch (verdict) {
        case 'comment':
            return {
                opening: (projectDir) => `The reviewer published review comments on the local checkout ${projectDir}.`,
                empty: `The reviewer published no comments in this round. ${NOTHING_TO_FIX}`,
                replies: REPLY_WHAT_YOU_DID,
                comments: FIX_EVERY_COMMENT,
            };
        case 'request_changes': {
            const outcome = instruction === null ? null : outcomeInstruction(verdict, instruction);
            return {
                opening: (projectDir) =>
                    `The reviewer finished a review round on the local checkout ${projectDir}, verdict request_changes.`,
                empty:
                    outcome === null
                        ? `The reviewer left no comments in this round. ${NOTHING_TO_FIX}`
                        : `The reviewer left no comments in this round, so there is nothing to fix. ${outcome} ` +
                          'Submit a result with an empty replies list and a one-line summary.',
                replies: REPLY_WHAT_YOU_DID,
                comments: outcome === null ? FIX_EVERY_COMMENT : `${FIX_EVERY_COMMENT} ${outcome}`,
            };
        }
        case 'ship':
        case 'sticky_ship': {
            const onApproval = instruction === null ? ON_APPROVAL : outcomeInstruction(verdict, instruction);
            return {
                opening: (projectDir) =>
                    `The reviewer finished a review round on the local checkout ${projectDir}, verdict ${verdict}.`,
                empty:
                    `The reviewer approved the changes without comments. ${onApproval} ` +
                    'Submit a result with an empty replies list and a one-line summary.',
                replies: 'Reply to every thread by threadId in the result file (see schema).',
                comments: `${APPROVED} ${onApproval}`,
            };
        }
        default:
            return unreachableVerdict(verdict);
    }
}

function unreachableVerdict(verdict: never): never {
    throw new Error(`неизвестный вердикт раунда ${String(verdict)}`);
}

/** Материализует каталог раунда и складывает задачу очереди. */
export async function materializeFeedbackPayload(
    taskDir: string,
    payload: FeedbackPayload,
): Promise<EnqueueInput> {
    await fs.mkdir(taskDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(path.dirname(taskDir), DIR_MODE);
    await fs.chmod(taskDir, DIR_MODE);

    const contextFile = path.join(taskDir, 'feedback.md');
    const schemaFile = path.join(taskDir, 'result-schema.json');
    await fs.writeFile(contextFile, payload.context, { encoding: 'utf8', mode: FILE_MODE });
    await fs.writeFile(schemaFile, payload.schema, { encoding: 'utf8', mode: FILE_MODE });

    return {
        type: 'review.feedback',
        // Ревьюер ждёт правок у экрана — раунд обгоняет фоновую генерацию маршрута.
        priority: 'interactive',
        instructions: payload.instructions,
        contextFiles: [contextFile],
        resultSchemaFile: schemaFile,
    };
}

/** Сам контекст раунда: вердикт, каталог проекта и треды по порядку. */
export function roundContextMarkdown(context: FeedbackRoundContext): string {
    const head = [
        '# Review round',
        '',
        `Verdict: ${context.verdict}`,
        `Project directory: ${context.projectDir}`,
        `Threads in this round: ${String(context.threads.length)}`,
        '',
        'Reply to a thread by its threadId. Line numbers are the ones of the diff excerpt:',
        'the gutter is `old new | line`, `.` means the line does not exist on that side.',
        '',
    ];
    if (context.threads.length === 0) {
        return [...head, 'The reviewer published no comments in this round.', ''].join('\n');
    }
    return [...head, ...context.threads.map(threadBlock), ''].join('\n');
}

function threadBlock(thread: FeedbackThread): string {
    return [
        `## Thread ${thread.threadId} — ${threadPlace(thread)}`,
        '',
        `Resolved: ${thread.resolved ? 'yes' : 'no'}`,
        ...(thread.note === null ? [] : [`Excerpt: [UNAVAILABLE: ${thread.note}]`]),
        ...(thread.excerpt === null ? [] : ['', '```', thread.excerpt, '```']),
        '',
        'Comments (oldest first):',
        '',
        ...thread.comments.flatMap((comment) => commentLines(comment, 0)),
        '',
    ].join('\n');
}

/** Где живёт тред: файл со строкой, весь файл или уровень PR. */
function threadPlace(thread: FeedbackThread): string {
    if (thread.file === null) {
        return 'pull request level, no file';
    }
    if (thread.position === null) {
        return `${thread.file} (whole file)`;
    }
    const { side, line, size } = thread.position;
    const range = size > 1 ? `${String(line)}-${String(line + size - 1)}` : String(line);
    return `${thread.file}, ${side} side, line ${range}`;
}

function commentLines(comment: FeedbackComment, depth: number): string[] {
    const indent = '  '.repeat(depth);
    const author = comment.author.bot ? `${comment.author.login} (agent)` : comment.author.login;
    return [
        `${indent}- ${author}, ${comment.createdAt}:`,
        ...comment.body.split('\n').map((line) => `${indent}  ${line}`),
        ...comment.replies.flatMap((reply) => commentLines(reply, depth + 1)),
    ];
}
