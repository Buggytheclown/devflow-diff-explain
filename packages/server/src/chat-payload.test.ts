import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatAnchor, ChatExchange, FileContent, PrDiff, PrMeta, UiRouteState } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildChatPayload,
    CHAT_HISTORY_EXCHANGE_BYTES,
    CHAT_HISTORY_EXCHANGES,
    CHAT_PAYLOAD_BUDGET_BYTES,
    materializeChatPayload,
    questionDirIn,
    selectedPatchContext,
    surroundingFileContext,
} from './chat-payload.js';
import { walkPatch } from './route/diff-index.js';
import { mediumDiff, mediumReadySnapshot } from './route/fixture-support.js';
import { diffKeyOf, SharedPayloadStore } from './shared-payload.js';

const META: PrMeta = {
    id: '4242',
    url: 'https://github.com/quillmart/quillmart/pull/4242',
    title: 'Окно редактирования заказа',
    author: { login: 'alice', displayName: 'Элис Ингрэм', bot: false, avatarUrl: null },
    fromBranch: 'users/alice/edit-window',
    toBranch: 'trunk',
    state: 'open',
    statusLabel: 'Ожидает ревью',
    checks: null,
    updatedAt: '2026-08-20T10:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: false, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'bob', displayName: null, bot: false, avatarUrl: null },
};

const READY_ROUTE: UiRouteState = {
    phase: 'ready',
    smallPr: false,
    snapshot: mediumReadySnapshot(),
    failure: null,
    stale: null,
};
const EMPTY_ROUTE: UiRouteState = { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null };
const GUTTER = /^ *(\d+|\.) +(\d+|\.) \| (.*)$/gm;

function fixtureAnchor(): ChatAnchor {
    const diff = mediumDiff();
    for (const stop of mediumReadySnapshot().stops) {
        for (const candidate of stop.anchors) {
            const file = diff.files.find((item) => item.fileId === candidate.fileId);
            if (file?.patch !== null && file?.patch !== undefined) {
                const { collapsed: _collapsed, ...anchor } = candidate;
                return { ...anchor, diffId: diff.diffId };
            }
        }
    }
    throw new Error('у фикстуры medium нет якоря с текстовым патчем');
}

function fileContent(anchor: ChatAnchor, lineCount = Math.max(anchor.end + 100, 1000)): FileContent {
    const text = Array.from({ length: lineCount }, (_, index) => `line ${String(index + 1)}`).join('\n');
    return { oldText: text, newText: text };
}

function exchange(id: number, answer = `Ответ ${String(id)}`): ChatExchange {
    return {
        id,
        question: `Вопрос ${String(id)}`,
        anchor: null,
        status: 'done',
        taskId: id,
        answer,
        progressText: null,
        error: null,
        locale: null,
        createdAt: `2026-09-01T10:${String(id).padStart(2, '0')}:00.000Z`,
        updatedAt: `2026-09-01T10:${String(id).padStart(2, '0')}:01.000Z`,
    };
}

function fileOf(payload: ReturnType<typeof buildChatPayload>, name: string): string {
    return payload.files.find((file) => file.name === name)?.content ?? '';
}

function payloadBytes(payload: ReturnType<typeof buildChatPayload>): number {
    return payload.files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
}

describe('chat payload с якорем', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;
    let shared: SharedPayloadStore;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-chat-payload-'));
        payloadDir = path.join(root, 'chat');
        sharedDir = path.join(root, 'shared');
        shared = new SharedPayloadStore(sharedDir, () => []);
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    async function materialize(
        context: Parameters<typeof buildChatPayload>[0],
        options?: Parameters<typeof buildChatPayload>[1],
    ) {
        return materializeChatPayload(questionDirIn(payloadDir), shared, buildChatPayload(context, options));
    }

    it('сохраняет точную цитату Markdown в контексте вопроса вместе с диапазоном', async () => {
        const anchor = { ...fixtureAnchor(), selectedText: 'нижняя граница' };
        const result = await materialize({ question: 'Объясни смысл', anchor, pr: META, diff: mediumDiff(), fileContent: fileContent(anchor), route: READY_ROUTE, history: [] });
        const question = result.contextFiles.find((file) => file.endsWith('/question.md'));
        expect(fs.readFileSync(question ?? '', 'utf8')).toContain(JSON.stringify(anchor.selectedText));
        expect(fs.readFileSync(question ?? '', 'utf8')).toContain(`Selected range: ${anchor.path}:${String(anchor.start)}`);
    });

    it('общее — по стабильному пути, своё — в свежем каталоге вопроса', async () => {
        const anchor = fixtureAnchor();
        const context = {
            question: 'Почему порядок операций выбран таким?',
            anchor,
            pr: META,
            diff: mediumDiff(),
            fileContent: fileContent(anchor),
            route: READY_ROUTE,
            history: [exchange(1)],
        };
        const first = await materialize(context);
        const second = await materialize(context);

        expect(first.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            expect.stringMatching(/\.new\.md$/),
            'question.md',
            'selection.patch.md',
            'route-context.md',
            'history.md',
        ]);
        // Первые два пути общие: их модель читает один раз за сессию.
        expect(first.contextFiles.slice(0, 2)).toEqual(second.contextFiles.slice(0, 2));
        expect(first.contextFiles[0]?.startsWith(path.join(sharedDir, 'guides'))).toBe(true);
        expect(first.contextFiles[1]?.startsWith(path.join(sharedDir, 'diff', diffKeyOf(mediumDiff()), 'files'))).toBe(
            true,
        );
        // Свои файлы — в своём каталоге вопроса: retry не перезаписывает payload прежней задачи.
        expect(path.dirname(first.contextFiles[2] ?? '')).not.toBe(path.dirname(second.contextFiles[2] ?? ''));
        expect(first.contextFiles.slice(2).every((file) => file.startsWith(payloadDir))).toBe(true);
        expect(first.contextFiles.every((file) => fs.existsSync(file))).toBe(true);
        expect(fs.readFileSync(first.contextFiles[0] ?? '', 'utf8')).toContain('# Task: answer the reviewer question');
        expect(fs.readFileSync(first.contextFiles[1] ?? '', 'utf8')).toContain(`File: ${anchor.path}`);
        expect(fs.readFileSync(first.contextFiles[2] ?? '', 'utf8')).toContain(context.question);
        const routeContext = fs.readFileSync(first.contextFiles[4] ?? '', 'utf8');
        const coveringStop = mediumReadySnapshot().stops.find((stop) =>
            stop.anchors.some(
                (candidate) =>
                    candidate.fileId === anchor.fileId &&
                    candidate.side === anchor.side &&
                    candidate.start <= anchor.end &&
                    candidate.end >= anchor.start,
            ),
        );
        expect(routeContext).toContain('## Pull request summary');
        expect(routeContext).toContain(coveringStop?.title);
        expect(first.resultSchemaFile).toBeUndefined();
        expect(Buffer.byteLength(first.instructions, 'utf8')).toBeLessThan(500);
        // Правило общего контекста: путь под `shared/` читается один раз за сессию.
        expect(first.instructions).toContain('shared/');
        expect(first.instructions).toContain('once per session');
        expect(fs.readFileSync(first.contextFiles[0] ?? '', 'utf8')).toContain('once per session');
    });

    it('два вопроса к одному файлу делят один общий путь и не переписывают его', async () => {
        const anchor = fixtureAnchor();
        const base = {
            question: 'Первый вопрос',
            anchor,
            pr: META,
            diff: mediumDiff(),
            fileContent: fileContent(anchor),
            route: READY_ROUTE,
            history: [],
        };
        const first = await materialize(base);
        const filePath = first.contextFiles[1] ?? '';
        const stamp = fs.statSync(filePath).mtimeMs;
        fs.writeFileSync(filePath, 'подменённый общий файл');

        const second = await materialize({
            ...base,
            question: 'Второй вопрос',
            anchor: { ...anchor, start: anchor.start + 1, end: anchor.end + 1 },
        });

        expect(second.contextFiles[1]).toBe(filePath);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('подменённый общий файл');
        expect(fs.statSync(filePath).mtimeMs).toBeGreaterThanOrEqual(stamp);
    });

    it('файл больше бюджета общим не становится: срез на якоре лежит в каталоге вопроса', async () => {
        const anchor = { ...fixtureAnchor(), start: 5_000, end: 5_003 };
        const input = await materialize(
            {
                question: 'Что делает этот диапазон?',
                anchor,
                pr: META,
                diff: mediumDiff(),
                fileContent: fileContent(anchor, 10_000),
                route: READY_ROUTE,
                history: [],
            },
            { sharedBudgetBytes: 4_000, budgetBytes: 20_000 },
        );

        expect(input.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            'question.md',
            'selection.patch.md',
            'file-context.md',
            'route-context.md',
            'history.md',
        ]);
        const slice = input.contextFiles[3] ?? '';
        expect(slice.startsWith(payloadDir)).toBe(true);
        const text = fs.readFileSync(slice, 'utf8');
        expect(text).toContain('5000 | line 5000');
        expect(text).toContain('[TRUNCATED: earlier file lines omitted');
        expect(text).toContain('[TRUNCATED: later file lines omitted');
        expect(fs.existsSync(path.join(sharedDir, 'diff', diffKeyOf(mediumDiff()), 'files'))).toBe(false);
    });

    it('печатает диапазон теми же номерами walkPatch, которыми построен якорь', () => {
        const anchor = fixtureAnchor();
        const file = mediumDiff().files.find((candidate) => candidate.fileId === anchor.fileId) ?? null;
        const text = selectedPatchContext(anchor, file);
        const printed = new Set<number>();
        for (const [, oldCell = '', newCell = ''] of text.matchAll(GUTTER)) {
            const cell = anchor.side === 'old' ? oldCell : newCell;
            if (cell !== '.') {
                printed.add(Number(cell));
            }
        }
        const expected = new Set<number>();
        for (const line of walkPatch(file?.patch ?? '')) {
            const number = line[anchor.side];
            if (number !== null && number >= anchor.start && number <= anchor.end) {
                expected.add(number);
            }
        }

        expect(printed).toEqual(expected);
        expect(text).toContain('Numbers are produced by the same patch walk used for anchor validation.');
    });

    it('центрирует большой файл на диапазоне и честно помечает урезание', () => {
        const anchor = { ...fixtureAnchor(), start: 5_000, end: 5_003 };
        const text = surroundingFileContext(anchor, fileContent(anchor, 10_000), 4_000);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4_000);
        expect(text).toContain('5000 | line 5000');
        expect(text).toContain('[TRUNCATED: earlier file lines omitted');
        expect(text).toContain('[TRUNCATED: later file lines omitted');
    });

    it('без маршрута, диффа и содержимого файла оставляет вопрос и честные пометки', () => {
        const anchor = fixtureAnchor();
        const payload = buildChatPayload({
            question: 'Что делает этот диапазон?',
            anchor,
            pr: null,
            diff: null,
            fileContent: null,
            route: EMPTY_ROUTE,
            history: [],
        });

        expect(fileOf(payload, 'question.md')).toContain('Что делает этот диапазон?');
        expect(fileOf(payload, 'question.md')).toContain('[UNAVAILABLE: the host could not provide the active diff.]');
        expect(payload.shared.map((entry) => entry.kind)).toEqual(['guide']);
        expect(fileOf(payload, 'selection.patch.md')).toContain('[UNAVAILABLE: the selected file is absent');
        expect(fileOf(payload, 'file-context.md')).toContain('[UNAVAILABLE: the host could not provide');
        expect(fileOf(payload, 'route-context.md')).toContain('No route snapshot is available');
    });
});

describe('chat payload уровня PR', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;
    let shared: SharedPayloadStore;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-chat-pr-payload-'));
        payloadDir = path.join(root, 'chat');
        sharedDir = path.join(root, 'shared');
        shared = new SharedPayloadStore(sharedDir, () => []);
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    async function materialize(
        context: Parameters<typeof buildChatPayload>[0],
        options?: Parameters<typeof buildChatPayload>[1],
    ) {
        return materializeChatPayload(questionDirIn(payloadDir), shared, buildChatPayload(context, options));
    }

    function prContext(question: string) {
        return {
            question,
            anchor: null,
            pr: META,
            diff: mediumDiff(),
            fileContent: null,
            route: READY_ROUTE,
            history: [],
        };
    }

    it('summary и абзацы плана — свои, список файлов и патчи — общий дифф', async () => {
        const diff = mediumDiff();
        const snapshot = mediumReadySnapshot();
        const input = await materialize(prContext('Что здесь меняется целиком?'));

        expect(input.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            'pr-diff.md',
            'question.md',
            'route-context.md',
            'history.md',
        ]);
        expect(input.contextFiles[1]).toBe(path.join(sharedDir, 'diff', diffKeyOf(diff), 'pr-diff.md'));

        const route = fs.readFileSync(input.contextFiles[3] ?? '', 'utf8');
        expect(route).toContain(snapshot.summary);
        expect(route).toContain('### Plan order');
        for (const stop of snapshot.stops) {
            if (stop.paragraph !== null) {
                expect(route).toContain(stop.paragraph);
            }
        }

        const context = fs.readFileSync(input.contextFiles[1] ?? '', 'utf8');
        expect(context).toContain('## Patches');
        for (const file of diff.files) {
            expect(context).toContain(`\`${file.path}\``);
            if (file.patch !== null) {
                const changedLine = [...walkPatch(file.patch)].find((line) => line.changed);
                expect(changedLine).toBeDefined();
                expect(context).toContain(changedLine?.raw);
            }
        }
    });

    it('пять вопросов по PR: дифф записан один раз и путь у всех один', async () => {
        const inputs = [];
        for (const index of [1, 2, 3, 4, 5]) {
            inputs.push(await materialize(prContext(`Вопрос ${String(index)}`)));
        }
        const diffPath = inputs[0]?.contextFiles[1] ?? '';
        // Подмена содержимого: повторная материализация обязана оставить файл как есть.
        fs.writeFileSync(diffPath, 'подменённый дифф');
        const sixth = await materialize(prContext('Вопрос 6'));

        expect(new Set(inputs.map((input) => input.contextFiles[1])).size).toBe(1);
        expect(sixth.contextFiles[1]).toBe(diffPath);
        expect(fs.readFileSync(diffPath, 'utf8')).toBe('подменённый дифф');
        expect(fs.readdirSync(path.dirname(diffPath))).toEqual(['pr-diff.md']);
        // Свой каталог у каждого вопроса всё равно свой.
        expect(new Set(inputs.map((input) => path.dirname(input.contextFiles[2] ?? ''))).size).toBe(5);
    });

    it('смена ключа диффа заводит новый каталог и убирает прежний', async () => {
        const first = await materialize(prContext('Вопрос по прежнему диффу'));
        const next = mediumDiff();
        const second = await materialize({
            ...prContext('Вопрос после нового пуша'),
            diff: { ...next, headCommit: `${next.headCommit}f` },
        });

        expect(second.contextFiles[1]).not.toBe(first.contextFiles[1]);
        expect(fs.existsSync(first.contextFiles[1] ?? '')).toBe(false);
        expect(fs.existsSync(second.contextFiles[1] ?? '')).toBe(true);
        expect(fs.readdirSync(path.join(sharedDir, 'diff'))).toHaveLength(1);
    });

    it('общий дифф урезается по своему бюджету, не по бюджету файлов вопроса', () => {
        const fixture = mediumDiff();
        const small = fixture.files.find((file) => file.patch !== null && !file.generated);
        if (small === undefined) {
            throw new Error('у фикстуры medium нет обычного файла с текстовым патчем');
        }
        const hugeLines = Array.from({ length: 20_000 }, (_, index) => `+const generated${String(index)} = ${String(index)};`);
        const diff: PrDiff = {
            ...fixture,
            files: [
                small,
                {
                    ...small,
                    fileId: 'huge-chat-patch',
                    path: 'src/huge-chat-patch.ts',
                    oldPath: null,
                    changeType: 'add',
                    additions: hugeLines.length,
                    deletions: 0,
                    patch: `@@ -0,0 +1,${String(hugeLines.length)} @@\n${hugeLines.join('\n')}\n`,
                },
            ],
        };
        const sharedBudgetBytes = 48 * 1024;
        const payload = buildChatPayload(
            {
                question: 'Что меняется во всём PR?',
                anchor: null,
                pr: META,
                diff,
                fileContent: null,
                route: READY_ROUTE,
                history: [],
            },
            { sharedBudgetBytes },
        );
        const context = payload.shared.find((entry) => entry.kind === 'pr-diff')?.content ?? '';
        const smallChangedLine = [...walkPatch(small.patch ?? '')].find((line) => line.changed);

        expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(sharedBudgetBytes);
        expect(payloadBytes(payload)).toBeLessThanOrEqual(CHAT_PAYLOAD_BUDGET_BYTES);
        expect(context).toContain(`\`${small.path}\``);
        expect(context).toContain(smallChangedLine?.raw);
        expect(context).toContain('`src/huge-chat-patch.ts`');
        expect(context).toContain('patch omitted');
        expect(context).not.toContain(hugeLines.at(-1));
    });

    it('берёт последние N завершённых обменов, новые первыми', () => {
        const history = Array.from({ length: CHAT_HISTORY_EXCHANGES + 3 }, (_, index) => exchange(index + 1));
        const payload = buildChatPayload({
            question: 'Продолжи обсуждение',
            anchor: null,
            pr: META,
            diff: mediumDiff(),
            fileContent: null,
            route: READY_ROUTE,
            history,
        });
        const text = fileOf(payload, 'history.md');

        expect(text.match(/^## \d+\. Exchange /gm)).toHaveLength(CHAT_HISTORY_EXCHANGES);
        expect(text).toContain(`Exchange ${String(CHAT_HISTORY_EXCHANGES + 3)} —`);
        expect(text).not.toContain('Exchange 1 —');
        expect(text.indexOf(`Exchange ${String(CHAT_HISTORY_EXCHANGES + 3)} —`)).toBeLessThan(
            text.indexOf(`Exchange ${String(CHAT_HISTORY_EXCHANGES + 2)} —`),
        );
    });

    it('режет один обмен истории и в PR-level payload', () => {
        const payload = buildChatPayload({
            question: 'Продолжи обсуждение',
            anchor: null,
            pr: META,
            diff: mediumDiff(),
            fileContent: null,
            route: READY_ROUTE,
            history: [exchange(1, 'доказательство '.repeat(30_000))],
        });
        const text = fileOf(payload, 'history.md');

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(CHAT_HISTORY_EXCHANGE_BYTES + 256);
        expect(text).toContain(
            `[TRUNCATED: assistant reply exceeds ${String(CHAT_HISTORY_EXCHANGE_BYTES)} bytes per chat exchange.]`,
        );
    });
});

describe('общий бюджет chat payload', () => {
    it('не превышает 320 КБ на большом файле и большой истории', () => {
        const anchor = fixtureAnchor();
        const hugeAnswer = 'доказательство '.repeat(30_000);
        const history = Array.from({ length: CHAT_HISTORY_EXCHANGES + 2 }, (_, index) =>
            exchange(index + 1, hugeAnswer),
        );
        const hugeText = Array.from({ length: 100_000 }, (_, index) => `line ${String(index + 1)} ${'x'.repeat(40)}`).join(
            '\n',
        );
        const payload = buildChatPayload({
            question: 'Объясни выделенный диапазон',
            anchor,
            pr: META,
            diff: mediumDiff(),
            fileContent: { oldText: hugeText, newText: hugeText },
            route: READY_ROUTE,
            history,
        });

        const historyText = fileOf(payload, 'history.md');
        const fileContext = fileOf(payload, 'file-context.md');

        expect(payloadBytes(payload)).toBeLessThanOrEqual(CHAT_PAYLOAD_BUDGET_BYTES);
        expect(historyText.match(/\[TRUNCATED: assistant reply exceeds/g)).toHaveLength(CHAT_HISTORY_EXCHANGES);
        expect(Buffer.byteLength(historyText, 'utf8')).toBeLessThanOrEqual(
            CHAT_HISTORY_EXCHANGES * CHAT_HISTORY_EXCHANGE_BYTES + 1024,
        );
        expect(fileContext).toContain(`${String(anchor.start)} | line ${String(anchor.start)}`);
        expect(fileContext).not.toContain('The surrounding file did not fit in the chat payload budget.');
        expect(fileContext).toContain('[TRUNCATED: later file lines omitted');
        expect(Buffer.byteLength(payload.instructions, 'utf8')).toBeLessThan(500);
    });
});
