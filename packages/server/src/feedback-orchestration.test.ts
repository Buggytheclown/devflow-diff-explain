import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Locale, ReviewUser } from '@sherpa/protocol';
import { generateJsonSchemas, UI_ENDPOINTS, uiSettingsSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { FeedbackOrchestrator } from './feedback-orchestrator.js';
import { buildFeedbackPayload } from './feedback-payload.js';
import { FeedbackStore } from './feedback-store.js';
import { arcVcs } from './hosts/local/arc-vcs.js';
import { FakeArc } from './hosts/local/fake-arc.js';
import { memoryIterationsStore } from './hosts/local/iterations-store.js';
import { LocalHost } from './hosts/local/local-host.js';
import { memoryThreadsStore } from './hosts/local/threads-store.js';
import type {
    FeedbackHost,
    FeedbackReply,
    FeedbackRound,
    FeedbackRoundContext,
    FeedbackThread,
} from './hosts/select.js';
import type { TaskRecord } from './queue.js';
import { TaskQueue } from './queue.js';
import type { SherpaServer } from './server.js';
import type { SettingsStore } from './settings-store.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Оркестрация раундов локального ревью на подставном `FeedbackHost`: постановка задачи,
 * fail-closed приёмка ответа и сверка после рестарта. Настоящего чекаута здесь нет — раунды
 * отдаёт фейк.
 */

const PROJECT_DIR = '/tmp/project';

interface CompletedRound {
    readonly roundId: string;
    readonly replies: readonly FeedbackReply[];
    readonly summary: string;
    readonly author: ReviewUser;
}

class FakeFeedbackHost implements FeedbackHost {
    readonly completed: CompletedRound[] = [];
    rounds: FeedbackRound[] = [];
    threadsOf = new Map<string, FeedbackThread[]>();
    /** Отказ записи ответов: так выглядит сбой `local-review.json` или самого чекаута. */
    failComplete = false;

    pendingRounds(): Promise<FeedbackRound[]> {
        return Promise.resolve([...this.rounds]);
    }

    roundContext(roundId: string): Promise<FeedbackRoundContext> {
        const round = this.rounds.find((candidate) => candidate.id === roundId);
        if (round === undefined) {
            return Promise.reject(new Error(`round ${roundId} is not found`));
        }
        return Promise.resolve({
            roundId,
            verdict: round.verdict,
            instruction: null,
            projectDir: PROJECT_DIR,
            threads: this.threadsOf.get(roundId) ?? [],
        });
    }

    completeRound(
        roundId: string,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void> {
        if (this.failComplete) {
            return Promise.reject(new Error('в раунд не записать'));
        }
        this.completed.push({ roundId, replies: result.replies, summary: result.summary, author });
        this.rounds = this.rounds.filter((round) => round.id !== roundId);
        return Promise.resolve();
    }
}

function thread(threadId: string, overrides: Partial<FeedbackThread> = {}): FeedbackThread {
    return {
        threadId,
        path: 'src/a.ts',
        file: `${PROJECT_DIR}/src/a.ts`,
        position: { side: 'new', line: 12, size: 1 },
        excerpt: '   11    12 | +const a = 2;',
        note: null,
        resolved: false,
        comments: [
            {
                author: { login: 'reviewer', displayName: null, bot: false, avatarUrl: null },
                createdAt: '2026-09-11T10:00:00.000Z',
                body: 'вынеси константу',
                replies: [],
            },
        ],
        ...overrides,
    };
}

describe('оркестрация раундов локального ревью', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let queue: TaskQueue;
    let store: FeedbackStore;
    let host: FakeFeedbackHost;
    let payloadDir: string;
    let orchestrator: FeedbackOrchestrator;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'feedback.db'));
        queue = new TaskQueue({ db });
        store = new FeedbackStore({ db });
        host = new FakeFeedbackHost();
        payloadDir = path.join(sherpaDir, 'payload', 'feedback');
        orchestrator = make();
    });

    afterEach(async () => {
        orchestrator.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function make(settings: Pick<SettingsStore, 'read'> | null = null): FeedbackOrchestrator {
        return new FeedbackOrchestrator({ host, queue, store, payloadDir, settings });
    }

    /** Настройки, язык которых меняется между постановкой задачи и сдачей результата. */
    function settingsWithLocale(locale: () => Locale): Pick<SettingsStore, 'read'> {
        return { read: () => uiSettingsSchema.parse({ locale: locale() }) };
    }

    function seedRound(id: string, threadIds: string[], verdict: FeedbackRound['verdict'] = 'request_changes'): void {
        host.rounds.push({ id, verdict, createdAt: '2026-09-11T10:05:00.000Z', threadIds });
        host.threadsOf.set(
            id,
            threadIds.map((threadId) => thread(threadId)),
        );
    }

    function onlyTask(): TaskRecord {
        const tasks = queue.listTasks();
        expect(tasks).toHaveLength(1);
        const task = tasks[0];
        if (task === undefined) {
            throw new Error('задача не поставлена');
        }
        return task;
    }

    it('раунд становится задачей с контекстом и схемой результата', async () => {
        seedRound('7', ['3']);

        await orchestrator.reconcile();

        const task = onlyTask();
        expect(task.type).toBe('review.feedback');
        expect(task.priority).toBe('interactive');
        expect(task.contextFiles).toEqual([path.join(payloadDir, '7', 'feedback.md')]);
        expect(task.resultSchemaFile).toBe(path.join(payloadDir, '7', 'result-schema.json'));

        const context = fs.readFileSync(task.contextFiles[0] ?? '', 'utf8');
        expect(context).toContain(`${PROJECT_DIR}/src/a.ts`);
        expect(context).toContain('## Thread 3');
        expect(context).toContain('вынеси константу');
        expect(JSON.parse(fs.readFileSync(task.resultSchemaFile ?? '', 'utf8'))).toEqual(
            generateJsonSchemas().reviewFeedbackResult,
        );
        expect(task.instructions).toContain('Fix the code for every comment.');
    });

    it('второй проход сверки задачу не задваивает', async () => {
        seedRound('7', ['3']);

        await orchestrator.reconcile();
        await orchestrator.reconcile();

        expect(queue.listTasks()).toHaveLength(1);
    });

    it('принятый ответ уходит в хост с подписью агента', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const task = onlyTask();

        const acceptance = orchestrator.acceptResult(
            task,
            JSON.stringify({ replies: [{ threadId: '3', body: 'вынес в константу' }], summary: 'поправил одно' }),
        );

        expect(acceptance?.kind).toBe('accepted');
        if (acceptance?.kind !== 'accepted') {
            throw new Error('результат не принят');
        }
        acceptance.onCommitted?.();
        await waitUntil(() => host.completed.length === 1, 'ответы уехали в хост');

        expect(host.completed).toEqual([
            {
                roundId: '7',
                replies: [{ threadId: '3', body: 'вынес в константу' }],
                summary: 'поправил одно',
                author: { login: 'agent', displayName: 'Агент', bot: true, avatarUrl: null },
            },
        ]);
        expect(store.ofRound('7')?.state).toBe('done');
    });

    it('подпись агента несёт харнес и модель сессии', async () => {
        const withRegistry = new FeedbackOrchestrator({
            host,
            queue,
            store,
            payloadDir,
            registry: {
                status: () => ({
                    kind: 'connected',
                    workerId: 'w-1',
                    harness: 'claude-code',
                    model: 'claude-opus-5',
                    registeredAt: '2026-09-11T10:00:00.000Z',
                    lastSeenAt: '2026-09-11T10:01:00.000Z',
                }),
            },
        });
        seedRound('7', ['3']);
        await withRegistry.reconcile();

        const acceptance = withRegistry.acceptResult(
            onlyTask(),
            JSON.stringify({ replies: [], summary: 'нечего править' }),
        );
        if (acceptance?.kind !== 'accepted') {
            throw new Error('результат не принят');
        }
        acceptance.onCommitted?.();
        await waitUntil(() => host.completed.length === 1, 'ответы уехали в хост');

        expect(host.completed[0]?.author).toEqual({
            login: 'claude-code',
            displayName: 'Агент · claude-opus-5',
            bot: true,
            avatarUrl: null,
        });
        withRegistry.close();
    });

    it('чужой тред, дубль и пустой итог отбиваются', async () => {
        seedRound('7', ['3', '4']);
        await orchestrator.reconcile();
        const task = onlyTask();

        const foreign = orchestrator.acceptResult(
            task,
            JSON.stringify({ replies: [{ threadId: '9', body: 'ответ' }], summary: 'итог' }),
        );
        expect(foreign).toEqual({
            kind: 'rejected',
            errors: [expect.stringContaining('thread 9 is not in this review round')],
        });

        const twice = orchestrator.acceptResult(
            task,
            JSON.stringify({
                replies: [
                    { threadId: '3', body: 'ответ' },
                    { threadId: '3', body: 'ещё ответ' },
                ],
                summary: 'итог',
            }),
        );
        expect(twice).toEqual({
            kind: 'rejected',
            errors: [expect.stringContaining('is answered twice')],
        });

        const empty = orchestrator.acceptResult(
            task,
            JSON.stringify({ replies: [{ threadId: '3', body: 'ответ' }], summary: '' }),
        );
        expect(empty?.kind).toBe('rejected');

        const notJson = orchestrator.acceptResult(task, 'не json');
        expect(notJson).toEqual({ kind: 'rejected', errors: [expect.stringContaining('valid JSON')] });
        expect(host.completed).toEqual([]);
    });

    it('чужой тип задачи оркестратор не трогает', () => {
        const echo = queue.enqueue({
            type: 'echo',
            priority: 'background',
            instructions: 'проба',
            contextFiles: [],
        });

        expect(orchestrator.acceptResult(echo, 'что угодно')).toBeNull();
    });

    it('сверка после рестарта не ставит вторую задачу на живую, но чинит потерянную', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const first = onlyTask();

        const revived = make();
        await revived.reconcile();
        expect(queue.listTasks()).toHaveLength(1);

        // Приёмка после рестарта обязана знать треды раунда — их подняла сверка.
        const acceptance = revived.acceptResult(
            first,
            JSON.stringify({ replies: [{ threadId: '3', body: 'сделал' }], summary: 'итог' }),
        );
        expect(acceptance?.kind).toBe('accepted');
        revived.close();
    });

    it('провалившийся раунд заново не ставится', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const task = onlyTask();
        queue.cancel(task.id);

        await orchestrator.reconcile();
        expect(store.ofRound('7')?.state).toBe('failed');

        await orchestrator.reconcile();
        expect(queue.listTasks()).toHaveLength(1);
        expect(host.rounds).toHaveLength(1);
    });

    it('отказ записи ответов оставляет раунд открытым и ставит его заново', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        host.failComplete = true;
        queue.setResultAcceptor((task, result) => orchestrator.acceptResult(task, result));

        const leased = queue.next('w-1');
        const response = queue.complete(
            'w-1',
            leased?.task.id ?? 0,
            JSON.stringify({ replies: [{ threadId: '3', body: 'сделал' }], summary: 'итог' }),
        );

        expect(response.kind).toBe('accepted');
        // Запись не прошла: раунд остаётся открытым, и сверка ставит его агенту заново.
        await waitUntil(() => queue.listTasks().length === 2, 'раунд поставлен заново');
        expect(host.completed).toEqual([]);
        expect(store.ofRound('7')?.state).toBe('open');
    });

    it('язык проверки фиксируется при постановке, а не при сдаче', async () => {
        let locale: Locale = 'en';
        const withSettings = make(settingsWithLocale(() => locale));
        seedRound('7', ['3']);
        await withSettings.reconcile();
        const task = onlyTask();
        expect(task.instructions).toContain('Write the replies and the summary in English.');

        // Ревьюер переключил язык, пока агент правил код: задача просила английский — его и проверяем.
        locale = 'ru';
        const rejected = withSettings.acceptResult(
            task,
            JSON.stringify({
                replies: [{ threadId: '3', body: 'It is worth noting that the constant is extracted.' }],
                summary: 'done',
            }),
        );

        expect(rejected).toEqual({
            kind: 'rejected',
            errors: [expect.stringContaining('it is worth noting')],
        });
        withSettings.close();
    });

    it('каталог раунда живёт не дольше своей задачи', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const roundDir = path.join(payloadDir, '7');
        expect(fs.existsSync(roundDir)).toBe(true);
        queue.cancel(onlyTask().id);

        await orchestrator.reconcile();

        expect(fs.existsSync(roundDir)).toBe(false);
    });

    it('ship без комментариев тоже едет задачей', async () => {
        seedRound('7', [], 'ship');

        await orchestrator.reconcile();

        const task = onlyTask();
        expect(task.instructions).toContain('approved the changes without comments');
        expect(fs.readFileSync(task.contextFiles[0] ?? '', 'utf8')).toContain(
            'The reviewer published no comments in this round.',
        );
    });
});

describe('payload раунда', () => {
    const context: FeedbackRoundContext = {
        roundId: '7',
        verdict: 'request_changes',
        instruction: null,
        projectDir: PROJECT_DIR,
        threads: [
            thread('3'),
            thread('4', {
                position: null,
                excerpt: null,
                note: 'the thread is outdated: the file changed after the comment was written',
                resolved: true,
            }),
            thread('5', { path: null, file: null, position: null, excerpt: null, note: null }),
        ],
    };

    it('контекст раунда — снимок текста', () => {
        expect(buildFeedbackPayload(context, 'ru').context).toMatchInlineSnapshot(`
          "# Review round

          Verdict: request_changes
          Project directory: /tmp/project
          Threads in this round: 3

          Reply to a thread by its threadId. Line numbers are the ones of the diff excerpt:
          the gutter is \`old new | line\`, \`.\` means the line does not exist on that side.

          ## Thread 3 — /tmp/project/src/a.ts, new side, line 12

          Resolved: no

          \`\`\`
             11    12 | +const a = 2;
          \`\`\`

          Comments (oldest first):

          - reviewer, 2026-09-11T10:00:00.000Z:
            вынеси константу

          ## Thread 4 — /tmp/project/src/a.ts (whole file)

          Resolved: yes
          Excerpt: [UNAVAILABLE: the thread is outdated: the file changed after the comment was written]

          Comments (oldest first):

          - reviewer, 2026-09-11T10:00:00.000Z:
            вынеси константу

          ## Thread 5 — pull request level, no file

          Resolved: no

          Comments (oldest first):

          - reviewer, 2026-09-11T10:00:00.000Z:
            вынеси константу

          "
        `);
    });

    it('инструкции называют вердикт своими словами', () => {
        // Локально публикуются только замечания — агент правит по каждому.
        expect(buildFeedbackPayload({ ...context, verdict: 'comment' }, 'ru').instructions).toMatchInlineSnapshot(
            `"The reviewer published review comments on the local checkout /tmp/project. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema): what you did, or why you did not. Write the replies and the summary in Russian. Never edit files outside the project directory. Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is. The working tree is re-read automatically; do not run any other Sherpa command for this."`,
        );

        // request_changes — режим вердиктов (`--verdicts`) и раунды, опубликованные до режима одного `comment`.
        expect(buildFeedbackPayload(context, 'ru').instructions).toMatchInlineSnapshot(
            `"The reviewer finished a review round on the local checkout /tmp/project, verdict request_changes. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema): what you did, or why you did not. Write the replies and the summary in Russian. Never edit files outside the project directory. Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is. The working tree is re-read automatically; do not run any other Sherpa command for this."`,
        );
    });

    it('ship без поручения: изменения одобрены, общий текст про действие на одобрение', () => {
        const ship = buildFeedbackPayload({ ...context, verdict: 'ship' }, 'en').instructions;
        expect(ship).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict ship. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema). Write the replies and the summary in English. Never edit files outside the project directory. The changes are approved. If the user asked you earlier to do something once the changes are approved (for example, commit them and open a pull request), do it now and say what you did in the summary. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
        // Ship не запрещает править код: одобрение не мешает выполнить поручение пользователя.
        expect(ship).not.toContain('do not change the code');
        expect(buildFeedbackPayload({ ...context, verdict: 'sticky_ship' }, 'en').instructions).not.toContain(
            'do not change the code',
        );
    });

    it('ship без комментариев: пустой список ответов, однострочный итог и общий текст про одобрение', () => {
        expect(
            buildFeedbackPayload({ ...context, threads: [], verdict: 'ship' }, 'en').instructions,
        ).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict ship. The reviewer approved the changes without comments. If the user asked you earlier to do something once the changes are approved (for example, commit them and open a pull request), do it now and say what you did in the summary. Submit a result with an empty replies list and a one-line summary. Write the replies and the summary in English. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
    });

    it('ship с поручением печатает его дословно вместо общего текста', () => {
        const withInstruction = { ...context, instruction: 'on ship, commit and open a PR' };

        expect(buildFeedbackPayload({ ...withInstruction, verdict: 'ship' }, 'en').instructions).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict ship. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema). Write the replies and the summary in English. Never edit files outside the project directory. The changes are approved. The user's instruction for the outcome of this review: "on ship, commit and open a PR". Carry out the part that applies to verdict ship now and say what you did in the summary. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
        expect(
            buildFeedbackPayload({ ...withInstruction, threads: [], verdict: 'sticky_ship' }, 'en').instructions,
        ).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict sticky_ship. The reviewer approved the changes without comments. The user's instruction for the outcome of this review: "on ship, commit and open a PR". Carry out the part that applies to verdict sticky_ship now and say what you did in the summary. Submit a result with an empty replies list and a one-line summary. Write the replies and the summary in English. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
    });

    it('request_changes с поручением: сначала правки по замечаниям, потом поручение', () => {
        const withInstruction = { ...context, instruction: 'on request changes, fix and run the tests' };

        expect(buildFeedbackPayload(withInstruction, 'en').instructions).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict request_changes. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema): what you did, or why you did not. Write the replies and the summary in English. Never edit files outside the project directory. Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is. The user's instruction for the outcome of this review: "on request changes, fix and run the tests". Carry out the part that applies to verdict request_changes now and say what you did in the summary. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
        expect(buildFeedbackPayload({ ...withInstruction, threads: [] }, 'en').instructions).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict request_changes. The reviewer left no comments in this round, so there is nothing to fix. The user's instruction for the outcome of this review: "on request changes, fix and run the tests". Carry out the part that applies to verdict request_changes now and say what you did in the summary. Submit a result with an empty replies list and a one-line summary. Write the replies and the summary in English. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
    });

    it('поручение с кавычками, обратным слешем и переводом строки печатается дословно', () => {
        const instruction = 'on ship, commit with message "SHERPA-61: done" in C:\\work\nthen open a PR';
        const instructions = buildFeedbackPayload({ ...context, verdict: 'ship', instruction }, 'en').instructions;

        expect(instructions).toContain(`outcome of this review: "${instruction}". Carry out`);
    });

    it('пустые comment и request_changes по-прежнему не просят ничего чинить', () => {
        expect(buildFeedbackPayload({ ...context, threads: [], verdict: 'comment' }, 'en').instructions).toContain(
            'The reviewer published no comments in this round. Nothing to fix: submit a result with an empty replies list and a one-line summary.',
        );
        expect(buildFeedbackPayload({ ...context, threads: [] }, 'en').instructions).toContain(
            'The reviewer left no comments in this round. Nothing to fix: submit a result with an empty replies list and a one-line summary.',
        );
    });
});

describe('публикация локального ревью ставит задачу агенту', () => {
    const PREFIX = 'app';
    let sherpaDir: string;
    let checkout: string;
    let server: SherpaServer | null;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-feedback-')));
        server = null;
    });

    afterEach(async () => {
        await server?.close();
        fs.rmSync(checkout, { recursive: true, force: true });
        await removeTempSherpaDir(sherpaDir);
    });

    it('ручка публикации заводит задачу review.feedback по свежему раунду', async () => {
        const fake = new FakeArc({ root: checkout, prefix: PREFIX });
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = new LocalHost({
            prKey: 'local-arc-app-0badc0de',
            vcs: arcVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });
        server = await startServer({
            prKey: 'local-arc-app-0badc0de',
            sherpaDir,
            longPollSeconds: 0.1,
            reviewHostFactory: () => ({ name: 'local-arc', host, refresh: () => host.refresh(), feedback: host }),
        });

        const diff = await host.getDiff();
        const comment = await host.saveDraft({
            body: 'вынеси константу',
            parentId: null,
            anchor: {
                fileId: diff.files[0]?.fileId ?? '',
                path: 'src/a.ts',
                position: { side: 'new', line: 1, size: 1 },
            },
        });
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewPublish,
            { verdict: 'comment' },
            server.token,
        );
        expect(response.status).toBe(200);

        const queue = server.queue;
        await waitUntil(
            () => queue.listTasks().some((task) => task.type === 'review.feedback'),
            'задача раунда',
        );
        const task = queue.listTasks().find((candidate) => candidate.type === 'review.feedback');
        expect(task?.priority).toBe('interactive');
        const context = fs.readFileSync(task?.contextFiles[0] ?? '', 'utf8');
        expect(context).toContain(path.join(fake.projectDir, 'src/a.ts'));
        expect(context).toContain(`## Thread ${comment.id}`);
        expect(context).toContain('вынеси константу');
    });
});

/** Ждёт условия: постановка задачи идёт фоном, фиксированная пауза здесь была бы гаданием. */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`не дождались: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
